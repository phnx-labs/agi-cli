import AppKit

// SessionsWindow — the persistent Sessions window (PHNX-4003, Track C). A real,
// frame-remembering NSPanel that projects `FeedStream.shared` (live sessions +
// attention across the fleet) and `ArtifactIndex.shared` (rendered pages) into a
// grouped, filterable list on the left and a `SessionCard` on the right.
//
// It is a PROJECTION, never a scheduler (spec SING-2): it renders FeedStream diffs
// and offers controls that shell ONE bounded `agents` argv each — it owns no
// timer that acts on the fleet. The single timer it holds is a 1 s relative-time
// refresh that re-renders only the VISIBLE list cells; all other redraws are
// driven by FeedStream diffs. Closing the window hides it and keeps FeedStream
// attached, so re-opening is instant and the badge stays live.

/// The panel accepts key/main so its search and reply fields take focus — a bare
/// NSPanel is non-activating by default.
final class SessionsPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
    /// Returns true when the controller consumed the key (1-9 / Return / Cmd-*).
    var keyHandler: ((NSEvent) -> Bool)?

    override func keyDown(with event: NSEvent) {
        if keyHandler?(event) == true { return }
        super.keyDown(with: event)
    }
}

final class SessionsWindowController: NSObject, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate {
    static let shared = SessionsWindowController()

    // MARK: Filters

    enum Filter: Int, CaseIterable {
        case recent, needsYou, running, doneToday
        var title: String {
            switch self {
            case .recent: return "Recent"
            case .needsYou: return "Needs you"
            case .running: return "Running"
            case .doneToday: return "Done today"
            }
        }
    }

    private var filter: Filter = .recent
    private var searchText = ""
    private var collapsed: Set<String> = []
    private var selectedRowKey: String?

    // MARK: Data

    /// All live entries from the feed, keyed by rowKey (previous/history rows
    /// dropped — this window is the live view).
    private var entries: [String: SessionEntry] = [:]
    /// The flattened, filtered, grouped display list backing the table.
    private var listItems: [ListItem] = []
    /// Snapshot devices (for load/interactive/local flags), fetched off-main.
    private var snapshotDevices: [String: Device] = [:]

    private enum ListItem {
        case group(name: String, count: Int, needYou: Int)
        case session(SessionEntry)
    }

    // MARK: Views

    private var panel: SessionsPanel?
    private let table = NSTableView()
    private let card = SessionCard()
    private let searchField = NSSearchField()
    private var chipButtons: [NSButton] = []
    private let deviceStrip = NSStackView()
    private let statusLabel = NSTextField(labelWithString: "")
    private var timeTimer: Timer?

    private override init() { super.init() }

    // MARK: - Public entry points

    /// Toggle the window (Cmd-Shift-I / the dropdown "Sessions" row). FeedStream is
    /// started once and stays attached.
    func toggle() {
        if let panel, panel.isVisible { panel.orderOut(nil) } else { open(selecting: nil) }
    }

    /// Show the window, optionally selecting a specific session (clicking a
    /// dropdown row opens the window on that session).
    func open(selecting sessionId: String?) {
        ensurePanel()
        FeedStream.shared.start()
        ArtifactIndex.shared.start()
        ingest()
        if let sessionId, let key = entries.first(where: { $0.value.sessionId == sessionId })?.key {
            selectedRowKey = key
        }
        panel?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        applyAndReload()
        startTimeTimer()
    }

    // MARK: - Panel construction

    private func ensurePanel() {
        guard panel == nil else { return }
        let p = SessionsPanel(contentRect: NSRect(x: 0, y: 0, width: 960, height: 600),
                              styleMask: [.titled, .closable, .resizable, .utilityWindow],
                              backing: .buffered, defer: false)
        p.title = "Sessions"
        p.isFloatingPanel = false        // behave like a document window
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.delegate = self
        p.keyHandler = { [weak self] event in self?.handleKey(event) ?? false }
        p.setFrameAutosaveName("AGIMenuSessionsWindow")

        let root = NSView()
        p.contentView = root

        // Toolbar: filter chips + search field.
        let toolbar = NSStackView()
        toolbar.orientation = .horizontal
        toolbar.spacing = 6
        toolbar.edgeInsets = NSEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
        for f in Filter.allCases {
            let b = NSButton(title: f.title, target: self, action: #selector(onChip(_:)))
            b.bezelStyle = .rounded
            b.setButtonType(.pushOnPushOff)
            b.tag = f.rawValue
            b.font = NSFont.systemFont(ofSize: 11)
            chipButtons.append(b)
            toolbar.addArrangedSubview(b)
        }
        searchField.placeholderString = "Search label, topic, project, ticket, device (Cmd-F)"
        searchField.target = self
        searchField.action = #selector(onSearch)
        searchField.sendsSearchStringImmediately = false
        searchField.translatesAutoresizingMaskIntoConstraints = false
        toolbar.addArrangedSubview(searchField)

        // Device strip.
        deviceStrip.orientation = .horizontal
        deviceStrip.spacing = 6
        deviceStrip.edgeInsets = NSEdgeInsets(top: 4, left: 12, bottom: 4, right: 12)
        let deviceScroll = NSScrollView()
        deviceScroll.hasHorizontalScroller = false
        deviceScroll.drawsBackground = false
        deviceScroll.documentView = deviceStrip

        // Split: list | card.
        let split = NSSplitView()
        split.isVertical = true
        split.dividerStyle = .thin

        let listScroll = NSScrollView()
        listScroll.hasVerticalScroller = true
        table.headerView = nil
        table.rowHeight = 46
        table.backgroundColor = .clear
        table.selectionHighlightStyle = .regular
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.action = #selector(onRowClick)
        let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("main"))
        col.resizingMask = .autoresizingMask
        table.addTableColumn(col)
        listScroll.documentView = table
        split.addArrangedSubview(listScroll)
        split.addArrangedSubview(card)

        // Status bar.
        statusLabel.font = NSFont.monospacedSystemFont(ofSize: 10, weight: .regular)
        statusLabel.textColor = .secondaryLabelColor
        let statusBar = NSStackView(views: [statusLabel])
        statusBar.orientation = .horizontal
        statusBar.edgeInsets = NSEdgeInsets(top: 4, left: 12, bottom: 4, right: 12)

        let column = NSStackView(views: [toolbar, deviceScroll, split, statusBar])
        column.orientation = .vertical
        column.spacing = 0
        column.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(column)
        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            column.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            column.topAnchor.constraint(equalTo: root.topAnchor),
            column.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            deviceScroll.heightAnchor.constraint(equalToConstant: 30),
            split.heightAnchor.constraint(greaterThanOrEqualToConstant: 400),
        ])
        split.setHoldingPriority(.defaultLow, forSubviewAt: 1)

        // Wire the card's bounded actions to the CLI.
        card.onReply = { args, done in Reply.perform(args, onResult: done) }
        card.onOpenTerminal = { id in AgentsCLI.focusSession(id) }
        card.onOpenArtifact = { path in NSWorkspace.shared.open(URL(fileURLWithPath: path)) }

        panel = p

        // Observe the data layer. These fire on the main queue.
        FeedStream.shared.addObserver(self) { [weak self] _ in self?.onFeedDiff() }
        ArtifactIndex.shared.addObserver(self) { [weak self] in self?.refreshCardArtifacts() }

        fetchSnapshotDevices()
    }

    // MARK: - Data ingest + render

    private func onFeedDiff() {
        guard panel?.isVisible == true else { return }
        ingest()
        applyAndReload()
    }

    private func ingest() {
        let rows = FeedStream.shared.rows
        let attention = FeedStream.shared.attention
        let now = Date()
        var next: [String: SessionEntry] = [:]
        for (rowKey, row) in rows {
            if row.isPrevious { continue }
            let attn = row.sessionId.flatMap { attention[$0] }
            let presentation = SessionRowModel.present(row, attention: attn, now: now)
            next[rowKey] = SessionEntry(rowKey: rowKey, row: row, attention: attn, presentation: presentation)
        }
        entries = next
    }

    private func applyAndReload() {
        let now = Date()
        let all = Array(entries.values)
        let filtered = all.filter { passesFilter($0) && matchesSearch($0) }

        // Group by project, sort groups by most-recent activity, rows by startedAt desc.
        var byGroup: [String: [SessionEntry]] = [:]
        for e in filtered { byGroup[e.presentation.groupKey, default: []].append(e) }
        let orderedGroups = byGroup.keys.sorted { a, b in
            recency(byGroup[a]!) > recency(byGroup[b]!)
        }

        var items: [ListItem] = []
        for name in orderedGroups {
            let rows = byGroup[name]!.sorted { ($0.row.startedAtMs ?? 0) > ($1.row.startedAtMs ?? 0) }
            let needYou = rows.filter { $0.presentation.status == .needsYou }.count
            items.append(.group(name: name, count: rows.count, needYou: needYou))
            if !collapsed.contains(name) {
                for r in rows { items.append(.session(r)) }
            }
        }
        listItems = items
        table.reloadData()
        restoreSelection()
        updateChips(all)
        updateStatusBar(now: now)
        rebuildDeviceStrip(now: now)
    }

    private func recency(_ rows: [SessionEntry]) -> Double {
        rows.map { $0.row.lastActivityMs ?? $0.row.startedAtMs ?? 0 }.max() ?? 0
    }

    private func passesFilter(_ e: SessionEntry) -> Bool {
        switch filter {
        case .recent: return true
        case .needsYou: return e.presentation.status == .needsYou || e.presentation.status == .idle
        case .running: return e.presentation.status == .working
        case .doneToday:
            guard e.presentation.status == .done, let ms = e.row.lastActivityMs ?? e.row.startedAtMs else { return false }
            return Calendar.current.isDateInToday(Date(timeIntervalSince1970: ms / 1000))
        }
    }

    private func matchesSearch(_ e: SessionEntry) -> Bool {
        guard !searchText.isEmpty else { return true }
        let hay = [e.presentation.title, e.row.topic, e.presentation.groupKey,
                   e.row.ticket?.id, SessionRowModel.deviceName(e.row), e.row.host]
            .compactMap { $0 }.joined(separator: " ").lowercased()
        return hay.contains(searchText.lowercased())
    }

    // MARK: - Chips / status / devices

    private func updateChips(_ all: [SessionEntry]) {
        func count(_ f: Filter) -> Int {
            switch f {
            case .recent: return all.count
            case .needsYou: return all.filter { $0.presentation.status == .needsYou || $0.presentation.status == .idle }.count
            case .running: return all.filter { $0.presentation.status == .working }.count
            case .doneToday: return all.filter {
                guard $0.presentation.status == .done, let ms = $0.row.lastActivityMs ?? $0.row.startedAtMs else { return false }
                return Calendar.current.isDateInToday(Date(timeIntervalSince1970: ms / 1000))
            }.count
            }
        }
        for b in chipButtons {
            guard let f = Filter(rawValue: b.tag) else { continue }
            b.title = "\(f.title) (\(count(f)))"
            b.state = (f == filter) ? .on : .off
        }
    }

    private func updateStatusBar(now: Date) {
        let heartbeats = FeedStream.shared.deviceHeartbeat
        let scopes = FeedStream.shared.scopeStatus
        let reporting = heartbeats.count
        let stale = heartbeats.values.filter { now.timeIntervalSince($0) > FeedStream.staleAfter }.count
            + scopes.values.filter { $0 == .unavailable }.count
        let lastEvent = heartbeats.values.max().map { Int(now.timeIntervalSince($0)) }
        var parts: [String] = []
        parts.append("stream \(healthWord(FeedStream.shared.health))")
        if let s = lastEvent { parts.append("last event \(s)s ago") }
        parts.append("\(reporting) device\(reporting == 1 ? "" : "s") reporting")
        if stale > 0 { parts.append("\(stale) stale") }
        parts.append("helper \(rssMB()) MB")
        parts.append("\(entries.count) row\(entries.count == 1 ? "" : "s")")
        statusLabel.stringValue = parts.joined(separator: "  ·  ")
    }

    private func healthWord(_ h: StreamHealth) -> String {
        switch h {
        case .live: return "live"
        case .starting: return "starting"
        case .stale: return "stale"
        case .reconnecting: return "reconnecting"
        case .breakerTripped: return "stopped (breaker)"
        case .stopped: return "stopped"
        }
    }

    private func rebuildDeviceStrip(now: Date) {
        deviceStrip.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let heartbeats = FeedStream.shared.deviceHeartbeat
        let scopes = FeedStream.shared.scopeStatus
        for name in heartbeats.keys.sorted() {
            let last = heartbeats[name]!
            let offline = scopes[name] == .unavailable
            if offline { continue } // offline devices collapse out of the strip
            var text = name
            if let dev = snapshotDevices[name], dev.isLocal { text += " ·" }
            let age = now.timeIntervalSince(last)
            var color = Palette.working
            if age > FeedStream.staleAfter {
                text += " · stale \(Int(age / 60))m"
                color = Palette.needsYou
            }
            deviceStrip.addArrangedSubview(chip(text, color: color))
        }
        let offlineCount = scopes.values.filter { $0 == .unavailable }.count
        if offlineCount > 0 { deviceStrip.addArrangedSubview(chip("\(offlineCount) offline", color: Palette.done)) }
    }

    private func chip(_ text: String, color: NSColor) -> NSView {
        let f = NSTextField(labelWithString: text)
        f.font = NSFont.monospacedSystemFont(ofSize: 10, weight: .medium)
        f.textColor = color
        f.wantsLayer = true
        f.layer?.backgroundColor = color.withAlphaComponent(0.12).cgColor
        f.layer?.cornerRadius = 5
        f.drawsBackground = false
        return f
    }

    private func fetchSnapshotDevices() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let devices = AgentsCLI.menubarSnapshot()?.devices ?? []
            DispatchQueue.main.async {
                self?.snapshotDevices = Dictionary(uniqueKeysWithValues: devices.map { ($0.name, $0) })
            }
        }
    }

    // MARK: - Table

    func numberOfRows(in tableView: NSTableView) -> Int { listItems.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard row < listItems.count else { return nil }
        switch listItems[row] {
        case let .group(name, count, needYou):
            return groupCell(name: name, count: count, needYou: needYou)
        case let .session(entry):
            return sessionCell(entry)
        }
    }

    func tableView(_ tableView: NSTableView, isGroupRow row: Int) -> Bool {
        if case .group = listItems[row] { return true }
        return false
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        if case .group = listItems[row] { return false }
        return true
    }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        if case .group = listItems[row] { return 26 }
        return 46
    }

    @objc private func onRowClick() {
        let row = table.clickedRow
        guard row >= 0, row < listItems.count else { return }
        if case let .group(name, _, _) = listItems[row] {
            if collapsed.contains(name) { collapsed.remove(name) } else { collapsed.insert(name) }
            applyAndReload()
        }
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        let row = table.selectedRow
        guard row >= 0, row < listItems.count, case let .session(entry) = listItems[row] else { return }
        selectedRowKey = entry.rowKey
        showCard(entry)
    }

    private func restoreSelection() {
        guard let key = selectedRowKey else { return }
        for (i, item) in listItems.enumerated() {
            if case let .session(e) = item, e.rowKey == key {
                table.selectRowIndexes(IndexSet(integer: i), byExtendingSelection: false)
                return
            }
        }
    }

    private func showCard(_ entry: SessionEntry) {
        let artifacts = entry.sessionId.map { ArtifactIndex.shared.artifacts(forSession: $0) } ?? []
        card.show(entry, artifacts: artifacts)
    }

    private func refreshCardArtifacts() {
        guard let key = selectedRowKey, let entry = entries[key] else { return }
        showCard(entry)
    }

    private func groupCell(name: String, count: Int, needYou: Int) -> NSView {
        let arrow = collapsed.contains(name) ? "\u{25B6}" : "\u{25BC}"
        var text = "\(arrow)  \(name)  (\(count))"
        let f = NSTextField(labelWithString: text)
        f.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        f.textColor = .secondaryLabelColor
        if needYou > 0 {
            text += "   \(needYou) need you"
            let attr = NSMutableAttributedString(string: text, attributes: [
                .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
                .foregroundColor: NSColor.secondaryLabelColor,
            ])
            let r = (text as NSString).range(of: "\(needYou) need you")
            if r.location != NSNotFound { attr.addAttribute(.foregroundColor, value: Palette.needsYou, range: r) }
            f.attributedStringValue = attr
        }
        let container = NSTableCellView()
        f.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(f)
        NSLayoutConstraint.activate([
            f.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 8),
            f.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -8),
            f.centerYAnchor.constraint(equalTo: container.centerYAnchor),
        ])
        return container
    }

    private func sessionCell(_ entry: SessionEntry) -> NSView {
        // Recompute the phase line with a fresh clock so the age stays live on the
        // 1 s visible-cell refresh; everything else rides the stored presentation.
        let p = entry.presentation
        let phase = SessionRowModel.phaseText(entry.row, attention: entry.attention,
                                              status: p.status, now: Date())
        let (dot, color) = Palette.dot(p.status)

        // Line 1: dot + title + progress + phase/device.
        var line1 = "\(dot) \(p.title)"
        if let prog = p.progress { line1 += "  \(prog.done)/\(prog.total)" }
        line1 += "   \(phase)"
        // Line 2: latest action + PR chip.
        var line2Parts: [String] = []
        if let action = p.latestAction { line2Parts.append(action) }
        if let chip = p.prChip { line2Parts.append(chip.text) }
        let line2 = line2Parts.joined(separator: "   ")

        let title = NSTextField(labelWithString: line1)
        let attr = NSMutableAttributedString(string: line1, attributes: [
            .font: NSFont.systemFont(ofSize: 12, weight: .medium),
            .foregroundColor: NSColor.labelColor,
        ])
        let r = (line1 as NSString).range(of: dot)
        if r.location != NSNotFound { attr.addAttribute(.foregroundColor, value: color, range: r) }
        title.attributedStringValue = attr
        title.lineBreakMode = .byTruncatingTail

        let sub = NSTextField(labelWithString: line2)
        sub.font = NSFont.systemFont(ofSize: 10)
        sub.textColor = .secondaryLabelColor
        sub.lineBreakMode = .byTruncatingTail

        let vstack = NSStackView(views: line2.isEmpty ? [title] : [title, sub])
        vstack.orientation = .vertical
        vstack.alignment = .leading
        vstack.spacing = 1
        vstack.translatesAutoresizingMaskIntoConstraints = false

        let container = NSTableCellView()
        container.addSubview(vstack)
        NSLayoutConstraint.activate([
            vstack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 20),
            vstack.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -8),
            vstack.centerYAnchor.constraint(equalTo: container.centerYAnchor),
        ])
        return container
    }

    // MARK: - Actions

    @objc private func onChip(_ sender: NSButton) {
        guard let f = Filter(rawValue: sender.tag) else { return }
        filter = f
        applyAndReload()
    }

    @objc private func onSearch() {
        searchText = searchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        applyAndReload()
    }

    // MARK: - Keyboard

    /// Handle the window's key events (routed from the panel): 1-9 answer an
    /// option on the selected row, Return focuses the reply field, Cmd-Return
    /// opens the terminal, Cmd-K nudges, Cmd-F focuses search.
    func handleKey(_ event: NSEvent) -> Bool {
        let cmd = event.modifierFlags.contains(.command)
        let chars = event.charactersIgnoringModifiers ?? ""
        if cmd, chars == "f" { panel?.makeFirstResponder(searchField); return true }
        // Don't steal typing while a text field is first responder.
        if panel?.firstResponder is NSText { return false }
        if cmd, chars == "k" { card.nudge(); return true }
        if cmd, event.keyCode == 36 { card.openTerminal(); return true } // Cmd-Return
        if event.keyCode == 36 { card.focusReply(); return true }        // Return
        if cmd, chars == "v" { return card.attachClipboardImage() }
        if let digit = Int(chars), digit >= 1, digit <= 9 { card.answerOption(index: digit - 1); return true }
        return false
    }

    // MARK: - Timer

    private func startTimeTimer() {
        guard timeTimer == nil else { return }
        let t = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.tickTime() }
        RunLoop.main.add(t, forMode: .common)
        timeTimer = t
    }

    private func stopTimeTimer() {
        timeTimer?.invalidate()
        timeTimer = nil
    }

    /// Re-render ONLY the visible session cells so their relative ages advance,
    /// and refresh the status bar's "last event" — no data reload, no CLI call.
    private func tickTime() {
        guard panel?.isVisible == true else { return }
        let visible = table.rows(in: table.visibleRect)
        if visible.length > 0 {
            table.reloadData(forRowIndexes: IndexSet(integersIn: visible.location..<(visible.location + visible.length)),
                             columnIndexes: IndexSet(integer: 0))
            restoreSelection()
        }
        updateStatusBar(now: Date())
    }

    // MARK: - Window lifecycle

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        stopTimeTimer()
        return false // hide, keep FeedStream attached
    }

    // MARK: - RSS

    private func rssMB() -> Int {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
            }
        }
        guard kr == KERN_SUCCESS else { return 0 }
        return Int(info.resident_size / (1024 * 1024))
    }
}
