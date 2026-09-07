import AppKit
import Foundation

// Track E (PHNX-4005) — the project pulse strip under the palette's project row:
// roughly where the bound project stands (milestone progress), what is running on
// it right now (live counts + NOW chips from the feed), and what makes sense next
// (NEXT UP from the ranked ticket list). Three lines, no paragraphs; every element
// is a click target.
//
// The decode model (`ProjectPulse`) is pure over `agents projects status <name>
// --json` and is a build gate (MENUBAR_PULSE_TEST). The live counts and NOW chips
// come from FeedStream.rows at render time (a projection, never a second poll),
// and NEXT UP comes from the palette's Linear cache — so the strip composes three
// already-owned sources rather than shelling anything of its own beyond the
// bounded, memoized `projects status` read.
//
// JSON shape pinned to cli/src/commands/projects.ts:853-879 (the object literal)
// and the nested types in cli/src/lib/{project-status,linear-project-counts}.ts.
// `agents projects status <name> --json` emits an ARRAY; a named lookup carries a
// single element with the full ProjectDef spread plus the rollup fields.

// MARK: - Decode model

/// The status-JSON-derived half of the pulse. The live half (running / need-you /
/// idle counts, NOW chips) is layered on from FeedStream at render time.
struct ProjectPulse: Equatable {
    let project: String
    /// Local plan checklist progress (`plan: {done,total}`).
    let plan: Progress?
    /// Linear rollup for the bound project (`linear`), when the project has a
    /// binding. Carries milestone progress and the counts the strip headlines.
    let linear: LinearCounts?
    /// Open PRs on the project's repos (`openPrs[].length`).
    let openPrCount: Int
    /// PRs merged in the reporting window (`mergedPrs`).
    let mergedPrs: Int
    /// Active agent sessions the CLI attributed to the project (`agents`).
    let agentCount: Int
    /// Latest release tag, when one exists (`latestRelease.tag`).
    let latestReleaseTag: String?

    struct Progress: Equatable {
        let done: Int
        let total: Int
        var fraction: Double { total > 0 ? Double(done) / Double(total) : 0 }
    }

    struct LinearCounts: Equatable {
        let done: Int
        let total: Int
        let inProgress: Int
        let milestones: [Milestone]
        let nextMilestone: Milestone?
        /// Open = everything not done (in progress + todo + backlog).
        var open: Int { max(0, total - done) }
    }

    struct Milestone: Equatable {
        let name: String
        let targetDate: String?
        let done: Int
        let total: Int
        let isNext: Bool
        var fraction: Double { total > 0 ? Double(done) / Double(total) : 0 }
        var percent: Int { Int((fraction * 100).rounded()) }
    }

    /// The milestone to headline: the one flagged `isNext`, else the first
    /// unfinished one, else the first.
    var headlineMilestone: Milestone? {
        guard let linear else { return nil }
        if let next = linear.nextMilestone { return next }
        if let flagged = linear.milestones.first(where: { $0.isNext }) { return flagged }
        if let unfinished = linear.milestones.first(where: { $0.done < $0.total }) { return unfinished }
        return linear.milestones.first
    }

    // MARK: Decode

    // The Codable mirror of the status element. Every field optional — the helper
    // and the on-PATH CLI release independently, and `schedule`/`latestRelease`/
    // `linear` are emitted as literal null while other sub-fields are simply
    // omitted (both decode to nil for an optional).
    private struct StatusJSON: Decodable {
        let name: String?
        let agents: Int?
        let plan: PlanJSON?
        let openPrs: [PrJSON]?
        let mergedPrs: Int?
        let latestRelease: ReleaseJSON?
        let linear: LinearJSON?

        struct PlanJSON: Decodable { let done: Int?; let total: Int? }
        struct PrJSON: Decodable { let url: String?; let number: Int? }
        struct ReleaseJSON: Decodable { let tag: String?; let publishedAt: String? }
        struct LinearJSON: Decodable {
            let done: Int?
            let total: Int?
            let inProgress: Int?
            let milestones: [MilestoneJSON]?
            let nextMilestone: MilestoneJSON?
        }
        struct MilestoneJSON: Decodable {
            let name: String?
            let targetDate: String?
            let done: Int?
            let total: Int?
            let isNext: Bool?
        }
    }

    /// Decode the `projects status --json` payload, picking the element whose name
    /// matches `project` (or the first). Returns nil only when the payload is not
    /// a decodable array of status objects.
    static func decode(_ data: Data, project: String) -> ProjectPulse? {
        guard let rows = try? JSONDecoder().decode([StatusJSON].self, from: data) else { return nil }
        let match = rows.first { $0.name == project } ?? rows.first
        guard let s = match else { return nil }
        return ProjectPulse(
            project: s.name ?? project,
            plan: s.plan.flatMap { p in
                guard let total = p.total else { return nil }
                return Progress(done: p.done ?? 0, total: total)
            },
            linear: s.linear.map { l in
                LinearCounts(
                    done: l.done ?? 0,
                    total: l.total ?? 0,
                    inProgress: l.inProgress ?? 0,
                    milestones: (l.milestones ?? []).map { Self.milestone($0) },
                    nextMilestone: l.nextMilestone.map { Self.milestone($0) })
            },
            openPrCount: s.openPrs?.count ?? 0,
            mergedPrs: s.mergedPrs ?? 0,
            agentCount: s.agents ?? 0,
            latestReleaseTag: s.latestRelease?.tag)
    }

    private static func milestone(_ m: StatusJSON.MilestoneJSON) -> Milestone {
        Milestone(name: m.name ?? "", targetDate: m.targetDate,
                  done: m.done ?? 0, total: m.total ?? 0, isNext: m.isNext ?? false)
    }
}

// MARK: - Live rollup (FeedStream-derived, pure)

/// The live half of the pulse, computed from the feed rows attributed to one
/// project. Pure over a row list so the self-test drives it with fixtures.
struct ProjectLiveRollup: Equatable {
    var running = 0
    var needYou = 0
    var idle = 0
    /// Dispatches fired from the palette that the feed has not reported yet —
    /// the `launching` placeholder rows FeedStream publishes (PHNX-4005).
    var launching = 0
    /// Up to three rows to show as NOW chips: a fresh launch first (it is the
    /// feedback for what the operator just did, and lives at most 60 s), then
    /// not-progressing (need-you, idle), then running.
    var nowRows: [SessionRow] = []

    /// True when a row belongs to `project` — matched on the row's `project`
    /// field (the CLI attributes it), case-insensitively.
    static func belongs(_ row: SessionRow, to project: String) -> Bool {
        guard let p = row.project, !p.isEmpty else { return false }
        return p.caseInsensitiveCompare(project) == .orderedSame
    }

    /// A row needs a human when it is waiting on input or has failed; it is
    /// running when working; a dispatch placeholder is launching; otherwise
    /// idle. Mirrors the feed's own buckets (SessionRow.phase / activity), kept
    /// coarse.
    static func bucket(_ row: SessionRow) -> String {
        let phase = row.phase?.lowercased() ?? ""
        let activity = row.activity?.lowercased() ?? ""
        if phase == PendingLaunches.launchingPhase { return "launching" }
        if phase == "waiting" || phase == "failed" || activity == "waiting_input" { return "need-you" }
        if phase == "running" || activity == "working" { return "running" }
        return "idle"
    }

    /// Rank for NOW ordering: a launching placeholder first (the operator's own
    /// dispatch, gone within 60 s either way), then not-progressing (need-you,
    /// then idle), then running last — the design rule that idle-but-unfinished
    /// is the highest-risk state, never buried below running (root AGENTS.md).
    private static func nowOrder(_ bucket: String) -> Int {
        switch bucket {
        case "launching": return 0
        case "need-you": return 1
        case "idle": return 2
        default: return 3
        }
    }

    static func rollup(rows: [SessionRow], project: String, nowLimit: Int = 3) -> ProjectLiveRollup {
        let mine = rows.filter { belongs($0, to: project) && !($0.isPrevious) }
        var r = ProjectLiveRollup()
        for row in mine {
            switch bucket(row) {
            case "launching": r.launching += 1
            case "need-you": r.needYou += 1
            case "running": r.running += 1
            default: r.idle += 1
            }
        }
        r.nowRows = Array(mine.sorted { a, b in
            let (ba, bb) = (nowOrder(bucket(a)), nowOrder(bucket(b)))
            if ba != bb { return ba < bb }
            return (a.lastActivityMs ?? 0) > (b.lastActivityMs ?? 0)
        }.prefix(nowLimit))
        return r
    }
}

// MARK: - View

private let kAccentPulse = NSColor(red: 0xa3/255.0, green: 0xe6/255.0, blue: 0x35/255.0, alpha: 1)

/// The compact three-line pulse strip embedded under the palette's project row.
/// Render-only: the controller orchestrates the data (it already holds the feed
/// rows and the Linear cache), computes the model + rollup + NEXT UP, and calls
/// `render`. Line 1 is milestone progress, line 2 is the live counts plus NOW
/// chips, line 3 is NEXT UP — every actionable element is a click target that
/// calls back to the controller.
final class ProjectPulseView: NSView {
    /// Click a NOW chip → take the operator to that session.
    var onOpenSession: ((SessionRow) -> Void)?
    /// Click NEXT UP (or Cmd-N) → attach the top ticket to a dispatch.
    var onAttachTicket: ((LinearTicket) -> Void)?
    /// Click the "all" affordance (or Cmd-T) → open the full ticket list.
    var onFullTicketList: (() -> Void)?

    private let milestoneLabel = NSTextField(labelWithString: "")
    private let countsLabel = NSTextField(labelWithString: "")
    private let nowRow = NSStackView()
    private let nextButton = NSButton()
    private(set) var nextTicket: LinearTicket?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        build()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    private func build() {
        translatesAutoresizingMaskIntoConstraints = false

        milestoneLabel.font = .monospacedSystemFont(ofSize: 11, weight: .medium)
        milestoneLabel.textColor = .secondaryLabelColor
        milestoneLabel.lineBreakMode = .byTruncatingTail
        milestoneLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        countsLabel.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        countsLabel.textColor = .tertiaryLabelColor

        nowRow.orientation = .horizontal
        nowRow.alignment = .centerY
        nowRow.spacing = 6

        let countsAndNow = NSStackView(views: [countsLabel, nowRow])
        countsAndNow.orientation = .horizontal
        countsAndNow.alignment = .centerY
        countsAndNow.spacing = 10

        nextButton.isBordered = false
        nextButton.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        nextButton.contentTintColor = kAccentPulse
        nextButton.alignment = .left
        nextButton.target = self
        nextButton.action = #selector(onNext(_:))
        nextButton.translatesAutoresizingMaskIntoConstraints = false
        nextButton.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let stack = NSStackView(views: [milestoneLabel, countsAndNow, nextButton])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    /// Render the strip for one project. Any of the inputs may be nil/empty — the
    /// strip degrades a line at a time rather than vanishing.
    func render(project: String?, pulse: ProjectPulse?, live: ProjectLiveRollup,
                nextUp: LinearTicket?) {
        milestoneLabel.stringValue = Self.milestoneText(pulse: pulse)
        countsLabel.stringValue = Self.countsText(pulse: pulse, live: live)
        rebuildNowChips(live.nowRows)
        renderNext(nextUp)
        isHidden = (project == nil || project?.isEmpty == true)
    }

    static func milestoneText(pulse: ProjectPulse?) -> String {
        guard let pulse else { return "" }
        if let m = pulse.headlineMilestone, !m.name.isEmpty {
            var s = "\u{25C8} \(m.name) \(m.percent)% (\(m.done)/\(m.total))"
            if let due = m.targetDate, !due.isEmpty { s += " \u{00B7} due \(due)" }
            return s
        }
        if let plan = pulse.plan, plan.total > 0 {
            return "\u{25C8} plan \(plan.done)/\(plan.total)"
        }
        return ""
    }

    static func countsText(pulse: ProjectPulse?, live: ProjectLiveRollup) -> String {
        var parts: [String] = []
        if let l = pulse?.linear {
            parts.append("\(l.open) open")
            if l.inProgress > 0 { parts.append("\(l.inProgress) in progress") }
        }
        if let prs = pulse?.openPrCount, prs > 0 { parts.append("\(prs) PR\(prs == 1 ? "" : "s")") }
        var liveBits: [String] = []
        if live.launching > 0 { liveBits.append("\u{25CC}\(live.launching)") }
        if live.running > 0 { liveBits.append("\u{25B6}\(live.running)") }
        if live.needYou > 0 { liveBits.append("\u{26A0}\(live.needYou)") }
        if live.idle > 0 { liveBits.append("\u{23F8}\(live.idle)") }
        if !liveBits.isEmpty { parts.append(liveBits.joined(separator: " ")) }
        return parts.joined(separator: " \u{00B7} ")
    }

    private func rebuildNowChips(_ rows: [SessionRow]) {
        for v in nowRow.arrangedSubviews { nowRow.removeArrangedSubview(v); v.removeFromSuperview() }
        for row in rows {
            let chip = NSButton(title: Self.chipTitle(row), target: self, action: #selector(onChip(_:)))
            chip.isBordered = false
            chip.font = .monospacedSystemFont(ofSize: 10.5, weight: .regular)
            chip.contentTintColor = Self.chipColor(row)
            chip.toolTip = row.topic ?? row.title ?? row.label ?? row.sessionId
            chip.tag = nowRow.arrangedSubviews.count
            nowChips.append(row)
            nowRow.addArrangedSubview(chip)
        }
        nowRow.isHidden = rows.isEmpty
        if rows.isEmpty { nowChips = [] }
    }
    private var nowChips: [SessionRow] = []

    /// `◌ launching · <name>` for a placeholder; otherwise the bucket dot + the
    /// row's title ladder + its PR number.
    static func chipTitle(_ row: SessionRow) -> String {
        let bucket = ProjectLiveRollup.bucket(row)
        let dot = bucket == "launching" ? "\u{25CC}"
            : bucket == "need-you" ? "\u{26A0}"
            : bucket == "running" ? "\u{25B6}" : "\u{23F8}"
        let name = row.topic ?? row.label ?? row.title ?? row.name ?? "session"
        let short = name.count > 22 ? String(name.prefix(21)) + "\u{2026}" : name
        if bucket == "launching" { return "\(dot) launching \u{00B7} \(short)" }
        let pr = (row.pr?.number).map { " #\($0)" } ?? ""
        return "\(dot) \(short)\(pr)"
    }

    static func chipColor(_ row: SessionRow) -> NSColor {
        switch ProjectLiveRollup.bucket(row) {
        case "need-you": return .systemOrange
        case "running": return kAccentPulse
        case "launching": return .tertiaryLabelColor
        default: return .secondaryLabelColor
        }
    }

    private func renderNext(_ ticket: LinearTicket?) {
        nextTicket = ticket
        guard let ticket else {
            nextButton.isHidden = true
            return
        }
        nextButton.isHidden = false
        let title = ticket.title.count > 48 ? String(ticket.title.prefix(47)) + "\u{2026}" : ticket.title
        nextButton.title = "NEXT \u{25B8} \(ticket.identifier) \(title)   \u{2318}N"
        nextButton.toolTip = "\(ticket.identifier) — \(ticket.title)\nclick or \u{2318}N attaches · \u{2318}T for the full list"
    }

    @objc private func onNext(_ sender: NSButton) {
        if let ticket = nextTicket { onAttachTicket?(ticket) }
    }

    @objc private func onChip(_ sender: NSButton) {
        let idx = sender.tag
        guard idx >= 0, idx < nowChips.count else { return }
        onOpenSession?(nowChips[idx])
    }
}
