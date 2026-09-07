import AppKit

// RecentSectionBuilder — the new dropdown sections that project the feed layer
// (PHNX-4003, Track C), kept out of the 2,150-line StatusItemController so that
// file's edits stay to swapping a builder in and adding two rows.
//
// It renders, all from `FeedStream.shared` (never a second data derivation — the
// same `SessionRowModel` the window uses):
//   - the "Sessions" row (opens the window; `n need you` in yellow when any),
//   - the status-color legend,
//   - RECENT grouped by project, newest first, two lines per row, and
//   - the "Notifications" submenu (today's feed banners, unanswered first).
//
// It is a PROJECTION with controls that open the window or shell ONE bounded
// `agents` argv — it owns no timer that acts on the fleet (spec SING-2). The
// notification list is a 30 s-cached read of `agents feed --filter all --json`
// bounded to 24 h, warmed off-main on menu open (the same warm-cache pattern the
// controller's routines/doctor sections use), so the menu never blocks.
final class RecentSectionBuilder: NSObject {
    static let shared = RecentSectionBuilder()
    private override init() {}

    // Bounds so the dropdown never walls: at most this many project groups and
    // rows per group in RECENT.
    private static let maxGroups = 6
    private static let maxRowsPerGroup = 5
    private static let maxNotifications = 12

    // MARK: - Sessions row + legend

    /// The "Sessions" row: opens the window, and shows `n need you` in yellow when
    /// any session across the fleet is waiting on the operator.
    func addSessionsRow(_ menu: NSMenu) {
        let needYou = liveEntries().filter { $0.presentation.status == .needsYou }.count
        let title = needYou > 0 ? "Sessions   \(needYou) need you" : "Sessions"
        let item = NSMenuItem(title: title, action: #selector(onOpenSessions), keyEquivalent: "i")
        item.keyEquivalentModifierMask = [.command, .shift]
        item.target = self
        if needYou > 0 {
            let attr = NSMutableAttributedString(string: title, attributes: [
                .font: NSFont.menuFont(ofSize: 0),
                .foregroundColor: NSColor.labelColor,
            ])
            let r = (title as NSString).range(of: "\(needYou) need you")
            if r.location != NSNotFound { attr.addAttribute(.foregroundColor, value: Palette.needsYou, range: r) }
            item.attributedTitle = attr
        }
        menu.addItem(item)
    }

    /// The status-color legend, so the dropdown's dots read at a glance.
    func addLegend(_ menu: NSMenu) {
        let text = "  \u{25CF} working   \u{25CF} needs you   \u{25CF} idle"
        let it = NSMenuItem(title: text, action: nil, keyEquivalent: "")
        it.isEnabled = false
        let attr = NSMutableAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: 10),
            .foregroundColor: NSColor.secondaryLabelColor,
        ])
        colorDot(attr, after: "working", color: Palette.working)
        colorDot(attr, after: "needs you", color: Palette.needsYou)
        colorDot(attr, after: "idle", color: Palette.idle)
        it.attributedTitle = attr
        menu.addItem(it)
    }

    private func colorDot(_ attr: NSMutableAttributedString, after word: String, color: NSColor) {
        let s = attr.string as NSString
        let wordRange = s.range(of: word)
        guard wordRange.location != NSNotFound else { return }
        // The dot glyph precedes the word by two chars ("\u{25CF} word").
        let dot = s.range(of: "\u{25CF}", options: .backwards,
                          range: NSRange(location: 0, length: wordRange.location))
        if dot.location != NSNotFound { attr.addAttribute(.foregroundColor, value: color, range: dot) }
    }

    // MARK: - RECENT grouped by project

    /// RECENT: live sessions across the fleet, grouped by project, newest first,
    /// two lines per row (name + dot + progress + phase/device; latest action + PR
    /// chip underneath) — the shared row model, the same the window renders. A row
    /// click opens the window on that session.
    func addRecentByProject(_ menu: NSMenu) {
        let entries = liveEntries()
        let title = NSMenuItem(title: "RECENT", action: nil, keyEquivalent: "")
        title.isEnabled = false
        title.attributedTitle = NSAttributedString(string: "RECENT", attributes: [
            .foregroundColor: NSColor.secondaryLabelColor,
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
        ])
        menu.addItem(title)

        if entries.isEmpty {
            let empty = NSMenuItem(title: "  No live sessions", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
            return
        }

        var byGroup: [String: [SessionEntry]] = [:]
        for e in entries { byGroup[e.presentation.groupKey, default: []].append(e) }
        let ordered = byGroup.keys.sorted { a, b in recency(byGroup[a]!) > recency(byGroup[b]!) }
        for name in ordered.prefix(Self.maxGroups) {
            let rows = byGroup[name]!.sorted { ($0.row.startedAtMs ?? 0) > ($1.row.startedAtMs ?? 0) }
            let needYou = rows.filter { $0.presentation.status == .needsYou }.count
            var header = "  \(name) (\(rows.count))"
            if needYou > 0 { header += " · \(needYou) need you" }
            let head = NSMenuItem(title: header, action: nil, keyEquivalent: "")
            head.isEnabled = false
            head.attributedTitle = NSAttributedString(string: header, attributes: [
                .foregroundColor: NSColor.secondaryLabelColor,
                .font: NSFont.systemFont(ofSize: 11, weight: .medium),
            ])
            menu.addItem(head)
            for e in rows.prefix(Self.maxRowsPerGroup) { menu.addItem(recentRow(e)) }
        }
    }

    private func recentRow(_ e: SessionEntry) -> NSMenuItem {
        let p = e.presentation
        let (dot, color) = Palette.dot(p.status)
        var line1 = "    \(dot) \(p.title)"
        if let prog = p.progress { line1 += "  \(prog.done)/\(prog.total)" }
        line1 += "   \(p.phaseText)"
        var parts: [String] = []
        if let action = p.latestAction { parts.append(action) }
        if let chip = p.prChip { parts.append(chip.text) }
        let line2 = parts.isEmpty ? "" : "        " + parts.joined(separator: "   ")

        let full = line2.isEmpty ? line1 : "\(line1)\n\(line2)"
        let item = NSMenuItem(title: full, action: #selector(onOpenSessionRow(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = e.sessionId
        let attr = NSMutableAttributedString(string: full, attributes: [
            .font: NSFont.menuFont(ofSize: 0),
            .foregroundColor: NSColor.labelColor,
        ])
        let dotRange = (full as NSString).range(of: dot)
        if dotRange.location != NSNotFound { attr.addAttribute(.foregroundColor, value: color, range: dotRange) }
        if !line2.isEmpty {
            let r = (full as NSString).range(of: line2)
            if r.location != NSNotFound {
                attr.addAttributes([.font: NSFont.systemFont(ofSize: 10),
                                    .foregroundColor: NSColor.secondaryLabelColor], range: r)
            }
        }
        item.attributedTitle = attr
        return item
    }

    // MARK: - Notifications submenu

    /// The "Notifications" submenu: today's feed banners (bounded to 24 h),
    /// unanswered first with a Reply/Approve action that opens the window on that
    /// session (where the reconciled attention block carries the real choices),
    /// then answered/informational ones as a log with Open.
    func addNotifications(_ menu: NSMenu) {
        let all = cachedNotifications
        let unanswered = all.filter { $0.unanswered }
        let answered = all.filter { !$0.unanswered }
        let head = "Notifications" + (unanswered.isEmpty ? "" : " (\(unanswered.count))")
        let item = NSMenuItem(title: head, action: nil, keyEquivalent: "")
        let sub = NSMenu()

        if all.isEmpty {
            let empty = NSMenuItem(title: notificationsLoaded ? "No notifications today" : "Checking…",
                                   action: nil, keyEquivalent: "")
            empty.isEnabled = false
            sub.addItem(empty)
        } else {
            for n in unanswered.prefix(Self.maxNotifications) { sub.addItem(notificationRow(n, actionable: true)) }
            if !unanswered.isEmpty && !answered.isEmpty { sub.addItem(.separator()) }
            for n in answered.prefix(Self.maxNotifications) { sub.addItem(notificationRow(n, actionable: false)) }
        }
        item.submenu = sub
        if !unanswered.isEmpty {
            item.attributedTitle = NSAttributedString(string: head, attributes: [
                .font: NSFont.menuFont(ofSize: 0),
                .foregroundColor: Palette.needsYou,
            ])
        }
        menu.addItem(item)
    }

    private func notificationRow(_ n: FeedBlock, actionable: Bool) -> NSMenuItem {
        let glyph = actionable ? "\u{26A0}" : "\u{25CB}"
        var text = "\(glyph) \(n.displayTitle)"
        if let host = n.host, !host.isEmpty { text += "  ·  \(host)" }
        let item = NSMenuItem(title: text, action: #selector(onOpenSessionRow(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = n.sessionId
        item.toolTip = actionable ? "Open the Sessions window to Approve / Reply" : "Open in the Sessions window"
        if actionable {
            let attr = NSMutableAttributedString(string: text, attributes: [
                .font: NSFont.menuFont(ofSize: 0), .foregroundColor: NSColor.labelColor,
            ])
            let r = (text as NSString).range(of: glyph)
            if r.location != NSNotFound { attr.addAttribute(.foregroundColor, value: Palette.needsYou, range: r) }
            item.attributedTitle = attr
        }
        return item
    }

    // MARK: - Actions

    @objc private func onOpenSessions() { SessionsWindowController.shared.open(selecting: nil) }

    @objc private func onOpenSessionRow(_ sender: NSMenuItem) {
        SessionsWindowController.shared.open(selecting: sender.representedObject as? String)
    }

    // MARK: - Feed entries (shared derivation with the window)

    private func liveEntries() -> [SessionEntry] {
        let rows = FeedStream.shared.rows
        let attention = FeedStream.shared.attention
        let now = Date()
        var out: [SessionEntry] = []
        for (rowKey, row) in rows where !row.isPrevious {
            let attn = row.sessionId.flatMap { attention[$0] }
            let presentation = SessionRowModel.present(row, attention: attn, now: now)
            out.append(SessionEntry(rowKey: rowKey, row: row, attention: attn, presentation: presentation))
        }
        return out
    }

    private func recency(_ rows: [SessionEntry]) -> Double {
        rows.map { $0.row.lastActivityMs ?? $0.row.startedAtMs ?? 0 }.max() ?? 0
    }

    // MARK: - Notifications cache

    private var cachedNotifications: [FeedBlock] = []
    private var notificationsLoaded = false
    private var lastFetch: Date = .distantPast
    private var fetching = false
    private static let cacheTTL: TimeInterval = 30
    private static let windowSeconds: TimeInterval = 24 * 3600

    /// Warm the notification cache off-main when stale (30 s TTL). Called from the
    /// controller's `menuWillOpen`; the section renders from the cache, so the
    /// first open may read "Checking…" and the next shows the banners — the same
    /// warm-cache contract the routines/doctor sections use.
    func refreshNotificationsIfStale() {
        guard !fetching, Date().timeIntervalSince(lastFetch) > Self.cacheTTL else { return }
        fetching = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let argv = Reply.resolveArgv(["feed", "--filter", "all", "--json"])
            let blocks = (ChildProcess.run(argv)).flatMap {
                try? JSONDecoder().decode([FeedBlock].self, from: $0)
            } ?? []
            let cutoff = Date().addingTimeInterval(-Self.windowSeconds)
            let recent = blocks.filter { ($0.date ?? .distantPast) >= cutoff }
                .sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
            DispatchQueue.main.async {
                self?.cachedNotifications = recent
                self?.notificationsLoaded = true
                self?.lastFetch = Date()
                self?.fetching = false
            }
        }
    }
}

// MARK: - Feed block (decode-only)

/// One `agents feed --filter all --json` block — the fields the Notifications
/// submenu needs. Every field optional so a newer/older CLI still decodes (the
/// helper and the on-PATH CLI release independently).
struct FeedBlock: Decodable {
    let blockId: String?
    let sessionId: String?
    let host: String?
    let project: String?
    let ts: String?
    let kind: String?
    let questions: [FeedQuestion]?
    let outcome: FeedOutcome?

    struct FeedQuestion: Decodable { let header: String?; let text: String? }
    struct FeedOutcome: Decodable { let key: String?; let kind: String?; let label: String? }

    /// Unanswered = the block has no assigned outcome yet.
    var unanswered: Bool { (outcome?.kind ?? "unassigned") == "unassigned" }

    var displayTitle: String {
        if let h = questions?.first?.header, !h.isEmpty { return h }
        if let t = questions?.first?.text, !t.isEmpty { return String(t.prefix(60)) }
        return kind ?? "notification"
    }

    var date: Date? {
        guard let ts else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: ts) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: ts)
    }
}
