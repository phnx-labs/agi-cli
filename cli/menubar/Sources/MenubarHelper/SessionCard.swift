import AppKit

// SessionCard — the right pane of the Sessions window (PHNX-4003, Track C). It
// renders ONE selected session from the shared row model plus its artifacts, and
// carries the operator actions: answer an option, allow/deny a permission,
// approve/send-back a plan, type a reply, nudge, open an artifact, jump to the
// terminal. Every action is one bounded `agents` argv built by `Reply` (or the
// canonical `agents focus`) and its ok/stderr result renders INLINE here, never
// as a toast.
//
// The card holds no data source: the window hands it a `SessionEntry` and the
// session's artifacts, and wires the reply/terminal/artifact closures so the
// window keeps the one FeedStream/ArtifactIndex attachment.

/// The four status colors + the brand accent, shared across the window's UI.
enum Palette {
    static let brand = NSColor(srgbRed: 0xa3 / 255.0, green: 0xe6 / 255.0, blue: 0x35 / 255.0, alpha: 1)
    static let working = NSColor(srgbRed: 0x22 / 255.0, green: 0xc5 / 255.0, blue: 0x5e / 255.0, alpha: 1)
    static let idle    = NSColor(srgbRed: 0xef / 255.0, green: 0x44 / 255.0, blue: 0x44 / 255.0, alpha: 1)
    static let needsYou = NSColor(srgbRed: 0xd4 / 255.0, green: 0xa7 / 255.0, blue: 0x2c / 255.0, alpha: 1)
    static let done    = NSColor(srgbRed: 0x6b / 255.0, green: 0x72 / 255.0, blue: 0x80 / 255.0, alpha: 1)
    static let purple  = NSColor(srgbRed: 0xa7 / 255.0, green: 0x8b / 255.0, blue: 0xfa / 255.0, alpha: 1)

    static func color(_ status: StatusColor) -> NSColor {
        switch status {
        case .working:  return working
        case .needsYou: return needsYou
        case .idle:     return idle
        case .done:     return done
        }
    }

    /// The dot glyph + its color for a status.
    static func dot(_ status: StatusColor) -> (String, NSColor) { ("\u{25CF}", color(status)) }

    static func prColor(_ chip: PRChip) -> NSColor {
        switch chip {
        case .merged:        return purple
        case .approved:      return working
        case .checksFailed:  return idle
        case .checksRunning: return done
        case .draft:         return NSColor.tertiaryLabelColor
        case .open:          return NSColor.secondaryLabelColor
        }
    }
}

/// One session as the window and card consume it: the raw row, its reconciled
/// attention item (if any), and the shared presentation. Assembled once by the
/// window from the feed so nothing re-derives.
struct SessionEntry: Equatable {
    let rowKey: String
    let row: SessionRow
    let attention: AttentionItem?
    let presentation: RowPresentation

    var sessionId: String? { row.sessionId }
}

final class SessionCard: NSView {
    // Wired by the window so the card never touches FeedStream / the CLI resolver.
    /// Perform a bounded reply argv and deliver the result for inline rendering.
    var onReply: (([String], @escaping (Reply.Outcome) -> Void) -> Void)?
    /// Jump to the session's terminal (`agents focus <id>`).
    var onOpenTerminal: ((String) -> Void)?
    /// Open a rendered artifact in the default browser.
    var onOpenArtifact: ((String) -> Void)?
    /// This machine's registry name (from the window's device snapshot), so a
    /// peer-owned terminal row injects with `--device`. Nil until the snapshot
    /// arrives; the fallback then routes every row explicitly.
    var localDevice: String? {
        didSet { if oldValue != localDevice, entry != nil { rebuild() } }
    }

    private let scroll = NSScrollView()
    private let stack = NSStackView()
    private var entry: SessionEntry?
    private var artifacts: [Artifact] = []

    /// The reply text field, retained so the window can focus it (Return) and so
    /// Cmd-V can attach an image ref.
    private let replyField = NSTextField()
    private var resultLabel: NSTextField?
    /// Choice ids in render order, so digit keys 1-9 map to the right choice.
    private var choiceIds: [String] = []

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.autohidesScrollers = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let clip = NSView()
        clip.translatesAutoresizingMaskIntoConstraints = false
        clip.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: clip.trailingAnchor),
            stack.topAnchor.constraint(equalTo: clip.topAnchor),
            stack.bottomAnchor.constraint(equalTo: clip.bottomAnchor),
        ])
        scroll.documentView = clip
        NSLayoutConstraint.activate([
            clip.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            clip.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor),
            clip.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
        ])

        replyField.placeholderString = "Reply — Return sends, Cmd-K nudges, Cmd-Return opens the terminal"
        replyField.target = self
        replyField.action = #selector(onReplyReturn)
        replyField.font = NSFont.systemFont(ofSize: 12)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    // MARK: - Render

    func show(_ entry: SessionEntry?, artifacts: [Artifact]) {
        self.entry = entry
        self.artifacts = artifacts
        rebuild()
    }

    private func rebuild() {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        resultLabel = nil
        choiceIds = []
        guard let entry else {
            stack.addArrangedSubview(secondary("Select a session to see its detail."))
            return
        }
        let p = entry.presentation
        let row = entry.row

        // Header line: dot + title.
        let (glyph, color) = Palette.dot(p.status)
        stack.addArrangedSubview(heading("\(glyph) \(p.title)", color: color))

        // Meta: harness + version, project, host, terminal kind.
        var meta: [String] = []
        if let kind = row.kind { meta.append(row.version.map { "\(kind) \($0)" } ?? kind) }
        if !p.groupKey.isEmpty { meta.append(p.groupKey) }
        if let m = SessionRowModel.deviceName(row) as String?, !m.isEmpty { meta.append(m) }
        if let host = row.host, !host.isEmpty { meta.append(host) }
        if let account = row.account, !account.isEmpty { meta.append(account) }
        if !meta.isEmpty { stack.addArrangedSubview(secondary(meta.joined(separator: " · "))) }
        if let cwd = row.cwd, !cwd.isEmpty { stack.addArrangedSubview(secondary(cwd)) }

        // Phase pill + PR chip.
        let pills = NSStackView()
        pills.orientation = .horizontal
        pills.spacing = 8
        pills.addArrangedSubview(pill(p.phaseText, color: Palette.color(p.status)))
        if let chip = p.prChip { pills.addArrangedSubview(pill(chip.text, color: Palette.prColor(chip))) }
        if let n = p.subagents { pills.addArrangedSubview(pill("\u{2442} \(n)", color: Palette.brand)) }
        stack.addArrangedSubview(pills)

        // REQUEST.
        if let req = row.request, let text = req.text, !text.isEmpty {
            let turns = req.turns.map { " · \($0) turn\($0 == 1 ? "" : "s")" } ?? ""
            stack.addArrangedSubview(sectionTitle("REQUEST\(turns)"))
            stack.addArrangedSubview(body(text))
        }

        // Attention block.
        if let attn = entry.attention { addAttentionBlock(attn) }

        // PROGRESS.
        if let progress = p.progress {
            stack.addArrangedSubview(sectionTitle("PROGRESS · \(progress.done)/\(progress.total)"))
        }
        if let action = p.latestAction { stack.addArrangedSubview(body(action)) }

        // FILES & ARTIFACTS.
        addArtifactsBlock(row)

        // Reply field + Terminal.
        stack.addArrangedSubview(sectionTitle("REPLY"))
        let target = replyTarget(entry)
        if Reply.canReply(target) {
            replyField.isEnabled = true
            replyField.placeholderString = "Reply — Return sends, Cmd-K nudges, Cmd-Return opens the terminal"
        } else {
            replyField.isEnabled = false
            replyField.placeholderString = target.disabledReason.map { "Reply unavailable: \($0)" }
                ?? "Reply unavailable — no live rail. Use Terminal."
        }
        replyField.stringValue = ""
        pin(replyField)
        stack.addArrangedSubview(replyField)

        let actions = NSStackView()
        actions.orientation = .horizontal
        actions.spacing = 8
        actions.addArrangedSubview(button("Send", #selector(onSend)))
        actions.addArrangedSubview(button("Nudge (Continue.)", #selector(onNudge)))
        if row.sessionId != nil { actions.addArrangedSubview(button("Terminal", #selector(onTerminal))) }
        stack.addArrangedSubview(actions)

        let result = secondary("")
        result.textColor = .secondaryLabelColor
        resultLabel = result
        stack.addArrangedSubview(result)
    }

    private func addAttentionBlock(_ attn: AttentionItem) {
        let head = attn.kind == "plan_review" ? "PLAN REVIEW"
            : attn.kind == "permission" ? "PERMISSION"
            : attn.kind.uppercased()
        stack.addArrangedSubview(sectionTitle("\u{26A0} \(head)"))
        if let q = attn.question?.text ?? attn.question?.header, !q.isEmpty {
            stack.addArrangedSubview(body(q))
        }
        if attn.kind == "permission", let source = attn.source, !source.isEmpty {
            stack.addArrangedSubview(secondary(source))
        }

        // Choices: prefer the reconciled `choices` (they carry the stable id used
        // by `feed answer --choice`); fall back to the question's options.
        var labels: [String] = []
        if let choices = attn.choices, !choices.isEmpty {
            for c in choices {
                choiceIds.append(c.id ?? "\(choiceIds.count)")
                labels.append(c.label ?? c.id ?? "choice \(labels.count + 1)")
            }
        } else if let options = attn.question?.options, !options.isEmpty {
            for (i, o) in options.enumerated() {
                choiceIds.append("\(i)")
                labels.append(o.label ?? "option \(i + 1)")
            }
        }
        guard !labels.isEmpty else { return }
        let row = NSStackView()
        row.orientation = .horizontal
        row.spacing = 8
        for (i, label) in labels.enumerated() where i < 9 {
            let b = button("\(i + 1). \(label)", #selector(onChoice(_:)))
            b.tag = i
            row.addArrangedSubview(b)
        }
        stack.addArrangedSubview(row)
    }

    private func addArtifactsBlock(_ row: SessionRow) {
        let hasFiles = (row.files?.total ?? 0) > 0
        guard !artifacts.isEmpty || hasFiles else { return }
        var title = "FILES & ARTIFACTS"
        if let total = row.files?.total, total > 0 { title += " · \(total) file\(total == 1 ? "" : "s")" }
        stack.addArrangedSubview(sectionTitle(title))
        for artifact in artifacts.prefix(8) {
            let line = NSStackView()
            line.orientation = .horizontal
            line.spacing = 8
            let name = artifact.title.isEmpty ? (artifact.kind ?? "artifact") : artifact.title
            line.addArrangedSubview(body(name))
            let open = button("Open", #selector(onOpenArtifactBtn(_:)))
            open.tag = artifactTag(artifact)
            line.addArrangedSubview(open)
            stack.addArrangedSubview(line)
        }
    }

    // Artifacts open by index — the tag carries the position in `artifacts`.
    private func artifactTag(_ artifact: Artifact) -> Int { artifacts.firstIndex(of: artifact) ?? 0 }

    // MARK: - Actions

    private func replyTarget(_ entry: SessionEntry) -> ReplyTarget {
        let row = entry.row
        if let attn = entry.attention {
            return ReplyTarget(sessionId: attn.sessionId,
                               attentionKey: attn.key,
                               capability: ReplyCapability(attn.replyCapability),
                               cloudId: nil,
                               team: row.spawnedTeam,
                               mate: nil,
                               disabledReason: attn.replyCapability == "none"
                                   ? "the CLI reports no reply rail for this session" : nil)
        }
        // No open block: route on the row's own context/host exactly as the CLI
        // would report its reply rail (Reply.fallbackTarget).
        return Reply.fallbackTarget(for: row, localDevice: localDevice)
    }

    @objc private func onReplyReturn() { onSend() }

    @objc private func onSend() {
        guard let entry else { return }
        let text = replyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard let args = Reply.textArgs(replyTarget(entry), text: text) else {
            renderResult(.init(ok: false, output: "no reply rail for this session")); return
        }
        run(args, pending: "sending…")
    }

    @objc private func onNudge() {
        guard let entry else { return }
        guard let args = Reply.textArgs(replyTarget(entry), text: "Continue.") else {
            renderResult(.init(ok: false, output: "no reply rail for this session")); return
        }
        run(args, pending: "nudging…")
    }

    @objc private func onChoice(_ sender: NSButton) { answerOption(index: sender.tag) }

    /// Answer the Nth option (0-based). Wired to both the buttons and digit keys.
    func answerOption(index: Int) {
        guard let entry, index >= 0, index < choiceIds.count else { return }
        guard let args = Reply.choiceArgs(replyTarget(entry), choiceId: choiceIds[index]) else {
            renderResult(.init(ok: false, output: "no open feed block to answer")); return
        }
        run(args, pending: "answering \(index + 1)…")
    }

    @objc private func onTerminal() { openTerminal() }

    func openTerminal() {
        guard let id = entry?.sessionId else { return }
        onOpenTerminal?(id)
    }

    /// Send "Continue." via the reply rail (Cmd-K).
    func nudge() { onNudge() }

    /// Focus the reply field (Return on a selected row).
    func focusReply() { window?.makeFirstResponder(replyField) }

    @objc private func onOpenArtifactBtn(_ sender: NSButton) {
        guard sender.tag >= 0, sender.tag < artifacts.count else { return }
        onOpenArtifact?(artifacts[sender.tag].htmlPath)
    }

    /// Cmd-V attaches an image ref the same way the palette does — reuse the
    /// palette's pasteboard reader, then append the written ref to the reply text.
    func attachClipboardImage() -> Bool {
        let written = AgentsCLI.imageAttachments(from: .general)
        guard !written.isEmpty else { return false }
        let refs = written.joined(separator: " ")
        let current = replyField.stringValue
        replyField.stringValue = current.isEmpty ? refs : current + " " + refs
        window?.makeFirstResponder(replyField)
        return true
    }

    private func run(_ args: [String], pending: String) {
        renderResult(.init(ok: true, output: pending), tint: .secondaryLabelColor)
        onReply?(args) { [weak self] result in self?.renderResult(result) }
    }

    private func renderResult(_ result: Reply.Outcome, tint: NSColor? = nil) {
        guard let label = resultLabel else { return }
        if result.output.isEmpty {
            label.stringValue = result.ok ? "done" : "failed"
        } else {
            label.stringValue = result.output
        }
        label.textColor = tint ?? (result.ok ? Palette.working : Palette.idle)
    }

    // MARK: - View builders

    private func heading(_ text: String, color: NSColor) -> NSTextField {
        let f = label(text, size: 15, weight: .semibold)
        f.attributedStringValue = tinted(text, dotColor: color, size: 15)
        return f
    }

    private func sectionTitle(_ text: String) -> NSTextField {
        let f = label(text, size: 11, weight: .semibold)
        f.textColor = .secondaryLabelColor
        return f
    }

    private func body(_ text: String) -> NSTextField {
        let f = label(text, size: 12, weight: .regular)
        f.lineBreakMode = .byWordWrapping
        f.maximumNumberOfLines = 0
        pin(f)
        return f
    }

    private func secondary(_ text: String) -> NSTextField {
        let f = label(text, size: 11, weight: .regular)
        f.textColor = .secondaryLabelColor
        f.lineBreakMode = .byWordWrapping
        f.maximumNumberOfLines = 0
        pin(f)
        return f
    }

    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight) -> NSTextField {
        let f = NSTextField(labelWithString: text)
        f.font = NSFont.systemFont(ofSize: size, weight: weight)
        f.translatesAutoresizingMaskIntoConstraints = false
        return f
    }

    private func pill(_ text: String, color: NSColor) -> NSView {
        let container = NSView()
        container.wantsLayer = true
        container.layer?.backgroundColor = color.withAlphaComponent(0.15).cgColor
        container.layer?.cornerRadius = 6
        let f = NSTextField(labelWithString: text)
        f.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .medium)
        f.textColor = color
        f.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(f)
        container.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            f.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 8),
            f.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -8),
            f.topAnchor.constraint(equalTo: container.topAnchor, constant: 3),
            f.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -3),
        ])
        return container
    }

    private func button(_ title: String, _ action: Selector) -> NSButton {
        let b = NSButton(title: title, target: self, action: action)
        b.bezelStyle = .rounded
        b.controlSize = .small
        b.font = NSFont.systemFont(ofSize: 11)
        return b
    }

    private func tinted(_ text: String, dotColor: NSColor, size: CGFloat) -> NSAttributedString {
        let attr = NSMutableAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: size, weight: .semibold),
            .foregroundColor: NSColor.labelColor,
        ])
        if let first = text.first {
            attr.addAttribute(.foregroundColor, value: dotColor,
                              range: NSRange(location: 0, length: String(first).utf16.count))
        }
        return attr
    }

    /// Pin an arranged subview to the stack width so wrapping text lays out.
    private func pin(_ view: NSView) {
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        DispatchQueue.main.async { [weak self, weak view] in
            guard let self, let view, view.superview != nil else { return }
            view.widthAnchor.constraint(equalTo: self.stack.widthAnchor,
                                        constant: -(self.stack.edgeInsets.left + self.stack.edgeInsets.right)).isActive = true
        }
    }
}
