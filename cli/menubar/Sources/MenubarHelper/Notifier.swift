import AppKit

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
