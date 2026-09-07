import AppKit
import UserNotifications

// Actionable desktop notifications for the daemon (PHNX-4004, parent PHNX-3999).
//
// The daemon fires one-shot `"AGI Menu" --notify …` processes (notify-desktop.ts)
// carrying a category, an attention key, a session id, and the answerable
// choices. This helper turns each into a UNUserNotificationCenter banner whose
// action buttons match the ask — Approve / Approve for session / Deny on a
// permission, the options plus a typed Reply on a question, Approve / Send back
// on a plan review, Open report / Open PR when a run finishes, Open terminal on a
// stall/failure — and routes the operator's choice back through exactly one
// bounded `agents` argv (`agents feed answer <key> --choice <id>` /
// `agents feed answer <key> --text "<typed>"`, or `agents open agents://session/<id>`).
//
// Two processes, one bundle id (`com.phnx-labs.agents-menubar`): the SHORT-LIVED
// one-shot POSTS the banner and exits; the PERSISTENT menu-bar instance is the
// UNUserNotificationCenterDelegate that RECEIVES the response later and runs the
// mapped command. That split is why categories are registered in both — the
// banner's buttons render from the running bundle's registered categories.
//
// When the system won't authorize UserNotifications (denied), delivery degrades
// to the deprecated NSUserNotification path (a plain banner, no action buttons)
// so a permission/question notice is never silently lost — the same
// preserve-delivery principle notify-desktop.ts applies with osascript.

// MARK: - Identifiers

/// Stable category identifiers registered with UNUserNotificationCenter. The
/// one-shot picks one from `--category` (+ the choice count for questions); the
/// running bundle must have the same set registered for the buttons to render.
enum NotifyCategory {
    static let permission = "agents.permission"
    static let planReview = "agents.plan_review"
    static let done = "agents.done"
    static let failure = "agents.failure"
    /// A question with no discrete options — only a typed Reply.
    static let questionReplyOnly = "agents.question"
    /// A question with N (1…3) discrete option buttons plus a typed Reply.
    static func question(options: Int) -> String { "agents.question.\(min(max(options, 1), 3))" }
}

/// Stable action identifiers. The choice ids (`approve`, `approve-session`,
/// `deny`, `send-back`, `open-report`, `open-pr`, `open-terminal`) are the same
/// strings D1 puts in `--choice`, so the delegate echoes them straight back to
/// `agents feed answer --choice <id>`. The `optN` ids are the generic
/// question-option buttons a static category forces (per-notification button
/// titles are impossible); they map back to the Nth `--choice` id via userInfo.
enum NotifyAction {
    static let approve = "approve"
    static let approveSession = "approve-session"
    static let deny = "deny"
    static let sendBack = "send-back"
    static let openReport = "open-report"
    static let openPR = "open-pr"
    static let openTerminal = "open-terminal"
    static let reply = "reply"
    static func option(_ n: Int) -> String { "opt\(n)" }
    static func optionIndex(_ identifier: String) -> Int? {
        guard identifier.hasPrefix("opt"), let n = Int(identifier.dropFirst(3)), n >= 1 else { return nil }
        return n
    }
}

/// userInfo keys carried on every actionable banner, read back in `didReceive`.
private enum NotifyUserInfoKey {
    static let key = "attentionKey"
    static let session = "sessionId"
    static let action = "action"
    static let choiceIds = "choiceIds"
    static let agent = "agent"
}

// MARK: - Parsed one-shot request (pure, self-tested)

/// The parsed `--notify` argv, before any UserNotifications object is built. Pure
/// so `MENUBAR_NOTIFY_TEST` can pin argv → category/userInfo/actions without
/// touching the notification center.
struct NotifyRequest: Equatable {
    struct Choice: Equatable { let id: String; let label: String }

    let title: String
    let body: String
    let subtitle: String?
    let action: String?
    let agent: String?
    /// Raw `--category` value: permission | question | plan_review | done | failure.
    let category: String?
    let key: String?
    let sessionId: String?
    let choices: [Choice]

    /// Parse the one-shot argv. nil when the required title/body are missing —
    /// the same exit(2) contract the previous NSUserNotification one-shot had.
    init?(argv: [String]) {
        func value(_ flag: String) -> String? {
            guard let i = argv.firstIndex(of: flag), i + 1 < argv.count else { return nil }
            return argv[i + 1]
        }
        guard let title = value("--title"), let body = value("--body") else { return nil }
        self.title = title
        self.body = body
        self.subtitle = value("--subtitle")
        self.action = value("--action")
        self.agent = value("--agent")
        self.category = value("--category")
        self.key = value("--key")
        self.sessionId = value("--session")
        // Each `--choice id=label` is its own argv pair; the child never saw a
        // shell, so an `=` inside a label is inert — split on the FIRST `=` only.
        var parsed: [Choice] = []
        var i = 0
        while i < argv.count {
            if argv[i] == "--choice", i + 1 < argv.count {
                let raw = argv[i + 1]
                if let eq = raw.firstIndex(of: "=") {
                    parsed.append(Choice(id: String(raw[..<eq]), label: String(raw[raw.index(after: eq)...])))
                } else {
                    parsed.append(Choice(id: raw, label: raw))
                }
                i += 2
            } else {
                i += 1
            }
        }
        self.choices = parsed
    }

    /// The UNUserNotificationCenter category identifier this request maps to, or
    /// nil when `--category` is absent/unknown (a plain banner, no buttons).
    var categoryIdentifier: String? {
        switch category {
        case "permission": return NotifyCategory.permission
        case "plan_review": return NotifyCategory.planReview
        case "done": return NotifyCategory.done
        case "failure": return NotifyCategory.failure
        case "question":
            return choices.isEmpty ? NotifyCategory.questionReplyOnly
                : NotifyCategory.question(options: choices.count)
        default: return nil
        }
    }

    /// Permission / question / plan-review asks are time-sensitive (an agent is
    /// blocked waiting); a finished run or a stall is ordinary `.active`.
    var isTimeSensitive: Bool {
        category == "permission" || category == "question" || category == "plan_review"
    }
}

// MARK: - Response mapping (pure, self-tested)

/// What a tapped action maps to. `argv` is the `agents` command it runs (nil for
/// the NSWorkspace-open cases, which the delegate opens directly).
enum NotifyResponse: Equatable {
    case feedAnswerChoice(key: String, choiceId: String)
    case feedAnswerText(key: String, text: String)
    case openFile(path: String)
    case openWeb(url: String)
    case openSession(sessionId: String)
    /// The tapped button named a target (`report` / `PR`) the banner did not
    /// carry — the CLI's single `--action` holds one link, so a done banner with
    /// both open-report and open-pr can only deliver one of them. Surfaced as a
    /// follow-up banner rather than swallowed as a no-op.
    case unavailable(target: String)
    case none

    /// The argv AFTER `agents` (the delegate prepends the resolved binary), or
    /// nil for openFile/openWeb (opened via NSWorkspace), unavailable, and none.
    var agentsArgs: [String]? {
        switch self {
        case let .feedAnswerChoice(key, id): return ["feed", "answer", key, "--choice", id]
        case let .feedAnswerText(key, text): return ["feed", "answer", key, "--text", text]
        case let .openSession(sessionId): return ["open", "agents://session/\(sessionId)"]
        case .openFile, .openWeb, .unavailable, .none: return nil
        }
    }

    /// True when a non-zero exit should raise the "could not deliver" follow-up
    /// banner — only the answer routes, not a best-effort open.
    var isAnswer: Bool {
        switch self {
        case .feedAnswerChoice, .feedAnswerText: return true
        default: return false
        }
    }
}

/// The userInfo a response carries, parsed out of the delivered notification.
struct NotifyResponseContext: Equatable {
    let key: String?
    let sessionId: String?
    /// The `--action` value (`open:<path>` / `url:<https…>`), for open-report/open-pr.
    let action: String?
    /// Choice ids in banner order; `optN` maps to `choiceIds[N-1]`.
    let choiceIds: [String]

    init(key: String?, sessionId: String?, action: String?, choiceIds: [String]) {
        self.key = key
        self.sessionId = sessionId
        self.action = action
        self.choiceIds = choiceIds
    }

    init(userInfo: [AnyHashable: Any]) {
        self.key = userInfo[NotifyUserInfoKey.key] as? String
        self.sessionId = userInfo[NotifyUserInfoKey.session] as? String
        self.action = userInfo[NotifyUserInfoKey.action] as? String
        self.choiceIds = userInfo[NotifyUserInfoKey.choiceIds] as? [String] ?? []
    }
}

/// Map a tapped action identifier (+ any typed text) to the command it runs.
/// Pure — the self-test pins every branch without a notification center.
func resolveNotifyResponse(actionIdentifier: String,
                           context: NotifyResponseContext,
                           typedText: String?) -> NotifyResponse {
    let text = typedText?.trimmingCharacters(in: .whitespacesAndNewlines)
    let hasText = !(text ?? "").isEmpty

    switch actionIdentifier {
    case UNNotificationDefaultActionIdentifier, NotifyAction.openTerminal:
        // A tap on the banner body, or the explicit Open-terminal button, opens
        // the session in its terminal.
        return context.sessionId.map { .openSession(sessionId: $0) } ?? .none

    case UNNotificationDismissActionIdentifier:
        return .none

    case NotifyAction.openReport:
        // `open:<path>` → open the report file. Any other action means the
        // banner offered the button without carrying the report: say so.
        guard let action = context.action, action.hasPrefix("open:") else {
            return .unavailable(target: "report")
        }
        return .openFile(path: String(action.dropFirst("open:".count)))

    case NotifyAction.openPR:
        // `url:<https…>` → open the PR page. Web schemes only; a banner whose
        // single `--action` went to the report (or carries no usable URL) has
        // no PR link to open, so the tap surfaces a follow-up instead of nothing.
        guard let action = context.action, action.hasPrefix("url:"),
              let url = URL(string: String(action.dropFirst("url:".count))),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
            return .unavailable(target: "PR")
        }
        return .openWeb(url: url.absoluteString)

    case NotifyAction.reply:
        // Free-text reply; an empty submit answers nothing.
        guard hasText, let key = context.key else { return .none }
        return .feedAnswerText(key: key, text: text!)

    default:
        if let n = NotifyAction.optionIndex(actionIdentifier) {
            // Generic question-option button → the Nth reconciled choice id.
            guard n <= context.choiceIds.count, let key = context.key else { return .none }
            return .feedAnswerChoice(key: key, choiceId: context.choiceIds[n - 1])
        }
        // A direct choice id (approve / approve-session / deny / send-back / the
        // plan-review approve). Send-back carries optional typed feedback: a typed
        // send-back becomes a free-text answer, an empty one the plain choice.
        guard let key = context.key else { return .none }
        if hasText { return .feedAnswerText(key: key, text: text!) }
        return .feedAnswerChoice(key: key, choiceId: actionIdentifier)
    }
}

// MARK: - Command runner (injected in the self-test)

/// Runs one `agents` command with a deadline; returns its exit code and stderr
/// tail. Injected so `MENUBAR_NOTIFY_TEST` can assert the argv without spawning.
protocol NotifyCommandRunning {
    func run(agentsArgs: [String], timeout: TimeInterval) -> (code: Int32, stderr: String)
}

/// The real runner: `agents <args>` through ChildProcess, bounded and
/// group-killed like every other CLI call the helper makes.
struct ChildProcessCommandRunner: NotifyCommandRunning {
    func run(agentsArgs: [String], timeout: TimeInterval) -> (code: Int32, stderr: String) {
        let argv = AgentsCLI.agentsArgv(agentsArgs)
        guard let result = ChildProcess.runResult(argv, timeout: timeout) else {
            return (code: -1, stderr: "command timed out or could not start")
        }
        let stderr = String(data: result.stderr, encoding: .utf8) ?? ""
        return (code: result.code, stderr: stderr)
    }
}

// MARK: - Notifier

enum Notifier {
    /// Deadline for a response command. A `feed answer` claims-and-routes over a
    /// possibly-remote session, so it needs room beyond a local call, but a
    /// wedged one must not linger.
    static let responseTimeout: TimeInterval = 20

    /// The persistent instance's response delegate. Held for the process lifetime
    /// so UNUserNotificationCenter keeps a strong reference to it.
    static let responseDelegate = NotificationDelegate()

    /// Track C (the Sessions window) may set this to suppress a banner whose
    /// session is the currently-selected row — the operator is already looking at
    /// it (§5). Left nil so this track compiles and runs without C; C wires it at
    /// launch. Returns true to suppress presentation (the item still lands in the
    /// notification list).
    static var isSessionSelectedInSessionsWindow: ((_ sessionId: String) -> Bool)?

    private static var loggedDenied = false

    // MARK: Launch wiring (persistent instance)

    /// Register the actionable categories and install the response delegate on the
    /// persistent menu-bar instance, then request authorization once. Idempotent;
    /// called from `applicationDidFinishLaunching`.
    static func configureForLaunch() {
        let center = UNUserNotificationCenter.current()
        center.delegate = responseDelegate
        registerCategories(on: center)
        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            if !granted { logDeniedOnce(error) }
        }
    }

    /// Register the five category families. Idempotent — a fresh call replaces the
    /// set with the same content. Called by BOTH the persistent instance (so a
    /// received banner renders its buttons) and the one-shot (so a banner it posts
    /// shows buttons even when the persistent instance is not running).
    static func registerCategories(on center: UNUserNotificationCenter) {
        let approve = UNNotificationAction(identifier: NotifyAction.approve, title: "Approve", options: [])
        let approveSession = UNNotificationAction(identifier: NotifyAction.approveSession,
                                                  title: "Approve for session", options: [])
        let deny = UNNotificationAction(identifier: NotifyAction.deny, title: "Deny", options: [.destructive])
        let permission = UNNotificationCategory(identifier: NotifyCategory.permission,
                                                actions: [approve, approveSession, deny],
                                                intentIdentifiers: [], options: [])

        let reply = UNTextInputNotificationAction(identifier: NotifyAction.reply, title: "Reply…",
                                                  options: [], textInputButtonTitle: "Send",
                                                  textInputPlaceholder: "Type a reply")
        // A static category cannot carry per-notification button titles, so the
        // option buttons are generic (Option 1…3) and the body lists the real
        // options; `optN` maps back to the Nth choice id.
        var questionCategories: [UNNotificationCategory] = [
            UNNotificationCategory(identifier: NotifyCategory.questionReplyOnly,
                                   actions: [reply], intentIdentifiers: [], options: []),
        ]
        for n in 1...3 {
            let opts = (1...n).map {
                UNNotificationAction(identifier: NotifyAction.option($0), title: "Option \($0)", options: [])
            }
            questionCategories.append(UNNotificationCategory(identifier: NotifyCategory.question(options: n),
                                                             actions: opts + [reply],
                                                             intentIdentifiers: [], options: []))
        }

        let planApprove = UNNotificationAction(identifier: NotifyAction.approve, title: "Approve", options: [])
        let sendBack = UNTextInputNotificationAction(identifier: NotifyAction.sendBack, title: "Send back",
                                                     options: [], textInputButtonTitle: "Send back",
                                                     textInputPlaceholder: "Add feedback (optional)")
        let planReview = UNNotificationCategory(identifier: NotifyCategory.planReview,
                                                actions: [planApprove, sendBack],
                                                intentIdentifiers: [], options: [])

        let openReport = UNNotificationAction(identifier: NotifyAction.openReport, title: "Open report", options: [])
        let openPR = UNNotificationAction(identifier: NotifyAction.openPR, title: "Open PR", options: [])
        let done = UNNotificationCategory(identifier: NotifyCategory.done,
                                          actions: [openReport, openPR], intentIdentifiers: [], options: [])

        let openTerminal = UNNotificationAction(identifier: NotifyAction.openTerminal,
                                                title: "Open terminal", options: [])
        let failure = UNNotificationCategory(identifier: NotifyCategory.failure,
                                             actions: [openTerminal], intentIdentifiers: [], options: [])

        center.setNotificationCategories(Set([permission, planReview, done, failure] + questionCategories))
    }

    // MARK: One-shot post

    /// One-shot `--notify` mode: parse the argv, build a UserNotifications banner
    /// with the actionable category, post it, briefly spin so the add completes,
    /// then exit. Keeps the 0.6s flush + 3s self-terminate watchdog the previous
    /// NSUserNotification one-shot had. Degrades to NSUserNotification when the
    /// system won't authorize UserNotifications, so delivery is never lost.
    static func runOneShot(_ args: [String]) -> Never {
        guard let request = NotifyRequest(argv: args) else { exit(2) }
        // Hard self-terminate watchdog on a BACKGROUND queue: a wedged main thread
        // (locked screen, WindowServer/XPC hiccup) can't starve it, so the process
        // always exits. 3s sits above the 0.6s flush and below the Node-side 4s
        // SIGKILL (notify-desktop.ts).
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 3) { exit(0) }

        // A running NSApplication for delivery to attribute the banner to; never
        // call run() — the runloop below drives this short-lived process.
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)

        let center = UNUserNotificationCenter.current()
        // A minimal delegate guarantees the banner presents even if the system
        // considers this fresh process foreground.
        center.delegate = responseDelegate
        registerCategories(on: center)

        center.getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                postUserNotification(request, on: center)
            case .notDetermined:
                center.requestAuthorization(options: [.alert, .sound]) { granted, error in
                    if granted { postUserNotification(request, on: center) }
                    else { logDeniedOnce(error); postLegacyFallback(request) }
                }
            case .denied:
                logDeniedOnce(nil)
                postLegacyFallback(request)
            @unknown default:
                postLegacyFallback(request)
            }
        }
        // Drive the runloop until a completion handler or the 3s watchdog exits
        // the process. RunLoop.run() returns immediately when it has no input
        // source, so loop rather than let the -> Never one-shot fall through.
        while true { RunLoop.main.run(until: Date().addingTimeInterval(1)) }
    }

    /// Build the UNMutableNotificationContent and add it; exit after a short flush.
    private static func postUserNotification(_ request: NotifyRequest, on center: UNUserNotificationCenter) {
        let content = UNMutableNotificationContent()
        content.title = request.title
        content.body = bodyWithOptions(request)
        if let subtitle = request.subtitle { content.subtitle = subtitle }
        if let categoryIdentifier = request.categoryIdentifier {
            content.categoryIdentifier = categoryIdentifier
        }
        content.interruptionLevel = request.isTimeSensitive ? .timeSensitive : .active
        // Group a session's banners so they collapse together in Notification Center.
        if let sessionId = request.sessionId { content.threadIdentifier = sessionId }
        content.sound = .default

        var userInfo: [String: Any] = [:]
        if let key = request.key { userInfo[NotifyUserInfoKey.key] = key }
        if let sessionId = request.sessionId { userInfo[NotifyUserInfoKey.session] = sessionId }
        if let action = request.action { userInfo[NotifyUserInfoKey.action] = action }
        if let agent = request.agent { userInfo[NotifyUserInfoKey.agent] = agent }
        if !request.choices.isEmpty { userInfo[NotifyUserInfoKey.choiceIds] = request.choices.map(\.id) }
        content.userInfo = userInfo

        if let url = AgentAvatar.attachmentURL(for: request.agent),
           let attachment = try? UNNotificationAttachment(identifier: "avatar", url: url, options: nil) {
            content.attachments = [attachment]
        }

        let requestId = request.key ?? UUID().uuidString
        let notification = UNNotificationRequest(identifier: requestId, content: content, trigger: nil)
        center.add(notification) { _ in
            // Give delivery a beat to flush, then exit — the watchdog is the backstop.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { exit(0) }
        }
    }

    /// A question's discrete options can't be button titles (static categories),
    /// so number them into the body — "1) Yes  2) No" — so the generic Option-N
    /// buttons are legible. Every other category returns the body unchanged.
    private static func bodyWithOptions(_ request: NotifyRequest) -> String {
        guard request.category == "question", !request.choices.isEmpty else { return request.body }
        let numbered = request.choices.enumerated()
            .map { "\($0.offset + 1)) \($0.element.label)" }
            .joined(separator: "   ")
        return request.body.isEmpty ? numbered : "\(request.body)\n\(numbered)"
    }

    /// Degrade to the deprecated NSUserNotification (no action buttons) when
    /// UserNotifications is unauthorized, so a notice is never silently lost.
    private static func postLegacyFallback(_ request: NotifyRequest) {
        post(title: request.title, body: bodyWithOptions(request), subtitle: request.subtitle,
             url: clickURL(for: request.action), agent: request.agent)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { exit(0) }
    }

    // MARK: Response handling (persistent instance)

    /// Run the command a tapped action maps to and return at once. openFile/openWeb
    /// go straight to NSWorkspace; an unavailable target posts its follow-up; the
    /// answer/open-session cases run one bounded `agents` argv OFF the calling
    /// thread — `didReceive` is not guaranteed to arrive off main, and a `feed
    /// answer` routing over a remote rail can take the full 20 s deadline, which
    /// on the main thread would freeze the status item (the same rule every
    /// timer-driven `ChildProcess` caller follows). A non-zero `feed answer` hops
    /// back to main to raise the "could not deliver" follow-up.
    static func handleResponse(_ response: NotifyResponseContext, actionIdentifier: String,
                               typedText: String?, agent: String?,
                               runner: NotifyCommandRunning = ChildProcessCommandRunner()) {
        let resolved = resolveNotifyResponse(actionIdentifier: actionIdentifier,
                                             context: response, typedText: typedText)
        switch resolved {
        case let .openFile(path):
            NSWorkspace.shared.open(URL(fileURLWithPath: path))
        case let .openWeb(url):
            if let u = URL(string: url) { NSWorkspace.shared.open(u) }
        case let .unavailable(target):
            postFollowUp(title: "Could not open the \(target)",
                         body: "This notice carried no \(target) link. Open the session in its terminal to find it.",
                         agent: agent, context: response)
        case .none:
            return
        default:
            guard let args = resolved.agentsArgs else { return }
            DispatchQueue.global(qos: .userInitiated).async {
                let result = runner.run(agentsArgs: args, timeout: responseTimeout)
                guard result.code != 0, resolved.isAnswer else { return }
                DispatchQueue.main.async {
                    postAnswerFailure(stderr: result.stderr, agent: agent, context: response)
                }
            }
        }
    }

    /// The "could not deliver your reply" follow-up banner, so a failed
    /// `agents feed answer` is visible rather than swallowed. Its Open-terminal
    /// button reopens the session so the operator can answer directly.
    private static func postAnswerFailure(stderr: String, agent: String?, context: NotifyResponseContext) {
        let tail = stderr.split(whereSeparator: \.isNewline).suffix(3).joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)
        postFollowUp(title: "Could not deliver your reply",
                     body: tail.isEmpty ? "Open the session in its terminal to answer directly." : tail,
                     agent: agent, context: context)
    }

    /// One follow-up banner shape for every response the helper could not carry
    /// out: category `agents.failure` (Open terminal), the session's thread and
    /// avatar, so the operator lands in the session instead of a dead tap.
    private static func postFollowUp(title: String, body: String, agent: String?, context: NotifyResponseContext) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.subtitle = "Open in terminal"
        content.categoryIdentifier = NotifyCategory.failure
        content.interruptionLevel = .active
        content.sound = .default
        var userInfo: [String: Any] = [:]
        if let sessionId = context.sessionId { userInfo[NotifyUserInfoKey.session] = sessionId }
        content.userInfo = userInfo
        if let url = AgentAvatar.attachmentURL(for: agent),
           let attachment = try? UNNotificationAttachment(identifier: "avatar", url: url, options: nil) {
            content.attachments = [attachment]
        }
        let request = UNNotificationRequest(identifier: "answer-failure-\(UUID().uuidString)",
                                            content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
    }

    /// Whether to suppress presenting a banner because its session's row is
    /// selected in the (track C) Sessions window. Never suppresses without C.
    static func shouldSuppressPresentation(sessionId: String?) -> Bool {
        guard let sessionId, let check = isSessionSelectedInSessionsWindow else { return false }
        return check(sessionId)
    }

    private static func logDeniedOnce(_ error: Error?) {
        guard !loggedDenied else { return }
        loggedDenied = true
        let reason = error.map { " (\($0.localizedDescription))" } ?? ""
        FileHandle.standardError.write(Data(
            "\(HelperIdentity.executableName): notifications not authorized\(reason) — degrading to NSUserNotification.\n".utf8))
    }

    // MARK: NSUserNotification — in-app confirmations + unauthorized fallback

    private static let legacyDelegate = NotifierDelegate()
    private static var legacyWired = false

    /// Register the deprecated-center click delegate (idempotent). Retained for
    /// the in-app `post` confirmations and the UserNotifications degradation path;
    /// the UserNotifications delegate is wired separately by `configureForLaunch`.
    static func wireClickHandler() {
        if !legacyWired {
            NSUserNotificationCenter.default.delegate = legacyDelegate
            legacyWired = true
        }
    }

    /// Deliver a plain NSUserNotification (no action buttons). Two callers: the
    /// occasional user-invoked in-app confirmation ("Created RUSH-####", click to
    /// open) — which needs no authorization prompt, right for a signed helper —
    /// and the unauthorized-degradation path of the actionable one-shot above.
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

    /// Map the daemon `--action` deep-link to a URL the legacy click delegate
    /// opens (`open:<path>` / `url:<https…>` / `routines:list`), for the
    /// NSUserNotification fallback. Any other/absent action yields no target.
    static func clickURL(for action: String?) -> String? {
        guard let action else { return nil }
        if action.hasPrefix("open:") {
            return URL(fileURLWithPath: String(action.dropFirst("open:".count))).absoluteString
        }
        if action.hasPrefix("url:") {
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

// MARK: - Delegates

/// The persistent instance's UserNotifications delegate. Presents banners while
/// the helper is frontmost (unless suppressed by the Sessions window) and runs
/// the command a tapped action maps to.
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let sessionId = notification.request.content.userInfo[NotifyUserInfoKey.session] as? String
        if Notifier.shouldSuppressPresentation(sessionId: sessionId) {
            // Keep the item in the notification list, just don't interrupt.
            completionHandler([])
            return
        }
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let content = response.notification.request.content
        let context = NotifyResponseContext(userInfo: content.userInfo)
        let typedText = (response as? UNTextInputNotificationResponse)?.userText
        let agent = content.userInfo[NotifyUserInfoKey.agent] as? String
        Notifier.handleResponse(context, actionIdentifier: response.actionIdentifier,
                                typedText: typedText, agent: agent)
        completionHandler()
    }
}

// Legacy NSUserNotification click delegate — retained for the unauthorized
// degradation path. NSUserNotification carries no click target on its own, so the
// URL is stashed in userInfo and opened from didActivate.
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
