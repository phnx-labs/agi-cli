import Foundation

// SessionRowModel — the ONE derivation from a live `SessionRow` (+ its optional
// `AttentionItem`) to what a surface renders (PHNX-4003, Track C).
//
// Both the persistent Sessions window and the dropdown RECENT section consume
// `present(_:attention:now:)`; there is no second place that decides a status
// color, a PR chip, a phase line, or a progress tally. Keeping it a pure function
// over the decode-only feed models (no AppKit, no clock except the injected
// `now`) is what lets `MENUBAR_ROWMODEL_TEST=1` assert every branch headless.
//
// The status ranking follows the repo's "rank by progress, not liveness" rule
// (root AGENTS.md): a session that has STOPPED progressing (needs you / idle /
// failed) outranks a healthy running one, so the window and dropdown surface
// not-progressing work first and fold the healthy set.

// MARK: - Presentation model

/// The four operator-facing status colors. Mapped to NSColor by the UI layer so
/// this stays AppKit-free and unit-testable headless.
enum StatusColor: Equatable {
    case working   // green  — phase running/working, nothing needed
    case needsYou  // yellow — a question/permission/plan_review, or phase waiting
    case idle      // red    — idle / stall / failure / failed (highest-risk)
    case done      // grey   — terminal, safe to fold away
}

/// The PR chip state derived from the row's PR status. The UI renders label +
/// color; the model decides which state applies. `number` rides so the chip can
/// read `PR #123`.
enum PRChip: Equatable {
    case merged(Int?)         // purple — "PR #n · merged ✓"
    case approved(Int?)       // green  — "PR #n · checks ✓ · approved"
    case checksFailed(Int?)   // red    — "PR #n · checks ✗"
    case checksRunning(Int?)  // grey   — "PR #n · checks running"
    case draft(Int?)          // dimmed — "PR #n · draft"
    case open(Int?)           // default — "PR #n"

    var number: Int? {
        switch self {
        case let .merged(n), let .approved(n), let .checksFailed(n),
             let .checksRunning(n), let .draft(n), let .open(n):
            return n
        }
    }

    /// The rendered chip text.
    var text: String {
        let head = number.map { "PR #\($0)" } ?? "PR"
        switch self {
        case .merged:        return "\(head) · merged ✓"
        case .approved:      return "\(head) · checks ✓ · approved"
        case .checksFailed:  return "\(head) · checks ✗"
        case .checksRunning: return "\(head) · checks running"
        case .draft:         return "\(head) · draft"
        case .open:          return head
        }
    }
}

/// The derived, render-ready projection of one session row. Carries only what a
/// surface draws; the raw millis ride so the window can sort/group without a
/// second derivation.
struct RowPresentation: Equatable {
    let title: String
    let status: StatusColor
    let phaseText: String
    let progress: (done: Int, total: Int)?
    let latestAction: String?
    let prChip: PRChip?
    let subagents: Int?
    let groupKey: String
    /// Sort inputs, surfaced so the list can order without re-deriving.
    let startedAtMs: Double?
    let lastActivityMs: Double?

    static func == (a: RowPresentation, b: RowPresentation) -> Bool {
        a.title == b.title && a.status == b.status && a.phaseText == b.phaseText
            && a.progress?.done == b.progress?.done && a.progress?.total == b.progress?.total
            && a.latestAction == b.latestAction && a.prChip == b.prChip
            && a.subagents == b.subagents && a.groupKey == b.groupKey
            && a.startedAtMs == b.startedAtMs && a.lastActivityMs == b.lastActivityMs
    }
}

// MARK: - Derivation

enum SessionRowModel {
    /// The one derivation. `attention` is the reconciled item for this session (if
    /// any); `now` is injected so a test controls relative time.
    static func present(_ row: SessionRow, attention: AttentionItem?, now: Date = Date()) -> RowPresentation {
        let status = statusColor(row, attention: attention)
        return RowPresentation(
            title: title(row),
            status: status,
            phaseText: phaseText(row, attention: attention, status: status, now: now),
            progress: progress(row),
            latestAction: latestAction(row),
            prChip: prChip(row),
            subagents: subagents(row),
            groupKey: groupKey(row),
            startedAtMs: row.startedAtMs,
            lastActivityMs: row.lastActivityMs)
    }

    // MARK: title ladder

    static func title(_ row: SessionRow) -> String {
        for candidate in [row.label, row.name, row.title, row.topic] {
            if let c = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !c.isEmpty { return c }
        }
        if let sid = row.sessionId, !sid.isEmpty { return String(sid.prefix(8)) }
        return "session"
    }

    // MARK: status color

    /// green = phase running/working; yellow = attention question/permission/
    /// plan_review OR phase waiting; red = idle/stall/failure/failed; grey = done.
    /// A pending attention item beats the row's own phase — a running session that
    /// just asked a question needs you now.
    static func statusColor(_ row: SessionRow, attention: AttentionItem?) -> StatusColor {
        if let kind = attention?.kind {
            switch kind {
            case "question", "permission", "plan_review", "review", "declared":
                return .needsYou
            case "failure", "stall":
                return .idle
            default:
                break
            }
        }
        // Phase is the coarse lifecycle bucket the feed sets.
        switch row.phase {
        case "done":
            return .done
        case "failed":
            return .idle
        case "waiting":
            return .needsYou
        case "idle":
            return .idle
        case "running":
            return .working
        case PendingLaunches.launchingPhase:
            // A dispatch placeholder (PHNX-4005) is in progress, not yet working.
            return .working
        default:
            break
        }
        // Fall back to the finer live activity/status when phase is absent.
        switch row.activity {
        case "waiting_input": return .needsYou
        case "idle":          return .idle
        case "working":       return .working
        default: break
        }
        switch row.status {
        case "running":            return .working
        case "idle":               return .idle
        case "crashed", "failed":  return .idle
        case "closed", "done":     return .done
        default:                   return .working
        }
    }

    // MARK: phase text — "working · 18h · s0", "question · 13m · zion", "idle 41m · m1"

    static func phaseText(_ row: SessionRow, attention: AttentionItem?, status: StatusColor, now: Date) -> String {
        let device = deviceName(row)
        let age = ageLabel(row, now: now)
        let label = phaseLabel(row, attention: attention, status: status)

        // A red idle row folds the age into the label ("idle 41m"), then device.
        if status == .idle && (label == "idle" || label == "stall"), let age {
            return joined(["\(label) \(age)", device])
        }
        return joined([label, age, device])
    }

    /// The leading word of the phase line: the attention kind when one is pending,
    /// else the row's phase/activity bucket.
    private static func phaseLabel(_ row: SessionRow, attention: AttentionItem?, status: StatusColor) -> String {
        if let kind = attention?.kind, !kind.isEmpty {
            switch kind {
            case "plan_review": return "plan review"
            default:            return kind
            }
        }
        // Map the coarse phase/activity bucket to its display word — a "running"
        // phase reads as "working" (the green label), matching the brief.
        switch row.phase {
        case "running": return "working"
        case PendingLaunches.launchingPhase: return "launching"
        case "waiting": return "waiting"
        case "idle":    return "idle"
        case "failed":  return "failed"
        case "done":    return "done"
        default: break
        }
        switch row.activity {
        case "working":       return "working"
        case "waiting_input": return "waiting"
        case "idle":          return "idle"
        default: break
        }
        switch status {
        case .working:  return "working"
        case .needsYou: return "waiting"
        case .idle:     return "idle"
        case .done:     return "done"
        }
    }

    // MARK: progress

    static func progress(_ row: SessionRow) -> (done: Int, total: Int)? {
        guard let total = row.todos?.total, total > 0 else { return nil }
        return (done: row.todos?.done ?? 0, total: total)
    }

    // MARK: latest action — last timeline step + tool, else last agent line

    static func latestAction(_ row: SessionRow) -> String? {
        if let step = row.timeline?.latestStep,
           let text = step.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            if let now = step.now?.trimmingCharacters(in: .whitespacesAndNewlines), !now.isEmpty {
                return "\(text) · \(now)"
            }
            return text
        }
        if let line = row.lastAgentLine?.trimmingCharacters(in: .whitespacesAndNewlines), !line.isEmpty {
            return line
        }
        return nil
    }

    // MARK: PR chip

    /// Derive the chip from the row's PR status. We have `state`, `isDraft`,
    /// `reviewDecision`, and `mergeable` (GitHub's mergeable_state vocabulary) —
    /// there is no separate check-rollup field on the row, so "checks" is read off
    /// `mergeable`: clean = passing, unstable/dirty/blocked = failing, unknown/nil
    /// = still computing.
    static func prChip(_ row: SessionRow) -> PRChip? {
        guard let pr = row.pr, (pr.number != nil || pr.url != nil) else { return nil }
        let n = pr.number
        if pr.state?.lowercased() == "merged" { return .merged(n) }
        if pr.isDraft == true || pr.state?.lowercased() == "draft" { return .draft(n) }

        let mergeable = pr.mergeable?.lowercased()
        let approved = pr.reviewDecision?.uppercased() == "APPROVED"
        switch mergeable {
        case "unstable", "dirty", "blocked":
            return .checksFailed(n)
        case "unknown", .none, "":
            // No check verdict yet. If review already landed, show that.
            return approved ? .approved(n) : .checksRunning(n)
        default: // "clean", "behind", "has_hooks"
            return approved ? .approved(n) : .open(n)
        }
    }

    // MARK: subagents glyph count

    /// The count for `⑂ n`, shown when the session spawned sub-agents, holds more
    /// than one live pid, or launched a team. Nil when it is a lone process.
    static func subagents(_ row: SessionRow) -> Int? {
        if let n = row.subAgentCount, n > 0 { return n }
        if let p = row.pidCount, p > 1 { return p }
        if row.spawnedTeam?.isEmpty == false { return row.subAgentCount ?? row.pidCount ?? 1 }
        return nil
    }

    // MARK: group key — project

    static func groupKey(_ row: SessionRow) -> String {
        if let p = row.project?.trimmingCharacters(in: .whitespacesAndNewlines), !p.isEmpty { return p }
        if let cwd = row.cwd, !cwd.isEmpty {
            let base = (cwd as NSString).lastPathComponent
            if !base.isEmpty { return base }
        }
        return "other"
    }

    // MARK: helpers

    static func deviceName(_ row: SessionRow) -> String {
        if let m = row.machine?.trimmingCharacters(in: .whitespacesAndNewlines), !m.isEmpty { return m }
        if let s = row.sourceDevice?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty { return s }
        return ""
    }

    /// Relative age from the row's last activity (falling back to start): `now`,
    /// `13m`, `18h`, `2d`. Nil when the row carries no timestamp.
    static func ageLabel(_ row: SessionRow, now: Date) -> String? {
        guard let ms = row.lastActivityMs ?? row.startedAtMs else { return nil }
        let secs = now.timeIntervalSince1970 - ms / 1000
        return ageLabel(seconds: secs)
    }

    static func ageLabel(seconds: TimeInterval) -> String {
        let mins = Int(max(0, seconds) / 60)
        if mins < 1 { return "now" }
        if mins < 60 { return "\(mins)m" }
        let hours = mins / 60
        if hours < 24 { return "\(hours)h" }
        return "\(hours / 24)d"
    }

    private static func joined(_ parts: [String?]) -> String {
        parts.compactMap { $0.flatMap { $0.isEmpty ? nil : $0 } }.joined(separator: " · ")
    }
}
