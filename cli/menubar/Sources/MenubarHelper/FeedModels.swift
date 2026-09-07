import Foundation

// Data-layer models + pure reducer for the live-session feed (PHNX-4002, Track B).
//
// This file holds the decode-only Swift mirrors of the `agents feed watch --json`
// envelope contract and a PURE state reducer (`FeedState`) that the streaming
// owner (`FeedStream`) and the headless self-test both drive. Keeping the reducer
// free of processes, clocks (injectable `now`), and AppKit is what lets
// `MENUBAR_FEED_TEST=1` replay a fixture and assert row counts, attention keys,
// and reset-on-gap without spawning anything.
//
// The envelope keys are pinned against the TypeScript source, not memory:
//   - `FeedWatchEnvelope` in cli/src/lib/feed/watch.ts:17-30 — the `v`/`type`/
//     `streamId`/`sequence`/`scope` base plus the per-type bodies
//     (`reset` carries `capturedAt`/`agents`/`attention`; `agent.upsert` carries
//     `rowKey`/`agent`; `agent.remove`/`attention.remove` carry `rowKey`;
//     `attention.upsert` carries `rowKey`/`attention`; `activity.append` carries
//     `event`; `scope` carries `capturedAt`/`status`/`reason?`; `heartbeat`
//     carries `capturedAt`).
//   - `SessionWatchRow` in cli/src/lib/session/remote/watch.ts:36-49 (extends
//     `ActiveSession`, cli/src/lib/session/active.ts:315-480, adding `rowKey`,
//     `sourceDevice`, `previous`, `resumable`).
//   - `AttentionItem` in cli/src/lib/feed/attention.ts:67-92.
//   - `ActivityEvent` — the `event` payload (cli/src/lib/feed/activity.ts),
//     verified against captured `activity.append` lines.
//
// Every field is optional and unknown keys are ignored: the helper and the
// on-PATH `agents` CLI release independently, so version skew between them is
// routine (the same rule the existing Models.swift decoders carry).

// MARK: - Session row

/// One live/previous session row as it rides the feed stream. A decode-only
/// mirror of `SessionWatchRow`; only the fields a native surface renders are
/// kept, and each is optional so an older or newer producer still decodes.
struct SessionRow: Decodable, Equatable {
    /// Stable, opaque identity within one device scope — the `rows` map key.
    let rowKey: String?
    /// Device scope that produced the row (`toSessionWatchRow(scope, …)`).
    let sourceDevice: String?
    let sessionId: String?
    /// A `/rename` or harness-set label; wins the title ladder.
    let label: String?
    /// Durable `agents run --name` handle.
    let name: String?
    let title: String?
    let topic: String?
    let project: String?
    let cwd: String?
    /// Terminal/host app for the row (`code`, `iterm`, `tmux`, …).
    let host: String?
    /// Host device the process runs on.
    let machine: String?
    /// Host process (claude/codex/…) — the harness family.
    let kind: String?
    /// Where the session runs (`ActiveContext` + the stream's `recent`):
    /// terminal | teams | cloud | headless | recent. The CLI's reply-rail verdict
    /// (`replyCapabilityForSession`, cli/src/lib/feed/attention.ts) keys on this
    /// plus `host`, and the card's no-block fallback mirrors that exact ladder.
    let context: String?
    /// Team a teammate row belongs to (`context == "teams"`), with its member id.
    let teamName: String?
    let agentId: String?
    /// Cloud task id for a `context == "cloud"` row — such rows carry no
    /// `sessionId`, so this is the `agents cloud message` target.
    let cloudTaskId: String?
    /// Custom profile name when launched via `agents run <profile>`.
    let harness: String?
    /// Coarse lifecycle bucket: running | waiting | failed | done | idle.
    let phase: String?
    /// Raw live status (running | idle | closed | crashed | …).
    let status: String?
    /// Inferred activity: working | waiting_input | idle.
    let activity: String?
    let awaitingReason: String?
    let question: SessionQuestion?
    let todos: TodoProgress?
    let timeline: TimelineSummary?
    let lastAgentLine: String?
    let preview: String?
    let files: SessionFilesRef?
    let request: SessionRequestRef?
    let pr: PullRequestRef?
    let ticket: TicketRef?
    let subAgentCount: Int?
    let pidCount: Int?
    let spawnedTeam: String?
    let startedAtMs: Double?
    let lastActivityMs: Double?
    let tokPerSec: Double?
    let version: String?
    let account: String?
    /// Durable history row kept on the stream under a distinct identity.
    let previous: Bool?
    let resumable: Bool?

    var isPrevious: Bool { previous ?? false }

    /// Explicit initializer (every field defaults to nil) so a synthetic row —
    /// the dispatch placeholder — and a crafted test row can be built without
    /// round-tripping JSON. Decoding still uses the synthesized `init(from:)`.
    init(rowKey: String? = nil, sourceDevice: String? = nil, sessionId: String? = nil,
         label: String? = nil, name: String? = nil, title: String? = nil, topic: String? = nil,
         project: String? = nil, cwd: String? = nil, host: String? = nil, machine: String? = nil,
         kind: String? = nil, harness: String? = nil, phase: String? = nil, status: String? = nil,
         activity: String? = nil, awaitingReason: String? = nil, question: SessionQuestion? = nil,
         todos: TodoProgress? = nil, timeline: TimelineSummary? = nil, lastAgentLine: String? = nil,
         preview: String? = nil, files: SessionFilesRef? = nil, request: SessionRequestRef? = nil,
         pr: PullRequestRef? = nil, ticket: TicketRef? = nil, subAgentCount: Int? = nil,
         pidCount: Int? = nil, spawnedTeam: String? = nil, startedAtMs: Double? = nil,
         lastActivityMs: Double? = nil, tokPerSec: Double? = nil, version: String? = nil,
         account: String? = nil, previous: Bool? = nil, resumable: Bool? = nil) {
        self.rowKey = rowKey; self.sourceDevice = sourceDevice; self.sessionId = sessionId
        self.label = label; self.name = name; self.title = title; self.topic = topic
        self.project = project; self.cwd = cwd; self.host = host; self.machine = machine
        self.kind = kind; self.harness = harness; self.phase = phase; self.status = status
        self.activity = activity; self.awaitingReason = awaitingReason; self.question = question
        self.todos = todos; self.timeline = timeline; self.lastAgentLine = lastAgentLine
        self.preview = preview; self.files = files; self.request = request
        self.pr = pr; self.ticket = ticket; self.subAgentCount = subAgentCount
        self.pidCount = pidCount; self.spawnedTeam = spawnedTeam; self.startedAtMs = startedAtMs
        self.lastActivityMs = lastActivityMs; self.tokPerSec = tokPerSec; self.version = version
        self.account = account; self.previous = previous; self.resumable = resumable
    }
}

/// The structured decision an agent is waiting on. Mirrors the feed's
/// `BlockQuestion` (cli/src/lib/feed/feed.ts) / `StructuredQuestion` shapes.
struct SessionQuestion: Decodable, Equatable {
    let text: String?
    let header: String?
    let reason: String?
    let multiSelect: Bool?
    let options: [QuestionOption]?
}

struct QuestionOption: Decodable, Equatable {
    let label: String?
    let description: String?
}

/// Live plan progress from the latest `TodoWrite` (`TodoProgress`,
/// cli/src/lib/session/types.ts:179). Only the tally + live step are kept.
struct TodoProgress: Decodable, Equatable {
    let done: Int?
    let total: Int?
    let activeForm: String?
}

/// Bounded projection of a session's timeline (`SessionTimeline`,
/// cli/src/lib/session/types.ts:264). The full step list belongs to track C;
/// the data layer keeps the totals plus the single latest step so a row can
/// show "what it is doing" without retaining history.
struct TimelineSummary: Decodable, Equatable {
    let tools: Int?
    let failed: Int?
    let blocked: Int?
    let spanMs: Double?
    /// ready | partial | unavailable.
    let state: String?
    let reason: String?
    let steps: [TimelineStep]?

    /// The newest narrated step, when present — "last step + tool" per the brief.
    var latestStep: TimelineStep? { steps?.last }
}

struct TimelineStep: Decodable, Equatable {
    let text: String?
    let at: String?
    let live: Bool?
    /// Harness label of the running tool on a live step (the now-line).
    let now: String?
}

/// Files a session changed (`SessionFiles`, cli/src/lib/session/types.ts:311).
/// Only the total + source ride a row; the change list is track C's.
struct SessionFilesRef: Decodable, Equatable {
    let total: Int?
    /// harness | tools.
    let source: String?
}

/// The session's operative request (`SessionRequest`,
/// cli/src/lib/session/types.ts). Prose + a headline; never rewritten.
struct SessionRequestRef: Decodable, Equatable {
    let kind: String?
    let text: String?
    let headline: String?
    let turns: Int?
}

/// A PR detected on the session. `DetectedPr` (cli/src/lib/session/state.ts:59)
/// carries `url`/`number`; the feed's `pullRequest` status can add state/review
/// fields, all optional so either producer decodes.
struct PullRequestRef: Decodable, Equatable {
    let url: String?
    let number: Int?
    let state: String?
    let isDraft: Bool?
    let reviewDecision: String?
    let mergeable: String?
}

/// Tracker ticket (`DetectedTicket`, cli/src/lib/session/state.ts:70).
struct TicketRef: Decodable, Equatable {
    let id: String?
    let url: String?
}

// MARK: - Attention

/// The canonical operator-facing attention record — one reconciled thing that
/// needs a human. Decode-only mirror of `AttentionItem`
/// (cli/src/lib/feed/attention.ts:67-92). `openedAt` is the ISO stamp the ask
/// opened (the brief's `since`).
struct AttentionItem: Decodable, Equatable {
    /// Stable identity: `host/session/generation`.
    let key: String
    let sessionId: String
    let mailboxId: String?
    let host: String?
    let project: String?
    /// question | permission | plan_review | declared | failure | stall | review.
    let kind: String
    let source: String?
    let state: String?
    /// ISO-8601 timestamp the ask opened (the brief's `since`).
    let openedAt: String?
    let question: SessionQuestion?
    let choices: [AttentionChoice]?
    /// terminal | tmux | cloud | team | none.
    let replyCapability: String?
    let safeDefault: String?
    let fingerprint: String?

    /// Brief alias: the moment the ask opened.
    var since: String? { openedAt }
}

/// One answerable choice on an attention item. Mirrors `AttentionChoice`
/// (cli/src/lib/feed/attention.ts:57-60): a `BlockOption` (`label`/`description`)
/// plus a stable echo `id` and the optional harness-native `deliveryKey`.
struct AttentionChoice: Decodable, Equatable {
    let id: String?
    let label: String?
    let description: String?
    let deliveryKey: String?
}

// MARK: - Activity

/// One appended activity line (`activity.append` → `event`). The stream retains
/// only the LATEST line per session (no history array), so only the fields a
/// row-level "latest activity" needs are decoded. Verified against captured
/// `activity.append` output (keys: `v`, `ts`, `event`, `sessionId`, `host`,
/// `agent`, `tool`, `detail`, `category`, …).
struct ActivityEvent: Decodable, Equatable {
    let ts: String?
    /// The activity kind, e.g. `bash.executed`, `pr.opened`.
    let event: String?
    let sessionId: String?
    let host: String?
    let agent: String?
    let tool: String?
    let detail: String?
    let category: String?
}

// MARK: - Envelope

/// A decoded `agents feed watch --json` line. The polymorphic body is routed on
/// `type`; the common `streamId`/`sequence`/`scope` ride every case. Peer events
/// carry extra `peerStreamId`/`peerSequence` fields (the fleet coordinator
/// re-emits them under its own monotonic `streamId`/`sequence`) which are
/// ignored here — the coordinator stream is the one the client tracks.
enum FeedEnvelope: Equatable {
    case reset(scope: String, streamId: String, sequence: Int, capturedAtMs: Double?, agents: [SessionRow], attention: [AttentionItem])
    case agentUpsert(scope: String, streamId: String, sequence: Int, rowKey: String, agent: SessionRow)
    case agentRemove(scope: String, streamId: String, sequence: Int, rowKey: String)
    case attentionUpsert(scope: String, streamId: String, sequence: Int, rowKey: String, attention: AttentionItem)
    case attentionRemove(scope: String, streamId: String, sequence: Int, rowKey: String)
    case activityAppend(scope: String, streamId: String, sequence: Int, event: ActivityEvent)
    case scope(scope: String, streamId: String, sequence: Int, capturedAtMs: Double?, status: String, reason: String?)
    case heartbeat(scope: String, streamId: String, sequence: Int, capturedAtMs: Double?)

    var streamId: String {
        switch self {
        case let .reset(_, s, _, _, _, _), let .agentUpsert(_, s, _, _, _),
             let .agentRemove(_, s, _, _), let .attentionUpsert(_, s, _, _, _),
             let .attentionRemove(_, s, _, _), let .activityAppend(_, s, _, _),
             let .scope(_, s, _, _, _, _), let .heartbeat(_, s, _, _):
            return s
        }
    }

    var sequence: Int {
        switch self {
        case let .reset(_, _, n, _, _, _), let .agentUpsert(_, _, n, _, _),
             let .agentRemove(_, _, n, _), let .attentionUpsert(_, _, n, _, _),
             let .attentionRemove(_, _, n, _), let .activityAppend(_, _, n, _),
             let .scope(_, _, n, _, _, _), let .heartbeat(_, _, n, _):
            return n
        }
    }

    var scope: String {
        switch self {
        case let .reset(sc, _, _, _, _, _), let .agentUpsert(sc, _, _, _, _),
             let .agentRemove(sc, _, _, _), let .attentionUpsert(sc, _, _, _, _),
             let .attentionRemove(sc, _, _, _), let .activityAppend(sc, _, _, _),
             let .scope(sc, _, _, _, _, _), let .heartbeat(sc, _, _, _):
            return sc
        }
    }

    var capturedAtMs: Double? {
        switch self {
        case let .reset(_, _, _, ms, _, _), let .scope(_, _, _, ms, _, _), let .heartbeat(_, _, _, ms):
            return ms
        default:
            return nil
        }
    }

    /// Decode one NDJSON line. Returns nil for a blank line, a malformed line, or
    /// an unknown `type` — a bad line is skipped, never thrown (the SES-1/SES-3
    /// "skip a malformed line" rule the CLI reader also holds).
    static func decode(_ line: String) -> FeedEnvelope? {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String,
              let streamId = obj["streamId"] as? String,
              let scopeName = obj["scope"] as? String else { return nil }
        let sequence: Int
        if let n = obj["sequence"] as? Int { sequence = n }
        else if let d = obj["sequence"] as? Double { sequence = Int(d) }
        else { return nil }
        let capturedAt = (obj["capturedAt"] as? Double) ?? (obj["capturedAt"] as? Int).map(Double.init)

        let decoder = JSONDecoder()
        func child<T: Decodable>(_ key: String, _ type: T.Type) -> T? {
            guard let value = obj[key], let d = try? JSONSerialization.data(withJSONObject: value) else { return nil }
            return try? decoder.decode(T.self, from: d)
        }

        switch type {
        case "reset":
            return .reset(scope: scopeName, streamId: streamId, sequence: sequence, capturedAtMs: capturedAt,
                          agents: child("agents", [SessionRow].self) ?? [],
                          attention: child("attention", [AttentionItem].self) ?? [])
        case "agent.upsert":
            guard let rowKey = obj["rowKey"] as? String, let agent = child("agent", SessionRow.self) else { return nil }
            return .agentUpsert(scope: scopeName, streamId: streamId, sequence: sequence, rowKey: rowKey, agent: agent)
        case "agent.remove":
            guard let rowKey = obj["rowKey"] as? String else { return nil }
            return .agentRemove(scope: scopeName, streamId: streamId, sequence: sequence, rowKey: rowKey)
        case "attention.upsert":
            guard let rowKey = obj["rowKey"] as? String, let item = child("attention", AttentionItem.self) else { return nil }
            return .attentionUpsert(scope: scopeName, streamId: streamId, sequence: sequence, rowKey: rowKey, attention: item)
        case "attention.remove":
            guard let rowKey = obj["rowKey"] as? String else { return nil }
            return .attentionRemove(scope: scopeName, streamId: streamId, sequence: sequence, rowKey: rowKey)
        case "activity.append":
            guard let event = child("event", ActivityEvent.self) else { return nil }
            return .activityAppend(scope: scopeName, streamId: streamId, sequence: sequence, event: event)
        case "scope":
            let status = (obj["status"] as? String) ?? "available"
            return .scope(scope: scopeName, streamId: streamId, sequence: sequence, capturedAtMs: capturedAt,
                          status: status, reason: obj["reason"] as? String)
        case "heartbeat":
            return .heartbeat(scope: scopeName, streamId: streamId, sequence: sequence, capturedAtMs: capturedAt)
        default:
            return nil
        }
    }
}

// MARK: - Scope status + stream health

/// Per-device availability, from the `scope` envelope. `unavailable` keeps the
/// device's rows and marks it stale rather than erasing them.
enum FeedScopeStatus: String, Equatable {
    case available
    case unavailable
}

/// Health of the single `feed watch` child, exposed to the UI.
enum StreamHealth: Equatable {
    /// The child has been spawned but no line has arrived yet.
    case starting
    /// A line arrived within the freshness window.
    case live
    /// No line for longer than the stale window; rows are kept but shown stale.
    case stale(since: Date)
    /// The child exited and a respawn is scheduled (`attempt` = consecutive failures).
    case reconnecting(attempt: Int)
    /// Too many consecutive failures; respawning is paused until `restart()`.
    case breakerTripped
    /// `stop()` was called; nothing is running.
    case stopped
}

// MARK: - Diff

/// What changed on the reducer in one `apply`. `upserted`/`removed` are rowKeys;
/// `attentionChanged` are sessionIds (the keys of `FeedState.attention`).
struct FeedDiff: Equatable {
    var upserted: Set<String> = []
    var removed: Set<String> = []
    var attentionChanged: Set<String> = []
    var isEmpty: Bool { upserted.isEmpty && removed.isEmpty && attentionChanged.isEmpty }
}

// MARK: - Pure reducer

/// The pure feed state machine. `apply` folds one envelope in and returns the
/// diff; it never touches a process, the filesystem, or AppKit, and takes `now`
/// as a parameter so a test controls the clock.
///
/// Multi-device semantics: the fleet coordinator forwards each device's events
/// (including that device's own `reset`) under ONE monotonic coordinator stream,
/// so the state is a UNION across `scope`s and a `reset` for scope X replaces
/// only X's slice (tracked by `rowScope`), never the whole map.
///
/// Reconnect semantics: a new `streamId` (the child was respawned → a fresh
/// coordinator `FeedWatchState`) or a `sequence` gap drops every row and waits
/// for the next `reset` to rebuild (`awaitingReset`); non-reset events are
/// ignored in that window so a partial post-gap view is never shown.
struct FeedState {
    private(set) var rows: [String: SessionRow] = [:]           // rowKey -> row
    private(set) var attention: [String: AttentionItem] = [:]   // sessionId -> item
    private(set) var deviceHeartbeat: [String: Date] = [:]      // scope -> last-seen
    private(set) var scopeStatus: [String: FeedScopeStatus] = [:]
    /// Latest activity line per session — NO history retention beyond the last line.
    private(set) var latestActivity: [String: ActivityEvent] = [:]
    private(set) var streamId: String?
    private(set) var lastSequence: Int?
    private(set) var lastEventAt: Date?
    private(set) var awaitingReset = false
    /// Total resets folded — a diagnostic the smoke/self-test reads.
    private(set) var resetCount = 0

    private var rowScope: [String: String] = [:]         // rowKey -> scope
    private var attnRowToSession: [String: String] = [:] // attention rowKey -> sessionId

    mutating func apply(_ env: FeedEnvelope, now: Date = Date()) -> FeedDiff {
        var diff = FeedDiff()
        lastEventAt = now

        // Stream identity + gap detection.
        if let current = streamId {
            if env.streamId != current {
                diff.removed.formUnion(rows.keys)
                clearRows()
                streamId = env.streamId
                awaitingReset = true
            } else if let last = lastSequence, env.sequence != last + 1 {
                diff.removed.formUnion(rows.keys)
                clearRows()
                awaitingReset = true
            }
        } else {
            streamId = env.streamId
        }
        lastSequence = env.sequence

        // Device liveness rides every envelope carrying a scope.
        if let ms = env.capturedAtMs {
            deviceHeartbeat[env.scope] = Date(timeIntervalSince1970: ms / 1000)
        } else {
            deviceHeartbeat[env.scope] = now
        }

        switch env {
        case let .reset(scope, _, _, _, agents, attns):
            awaitingReset = false
            resetCount += 1
            let survivingSessions = Set(agents.compactMap { $0.sessionId })
            // Replace this scope's slice only.
            for (rowKey, s) in rowScope where s == scope {
                let goneSession = rows[rowKey]?.sessionId
                if rows.removeValue(forKey: rowKey) != nil { diff.removed.insert(rowKey) }
                rowScope[rowKey] = nil
                // Drop the retained activity line for a session that did NOT
                // survive this reset, so latestActivity cannot grow without bound
                // across a long-lived connection (a session kept in the new slice
                // keeps its line).
                if let goneSession, !survivingSessions.contains(goneSession) {
                    latestActivity[goneSession] = nil
                }
                if let sid = attnRowToSession.removeValue(forKey: rowKey),
                   attention.removeValue(forKey: sid) != nil {
                    diff.attentionChanged.insert(sid)
                }
            }
            for row in agents {
                guard let rowKey = row.rowKey else { continue }
                rows[rowKey] = row
                rowScope[rowKey] = scope
                diff.removed.remove(rowKey) // a re-added key is a net upsert
                diff.upserted.insert(rowKey)
            }
            for item in attns {
                attention[item.sessionId] = item
                diff.attentionChanged.insert(item.sessionId)
                if let rowKey = agents.first(where: { $0.sessionId == item.sessionId })?.rowKey {
                    attnRowToSession[rowKey] = item.sessionId
                }
            }
            scopeStatus[scope] = .available

        case let .agentUpsert(scope, _, _, rowKey, agent):
            if awaitingReset { break }
            rows[rowKey] = agent
            rowScope[rowKey] = scope
            diff.upserted.insert(rowKey)

        case let .agentRemove(_, _, _, rowKey):
            if awaitingReset { break }
            let goneSession = rows[rowKey]?.sessionId
            if rows.removeValue(forKey: rowKey) != nil { diff.removed.insert(rowKey) }
            rowScope[rowKey] = nil
            // The row is gone; drop its retained activity line too (one row per
            // session under the feed's per-device ownership) so latestActivity
            // does not leak an entry for every finished session.
            if let goneSession { latestActivity[goneSession] = nil }
            if let sid = attnRowToSession.removeValue(forKey: rowKey),
               attention.removeValue(forKey: sid) != nil {
                diff.attentionChanged.insert(sid)
            }

        case let .attentionUpsert(_, _, _, rowKey, item):
            if awaitingReset { break }
            attention[item.sessionId] = item
            attnRowToSession[rowKey] = item.sessionId
            diff.attentionChanged.insert(item.sessionId)

        case let .attentionRemove(_, _, _, rowKey):
            if awaitingReset { break }
            if let sid = attnRowToSession.removeValue(forKey: rowKey),
               attention.removeValue(forKey: sid) != nil {
                diff.attentionChanged.insert(sid)
            }

        case let .activityAppend(_, _, _, event):
            if awaitingReset { break }
            guard let sid = event.sessionId else { break }
            latestActivity[sid] = event
            // Signal the owning row changed so observers re-render its latest line.
            if let rowKey = rows.first(where: { $0.value.sessionId == sid })?.key {
                diff.upserted.insert(rowKey)
            }

        case let .scope(scope, _, _, _, status, _):
            scopeStatus[scope] = (status == "unavailable") ? .unavailable : .available
            // Rows for the scope are kept; only the device is marked.

        case .heartbeat:
            break
        }
        return diff
    }

    private mutating func clearRows() {
        rows.removeAll()
        attention.removeAll()
        rowScope.removeAll()
        attnRowToSession.removeAll()
        latestActivity.removeAll()
        // deviceHeartbeat / scopeStatus survive a reconnect: a device we have
        // heard from stays known even while the coordinator restarts.
    }
}

// MARK: - Respawn policy (backoff + circuit breaker)

/// The pure spawn cadence for the feed child: exponential backoff from 1s
/// doubling to a 30s cap (never faster than 1/s), and a circuit breaker after
/// 10 consecutive failures. A healthy connection resets both.
struct RespawnPolicy {
    let baseDelay: TimeInterval = 1
    let maxDelay: TimeInterval = 30
    let breakerThreshold = 10
    private(set) var consecutiveFailures = 0

    var isTripped: Bool { consecutiveFailures >= breakerThreshold }

    /// Backoff for the Nth consecutive attempt (attempt 1 = 1s): `2^(n-1)`
    /// clamped to `[baseDelay, maxDelay]`.
    func delay(forAttempt attempt: Int) -> TimeInterval {
        guard attempt > 0 else { return baseDelay }
        let raw = baseDelay * pow(2, Double(attempt - 1))
        return min(maxDelay, max(baseDelay, raw))
    }

    mutating func recordFailure() { consecutiveFailures += 1 }
    mutating func recordHealthy() { consecutiveFailures = 0 }
    mutating func reset() { consecutiveFailures = 0 }
}
