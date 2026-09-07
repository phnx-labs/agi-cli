import Foundation

// Track E (PHNX-4005) — the pure data layer behind the palette's dispatch form:
// the three new dispatch dimensions (mode / surface / watchdog), the per-project
// remembered defaults, the collapsed summary line, and the pending-launch
// registry that a minted session id resolves against.
//
// Everything here is pure or UserDefaults-backed — no AppKit, no process, an
// injectable clock — so `MENUBAR_DISPATCH_TEST=1` drives it headlessly and the
// argv/summary/registry contracts are a build gate (see DispatchSelfTest.swift).
//
// The CLI contract these map onto is pinned to `cli/src/commands/exec.ts` (the
// `agents run` options) and `cli/src/commands/watchdog.ts` (the watchdog policy
// verb), NOT to memory — the exact flags are quoted at each mapping below.

// MARK: - Mode

/// How autonomous the dispatch is. Plan is special: it keeps the palette's
/// existing ticket-agent flow (investigate + return ticket fields / post a plan),
/// so it carries NO `--mode` on a run argv. Auto and Edit go through `agents run`
/// with the matching `--mode` value.
///
/// `agents run -m, --mode <mode>` accepts `plan | edit | auto | skip`
/// (exec.ts:685); this surface deliberately offers only the three safe ones —
/// `skip` (bypass every permission prompt) is never a one-keystroke default.
enum DispatchMode: String, Codable, CaseIterable {
    case plan
    case auto
    case edit

    var title: String {
        switch self {
        case .plan: return "Plan"
        case .auto: return "Auto"
        case .edit: return "Edit"
        }
    }

    /// The `--mode` value for a run dispatch, or nil for Plan (which never runs
    /// `agents run` — it drives the ticket-agent flow instead).
    var runModeValue: String? {
        self == .plan ? nil : rawValue
    }

    /// Plan is not a headless run; it hands the note to the ticket agent.
    var isRun: Bool { self != .plan }
}

// MARK: - Surface

/// Where the agent's UI lives. Interactive opens a real terminal
/// (`agents run --terminal`, exec.ts:736); headless runs in the background and
/// self-notifies (`--notify`).
enum DispatchSurface: String, Codable, CaseIterable {
    case interactive
    case headless

    var title: String {
        switch self {
        case .interactive: return "Interactive"
        case .headless: return "Headless"
        }
    }
}

// MARK: - Watchdog

/// The per-session watchdog policy. This is NOT a flag on `agents run` — there is
/// no such flag (verified against exec.ts). It is a separate command,
/// `agents watchdog policy <session-id> off|keep|handsoff`
/// (watchdog.ts:418-422), applied on the session id the dispatch mints. `keep`
/// is the default the daemon already uses, so it needs no command; `off` and
/// `handsoff` are the deviations that emit one.
enum WatchdogPolicy: String, Codable, CaseIterable {
    case off
    case keep
    case handsoff

    /// The label the form shows. Maps the operator's intent to the CLI token.
    var title: String {
        switch self {
        case .off: return "Off"
        case .keep: return "Keep moving"
        case .handsoff: return "Hands-off"
        }
    }

    /// The exact token `agents watchdog policy <id> <token>` accepts.
    var policyToken: String { rawValue }

    /// `keep` is the daemon default, so it needs no policy command; the other two
    /// deviate from it and emit one.
    var needsPolicyCommand: Bool { self != .keep }
}

// MARK: - Remembered defaults

/// The remembered dispatch defaults for one project, persisted under
/// `menubar.quickDispatch.defaults.<project>`. The whole point is that when the
/// defaults are right the owner dispatches with one keystroke and never re-picks
/// an agent — so this is per project (the agent that fits `agi` is rarely the one
/// that fits a research repo) and it round-trips through UserDefaults verbatim.
struct DispatchDefaults: Codable, Equatable {
    /// Selected agent ids, order preserved (single-select by default; a second
    /// via Cmd-click).
    var agents: [String]
    /// Where it runs: `local` (This Mac), `auto` (least-loaded preferred worker),
    /// or a device name. Maps to `agents run --device <runOn>` for anything but
    /// `local` (exec.ts:795 — `--device` accepts `auto`, a name, or `user@host`).
    var runOn: String
    var mode: DispatchMode
    var surface: DispatchSurface
    var watchdog: WatchdogPolicy

    /// The starting point on a project with nothing remembered: one agent, this
    /// Mac, Auto, Interactive, Keep moving — the collapsed-summary example in the
    /// brief.
    static func fallback(agent: String = "claude") -> DispatchDefaults {
        DispatchDefaults(agents: [agent], runOn: "local", mode: .auto,
                         surface: .interactive, watchdog: .keep)
    }

    /// A copy with one dimension overridden (used to force Plan for one dispatch).
    func with(mode: DispatchMode) -> DispatchDefaults {
        var copy = self
        copy.mode = mode
        return copy
    }

    static let defaultsKeyPrefix = "menubar.quickDispatch.defaults."

    static func storageKey(project: String) -> String {
        defaultsKeyPrefix + project
    }

    /// Load the remembered defaults for a project, or the fallback when none is
    /// stored (or the stored blob is from an older shape and no longer decodes).
    /// The fallback's agent is the roster's first entry so an empty box still
    /// dispatches something sensible.
    static func load(project: String?,
                     fallbackAgent: String = "claude",
                     store: UserDefaults = .standard) -> DispatchDefaults {
        guard let project, !project.isEmpty,
              let data = store.data(forKey: storageKey(project: project)),
              let decoded = try? JSONDecoder().decode(DispatchDefaults.self, from: data),
              !decoded.agents.isEmpty else {
            return fallback(agent: fallbackAgent)
        }
        return decoded
    }

    /// Persist as this project's remembered defaults. A nil/empty project name is
    /// a no-op (the degraded no-definitions path has no project to key on).
    func save(project: String?, store: UserDefaults = .standard) {
        guard let project, !project.isEmpty,
              let data = try? JSONEncoder().encode(self) else { return }
        store.set(data, forKey: DispatchDefaults.storageKey(project: project))
    }

    // MARK: Collapsed summary line

    /// The one-line summary the collapsed form shows, e.g.
    /// `Claude 2.1.263 · this-mac · agi · Auto · Interactive · Keep moving`.
    /// `version` (per the primary agent, from `agents view --json`) is optional —
    /// it is a cached adornment, and the line reads fine without it.
    func summaryLine(project: String?, primaryVersion: String? = nil) -> String {
        var parts: [String] = []
        let agentLabels = agents.map { id -> String in
            let label = DispatchDefaults.agentLabel(id)
            if agents.count == 1, let v = primaryVersion, !v.isEmpty {
                return "\(label) \(v)"
            }
            return label
        }
        parts.append(agentLabels.joined(separator: "+"))
        parts.append(DispatchDefaults.runOnLabel(runOn))
        if let project, !project.isEmpty { parts.append(project) }
        parts.append(mode.title)
        parts.append(surface.title)
        parts.append(watchdog.title)
        return parts.joined(separator: " · ")
    }

    /// `local` reads as `this-mac`; everything else (a device name or `auto`)
    /// prints verbatim.
    static func runOnLabel(_ runOn: String) -> String {
        runOn == "local" ? "this-mac" : runOn
    }

    /// Display label for an agent id, reusing the roster's names when the id is a
    /// known harness. Kept here (not only in LocalState) so the summary line is
    /// pure and the self-test does not touch the roster env.
    static func agentLabel(_ id: String) -> String {
        LocalState.agentLabel(id)
    }
}

// MARK: - Pending-launch registry

/// A launch the palette fired but has not yet seen come back on the feed. It
/// shows as a `launching` placeholder row so the operator sees the dispatch
/// took, and it is resolved when a matching feed row appears — keyed by the
/// minted session id for Claude (the id rides `--session-id`, exec.ts:1181), or
/// by `--name` for the harnesses that coin their own id until the
/// `@@AGENTS_SESSION_ID <id>@@` stdout marker resolves it
/// (session-marker.ts:21-34). A placeholder with no matching row after
/// `ttlMs` expires as "did not start".
///
/// The matching + expiry are PURE static functions over the placeholder set and
/// the current feed rows, and `LaunchPlaceholders` is the pure registry that
/// folds them into a row map + diff, so the self-tests drive both with a decoded
/// fixture and no FeedStream. FeedStream owns ONE `LaunchPlaceholders` behind
/// its `registerPlaceholder` / `failPlaceholder` API and merges its rows into
/// the rows it publishes, which is what lets the palette's pulse strip and the
/// Sessions window render a placeholder with no wiring of their own.
struct PendingLaunch: Equatable {
    /// The key the feed row is expected to carry: a session id (byUuid) or a
    /// `--name` slug.
    let key: String
    /// True when `key` is a minted session id (Claude); false when it is a
    /// `--name` to match until the harness coins its id.
    let byUuid: Bool
    let agent: String
    /// The run's `--name` slug, always recorded so a name match works even for
    /// the Claude case once the row surfaces before its id.
    let name: String
    /// The project the palette dispatched under, so the placeholder row is
    /// attributed the way the real row will be (`SessionRow.project`) and the
    /// pulse strip counts it. Nil on the no-definitions path.
    let project: String?
    /// The narrowed working directory, when the dispatch used `--cwd`.
    let cwd: String?
    let launchedAtMs: Double
    /// The tail of the child's stderr, filled when the launch failed — shown with
    /// "did not start" when the placeholder expires.
    var stderrTail: String?

    /// Does `row` fulfil this pending launch? A Claude launch matches on its
    /// minted session id; any launch also matches on its `--name`, which is what
    /// resolves a harness that coined its own id.
    func isFulfilled(by row: SessionRow) -> Bool {
        if byUuid, let sid = row.sessionId, !sid.isEmpty, sid == key { return true }
        if let rowName = row.name, !rowName.isEmpty, rowName == name { return true }
        return false
    }

    /// The rowKey the placeholder occupies in the published rows map. Namespaced
    /// so it can never collide with a real `<device>/<session>` key.
    var rowKey: String { PendingLaunches.rowKeyPrefix + key }

    /// The synthetic feed row for this launch: phase `launching`, the harness as
    /// `kind`, the `--name` slug as the title, and the project it was dispatched
    /// under, so every consumer of `FeedStream.rows` renders it like a real row
    /// that has not reported yet. The session id rides only on a uuid-keyed
    /// launch (a name-keyed one has no id until the harness coins it).
    var placeholderRow: SessionRow {
        SessionRow(rowKey: rowKey,
                   sessionId: byUuid ? key : nil,
                   name: name,
                   title: name,
                   project: project,
                   cwd: cwd,
                   kind: agent,
                   phase: PendingLaunches.launchingPhase,
                   status: PendingLaunches.launchingPhase,
                   startedAtMs: launchedAtMs,
                   lastActivityMs: launchedAtMs)
    }
}

enum PendingLaunches {
    /// The default lifetime of a placeholder before it reads "did not start".
    static let defaultTTLMs: Double = 60_000
    /// The `phase` a placeholder row carries — distinct from every feed bucket
    /// (running | waiting | failed | done | idle) so a consumer can style it.
    static let launchingPhase = "launching"
    /// rowKey namespace for placeholder rows.
    static let rowKeyPrefix = "launching/"

    /// The keys of placeholders that a feed row now fulfils — remove these.
    static func resolvedKeys(_ pending: [PendingLaunch], rows: [SessionRow]) -> Set<String> {
        var out = Set<String>()
        for p in pending where rows.contains(where: { p.isFulfilled(by: $0) }) {
            out.insert(p.key)
        }
        return out
    }

    /// The keys of placeholders older than `ttlMs` with no fulfilling row — these
    /// expire as "did not start".
    static func expiredKeys(_ pending: [PendingLaunch], rows: [SessionRow],
                            now: Double, ttlMs: Double = defaultTTLMs) -> Set<String> {
        let resolved = resolvedKeys(pending, rows: rows)
        var out = Set<String>()
        for p in pending where !resolved.contains(p.key) && (now - p.launchedAtMs) >= ttlMs {
            out.insert(p.key)
        }
        return out
    }

    /// Human line for an expired placeholder — "did not start" plus the stderr
    /// tail when one was captured.
    static func expiredMessage(_ p: PendingLaunch) -> String {
        let head = "\(DispatchDefaults.agentLabel(p.agent)) did not start"
        guard let tail = p.stderrTail?.trimmingCharacters(in: .whitespacesAndNewlines),
              !tail.isEmpty else { return head }
        return "\(head): \(tail)"
    }
}

/// The pure placeholder registry FeedStream wraps. Holds the unresolved
/// launches, projects them as `launching` rows, and reconciles them against the
/// REAL feed rows (never against its own rows — a uuid placeholder would
/// otherwise fulfil itself). Every mutation returns the `FeedDiff` FeedStream
/// forwards to its observers, in the same rowKey vocabulary as real rows.
struct LaunchPlaceholders: Equatable {
    private(set) var pending: [PendingLaunch] = []

    /// Placeholder rows keyed by their namespaced rowKey, for merging into the
    /// published rows map.
    var rows: [String: SessionRow] {
        var out: [String: SessionRow] = [:]
        for p in pending { out[p.rowKey] = p.placeholderRow }
        return out
    }

    /// Register a launch. Re-registering a key replaces the earlier entry (a
    /// retry of the same `--name`) rather than duplicating its row.
    mutating func register(_ launch: PendingLaunch) -> FeedDiff {
        pending.removeAll { $0.key == launch.key }
        pending.append(launch)
        var diff = FeedDiff()
        diff.upserted.insert(launch.rowKey)
        return diff
    }

    /// The launch's child exited non-zero before its row arrived: attach the
    /// stderr tail and expire it now — waiting out the ttl would only delay the
    /// "did not start" the operator needs. A key that already resolved (or
    /// expired) is a no-op. Returns the expired launch for the notification.
    mutating func fail(key: String, stderrTail: String) -> (diff: FeedDiff, expired: PendingLaunch?) {
        guard let idx = pending.firstIndex(where: { $0.key == key }) else { return (FeedDiff(), nil) }
        var launch = pending.remove(at: idx)
        launch.stderrTail = stderrTail
        var diff = FeedDiff()
        diff.removed.insert(launch.rowKey)
        return (diff, launch)
    }

    /// Drop every placeholder a real row now fulfils, and expire the ones past
    /// the ttl with no row. Returns the diff plus the expired launches (the
    /// caller notifies "did not start" for each).
    mutating func reconcile(realRows: [SessionRow], now: Double,
                            ttlMs: Double = PendingLaunches.defaultTTLMs)
        -> (diff: FeedDiff, expired: [PendingLaunch]) {
        guard !pending.isEmpty else { return (FeedDiff(), []) }
        let resolved = PendingLaunches.resolvedKeys(pending, rows: realRows)
        let expiredKeys = PendingLaunches.expiredKeys(pending, rows: realRows, now: now, ttlMs: ttlMs)
        var diff = FeedDiff()
        var expired: [PendingLaunch] = []
        for p in pending where resolved.contains(p.key) || expiredKeys.contains(p.key) {
            diff.removed.insert(p.rowKey)
            if expiredKeys.contains(p.key) { expired.append(p) }
        }
        pending.removeAll { resolved.contains($0.key) || expiredKeys.contains($0.key) }
        return (diff, expired)
    }
}
