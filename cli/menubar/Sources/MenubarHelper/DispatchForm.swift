import AppKit
import Foundation

// Track E (PHNX-4005) — the dispatch form the palette embeds below its text
// field. It owns the dispatch dimensions the panel did not already carry — mode
// (Plan / Auto / Edit), run-on (This Mac / auto / a fleet device), surface
// (Interactive / Headless), and watchdog (Off / Keep moving / Hands-off) — plus
// the collapsed summary line and the `▸ details` disclosure. Agent chips and the
// project popup stay the palette's own (the brief: reuse, do not duplicate); this
// view reads them for the summary and the remembered defaults.
//
// It holds only presentation state and calls back to the controller; it never
// spawns anything and owns no timer. The argv it drives is built by the pure
// AgentsCLI.dispatchArgs (self-tested), and the remembered defaults round-trip
// through DispatchDefaults.

private let kAccentForm = NSColor(red: 0xa3/255.0, green: 0xe6/255.0, blue: 0x35/255.0, alpha: 1)

// MARK: - Agent caption (`agents view --json`)

/// The active-account state + version for one harness, decoded from
/// `agents view --json` (cli/src/lib/view-types.ts `ViewJsonAgent`/`ViewJsonVersion`).
/// Only the fields the chip caption needs are kept; every one is optional so an
/// older/newer CLI still decodes.
struct AgentCaption: Equatable {
    let agent: String
    /// The default installed version's number (the value `agents --version`
    /// prints), or the first version when none is flagged default.
    let version: String?
    let signedIn: Bool
    let email: String?

    private struct AgentJSON: Decodable {
        let agent: String
        let versions: [VersionJSON]?
        struct VersionJSON: Decodable {
            let version: String?
            let isDefault: Bool?
            let signedIn: Bool?
            let email: String?
        }
    }

    /// Decode `agents view --json` into a per-harness caption map, keyed by agent
    /// id. Returns nil only when the payload is not a decodable agent array.
    static func decodeMap(_ data: Data) -> [String: AgentCaption]? {
        guard let rows = try? JSONDecoder().decode([AgentJSON].self, from: data) else { return nil }
        var out: [String: AgentCaption] = [:]
        for row in rows {
            let versions = row.versions ?? []
            let chosen = versions.first { $0.isDefault == true } ?? versions.first
            out[row.agent] = AgentCaption(
                agent: row.agent,
                version: chosen?.version,
                signedIn: chosen?.signedIn ?? false,
                email: chosen?.email)
        }
        return out
    }

    /// The short caption under a chip: version and sign-in, e.g. `2.1.263 · muqsit`
    /// or `signed out`.
    var chipCaption: String {
        var parts: [String] = []
        if let version, !version.isEmpty { parts.append(version) }
        if signedIn {
            if let email, !email.isEmpty {
                parts.append(email.split(separator: "@").first.map(String.init) ?? email)
            }
        } else {
            parts.append("signed out")
        }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Run-on options

/// One entry of the run-on popup: This Mac, auto, or a named device. `token` is
/// what rides `--device` (nil for This Mac / "auto"/name otherwise) and what the
/// defaults persist as `runOn` (`local`/`auto`/name).
struct RunOnOption: Equatable {
    let token: String   // "local" | "auto" | device name
    let title: String
    let enabled: Bool

    /// Build the popup entries from the fleet snapshot: This Mac first, then
    /// `auto` when a preferred device exists (mirrors `--device auto` picking only
    /// preferred/worker boxes — we do not compute placement ourselves, we just
    /// offer the CLI's own affordance), then every device by name, preferred
    /// first. A nil/empty device list still yields This Mac + auto.
    static func build(devices: [Device]) -> [RunOnOption] {
        var out: [RunOnOption] = [RunOnOption(token: "local", title: "This Mac", enabled: true)]
        let hasPreferred = devices.contains { $0.isPreferred }
        out.append(RunOnOption(token: "auto",
                               title: hasPreferred ? "Auto (preferred worker)" : "Auto",
                               enabled: true))
        let sorted = devices
            .filter { !$0.isLocal }
            .sorted { a, b in
                if a.isPreferred != b.isPreferred { return a.isPreferred }
                return a.name.lowercased() < b.name.lowercased()
            }
        for d in sorted {
            let star = d.isPreferred ? "\u{2605} " : ""
            out.append(RunOnOption(token: d.name, title: "\(star)\(d.name)", enabled: true))
        }
        return out
    }
}

// MARK: - The form view

final class DispatchFormView: NSView {
    // Dimensions the form owns.
    private(set) var mode: DispatchMode = .auto
    private(set) var surface: DispatchSurface = .interactive
    private(set) var watchdog: WatchdogPolicy = .keep
    private(set) var runOn: String = "local"

    /// Fired whenever a dimension changes, so the controller refreshes its hint /
    /// summary and persists the defaults.
    var onChange: (() -> Void)?
    /// Fired when the form's height changes (the `▸ details` disclosure), so the
    /// controller re-lays out the panel.
    var onLayoutChange: (() -> Void)?
    /// The controller supplies the full one-line summary (it knows the agents +
    /// project); the form renders it in the collapsed state.
    var summaryProvider: (() -> String)?

    private static let expandedKey = "menubar.quickDispatch.formExpanded"
    private(set) var isExpanded = UserDefaults.standard.bool(forKey: DispatchFormView.expandedKey)

    private let disclosure = NSButton()
    private let summaryLabel = NSTextField(labelWithString: "")
    private let modeControl = NSSegmentedControl(labels: DispatchMode.allCases.map(\.title),
                                                 trackingMode: .selectOne, target: nil, action: nil)
    private let surfaceControl = NSSegmentedControl(labels: DispatchSurface.allCases.map(\.title),
                                                    trackingMode: .selectOne, target: nil, action: nil)
    private let watchdogControl = NSSegmentedControl(labels: WatchdogPolicy.allCases.map(\.title),
                                                     trackingMode: .selectOne, target: nil, action: nil)
    private let runOnPicker = NSPopUpButton(frame: .zero, pullsDown: false)
    private var runOnOptions: [RunOnOption] = [RunOnOption(token: "local", title: "This Mac", enabled: true)]
    private var detailRows: NSStackView!
    private var rebuildingRunOn = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        build()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    // MARK: Build

    private func build() {
        translatesAutoresizingMaskIntoConstraints = false

        disclosure.bezelStyle = .inline
        disclosure.isBordered = false
        disclosure.font = .monospacedSystemFont(ofSize: 11.5, weight: .medium)
        disclosure.contentTintColor = .secondaryLabelColor
        disclosure.target = self
        disclosure.action = #selector(onDisclosure(_:))
        disclosure.translatesAutoresizingMaskIntoConstraints = false

        summaryLabel.font = .monospacedSystemFont(ofSize: 11.5, weight: .regular)
        summaryLabel.textColor = .secondaryLabelColor
        summaryLabel.lineBreakMode = .byTruncatingTail
        summaryLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let header = NSStackView(views: [disclosure, summaryLabel])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = 8
        header.translatesAutoresizingMaskIntoConstraints = false

        for control in [modeControl, surfaceControl, watchdogControl] {
            control.segmentStyle = .rounded
            control.font = .systemFont(ofSize: 11.5)
            control.translatesAutoresizingMaskIntoConstraints = false
            control.target = self
        }
        modeControl.action = #selector(onMode(_:))
        surfaceControl.action = #selector(onSurface(_:))
        watchdogControl.action = #selector(onWatchdog(_:))
        modeControl.selectedSegment = DispatchMode.allCases.firstIndex(of: mode) ?? 1
        surfaceControl.selectedSegment = DispatchSurface.allCases.firstIndex(of: surface) ?? 0
        watchdogControl.selectedSegment = WatchdogPolicy.allCases.firstIndex(of: watchdog) ?? 1

        runOnPicker.controlSize = .small
        runOnPicker.font = .systemFont(ofSize: 12)
        runOnPicker.target = self
        runOnPicker.action = #selector(onRunOn(_:))
        runOnPicker.translatesAutoresizingMaskIntoConstraints = false
        rebuildRunOnPicker()

        let modeRow = labeledRow("Mode", modeControl)
        let runRow = labeledRow("Run on", runOnPicker)
        let surfaceRow = labeledRow("Surface", surfaceControl)
        let watchdogRow = labeledRow("Watchdog", watchdogControl)

        detailRows = NSStackView(views: [modeRow, runRow, surfaceRow, watchdogRow])
        detailRows.orientation = .vertical
        detailRows.alignment = .leading
        detailRows.spacing = 6
        detailRows.translatesAutoresizingMaskIntoConstraints = false

        let stack = NSStackView(views: [header, detailRows])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            header.widthAnchor.constraint(equalTo: stack.widthAnchor),
            modeControl.widthAnchor.constraint(equalToConstant: 210),
            surfaceControl.widthAnchor.constraint(equalToConstant: 210),
            watchdogControl.widthAnchor.constraint(equalToConstant: 280),
            runOnPicker.widthAnchor.constraint(lessThanOrEqualToConstant: 220),
        ])
        applyExpanded()
    }

    private func labeledRow(_ title: String, _ control: NSView) -> NSStackView {
        let label = NSTextField(labelWithString: title)
        label.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        label.textColor = .tertiaryLabelColor
        label.translatesAutoresizingMaskIntoConstraints = false
        label.widthAnchor.constraint(equalToConstant: 64).isActive = true
        let row = NSStackView(views: [label, control])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        return row
    }

    // MARK: Run-on popup

    /// Rebuild the run-on popup from the fleet snapshot. Keeps the current pick
    /// selected when it survives; otherwise falls back to This Mac.
    func setDevices(_ devices: [Device]) {
        runOnOptions = RunOnOption.build(devices: devices)
        rebuildRunOnPicker()
    }

    private func rebuildRunOnPicker() {
        rebuildingRunOn = true
        defer { rebuildingRunOn = false }
        runOnPicker.removeAllItems()
        for opt in runOnOptions {
            runOnPicker.addItem(withTitle: opt.title)
            runOnPicker.lastItem?.isEnabled = opt.enabled
        }
        if let idx = runOnOptions.firstIndex(where: { $0.token == runOn }) {
            runOnPicker.selectItem(at: idx)
        } else {
            runOn = "local"
            runOnPicker.selectItem(at: 0)
        }
    }

    // MARK: Apply / read defaults

    /// Apply remembered defaults to the controls (agents/project live on the
    /// panel; this view owns the other four dimensions).
    func apply(_ defaults: DispatchDefaults) {
        mode = defaults.mode
        surface = defaults.surface
        watchdog = defaults.watchdog
        runOn = defaults.runOn
        modeControl.selectedSegment = DispatchMode.allCases.firstIndex(of: mode) ?? 1
        surfaceControl.selectedSegment = DispatchSurface.allCases.firstIndex(of: surface) ?? 0
        watchdogControl.selectedSegment = WatchdogPolicy.allCases.firstIndex(of: watchdog) ?? 1
        rebuildRunOnPicker()
        refreshSummary()
    }

    /// Fold this view's four dimensions into a DispatchDefaults, given the agents
    /// and run-on the panel resolved.
    func defaults(agents: [String]) -> DispatchDefaults {
        DispatchDefaults(agents: agents, runOn: runOn, mode: mode,
                         surface: surface, watchdog: watchdog)
    }

    /// Force the mode to Plan for this dispatch only (Cmd-P), without persisting.
    func forcePlanForThisDispatch() {
        setMode(.plan)
    }

    private func setMode(_ next: DispatchMode) {
        mode = next
        modeControl.selectedSegment = DispatchMode.allCases.firstIndex(of: next) ?? 1
        onChange?()
        refreshSummary()
    }

    func refreshSummary() {
        summaryLabel.stringValue = summaryProvider?() ?? ""
    }

    // MARK: Actions

    @objc private func onDisclosure(_ sender: NSButton) {
        isExpanded.toggle()
        UserDefaults.standard.set(isExpanded, forKey: Self.expandedKey)
        applyExpanded()
    }

    private func applyExpanded() {
        detailRows.isHidden = !isExpanded
        disclosure.title = isExpanded ? "\u{25BE} details" : "\u{25B8} details"
        refreshSummary()
        onLayoutChange?()
    }

    /// Height the panel should budget for this form: the summary line always, plus
    /// the four control rows when expanded.
    var contentHeight: CGFloat { isExpanded ? 24 + 4 * 30 : 24 }

    @objc private func onMode(_ sender: NSSegmentedControl) {
        mode = DispatchMode.allCases[safe: sender.selectedSegment] ?? .auto
        onChange?(); refreshSummary()
    }

    @objc private func onSurface(_ sender: NSSegmentedControl) {
        surface = DispatchSurface.allCases[safe: sender.selectedSegment] ?? .interactive
        onChange?(); refreshSummary()
    }

    @objc private func onWatchdog(_ sender: NSSegmentedControl) {
        watchdog = WatchdogPolicy.allCases[safe: sender.selectedSegment] ?? .keep
        onChange?(); refreshSummary()
    }

    @objc private func onRunOn(_ sender: NSPopUpButton) {
        guard !rebuildingRunOn else { return }
        let idx = sender.indexOfSelectedItem
        guard idx >= 0, idx < runOnOptions.count else { return }
        runOn = runOnOptions[idx].token
        onChange?(); refreshSummary()
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
