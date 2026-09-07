import AppKit
import ImageIO

// Spotlight-style quick-dispatch bar (Cmd-Shift-O). A thin capture surface: type
// a one-line note, optionally attach one or more recent screenshots from clip
// history, pick the agents, and hit Return. "File Ticket" dispatches the ticket
// agent; "Fix" fans out autonomous `agents run --mode auto --name quick-*`
// sessions. The panel then gets out of the way — agents do the work, and
// notifications report results.
//
// Focus is the crux. This is a no-Dock .accessory app, so a borderless panel
// can't take keyboard input by default. Three things, all required on summon:
//   NSApp.activate(ignoringOtherApps:true)  → the process gets the keyboard
//   makeKeyAndOrderFront                     → the window becomes key (needs the
//                                              canBecomeKey override below)
//   makeFirstResponder(field)                → the field editor lands keystrokes
// This deliberately steals focus (Spotlight/Alfred do the same) — scoped to the
// explicit Cmd-Shift-O press only. It does NOT regress the focus-safe clip paste
// (Clip.inject), which has no summon and still targets the frontmost app.

private let kAccent = NSColor(red: 0xa3/255.0, green: 0xe6/255.0, blue: 0x35/255.0, alpha: 1)

// A borderless window returns canBecomeKey == false by default; override so the
// text field can edit. resignKey drives click-outside / app-switch dismissal.
final class PromptPanel: NSPanel {
    var onResignKey: (() -> Void)?
    var onBecomeKey: (() -> Void)?
    // Cmd-1 … Cmd-9 dispatch the Nth listed ticket. Returns true when the index
    // matched a visible row, so an unhandled digit still reaches the field editor.
    var onTicketShortcut: ((Int) -> Bool)?
    // Cmd-V with an image on the clipboard attaches it instead of pasting text.
    // Returns true when it consumed the paste.
    var onPasteImages: (() -> Bool)?
    // Cmd-T folds the ticket list open/closed.
    var onToggleTickets: (() -> Void)?
    // Image files dropped on the panel; the drag's own pasteboard is handed over.
    var onDropImages: ((NSPasteboard) -> Void)?

    static let pinnedDefaultsKey = "menubar.quickDispatch.pinned"

    /// Pinned means the palette survives focus loss: `resignKey` stops dismissing
    /// it, so you can click into another app, copy something, and come back to the
    /// note you were typing. Persisted, because a pin the user set is a standing
    /// preference, not a per-summon toggle.
    var isPinned = UserDefaults.standard.bool(forKey: PromptPanel.pinnedDefaultsKey) {
        didSet {
            UserDefaults.standard.set(isPinned, forKey: Self.pinnedDefaultsKey)
            applyPinnedBehavior()
        }
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
    override func resignKey() {
        super.resignKey()
        if !isPinned { onResignKey?() }
    }
    override func becomeKey() {
        super.becomeKey()
        onBecomeKey?()
    }

    /// A pinned panel keeps `.floating` and `canJoinAllSpaces` but drops
    /// `.transient` — a transient window is hidden by Mission Control / another
    /// space, which is exactly what a pin is asking it not to do. Pure so the
    /// headless self-test pins the policy without a live window server.
    static func collectionBehavior(pinned: Bool) -> NSWindow.CollectionBehavior {
        pinned
            ? [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
            : [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
    }

    func applyPinnedBehavior() {
        level = .floating
        collectionBehavior = Self.collectionBehavior(pinned: isPinned)
    }

    // A borderless .accessory app has NO main menu, so the standard clipboard key
    // equivalents (Cmd-V/C/X/A) are never dispatched to the field editor and paste
    // silently does nothing. Route them through the responder chain so the text
    // field's editor handles them.
    //
    // This is also the ONLY place a Cmd-V can be intercepted for image paste.
    // Overriding `paste(_:)` on the NSTextField does not work: a focused
    // NSTextField edits through the window's shared field EDITOR (an NSTextView),
    // which responds to `paste:` itself and therefore wins the responder chain
    // before the field is ever asked — so the override would never fire. Handling
    // it here, ahead of `sendAction`, keeps one interception point for the one
    // keystroke that can carry an image.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
           let key = event.charactersIgnoringModifiers?.lowercased() {
            if let digit = Int(key), digit >= 1, digit <= 9,
               onTicketShortcut?(digit - 1) == true {
                return true
            }
            if key == "t" { onToggleTickets?(); return true }
            if key == "v", onPasteImages?() == true { return true }
            let selector: Selector?
            switch key {
            case "v": selector = #selector(NSText.paste(_:))
            case "c": selector = #selector(NSText.copy(_:))
            case "x": selector = #selector(NSText.cut(_:))
            case "a": selector = #selector(NSResponder.selectAll(_:))
            default:  selector = nil
            }
            if let selector, NSApp.sendAction(selector, to: nil, from: self) { return true }
        }
        return super.performKeyEquivalent(with: event)
    }
}

// The panel's background view doubles as the drag destination: dropping image
// files anywhere on the palette attaches them. Registered on the content view
// rather than the thumbnail strip, because the strip is hidden whenever there is
// nothing to show — which is exactly when a drop is most useful.
final class PromptDropView: NSVisualEffectView {
    var onDropImages: ((NSPasteboard) -> Void)?

    private func imageURLs(from sender: NSDraggingInfo) -> [URL] {
        let options: [NSPasteboard.ReadingOptionKey: Any] = [
            .urlReadingFileURLsOnly: true,
            .urlReadingContentsConformToTypes: ["public.image"],
        ]
        let objects = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self],
                                                            options: options) as? [URL]
        return (objects ?? []).filter {
            AgentsCLI.imageExtensions.contains($0.pathExtension.lowercased())
        }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        imageURLs(from: sender).isEmpty ? [] : .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        imageURLs(from: sender).isEmpty ? [] : .copy
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard !imageURLs(from: sender).isEmpty else { return false }
        // Hand the drag's OWN pasteboard over, so a drop and a Cmd-V run the very
        // same reader (AgentsCLI.imageAttachments) rather than two near-copies.
        onDropImages?(sender.draggingPasteboard)
        return true
    }
}

// One clickable clip in the history strip. Draws the image aspect-filled into a
// rounded square; a lime border + full opacity marks it selected, dim + hairline
// marks it available. Single click toggles selection; double click previews the
// full image (thumbnails are small — this is how you confirm which one it is).
final class ClipThumbView: NSView {
    let path: String
    var isSelected = false { didSet { updateChrome() } }
    var onToggle: ((ClipThumbView) -> Void)?
    var onPreview: ((ClipThumbView) -> Void)?
    static let side: CGFloat = 54

    init(path: String, thumbnail: CGImage?) {
        self.path = path
        super.init(frame: NSRect(x: 0, y: 0, width: Self.side, height: Self.side))
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.masksToBounds = true
        layer?.backgroundColor = NSColor.black.withAlphaComponent(0.15).cgColor
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: Self.side).isActive = true
        heightAnchor.constraint(equalToConstant: Self.side).isActive = true
        toolTip = (path as NSString).lastPathComponent
        if let thumbnail {
            layer?.contents = thumbnail
            layer?.contentsGravity = .resizeAspectFill
        }
        updateChrome()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        if event.clickCount >= 2 {
            // Double-click: cancel the pending single-click toggle, open the preview.
            NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(fireToggle), object: nil)
            onPreview?(self)
        } else {
            // Single click: defer the toggle by the double-click interval so a
            // double-click previews WITHOUT also flipping the selection.
            perform(#selector(fireToggle), with: nil, afterDelay: NSEvent.doubleClickInterval)
        }
    }
    @objc private func fireToggle() { onToggle?(self) }

    // A focused thumbnail takes the keyboard so Backspace can drop it from the
    // attachment set — the obvious gesture for "not that one", and the only way to
    // deselect without hunting for the same small square with the mouse.
    override var acceptsFirstResponder: Bool { true }
    override func becomeFirstResponder() -> Bool { focused = true; return true }
    override func resignFirstResponder() -> Bool { focused = false; return true }

    override func keyDown(with event: NSEvent) {
        // 51 = delete/backspace, 117 = forward delete.
        if event.keyCode == 51 || event.keyCode == 117 {
            if isSelected { onToggle?(self) }
            return
        }
        // Space toggles, matching the click. Anything else (typing the note,
        // Escape, Return) belongs to the panel — pass it on.
        if event.charactersIgnoringModifiers == " " {
            onToggle?(self)
            return
        }
        super.keyDown(with: event)
    }

    private var focused = false { didSet { updateChrome() } }

    private func updateChrome() {
        layer?.borderWidth = isSelected ? 2.5 : (focused ? 2 : 1)
        layer?.borderColor = (isSelected ? kAccent
                              : focused ? NSColor.labelColor.withAlphaComponent(0.6)
                              : NSColor.separatorColor).cgColor
        animator().alphaValue = isSelected ? 1.0 : (focused ? 0.8 : 0.55)
    }
}

// One open Linear ticket in the panel's list. Click dispatches it to the selected
// agents in the picked repo; Cmd-click opens it in Linear instead (the escape hatch
// for "I want to read it first"). A row is a real button-shaped surface — hover
// highlight and a `⌘N` chip — because dispatching an agent on a click needs to look
// deliberate, not incidental.
final class TicketRowView: NSView {
    let ticket: LinearTicket
    var onDispatch: ((LinearTicket) -> Void)?
    var onOpen: ((LinearTicket) -> Void)?
    static let height: CGFloat = 22

    private var hovered = false { didSet { updateChrome() } }

    init(ticket: LinearTicket, index: Int) {
        self.ticket = ticket
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 5
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: Self.height).isActive = true

        let shortcut = Self.label(index < 9 ? "\u{2318}\(index + 1)" : "",
                                  color: .tertiaryLabelColor, width: 24)
        let priority = Self.label(LinearTickets.priorityLabel(ticket.priority),
                                  color: Self.priorityColor(ticket.priority), width: 24)
        let identifier = Self.label(ticket.identifier, color: kAccent, width: 80)
        let state = Self.label(ticket.stateName, color: .tertiaryLabelColor, width: 56)
        // A long title truncates instead of widening the panel.
        let title = Self.label(ticket.title, color: .labelColor, width: nil)
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let row = NSStackView(views: [shortcut, priority, identifier, state, title])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])

        var tip = "\(ticket.identifier) — \(ticket.title)"
        if let due = ticket.dueDate, !due.isEmpty { tip += "\ndue \(due)" }
        tip += "\nclick dispatches · \u{2318}click opens in Linear"
        toolTip = tip
        updateChrome()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: bounds,
                                       options: [.mouseEnteredAndExited, .activeAlways],
                                       owner: self, userInfo: nil))
    }
    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }

    override func mouseDown(with event: NSEvent) {
        if event.modifierFlags.contains(.command) {
            onOpen?(ticket)
        } else {
            onDispatch?(ticket)
        }
    }

    private func updateChrome() {
        layer?.backgroundColor = hovered
            ? kAccent.withAlphaComponent(0.14).cgColor
            : NSColor.clear.cgColor
    }

    // Linear's scale: 1 urgent, 2 high, 3 medium, 4 low, 0 none.
    static func priorityColor(_ priority: Int) -> NSColor {
        switch priority {
        case 1: return .systemRed
        case 2: return .systemOrange
        case 3: return .secondaryLabelColor
        default: return .tertiaryLabelColor
        }
    }

    private static func label(_ text: String, color: NSColor, width: CGFloat?) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = .monospacedSystemFont(ofSize: 11.5, weight: .regular)
        field.textColor = color
        field.translatesAutoresizingMaskIntoConstraints = false
        if let width { field.widthAnchor.constraint(equalToConstant: width).isActive = true }
        return field
    }
}

enum QuickDispatchAction: Int {
    case plan = 0
    case run = 1
}

struct PromptDraft {
    let note: String
    let selectedPaths: [String]
    let selectedAgents: Set<String>
    let action: QuickDispatchAction

    // Pure decision for what to preserve when the panel dismisses without
    // submitting: a note that is empty (or only whitespace) means "nothing to keep"
    // and yields nil so the next summon starts clean; otherwise the note and its
    // current selections round-trip verbatim. Kept as a free function so the
    // save/clear state machine is testable without a live NSPanel (see
    // IssueSelfTest.testDraftPreservation).
    static func forDismissal(note: String,
                             selectedPaths: [String],
                             selectedAgents: Set<String>,
                             action: QuickDispatchAction) -> PromptDraft? {
        if note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return nil
        }
        return PromptDraft(note: note,
                           selectedPaths: selectedPaths,
                           selectedAgents: selectedAgents,
                           action: action)
    }
}

final class PromptPanelController: NSObject, NSTextFieldDelegate {
    // A screenshot older than this isn't pre-selected — but it still shows in the
    // strip for manual attach, since the user can see exactly what they're picking.
    private static let recentClipWindow: TimeInterval = 10 * 60
    private static let panelWidth: CGFloat = 680
    // Panel height is additive: the capture half is fixed, and the screenshot strip
    // and the ticket list each add their own block when they have content.
    private static let baseHeight: CGFloat = 156
    private static let thumbStripHeight: CGFloat = 92
    private static let ticketSectionChrome: CGFloat = 36   // one control row + spacing
    // Fixed viewport for the ticket list — rows scroll inside; panel height does not
    // grow with every ticket (keeps the capture field pinned).
    private static let ticketViewportHeight: CGFloat =
        CGFloat(LinearTickets.viewportRows) * TicketRowView.height

    private var panel: PromptPanel?
    private let field = NSTextField()
    private let modeControl = NSSegmentedControl(labels: ["Plan", "Run"],
                                                 trackingMode: .selectOne,
                                                 target: nil,
                                                 action: nil)
    private let agentStrip = NSStackView()
    private let hint = NSTextField(labelWithString: "")
    private let thumbStrip = NSStackView()
    // Pin toggle: a pinned palette ignores focus loss (PromptPanel.isPinned).
    private let pinButton = NSButton()
    // WHERE the agent runs. `projectPicker` lists every `agents projects`
    // definition BY NAME — two definitions may share a checkout (`prix` and `rush`
    // both point at the `muqsitnawaz/agents` monorepo), so the name is the
    // identity and the root is only a tooltip. `projectFilter` is the type-ahead
    // over that list; `pathPicker` narrows to a worktree or subdirectory INSIDE
    // the chosen project, sourced from recent session cwds.
    private let projectPicker = NSPopUpButton(frame: .zero, pullsDown: false)
    private let projectFilter = NSSearchField()
    private let pathPicker = NSPopUpButton(frame: .zero, pullsDown: false)
    private var projects: [ProjectDef] = []
    private var visibleProjects: [ProjectDef] = []
    private var recentSessions: [RecentSession] = []
    /// Directories behind `pathPicker`'s rows after the first. Index 0 of the
    /// popup is always the project itself (dispatched as `--project <name>`).
    private var pathDirs: [String] = []
    private var rebuildingProjectPicker = false
    private var rebuildingPathPicker = false
    private static let lastProjectKey = "menubar.quickDispatch.lastProject"
    // Ticket half: one compact row of popups (Linear project · filter · sort) — no
    // chip matrices or two-column blocks — then a scrollable flat list.
    private let linearPicker = NSPopUpButton(frame: .zero, pullsDown: false)
    private let filterPicker = NSPopUpButton(frame: .zero, pullsDown: false)
    private let sortPicker = NSPopUpButton(frame: .zero, pullsDown: false)
    private let ticketStatus = NSTextField(labelWithString: "")
    private let ticketList = NSStackView()
    private let ticketScroll = NSScrollView()
    /// The Tickets control row, hidden with the list when the section is folded.
    private var ticketHeader: NSStackView?
    private var linearCache = LinearTickets.Cache()
    private var activeProject: LinearProject?
    private var visibleTickets: [LinearTicket] = []
    private var ticketFilter: LinearTickets.QuickFilter = .all
    private var ticketSort: LinearTickets.QuickSort = .urgentFirst
    // Bumped on every scope change so a slow `linear tasks` answering after the
    // user switched repo/project is dropped instead of overwriting the new list.
    private var ticketFetchToken = 0
    private var rebuildingLinearPicker = false
    private var rebuildingFilterPickers = false
    private static let projectOverrideKeyPrefix = "menubar.quickDispatch.project."
    private static let lastFilterKey = "menubar.quickDispatch.ticketFilter"
    private static let lastSortKey = "menubar.quickDispatch.ticketSort"
    private static let ticketsExpandedKey = "menubar.quickDispatch.ticketsExpanded"
    /// The ticket list is a reference surface, not the capture surface, so it
    /// starts folded and Cmd-T opens it. The choice is remembered.
    private var ticketsExpanded = UserDefaults.standard.bool(forKey: PromptPanelController.ticketsExpandedKey)
    private var selected: [String] = []   // newest-first order preserved
    private var recentImagePaths: [String] = []
    private var thumbnailCache: [String: CGImage] = [:]
    private var scanInFlight = false
    private var pendingRescan = false
    private var linearCacheReadAt: Date?
    private var pendingRestoredSelection: [String]?
    /// Live thumbnail strip: FSEvents on the screenshot dirs while the panel is
    /// visible. See ScreenshotWatcher.swift.
    private lazy var screenshotWatcher = ScreenshotWatcher { [weak self] in
        self?.rescanAttachments()
    }
    private static let hydrationQueue = DispatchQueue(label: "agents.quick-dispatch.hydration",
                                                       qos: .userInitiated)
    private var selectedAgents = Set<String>()
    private var roster: [MenuAgent] = []
    private var agentButtons: [NSButton] = []
    private var action: QuickDispatchAction = .plan
    private var inFlight = false
    private var draft: PromptDraft?
    // Click-outside dismissal is armed only AFTER the summon settles — otherwise
    // the key/order race while activating an .accessory app fires resignKey once
    // and the panel dismisses itself the instant it appears.
    private var dismissArmed = false
    // Set while opening a thumbnail in Preview: Preview taking focus fires the
    // panel's resignKey, which would otherwise dismiss the bar and drop the typed
    // note. Cleared when the bar regains key focus.
    private var suppressDismiss = false

    // MARK: Summon / dismiss

    /// Build the static AppKit hierarchy while the helper starts, then hydrate
    /// disk-backed content off the main thread. The hotkey should only have to
    /// restore small in-memory controls and order an already-built panel.
    func prepare() {
        guard panel == nil else { return }
        panel = buildPanel()
        projects = ProjectCatalog.ordered(AgentsCLI.cachedProjects())
        rebuildProjectPicker()
        rebuildPathPicker()
        // Cold cache (first launch after install, or a cleared history dir): fetch
        // now rather than waiting for the status controller's next snapshot tick,
        // which is up to 3 minutes away. `projectsAsync` is memoized + singleflight,
        // so this is the same fetch, not a second one.
        if projects.isEmpty { refreshProjects() }
        rescanAttachments()
        loadLinearCache()
    }

    private func refreshProjects() {
        AgentsCLI.projectsAsync { [weak self] defs in
            guard let self else { return }
            self.projects = defs
            self.rebuildProjectPicker(selecting: self.selectedProject()?.name)
            self.rebuildPathPicker()
            self.updateHint()
            if self.panel?.isVisible == true { self.refreshTicketScope() }
        }
    }

    /// The status controller already refreshes recent sessions off-path for its
    /// RECENT section, on the same tick that fetches the menubar snapshot. Reuse
    /// that warm result — and take the same tick as the cue to refresh the project
    /// list, which is memoized for 10 minutes, so a palette summon never waits on
    /// `agents projects list`.
    func updateRecentSessions(_ sessions: [RecentSession]) {
        recentSessions = sessions
        rebuildPathPicker()
        refreshProjects()
    }

    func summon() {
        let started = DispatchTime.now().uptimeNanoseconds
        prepare()
        guard let panel else { return }

        // Summoning a palette that is already in front and focused is the user
        // asking for it to STAY there — the same chord toggles the pin, so the
        // gesture that opens it is also the gesture that makes it stick.
        if panel.isVisible, panel.isKeyWindow {
            panel.isPinned.toggle()
            syncPinButton()
            updateHint()
            return
        }

        // Restore an interrupted capture if another app stole focus last time.
        let restoredDraft = draft
        inFlight = false
        field.stringValue = restoredDraft?.note ?? ""
        action = restoredDraft?.action ?? .plan
        modeControl.setSelected(true, forSegment: action.rawValue)
        selectedAgents = restoredDraft?.selectedAgents ?? defaultAgentSelection()
        normalizeSelectionForAction()
        updateAgentButtons()
        pendingRestoredSelection = restoredDraft?.selectedPaths

        dismissArmed = false
        syncPinButton()
        panel.applyPinnedBehavior()
        position(panel)
        NSApp.activate(ignoringOtherApps: true)
        panel.orderFrontRegardless()
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(field)
        let visibleMs = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
        waitUntilReadyForTyping(panel)
        if ProcessInfo.processInfo.environment["MENUBAR_PROMPT_DEBUG"] == "1" {
            let readyMs = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
            FileHandle.standardError.write(Data(
                "summon: visibleMs=\(String(format: "%.1f", visibleMs)) readyMs=\(String(format: "%.1f", readyMs)) frame=\(panel.frame) visible=\(panel.isVisible) thumbs=\(thumbStrip.arrangedSubviews.count)\n".utf8))
        }
        // Cached rows and images fill only after the window is visible and the
        // field owns the editor. A stale cache is refreshed by the same async path.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if !self.recentImagePaths.isEmpty {
                self.rebuildThumbs(paths: self.recentImagePaths,
                                   thumbnails: self.thumbnailCache,
                                   restoring: self.pendingRestoredSelection)
                self.pendingRestoredSelection = nil
            }
            self.restoreTicketControls()
            self.refreshTicketScope()
            self.rescanAttachments()
            self.loadLinearCache()
            // Live strip: watch the screenshot dirs for as long as the palette is
            // on screen, so a shot taken WHILE it is open appears without a
            // re-summon. Stopped in dismiss() — a closed palette watches nothing.
            self.screenshotWatcher.start(
                paths: AgentsCLI.screenshotSourceDirs().map(\.path))
        }
        // Arm click-outside dismissal once the activation race has settled. The
        // preview affordance leaves it disarmed: its whole point is to hold the
        // panel on screen for QA and screenshots, and an unbundled dev build does
        // not keep app activation, so an armed panel dismisses itself immediately.
        guard ProcessInfo.processInfo.environment["MENUBAR_PROMPT_PREVIEW"] != "1" else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.dismissArmed = true
        }
    }

    private func dismiss(preservingDraft: Bool = true) {
        dismissArmed = false
        screenshotWatcher.stop()
        if preservingDraft {
            saveDraftForDismissal()
        } else {
            clearDraft()
        }
        guard let panel, panel.isVisible else { return }
        panel.orderOut(nil)
    }

    private func saveDraftForDismissal() {
        guard !inFlight else { return }
        draft = PromptDraft.forDismissal(note: field.stringValue,
                                         selectedPaths: selected,
                                         selectedAgents: selectedAgents,
                                         action: action)
    }

    private func clearDraft() {
        draft = nil
    }

    private func waitUntilReadyForTyping(_ panel: PromptPanel) {
        let deadline = Date().addingTimeInterval(0.25)
        while Date() < deadline {
            if panel.isKeyWindow, field.currentEditor() != nil { return }
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
    }

    // MARK: Submit

    private func submit() {
        let note = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !note.isEmpty, !inFlight else { return }
        inFlight = true
        let agents = selectedAgentList()
        let scope = dispatchScope()
        guard scope.project != nil || scope.cwd != nil else {
            refuseUnscopedDispatch()
            return
        }
        rememberProjectPick()
        switch action {
        case .plan:
            AgentsCLI.dispatchTicketAgent(note: note, screenshotPaths: selected,
                                          agent: agents.first, cwd: scope.cwd,
                                          project: scope.project)
        case .run:
            AgentsCLI.dispatchQuickFix(note: note, screenshotPaths: selected, agents: agents,
                                       cwd: scope.cwd, project: scope.project)
        }
        dismiss(preservingDraft: false)
    }

    /// Where the dispatch runs. A project the user picked by name is passed as
    /// `--project <name>` so the CLI resolves its base path and binds its sibling
    /// repos; only a narrowed worktree/subdirectory — which no project name
    /// addresses — falls back to `--cwd`.
    private func dispatchScope() -> (project: String?, cwd: String?) {
        // No definitions on this box: the path picker is offering recent session
        // cwds instead, so scope by directory (rebuildPathPicker).
        guard let def = selectedProject() else { return (nil, selectedPathDir()) }
        if let dir = selectedPathDir() { return (nil, dir) }
        return (def.name, nil)
    }

    /// Refuse to dispatch with NO scope at all. `agents run` with neither
    /// `--project` nor `--cwd` inherits the spawning process's cwd, and this
    /// helper is started by launchd with no `WorkingDirectory` — so the agent
    /// would land at `/`, a far broader permission surface than the `$HOME` this
    /// picker has always refused to offer. Fails loud with the fix rather than
    /// running somewhere the user did not choose (cli/AGENTS.md, "Fail loud at
    /// boundaries").
    private func refuseUnscopedDispatch() {
        Notifier.post(
            title: "Nowhere to run",
            body: "Define a project first: agents projects add <name>. "
                + "The palette will not dispatch an agent with no working directory.")
        inFlight = false
        updateHint()
    }

    private func rememberProjectPick() {
        guard let def = selectedProject() else { return }
        UserDefaults.standard.set(def.name, forKey: Self.lastProjectKey)
    }

    // Return submits, Escape clears. A single-line NSTextField sends these as
    // command selectors through the field editor — intercept them here.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.insertNewline(_:)) { submit(); return true }
        if sel == #selector(NSResponder.cancelOperation(_:)) { dismiss(preservingDraft: false); return true }
        return false
    }

    // MARK: Dispatch mode / agents

    @objc private func onModeChanged(_ sender: NSSegmentedControl) {
        action = QuickDispatchAction(rawValue: sender.selectedSegment) ?? .plan
        normalizeSelectionForAction()
        updateAgentButtons()
        updateHint()
    }

    @objc private func onAgentToggle(_ sender: NSButton) {
        guard sender.tag >= 0, sender.tag < roster.count else { return }
        let id = roster[sender.tag].id
        switch action {
        case .plan:
            selectedAgents = [id]
        case .run:
            if sender.state == .on {
                selectedAgents.insert(id)
            } else {
                selectedAgents.remove(id)
            }
            if selectedAgents.isEmpty {
                selectedAgents.insert(id)
            }
        }
        updateAgentButtons()
        updateHint()
    }

    private func rebuildAgents(restoring restoredAgents: Set<String>? = nil) {
        for v in agentStrip.arrangedSubviews {
            agentStrip.removeArrangedSubview(v)
            v.removeFromSuperview()
        }
        roster = LocalState.quickDispatchRoster()
        agentButtons = roster.enumerated().map { index, agent in
            let button = NSButton(checkboxWithTitle: agent.label, target: self,
                                  action: #selector(onAgentToggle(_:)))
            button.tag = index
            button.font = .systemFont(ofSize: 12.5, weight: .medium)
            button.contentTintColor = .labelColor
            return button
        }
        for button in agentButtons { agentStrip.addArrangedSubview(button) }
        selectedAgents = restoredAgents ?? defaultAgentSelection()
        normalizeSelectionForAction()
        updateAgentButtons()
    }

    private func defaultAgentSelection() -> Set<String> {
        let configured = ProcessInfo.processInfo.environment["AGENTS_QUICK_DISPATCH_AGENTS"]?
            .split(separator: ",")
            .map { LocalState.normalizeAgent(String($0).trimmingCharacters(in: .whitespacesAndNewlines)) }
            .filter { id in roster.contains { $0.id == id } } ?? []
        if !configured.isEmpty { return Set(configured) }
        return [roster.first?.id ?? "claude"]
    }

    private func selectedAgentList() -> [String] {
        let ordered = roster.map(\.id).filter { selectedAgents.contains($0) }
        return ordered.isEmpty ? [roster.first?.id ?? "claude"] : ordered
    }

    private func normalizeSelectionForAction() {
        let visible = Set(roster.map(\.id))
        selectedAgents = selectedAgents.intersection(visible)
        if selectedAgents.isEmpty {
            selectedAgents = [roster.first?.id ?? "claude"]
        }
        if action == .plan, let first = selectedAgentList().first {
            selectedAgents = [first]
        }
    }

    private func updateAgentButtons() {
        for (index, button) in agentButtons.enumerated() {
            let id = roster[index].id
            button.state = selectedAgents.contains(id) ? .on : .off
        }
    }

    // MARK: Project picker

    @objc private func onProjectChanged(_ sender: NSPopUpButton) {
        guard !rebuildingProjectPicker else { return }
        rememberProjectPick()
        rebuildPathPicker()
        updateHint()
        // The project IS the ticket scope: switching it switches the Linear project.
        refreshTicketScope()
    }

    @objc private func onProjectFilterChanged(_ sender: NSSearchField) {
        rebuildProjectPicker(selecting: selectedProject()?.name)
        rebuildPathPicker()
        updateHint()
        refreshTicketScope()
    }

    @objc private func onPathChanged(_ sender: NSPopUpButton) {
        guard !rebuildingPathPicker else { return }
        updateHint()
    }

    // Every defined project, BY NAME. The root is a tooltip, never the identity:
    // `prix` and `rush` share one checkout and must stay two rows.
    private func rebuildProjectPicker(selecting preferred: String? = nil) {
        rebuildingProjectPicker = true
        defer { rebuildingProjectPicker = false }

        let query = projectFilter.stringValue
        visibleProjects = ProjectCatalog.filter(projects, query: query)
        projectPicker.removeAllItems()
        guard !visibleProjects.isEmpty else {
            projectPicker.addItem(withTitle: projects.isEmpty
                ? "No projects (agents projects add …)"
                : "No project matches \u{201C}\(query)\u{201D}")
            projectPicker.isEnabled = false
            return
        }
        projectPicker.isEnabled = true
        for def in visibleProjects {
            projectPicker.addItem(withTitle: def.name)
            var tip = def.rootAbs ?? def.basePathAbs ?? def.name
            if let description = def.description, !description.isEmpty {
                tip = "\(description)\n\(tip)"
            }
            projectPicker.lastItem?.toolTip = tip
        }
        let wanted = preferred ?? UserDefaults.standard.string(forKey: Self.lastProjectKey)
        if let wanted, let idx = visibleProjects.firstIndex(where: { $0.name == wanted }) {
            projectPicker.selectItem(at: idx)
        } else {
            projectPicker.selectItem(at: 0)
        }
    }

    private func selectedProject() -> ProjectDef? {
        let idx = projectPicker.indexOfSelectedItem
        guard idx >= 0, idx < visibleProjects.count else { return nil }
        return visibleProjects[idx]
    }

    // Recent session cwds INSIDE the chosen project — a worktree or a monorepo
    // subdirectory. Row 0 is always the project itself.
    private func rebuildPathPicker() {
        rebuildingPathPicker = true
        defer { rebuildingPathPicker = false }

        let previous = selectedPathDir()
        pathPicker.removeAllItems()
        guard let def = selectedProject() else {
            // No project DEFINITION is selected. On a box that simply has none
            // defined yet — `agents projects` is a separate, opt-in resource, so
            // an existing palette user has none on upgrade — degrade to the recent
            // session cwds this picker used to offer, rather than dispatching with
            // no scope at all (which the helper's launchd process resolves as `/`).
            pathDirs = projects.isEmpty ? AgentsCLI.recentDirs(from: recentSessions) : []
            guard !pathDirs.isEmpty else {
                pathPicker.addItem(withTitle: "No project — add one first")
                pathPicker.lastItem?.toolTip =
                    "agents projects add <name>, or open a session in a repo so a recent directory is offered"
                pathPicker.isEnabled = false
                return
            }
            pathPicker.isEnabled = true
            for dir in pathDirs {
                pathPicker.addItem(withTitle: "\u{1F4C1} \((dir as NSString).lastPathComponent)")
                pathPicker.lastItem?.toolTip = "\(dir)\n\nRecent directory — define a project with agents projects add <name>"
            }
            if let previous, let idx = pathDirs.firstIndex(of: previous) {
                pathPicker.selectItem(at: idx)
            } else {
                pathPicker.selectItem(at: 0)
            }
            return
        }
        pathDirs = AgentsCLI.recentDirs(in: def, from: recentSessions)
        pathPicker.isEnabled = true
        pathPicker.addItem(withTitle: "\u{1F4C1} \(def.name)")
        pathPicker.lastItem?.toolTip = def.basePathAbs ?? def.name
        for dir in pathDirs {
            pathPicker.addItem(withTitle: "\u{21B3} \((dir as NSString).lastPathComponent)")
            pathPicker.lastItem?.toolTip = dir
        }
        if let previous, let idx = pathDirs.firstIndex(of: previous) {
            pathPicker.selectItem(at: idx + 1)
        } else {
            pathPicker.selectItem(at: 0)
        }
    }

    /// The narrowed directory inside the project, or nil when the project itself
    /// is selected (row 0) — in which case dispatch uses `--project <name>`.
    ///
    /// In the degraded no-definitions mode there is no project row, so row 0 is
    /// already a directory and the offset is 0.
    private func selectedPathDir() -> String? {
        let idx = pathPicker.indexOfSelectedItem - (selectedProject() == nil ? 0 : 1)
        guard idx >= 0, idx < pathDirs.count else { return nil }
        return pathDirs[idx]
    }

    // MARK: Linear tickets

    private func projectOverride(for projectName: String) -> String? {
        UserDefaults.standard.string(forKey: Self.projectOverrideKeyPrefix + projectName)
    }

    @objc private func onLinearProjectChanged(_ sender: NSPopUpButton) {
        // Populating the popup selects its first item, which arrives here as an
        // action — persisting that would pin every project to whatever Linear
        // happens to list first.
        guard !rebuildingLinearPicker else { return }
        guard let name = sender.titleOfSelectedItem, let def = selectedProject(),
              name != activeProject?.name else { return }
        // An explicit pick sticks to this project, which is how a project whose
        // binding is missing or points at the wrong Linear project gets corrected
        // without editing the definition.
        UserDefaults.standard.set(name, forKey: Self.projectOverrideKeyPrefix + def.name)
        refreshTicketScope()
    }

    @objc private func onFilterChanged(_ sender: NSPopUpButton) {
        guard !rebuildingFilterPickers else { return }
        let idx = sender.indexOfSelectedItem
        let all = LinearTickets.QuickFilter.allCases
        guard idx >= 0, idx < all.count else { return }
        ticketFilter = all[idx]
        UserDefaults.standard.set(ticketFilter.rawValue, forKey: Self.lastFilterKey)
        reapplyTicketList()
    }

    @objc private func onSortChanged(_ sender: NSPopUpButton) {
        guard !rebuildingFilterPickers else { return }
        let idx = sender.indexOfSelectedItem
        let all = LinearTickets.QuickSort.allCases
        guard idx >= 0, idx < all.count else { return }
        ticketSort = all[idx]
        UserDefaults.standard.set(ticketSort.rawValue, forKey: Self.lastSortKey)
        reapplyTicketList()
    }

    private func restoreTicketControls() {
        if let raw = UserDefaults.standard.string(forKey: Self.lastFilterKey),
           let f = LinearTickets.QuickFilter(rawValue: raw) {
            ticketFilter = f
        }
        if let raw = UserDefaults.standard.string(forKey: Self.lastSortKey),
           let s = LinearTickets.QuickSort(rawValue: raw) {
            ticketSort = s
        }
        rebuildFilterAndSortPickers()
    }

    private func rebuildFilterAndSortPickers() {
        rebuildingFilterPickers = true
        defer { rebuildingFilterPickers = false }

        filterPicker.removeAllItems()
        for f in LinearTickets.QuickFilter.allCases {
            filterPicker.addItem(withTitle: f.title)
        }
        if let idx = LinearTickets.QuickFilter.allCases.firstIndex(of: ticketFilter) {
            filterPicker.selectItem(at: idx)
        }

        sortPicker.removeAllItems()
        for s in LinearTickets.QuickSort.allCases {
            sortPicker.addItem(withTitle: s.title)
        }
        if let idx = LinearTickets.QuickSort.allCases.firstIndex(of: ticketSort) {
            sortPicker.selectItem(at: idx)
        }
    }

    /// Re-run filter+sort on the cached tickets for the active project (no fetch).
    private func reapplyTicketList() {
        guard let project = activeProject,
              let tickets = linearCache.scopes[project.name]?.tickets else {
            updateHint()
            return
        }
        visibleTickets = rankedAndFiltered(tickets)
        renderTickets()
    }

    // Point the ticket list at the Linear project BOUND to the picked project:
    // rebuild the Linear popup, render whatever is cached, and fetch when the
    // cache is stale.
    private func refreshTicketScope() {
        ticketFetchToken += 1
        let def = selectedProject()
        activeProject = LinearTickets.linearProject(
            for: def,
            projects: linearCache.projects,
            override: def.flatMap { projectOverride(for: $0.name) })
        rebuildLinearPicker()

        if linearCache.projects.isEmpty { fetchProjects() }

        guard let project = activeProject else {
            visibleTickets = []
            if let def {
                // Not an empty list — an unbound project, plus the command that
                // binds it. An empty list would read as "no open tickets".
                renderTickets(status: LinearTickets.unboundProjectHint(def.name))
            } else {
                renderTickets(status: "pick a project to see its tickets")
            }
            return
        }
        let cached = linearCache.scopes[project.name]?.tickets
        visibleTickets = rankedAndFiltered(cached ?? [])
        renderTickets(status: cached == nil ? "loading \(project.name)…" : nil)
        if !LinearTickets.isFresh(linearCache, project: project.name) {
            fetchTickets(project: project.name)
        }
    }

    private func fetchProjects() {
        let token = ticketFetchToken
        AgentsCLI.linearProjectsAsync { [weak self] projects in
            guard let self, let projects else { return }
            self.linearCache = LinearTickets.merged(self.linearCache, projects: projects)
            LinearTickets.saveCache(self.linearCache)
            // A project list arriving after a scope change still helps the CURRENT
            // scope, so re-resolve rather than dropping it on the token check.
            if token == self.ticketFetchToken || self.activeProject == nil { self.refreshTicketScope() }
        }
    }

    private func fetchTickets(project: String) {
        let token = ticketFetchToken
        AgentsCLI.linearTicketsAsync(project: project) { [weak self] tickets in
            guard let self else { return }
            guard let tickets else {
                if token == self.ticketFetchToken, self.visibleTickets.isEmpty {
                    self.renderTickets(status: "could not reach Linear")
                }
                return
            }
            self.linearCache = LinearTickets.merged(self.linearCache, project: project,
                                                    tickets: tickets)
            LinearTickets.saveCache(self.linearCache)
            guard token == self.ticketFetchToken, self.activeProject?.name == project else { return }
            self.visibleTickets = self.rankedAndFiltered(tickets)
            self.renderTickets()
        }
    }

    // Quick filter + sort, then the typed note as a text search — so an existing
    // ticket surfaces before Return files a duplicate. Flat list only (no groups).
    private func rankedAndFiltered(_ tickets: [LinearTicket]) -> [LinearTicket] {
        let query = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return LinearTickets.list(tickets,
                                  filter: ticketFilter,
                                  sort: ticketSort,
                                  query: query)
    }

    private func renderTickets(status: String? = nil) {
        for v in ticketList.arrangedSubviews {
            ticketList.removeArrangedSubview(v)
            v.removeFromSuperview()
        }
        for (index, ticket) in visibleTickets.enumerated() {
            let row = TicketRowView(ticket: ticket, index: index)
            row.onDispatch = { [weak self] t in self?.dispatchTicket(t) }
            row.onOpen = { [weak self] t in self?.openTicket(t) }
            ticketList.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: ticketList.widthAnchor).isActive = true
        }
        applyTicketVisibility()
        ticketStatus.stringValue = status ?? ticketCountText()
        // Document height grows with rows; the scroll viewport stays fixed so the
        // user can scroll through the full filtered set.
        let width = max(ticketScroll.contentSize.width, Self.panelWidth - 44)
        let contentH = max(CGFloat(visibleTickets.count) * TicketRowView.height, 1)
        ticketList.frame = NSRect(x: 0, y: 0, width: width, height: contentH)
        applyContentHeight()
        updateHint()
    }

    private func ticketCountText() -> String {
        guard let project = activeProject else { return "" }
        let total = linearCache.scopes[project.name]?.tickets.count ?? 0
        if total == 0 { return "no open tickets" }
        if visibleTickets.isEmpty {
            return "\(total) open · none match filter"
        }
        let shown = visibleTickets.count
        let sortBit = ticketSort == .urgentFirst ? "urgent first" : ticketSort.title.lowercased()
        if shown < total || ticketFilter != .all {
            return "\(shown)/\(total) · \(sortBit) · \u{2318}N"
        }
        return "\(total) open · \(sortBit) · click or \u{2318}N"
    }

    private func rebuildLinearPicker() {
        rebuildingLinearPicker = true
        defer { rebuildingLinearPicker = false }
        linearPicker.removeAllItems()
        let names = linearCache.projects.map(\.name)
        guard !names.isEmpty else {
            linearPicker.addItem(withTitle: activeProject?.name ?? "Linear project")
            linearPicker.isEnabled = false
            return
        }
        linearPicker.isEnabled = true
        for name in names {
            linearPicker.addItem(withTitle: name)
            linearPicker.lastItem?.toolTip = "Scope the ticket list to \(name)"
        }
        if let active = activeProject, let idx = names.firstIndex(of: active.name) {
            linearPicker.selectItem(at: idx)
        }
    }

    // Cmd-click a row: read the ticket in Linear instead of dispatching it. Same
    // dismissal suppression as the screenshot preview — the browser taking focus
    // must not throw away the typed note.
    private func openTicket(_ ticket: LinearTicket) {
        guard let raw = ticket.url, let url = URL(string: raw) else { return }
        suppressDismiss = true
        NSWorkspace.shared.open(url)
    }

    // Dispatch an EXISTING ticket: same agents, same repo, same balanced headless
    // run as a quick Run — Plan asks for a plan comment on the ticket, Run asks for
    // the change. The panel closes immediately, like a submit does, so a second
    // click can't double-dispatch.
    private func dispatchTicket(_ ticket: LinearTicket) {
        guard !inFlight else { return }
        inFlight = true
        let scope = dispatchScope()
        guard scope.project != nil || scope.cwd != nil else {
            refuseUnscopedDispatch()
            return
        }
        rememberProjectPick()
        AgentsCLI.dispatchTicketWork(ticket: ticket, agents: selectedAgentList(),
                                     action: action, cwd: scope.cwd, project: scope.project)
        dismiss(preservingDraft: false)
    }

    // Dispatch the Nth listed ticket (Cmd-1 … Cmd-9). False when no such row is
    // listed, so the keystroke falls through to the text field.
    private func dispatchTicket(at index: Int) -> Bool {
        guard index >= 0, index < visibleTickets.count else { return false }
        dispatchTicket(visibleTickets[index])
        return true
    }

    // MARK: Thumbnails

    private func rebuildThumbs(paths: [String], thumbnails: [String: CGImage],
                               restoring restoredSelection: [String]? = nil) {
        for v in thumbStrip.arrangedSubviews {
            thumbStrip.removeArrangedSubview(v)
            v.removeFromSuperview()
        }
        selected = []
        let restoredSet = Set(restoredSelection ?? [])
        for path in paths {
            let thumb = ClipThumbView(path: path, thumbnail: thumbnails[path])
            if restoredSelection != nil {
                if restoredSet.contains(path) {
                    thumb.isSelected = true
                    selected.append(path)
                }
            } else if path == paths.first, isRecent(path) {
                // Pre-select the newest clip only when it's recent enough to relate
                // to what the user just captured.
                thumb.isSelected = true
                selected.append(path)
            }
            thumb.onToggle = { [weak self] t in self?.toggle(t) }
            thumb.onPreview = { [weak self] t in self?.preview(t) }
            thumbStrip.addArrangedSubview(thumb)
        }
        thumbStrip.isHidden = thumbStrip.arrangedSubviews.isEmpty
        applyContentHeight()
        updateHint()
    }

    // Open the full screenshot in the default image viewer so the user can confirm
    // which one it is (thumbnails are small). Suppress the bar's click-outside
    // dismissal so summoning Preview doesn't close the bar / lose the typed note;
    // it re-arms when the bar regains key focus (panel.onBecomeKey).
    private func preview(_ thumb: ClipThumbView) {
        suppressDismiss = true
        NSWorkspace.shared.open(URL(fileURLWithPath: thumb.path))
    }

    private func toggle(_ thumb: ClipThumbView) {
        thumb.isSelected.toggle()
        if thumb.isSelected {
            selected.append(thumb.path)
        } else {
            selected.removeAll { $0 == thumb.path }
        }
        // Keep newest-first order regardless of click order.
        selected.sort {
            (recentImagePaths.firstIndex(of: $0) ?? .max)
                < (recentImagePaths.firstIndex(of: $1) ?? .max)
        }
        updateHint()
    }

    /// Rescan the screenshot directories, decode bounded thumbnails off the main
    /// thread, and rebuild the strip — the ONE path that fills the thumbnails,
    /// driven by summon AND by ScreenshotWatcher's FSEvents callback.
    ///
    /// Deliberately NOT time-gated. The old `hydrateContent` refused to re-run
    /// inside 30 seconds and also owned the Linear cache read, so the one guard
    /// that made sense for a `linear-cache.json` parse silently froze the
    /// screenshot strip for half a minute at a time (PHNX-4001). The guard now
    /// lives on the Linear read alone (`loadLinearCache`), and this coalesces
    /// instead: a scan already in flight sets `pendingRescan` and runs once more
    /// when it lands, so an FSEvents burst is one extra scan, never a queue.
    private func rescanAttachments() {
        if scanInFlight { pendingRescan = true; return }
        scanInFlight = true
        Self.hydrationQueue.async { [weak self] in
            let paths = AgentsCLI.recentImageAttachments()
            var thumbnails: [String: CGImage] = [:]
            for path in paths {
                if let image = Self.thumbnail(at: path) { thumbnails[path] = image }
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.scanInFlight = false
                let unchanged = paths == self.recentImagePaths
                self.recentImagePaths = paths
                self.thumbnailCache = thumbnails
                // Rebuilding an unchanged strip would throw away the current
                // selection chrome and refocus nothing; skip it.
                if !unchanged || self.pendingRestoredSelection != nil {
                    let selectionToRestore = self.pendingRestoredSelection
                        ?? (self.panel?.isVisible == true ? self.selected : nil)
                    self.rebuildThumbs(paths: paths, thumbnails: thumbnails,
                                       restoring: selectionToRestore)
                    self.pendingRestoredSelection = nil
                }
                if self.pendingRescan {
                    self.pendingRescan = false
                    self.rescanAttachments()
                }
            }
        }
    }

    /// Parse `linear-cache.json` off the main thread. This is the read the 30s
    /// freshness guard was written for — a JSON parse of every cached ticket,
    /// whose content only changes when a `linear tasks` fetch lands.
    private func loadLinearCache() {
        if let linearCacheReadAt, Date().timeIntervalSince(linearCacheReadAt) < 30 { return }
        linearCacheReadAt = Date()
        Self.hydrationQueue.async { [weak self] in
            let cache = LinearTickets.loadCache()
            DispatchQueue.main.async {
                guard let self else { return }
                self.linearCache = cache
                self.restoreTicketControls()
                if self.panel?.isVisible == true { self.refreshTicketScope() }
            }
        }
    }

    private static func thumbnail(at path: String) -> CGImage? {
        let url = URL(fileURLWithPath: path) as CFURL
        guard let source = CGImageSourceCreateWithURL(url, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 108,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    // MARK: Paste / drop

    /// Cmd-V with an image on the clipboard. Returns false when the clipboard
    /// holds no image, so the keystroke falls through to a normal text paste.
    /// The pasteboard→attachment decision itself lives in
    /// `AgentsCLI.imageAttachments(from:)` so it is driven by a real
    /// `NSPasteboard` in the headless self-test.
    private func pasteImagesFromPasteboard() -> Bool {
        let written = AgentsCLI.imageAttachments(from: .general)
        guard !written.isEmpty else { return false }
        attachNewly(written)
        return true
    }

    /// Show freshly written attachments in the strip and select them, without
    /// waiting for the FSEvents round trip (the attachments dir is watched, but a
    /// paste should be visible on the very next frame).
    private func attachNewly(_ paths: [String]) {
        let keep = Set(selected).union(paths)
        recentImagePaths = paths + recentImagePaths.filter { !paths.contains($0) }
        for path in paths where thumbnailCache[path] == nil {
            if let image = Self.thumbnail(at: path) { thumbnailCache[path] = image }
        }
        rebuildThumbs(paths: recentImagePaths, thumbnails: thumbnailCache,
                      restoring: recentImagePaths.filter { keep.contains($0) })
    }

    // MARK: Tickets fold

    @objc private func toggleTickets() {
        ticketsExpanded.toggle()
        UserDefaults.standard.set(ticketsExpanded, forKey: Self.ticketsExpandedKey)
        applyTicketVisibility()
        if ticketsExpanded { refreshTicketScope() }
        applyContentHeight()
        updateHint()
    }

    private func applyTicketVisibility() {
        ticketHeader?.isHidden = !ticketsExpanded
        ticketScroll.isHidden = !ticketsExpanded || visibleTickets.isEmpty
    }

    private func isRecent(_ path: String) -> Bool {
        guard let mtime = (try? FileManager.default.attributesOfItem(atPath: path))?[.modificationDate] as? Date
        else { return false }
        return Date().timeIntervalSince(mtime) <= Self.recentClipWindow
    }

    private func updateHint() {
        let count = selected.count
        let attach = count == 0 ? "no image attached"
            : count == 1 ? "1 image attached" : "\(count) images attached"
        let pickable = thumbStrip.arrangedSubviews.isEmpty
            ? " · ⌘V or drop to attach"
            : " · click attaches · ⌫ removes · dbl-click previews"
        let agents = selectedAgentList().map(LocalState.agentLabel).joined(separator: ", ")
        let where_ = dispatchScope()
        let scope = where_.cwd.map { " in \(($0 as NSString).lastPathComponent)" }
            ?? where_.project.map { " in \($0)" }
        let actionText: String
        if let scope {
            actionText = action == .plan
                ? "file ticket + plan with \(agents)\(scope)"
                : "run \(agents)\(scope) · balanced"
        } else {
            // Never render an unscoped dispatch as if it were a normal one.
            actionText = "no project — agents projects add <name>"
        }
        let tickets = ticketsExpanded ? "⌘T hides tickets" : "⌘T tickets"
        let pinned = panel?.isPinned == true ? " · pinned" : ""
        // Deliberately unchanged in length by the ticket list: this label's
        // intrinsic width is what sizes the panel, and the rows carry their own
        // `⌘N` chips plus a click/⌘click tooltip, so nothing needs saying here.
        hint.stringValue = "\(attach)\(pickable)    ↩ \(actionText) · \(tickets) · esc clear\(pinned)"
    }

    // Typing is also a ticket search: narrow the list so an existing ticket shows
    // up before Return files a duplicate.
    func controlTextDidChange(_ obj: Notification) {
        guard let project = activeProject,
              let tickets = linearCache.scopes[project.name]?.tickets else {
            updateHint()
            return
        }
        visibleTickets = rankedAndFiltered(tickets)
        renderTickets()
    }

    // Height is additive over the fixed capture half; the ticket viewport is a
    // fixed-height scroll area so many open tickets do not push the panel taller.
    // Grows downward from a fixed top edge so an async fill does not shift the
    // text field out from under the cursor.
    private func applyContentHeight() {
        guard let panel else { return }
        var height = Self.baseHeight
        if ticketsExpanded {
            height += Self.ticketSectionChrome
            if !ticketScroll.isHidden { height += Self.ticketViewportHeight }
        }
        if !thumbStrip.isHidden { height += Self.thumbStripHeight }
        guard abs(panel.frame.height - height) > 0.5 else { return }
        let top = panel.frame.maxY
        panel.setContentSize(NSSize(width: Self.panelWidth, height: height))
        if panel.isVisible {
            panel.setFrameOrigin(NSPoint(x: panel.frame.minX, y: top - panel.frame.height))
        }
    }

    // MARK: Build / layout

    private func buildPanel() -> PromptPanel {
        let panel = PromptPanel(
            contentRect: NSRect(x: 0, y: 0, width: Self.panelWidth, height: 188),
            styleMask: [.borderless],
            backing: .buffered, defer: false)
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.applyPinnedBehavior()
        panel.onResignKey = { [weak self] in
            guard let self, self.dismissArmed, !self.suppressDismiss else { return }
            self.dismiss()
        }
        // Returning to the bar after a preview re-arms click-outside dismissal.
        panel.onBecomeKey = { [weak self] in self?.suppressDismiss = false }
        panel.onTicketShortcut = { [weak self] index in self?.dispatchTicket(at: index) ?? false }
        panel.onPasteImages = { [weak self] in self?.pasteImagesFromPasteboard() ?? false }
        panel.onToggleTickets = { [weak self] in self?.toggleTickets() }

        let bg = PromptDropView()
        bg.material = .hudWindow
        bg.blendingMode = .behindWindow
        bg.state = .active
        bg.wantsLayer = true
        bg.layer?.cornerRadius = 14
        bg.layer?.masksToBounds = true
        bg.layer?.borderWidth = 1
        bg.layer?.borderColor = kAccent.withAlphaComponent(0.35).cgColor
        // Drop image files anywhere on the palette — same handler as Cmd-V.
        bg.registerForDraggedTypes([.fileURL])
        bg.onDropImages = { [weak self] pasteboard in
            guard let self else { return }
            let written = AgentsCLI.imageAttachments(from: pasteboard)
            if !written.isEmpty { self.attachNewly(written) }
        }
        panel.contentView = bg

        field.placeholderString = "Describe the task…"
        field.font = .systemFont(ofSize: 21, weight: .regular)
        field.textColor = .labelColor
        field.isBezeled = false
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.lineBreakMode = .byTruncatingTail
        field.usesSingleLineMode = true
        field.delegate = self

        thumbStrip.orientation = .horizontal
        thumbStrip.alignment = .centerY
        thumbStrip.spacing = 8

        modeControl.target = self
        modeControl.action = #selector(onModeChanged(_:))
        modeControl.selectedSegment = QuickDispatchAction.plan.rawValue
        modeControl.segmentStyle = .rounded
        modeControl.translatesAutoresizingMaskIntoConstraints = false

        agentStrip.orientation = .horizontal
        agentStrip.alignment = .centerY
        agentStrip.spacing = 10
        rebuildAgents()

        for picker in [projectPicker, pathPicker] {
            picker.translatesAutoresizingMaskIntoConstraints = false
            picker.controlSize = .small
            picker.font = .systemFont(ofSize: 12)
            picker.target = self
        }
        projectPicker.action = #selector(onProjectChanged(_:))
        pathPicker.action = #selector(onPathChanged(_:))

        // Type-ahead over the project list. Small and beside the popup rather than
        // a second row: the palette is a one-line capture bar, and filtering is a
        // refinement of the popup next to it, not a mode of its own.
        projectFilter.translatesAutoresizingMaskIntoConstraints = false
        projectFilter.controlSize = .small
        projectFilter.font = .systemFont(ofSize: 12)
        projectFilter.placeholderString = "filter"
        projectFilter.sendsSearchStringImmediately = true
        projectFilter.sendsWholeSearchString = false
        projectFilter.target = self
        projectFilter.action = #selector(onProjectFilterChanged(_:))
        projectFilter.toolTip = "Filter the project list — type part of a name"

        // Pin: keep the palette on screen when another app takes focus. Same
        // toggle as pressing the summon chord while it is already focused.
        pinButton.translatesAutoresizingMaskIntoConstraints = false
        pinButton.bezelStyle = .texturedRounded
        pinButton.setButtonType(.pushOnPushOff)
        pinButton.controlSize = .small
        pinButton.image = NSImage(systemSymbolName: "pin", accessibilityDescription: "Pin")
        pinButton.alternateImage = NSImage(systemSymbolName: "pin.fill", accessibilityDescription: "Unpin")
        pinButton.imagePosition = .imageOnly
        pinButton.target = self
        pinButton.action = #selector(onPinToggled(_:))

        hint.font = .monospacedSystemFont(ofSize: 11.5, weight: .regular)
        hint.textColor = .secondaryLabelColor

        linearPicker.translatesAutoresizingMaskIntoConstraints = false
        linearPicker.controlSize = .small
        linearPicker.font = .systemFont(ofSize: 12)
        linearPicker.target = self
        linearPicker.action = #selector(onLinearProjectChanged(_:))

        // Same control size as the project popup — one compact row of dropdowns,
        // not a two-column chip matrix.
        for picker in [filterPicker, sortPicker] {
            picker.translatesAutoresizingMaskIntoConstraints = false
            picker.controlSize = .small
            picker.font = .systemFont(ofSize: 12)
        }
        filterPicker.target = self
        filterPicker.action = #selector(onFilterChanged(_:))
        sortPicker.target = self
        sortPicker.action = #selector(onSortChanged(_:))
        rebuildFilterAndSortPickers()

        ticketStatus.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        ticketStatus.textColor = .tertiaryLabelColor
        ticketStatus.lineBreakMode = .byTruncatingTail
        ticketStatus.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        ticketList.orientation = .vertical
        ticketList.alignment = .leading
        ticketList.spacing = 0
        ticketList.translatesAutoresizingMaskIntoConstraints = false

        // Scrollable ticket body: fixed viewport, document grows with rows.
        // Document view uses flipped coordinate + explicit width so rows stay
        // full-width as the user scrolls (stack-as-document without a flip view
        // pins from the bottom and clips the first rows).
        ticketScroll.drawsBackground = false
        ticketScroll.hasVerticalScroller = true
        ticketScroll.hasHorizontalScroller = false
        ticketScroll.autohidesScrollers = true
        ticketScroll.borderType = .noBorder
        ticketScroll.scrollerStyle = .overlay
        ticketScroll.translatesAutoresizingMaskIntoConstraints = false
        let clip = FlippedClipView()
        clip.drawsBackground = false
        ticketScroll.contentView = clip
        ticketScroll.documentView = ticketList
        clip.postsBoundsChangedNotifications = true

        let controlRow = NSStackView(views: [modeControl, projectFilter, projectPicker,
                                            pathPicker, pinButton])
        controlRow.orientation = .horizontal
        controlRow.alignment = .centerY
        controlRow.spacing = 8

        // One row: Linear project (1:1 ticket scope) · quick filter · quick sort ·
        // count. No block cards — same popup language as the project row above.
        let ticketTitle = NSTextField(labelWithString: "Tickets")
        ticketTitle.font = .monospacedSystemFont(ofSize: 11, weight: .medium)
        ticketTitle.textColor = .secondaryLabelColor
        let header = NSStackView(views: [ticketTitle, linearPicker, filterPicker,
                                         sortPicker, ticketStatus])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = 8
        ticketHeader = header

        let stack = NSStackView(views: [field, controlRow, agentStrip, thumbStrip,
                                        header, ticketScroll, hint])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        bg.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: bg.leadingAnchor, constant: 22),
            stack.trailingAnchor.constraint(equalTo: bg.trailingAnchor, constant: -22),
            stack.centerYAnchor.constraint(equalTo: bg.centerYAnchor),
            field.widthAnchor.constraint(equalTo: stack.widthAnchor),
            modeControl.widthAnchor.constraint(equalToConstant: 180),
            ticketScroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            ticketScroll.heightAnchor.constraint(equalToConstant: Self.ticketViewportHeight),
            // The panel is a fixed-width bar: cap the popups so long names truncate
            // inside them instead of stretching the window past panelWidth.
            projectFilter.widthAnchor.constraint(equalToConstant: 96),
            projectPicker.widthAnchor.constraint(lessThanOrEqualToConstant: 170),
            pathPicker.widthAnchor.constraint(lessThanOrEqualToConstant: 170),
            pinButton.widthAnchor.constraint(equalToConstant: 28),
            linearPicker.widthAnchor.constraint(lessThanOrEqualToConstant: 160),
            filterPicker.widthAnchor.constraint(lessThanOrEqualToConstant: 110),
            sortPicker.widthAnchor.constraint(lessThanOrEqualToConstant: 120),
        ])
        rebuildProjectPicker()
        rebuildPathPicker()
        syncPinButton()
        applyTicketVisibility()
        return panel
    }

    @objc private func onPinToggled(_ sender: NSButton) {
        panel?.isPinned = sender.state == .on
        syncPinButton()
        updateHint()
    }

    private func syncPinButton() {
        let pinned = panel?.isPinned ?? false
        pinButton.state = pinned ? .on : .off
        pinButton.toolTip = pinned
            ? "Pinned — stays open when another app takes focus (⌘⇧O toggles)"
            : "Pin — keep the palette open when another app takes focus (⌘⇧O toggles)"
    }

    // Center horizontally, sit ~20% above vertical center (where Spotlight lives).
    private func position(_ panel: PromptPanel) {
        // In the QA preview affordance, pin to the PRIMARY screen. An unbundled
        // dev build does not keep app activation, so `NSScreen.main` can resolve
        // to whichever display last had a key window — on a multi-display desk
        // that put the panel on a screen a window capture could not reach, which
        // is the whole point of the preview mode. Never taken by a real summon.
        let previewing = ProcessInfo.processInfo.environment["MENUBAR_PROMPT_PREVIEW"] == "1"
        let target = previewing ? NSScreen.screens.first : NSScreen.main
        guard let screen = target else { panel.center(); return }
        let vf = screen.visibleFrame
        let size = panel.frame.size
        let x = vf.minX + (vf.width - size.width) / 2
        let y = vf.minY + (vf.height - size.height) / 2 + vf.height * 0.20
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }
}

// Top-left origin for the ticket list document view so row 0 is at the top of
// the scroll view (AppKit's default NSClipView is bottom-left).
private final class FlippedClipView: NSClipView {
    override var isFlipped: Bool { true }
}

// Local notifications for the ticket flow. NSUserNotification is deprecated but
// needs no framework link and no authorization prompt — right for a signed
// menu-bar helper delivering an occasional user-invoked confirmation.
//
// Clicking a completion notification opens the created ticket. NSUserNotification
// carries no click target on its own, so stash the URL in userInfo and open it
// from the center delegate's didActivate. Also force-present the banner even when
// this (accessory) app is frontmost, so the "Created RUSH-####" notice never gets
// swallowed silently.
final class NotifierDelegate: NSObject, NSUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: NSUserNotificationCenter,
                                didActivate notification: NSUserNotification) {
        if let s = notification.userInfo?["url"] as? String, let url = URL(string: s) {
            NSWorkspace.shared.open(url)
        }
    }
    func userNotificationCenter(_ center: NSUserNotificationCenter,
                                shouldPresent notification: NSUserNotification) -> Bool { true }
}

enum Notifier {
    private static let delegate = NotifierDelegate()
    private static var wired = false

    // Register the click delegate without delivering anything. Called at app
    // launch so the persistent menu-bar instance handles clicks on notifications
    // the daemon posts via one-shot `--notify` processes (RUSH-2030). Idempotent.
    static func wireClickHandler() {
        if !wired {
            NSUserNotificationCenter.default.delegate = delegate
            wired = true
        }
    }

    // `url`, when present, is opened on click (the created ticket, or a routine
    // report/log for daemon notifications). `subtitle` is the secondary line.
    //
    // `agent` names the harness the notification is ABOUT (`claude`, `codex`, …)
    // and drives the banner's RIGHT-hand `contentImage` via AgentAvatar. The LEFT
    // slot is the sending bundle's app icon, which macOS resolves from
    // MenubarHelper.app's LaunchServices record — so the two slots read as
    // "agents-cli, about Claude", the layout the system uses for a YouTube
    // notification (app icon left, channel avatar right). Passing no agent leaves
    // the right slot empty on purpose: `contentImage` used to be the agents-cli
    // app icon, which just repeated the left slot and said nothing.
    static func post(title: String, body: String, subtitle: String? = nil,
                     url: String? = nil, agent: String? = nil) {
        wireClickHandler()
        let note = NSUserNotification()
        note.title = title
        if let subtitle { note.subtitle = subtitle }
        note.informativeText = body
        if let url {
            note.userInfo = ["url": url]
            note.hasActionButton = true
            note.actionButtonTitle = "Open"
        }
        if let image = AgentAvatar.image(for: agent) {
            note.contentImage = image
        }
        NSUserNotificationCenter.default.deliver(note)
    }

    // Daemon notification one-shot: `"AGI Menu" --notify --title T --body B
    // [--subtitle S] [--action A] [--agent claude]` (RUSH-2030). The daemon spawns
    // the installed .app in this mode, so the notification is attributed to this
    // bundle and shows its AppIcon (the agents-cli mark) on the left — not the
    // generic osascript icon. `--agent` adds the harness avatar on the right.
    // Delivers, briefly spins the runloop so NSUserNotificationCenter flushes
    // before the short-lived process exits, then exits.
    static func runOneShot(_ args: [String]) -> Never {
        func value(_ flag: String) -> String? {
            guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
            return args[i + 1]
        }
        guard let title = value("--title"), let body = value("--body") else { exit(2) }
        // Hard self-terminate watchdog: guarantee this one-shot exits even if
        // delivery stalls (a locked screen or WindowServer/XPC hiccup can block
        // NSUserNotificationCenter.deliver on the main thread, so the runloop spin
        // below never reaches its deadline and the process hangs — piling up in
        // the menu bar). It runs on a BACKGROUND queue, not `.main`: a wedged main
        // thread can't starve it, so the force-exit fires regardless of runloop
        // state. 3s sits above the 0.6s happy-path flush and below the Node-side
        // 4s SIGKILL (notify-desktop.ts), so the process reliably ends itself.
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 3) {
            exit(0)
        }
        // Establish the app object so delivery has a running NSApplication to
        // attribute the notification to; never call run() — the runloop spin below
        // drives this short-lived process.
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        post(title: title, body: body, subtitle: value("--subtitle"),
             url: clickURL(for: value("--action")), agent: value("--agent"))
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        exit(0)
    }

    // Map the daemon action deep-link to a URL the click delegate opens:
    //   open:<path>   -> the run report/log file (opens in the default app)
    //   url:<https…>  -> a web target (the PR or ticket a finished run produced)
    //   routines:list -> the runs-history folder (opens in Finder)
    // Any other/absent action yields no click target.
    private static func clickURL(for action: String?) -> String? {
        guard let action else { return nil }
        if action.hasPrefix("open:") {
            return URL(fileURLWithPath: String(action.dropFirst("open:".count))).absoluteString
        }
        if action.hasPrefix("url:") {
            // Only web schemes: the click handler hands this straight to
            // NSWorkspace, so a `file:`/custom scheme here would be an arbitrary
            // open-anything primitive driven by a notification argument.
            let raw = String(action.dropFirst("url:".count))
            guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(),
                  scheme == "https" || scheme == "http" else { return nil }
            return url.absoluteString
        }
        if action == "routines:list" {
            return URL(fileURLWithPath: "\(NSHomeDirectory())/.agents/.history/runs").absoluteString
        }
        return nil
    }
}
