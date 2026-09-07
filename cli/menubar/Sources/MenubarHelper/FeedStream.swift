import Foundation

// FeedStream — the helper's single source of truth for live sessions + attention
// across the fleet (PHNX-4002, Track B).
//
// It owns EXACTLY ONE long-lived child, `agents feed watch --json` (no --local),
// spawned through ChildProcess.stream so it is group-killed on quit and reaped by
// the next launch if the helper dies (the launchd-KeepAlive orphan incident,
// AgentsCLI.swift:757-775 / ChildProcess.swift docblock). NDJSON is parsed off the
// main thread on a private serial queue; a pure `FeedState` reducer folds each
// envelope and the resulting diff is published to observers on the main queue.
//
// It is a PROJECTION, never a scheduler: it only READS the feed stream and never
// owns a timer that performs a fleet-affecting action (spec SING-2). The one timer
// it holds is a health watchdog over its OWN child — restart-on-silence only.
//
// ── Observer API (the seam tracks C and E code against — keep it exactly) ───────
//
//   final class FeedStream {
//       static let shared: FeedStream
//       struct Diff { let upserted: Set<String>; let removed: Set<String>; let attentionChanged: Set<String> }
//       var rows: [String: SessionRow] { get }           // main-queue reads only
//       var attention: [String: AttentionItem] { get }   // main-queue reads only
//       var health: StreamHealth { get }
//       func addObserver(_ id: AnyObject, _ handler: @escaping (Diff) -> Void)
//       func removeObserver(_ id: AnyObject)
//       func start(); func stop(); func restart()
//       // Dispatch placeholders (PHNX-4005): a launch the palette fired but the
//       // feed has not reported yet rides `rows` as a `launching` row.
//       var placeholders: [PendingLaunch] { get }          // main-queue reads only
//       func registerPlaceholder(_ launch: PendingLaunch)
//       func failPlaceholder(key: String, stderrTail: String)
//   }
//
// `upserted`/`removed` are rowKeys; `attentionChanged` are sessionIds. Reads of
// `rows`/`attention`/`health`/`deviceHeartbeat` are published snapshots that are
// mutated only on the main queue, so a UI caller reads them on the main queue.
//
// ── Placeholders ────────────────────────────────────────────────────────────────
//
// `registerPlaceholder` adds a synthetic row (rowKey `launching/<key>`, phase
// `launching`, see `PendingLaunch.placeholderRow`) to the published `rows` and
// fires an `upserted` diff for it, so the palette's pulse strip and the Sessions
// window render it with no wiring beyond observing `rows`. It is removed — with a
// `removed` diff — when a REAL row fulfils it (matched on the minted session id,
// or on `--name`), when the launch's child exits non-zero (`failPlaceholder`,
// carrying the stderr tail), or when the 60 s ttl passes with no row, which
// posts "did not start". Reconciliation runs on every ingested envelope and on
// the existing health tick; neither is a scheduler — expiring a placeholder only
// drops a projection row and notifies, it never acts on a session (SING-2).
final class FeedStream {
    static let shared = FeedStream()

    /// The diff delivered to observers — the exact shape tracks C and E consume.
    typealias Diff = FeedDiff

    // MARK: Published (main-queue) snapshots

    private var publishedRows: [String: SessionRow] = [:]
    private var publishedAttention: [String: AttentionItem] = [:]
    private var publishedDeviceHeartbeat: [String: Date] = [:]
    private var publishedScopeStatus: [String: FeedScopeStatus] = [:]
    private var publishedHealth: StreamHealth = .stopped
    private var publishedPlaceholders: [PendingLaunch] = []

    /// Live rows keyed by rowKey, including the `launching` placeholder rows.
    /// Main-queue reads only.
    var rows: [String: SessionRow] { publishedRows }
    /// Dispatch placeholders not yet fulfilled by a real row. Main-queue reads only.
    var placeholders: [PendingLaunch] { publishedPlaceholders }
    /// Attention items keyed by sessionId. Main-queue reads only.
    var attention: [String: AttentionItem] { publishedAttention }
    /// Last-seen time per device scope. Main-queue reads only.
    var deviceHeartbeat: [String: Date] { publishedDeviceHeartbeat }
    /// Per-device availability from `scope` envelopes. Main-queue reads only.
    var scopeStatus: [String: FeedScopeStatus] { publishedScopeStatus }
    /// Health of the single feed child.
    var health: StreamHealth { publishedHealth }

    // MARK: Owned state (queue-confined)

    private let queue = DispatchQueue(label: "com.phnx-labs.agents-menubar.feedstream")
    private var state = FeedState()
    private var placeholderRegistry = LaunchPlaceholders()
    private var handle: ChildProcess.StreamHandle?
    private var policy = RespawnPolicy()
    private var started = false
    private var stopping = false
    private var sawDataSinceSpawn = false
    private var restarting = false
    private var healthTimer: DispatchSourceTimer?

    // MARK: Tunables

    /// No line for this long → the stream reads stale (rows kept).
    static let staleAfter: TimeInterval = 45
    /// No line for this long → the child is force-restarted (it may be wedged).
    static let restartAfter: TimeInterval = 120
    /// Health watchdog cadence.
    static let healthCheckInterval: TimeInterval = 5

    private struct Observer {
        weak var owner: AnyObject?
        let handler: (Diff) -> Void
    }
    private var observers: [ObjectIdentifier: Observer] = [:]

    private init() {}

    // MARK: - Lifecycle

    func start() {
        queue.async {
            guard !self.started else { return }
            self.started = true
            self.stopping = false
            self.setHealth(.starting)
            self.spawnChild()
            self.startHealthTimer()
        }
    }

    func stop() {
        queue.async {
            self.stopping = true
            self.stopHealthTimer()
            self.handle?.stop()
            self.handle = nil
            self.started = false
            self.setHealth(.stopped)
        }
    }

    /// Restart on demand — clears a tripped breaker and respawns immediately.
    func restart() {
        queue.async {
            self.policy.reset()
            self.stopping = false
            self.started = true
            if self.healthTimer == nil { self.startHealthTimer() }
            if let handle = self.handle {
                // A live child: kill it and let onExit respawn promptly.
                self.restarting = true
                handle.stop()
            } else {
                self.spawnChild()
            }
        }
    }

    // MARK: - Observers

    func addObserver(_ id: AnyObject, _ handler: @escaping (Diff) -> Void) {
        let key = ObjectIdentifier(id)
        queue.async { self.observers[key] = Observer(owner: id, handler: handler) }
    }

    func removeObserver(_ id: AnyObject) {
        let key = ObjectIdentifier(id)
        queue.async { self.observers[key] = nil }
    }

    // MARK: - Placeholders

    /// Register a launch the palette just fired. Its `launching` row is published
    /// immediately and reconciled against real rows from then on.
    func registerPlaceholder(_ launch: PendingLaunch) {
        queue.async {
            let diff = self.placeholderRegistry.register(launch)
            self.publish(diff)
        }
    }

    /// The launch's child exited non-zero before its row arrived: expire the
    /// placeholder now with the captured stderr tail. No-op for a key that has
    /// already resolved or expired.
    func failPlaceholder(key: String, stderrTail: String) {
        queue.async {
            let (diff, expired) = self.placeholderRegistry.fail(key: key, stderrTail: stderrTail)
            if let expired { self.notifyExpired([expired]) }
            self.publish(diff)
        }
    }

    /// Fold a reconcile pass over the REAL rows into `diff`. Queue-confined.
    private func reconcilePlaceholders(into diff: inout Diff) {
        guard !placeholderRegistry.pending.isEmpty else { return }
        let now = Date().timeIntervalSince1970 * 1000
        let (change, expired) = placeholderRegistry.reconcile(
            realRows: Array(state.rows.values), now: now)
        diff.upserted.formUnion(change.upserted)
        diff.removed.formUnion(change.removed)
        notifyExpired(expired)
    }

    /// "did not start" for each expired launch — the one user-visible outcome of
    /// a user-initiated dispatch that never surfaced, posted from the registry's
    /// single owner so every window sees it exactly once.
    private func notifyExpired(_ expired: [PendingLaunch]) {
        guard !expired.isEmpty else { return }
        DispatchQueue.main.async {
            for p in expired {
                Notifier.post(title: "Dispatch did not start",
                              body: PendingLaunches.expiredMessage(p), agent: p.agent)
            }
        }
    }

    // MARK: - Child spawn

    private func spawnChild() {
        guard !stopping else { return }
        restarting = false
        sawDataSinceSpawn = false
        if policy.consecutiveFailures > 0 {
            setHealth(.reconnecting(attempt: policy.consecutiveFailures))
        } else if case .live = publishedHealth {
            // keep live across a seamless respawn
        } else {
            setHealth(.starting)
        }

        let argv = FeedStream.feedWatchArgv()
        let spawned = ChildProcess.stream(argv,
            onLine: { [weak self] line in
                self?.queue.async { self?.ingest(line) }
            },
            onExit: { [weak self] in
                self?.queue.async { self?.handleChildExit() }
            })
        guard let spawned else {
            // Could not even start the child — treat as a failure and back off.
            handleChildExit()
            return
        }
        handle = spawned
    }

    private func ingest(_ line: String) {
        guard let env = FeedEnvelope.decode(line) else { return }
        if !sawDataSinceSpawn {
            sawDataSinceSpawn = true
            policy.recordHealthy() // a working connection clears the breaker path
        }
        var diff = state.apply(env)
        reconcilePlaceholders(into: &diff)
        setHealth(.live)
        publish(diff)
    }

    private func handleChildExit() {
        handle = nil
        guard !stopping else { setHealth(.stopped); return }

        policy.recordFailure()
        if policy.isTripped {
            setHealth(.breakerTripped)
            return // wait for restart()
        }
        let attempt = policy.consecutiveFailures
        setHealth(.reconnecting(attempt: attempt))
        let delay = restarting ? policy.baseDelay : policy.delay(forAttempt: attempt)
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.stopping, self.handle == nil else { return }
            self.spawnChild()
        }
    }

    // MARK: - Health watchdog

    private func startHealthTimer() {
        stopHealthTimer()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + FeedStream.healthCheckInterval,
                       repeating: FeedStream.healthCheckInterval)
        timer.setEventHandler { [weak self] in self?.checkHealth() }
        healthTimer = timer
        timer.resume()
    }

    private func stopHealthTimer() {
        healthTimer?.cancel()
        healthTimer = nil
    }

    private func checkHealth() {
        // A placeholder must expire even when the feed is silent, so the ttl
        // check rides this tick too. It only drops a projection row + notifies.
        var placeholderDiff = Diff()
        reconcilePlaceholders(into: &placeholderDiff)
        if !placeholderDiff.isEmpty { publish(placeholderDiff) }

        guard !stopping, !restarting else { return }
        // Only meaningful once a child is up and the breaker is not tripped.
        if case .breakerTripped = publishedHealth { return }
        guard let last = state.lastEventAt else { return }
        let age = Date().timeIntervalSince(last)
        if age > FeedStream.restartAfter {
            // The child is silent past the hard ceiling — assume it is wedged and
            // force it down; onExit respawns it. This is a restart of OUR OWN
            // child, not a fleet action.
            restarting = true
            setHealth(.reconnecting(attempt: max(1, policy.consecutiveFailures)))
            if let handle { handle.stop() } else { spawnChild() }
        } else if age > FeedStream.staleAfter {
            setHealth(.stale(since: last))
        }
    }

    // MARK: - Publish

    private func publish(_ diff: Diff) {
        // Real rows first, placeholders on top — the namespaced rowKey means the
        // two never collide, so this is a union, not an override.
        let rowsSnap = state.rows.merging(placeholderRegistry.rows) { _, placeholder in placeholder }
        let placeholdersSnap = placeholderRegistry.pending
        let attnSnap = state.attention
        let heartbeatSnap = state.deviceHeartbeat
        let scopeSnap = state.scopeStatus
        DispatchQueue.main.async {
            self.publishedRows = rowsSnap
            self.publishedPlaceholders = placeholdersSnap
            self.publishedAttention = attnSnap
            self.publishedDeviceHeartbeat = heartbeatSnap
            self.publishedScopeStatus = scopeSnap
            if !diff.isEmpty { self.notify(diff) }
        }
    }

    /// Publish a health transition. A change also fires an empty diff so a UI
    /// observer can refresh its health banner without a separate channel.
    private func setHealth(_ next: StreamHealth) {
        let heartbeatSnap = state.deviceHeartbeat
        DispatchQueue.main.async {
            guard self.publishedHealth != next else { return }
            self.publishedHealth = next
            self.publishedDeviceHeartbeat = heartbeatSnap
            self.notify(Diff())
        }
    }

    /// Deliver to observers on the main queue; drop any whose owner is gone.
    private func notify(_ diff: Diff) {
        var handlers: [(Diff) -> Void] = []
        // Observers live on the private queue; snapshot them there to avoid a
        // cross-queue read, then invoke on main.
        queue.sync {
            for (key, observer) in observers {
                if observer.owner == nil { observers[key] = nil }
                else { handlers.append(observer.handler) }
            }
        }
        for handler in handlers { handler(diff) }
    }

    // MARK: - argv

    /// Build the `agents feed watch --json` argv, resolving the interpreter the
    /// same way AgentsCLI does (node + entry when the daemon exported them, since
    /// a launchd/GUI process has a minimal PATH; else the resolved `agents` bin).
    /// AgentsCLI.argv is private in a file this track must not edit, so the
    /// node/entry preference is mirrored here rather than reached across.
    static func feedWatchArgv() -> [String] {
        let env = ProcessInfo.processInfo.environment
        let watch = ["feed", "watch", "--json"]
        if let node = env["AGENTS_NODE"], let entry = env["AGENTS_ENTRY"],
           FileManager.default.isExecutableFile(atPath: node),
           FileManager.default.fileExists(atPath: entry) {
            return [node, entry] + watch
        }
        return [AgentsCLI.binary] + watch
    }
}
