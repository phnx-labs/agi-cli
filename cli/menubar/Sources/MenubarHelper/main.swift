import AppKit
import Carbon.HIToolbox

// agents-cli menu bar helper. A no-Dock (.accessory) status-bar app run as a
// launchd user agent (`com.phnx-labs.agents-menubar`, KeepAlive), installed and
// started by `agents menubar enable` -> install-menubar.ts. Do NOT hand-launch
// the interactive mode: launchd starts it in the GUI session, which is the only
// context where its global chords can hold the Accessibility grant they need
// (see Guards.swift).
//
// Usage:
//   "AGI Menu"                     # status item + global hotkeys (launchd-started)
//   "AGI Menu" --notify ...        # one-shot: post a desktop notification, exit
//   AGENTS_BIN=/path/to/agents    # override the `agents` binary location

// One-shot notification delivery for the daemon (RUSH-2030, PHNX-4004). Posts and
// exits WITHOUT starting the status-bar UI, so the daemon can fire branded,
// actionable UserNotifications by spawning the installed .app in this mode. The
// notification is attributed to this bundle, so it shows the app's AppIcon (the
// agents-cli mark) instead of the generic osascript/Script Editor icon, and its
// action responses route to the persistent instance. See Notifier (Notifier.swift).
if CommandLine.arguments.contains("--notify") {
    Notifier.runOneShot(CommandLine.arguments)
}

// Benchmark mode: time the data-layer methods that build the menu, then exit.
// No GUI session needed — LocalState reads files, AgentsCLI shells the CLI.
if ProcessInfo.processInfo.environment["MENUBAR_BENCH"] == "1" {
    Bench.run()
    exit(0)
}

// Clip test: persist the current clipboard image + print the scp token, then
// exit. No GUI, no hotkey, no Accessibility grant — verifies persist+format.
if ProcessInfo.processInfo.environment["MENUBAR_CLIP_TEST"] == "1" {
    Clip.printTokenAndExit()
}

// Issue-capture self-test: exercise the quick-issue logic (newest-clip pick,
// ticket-id parse, prompt contract) against real code, print PASS/FAIL, exit.
// No GUI, no hotkey. See IssueSelfTest.swift.
if ProcessInfo.processInfo.environment["MENUBAR_ISSUE_TEST"] == "1" {
    IssueSelfTest.run()
}

// Projects self-test (PHNX-4001): decode `agents projects list --json`, prove the
// palette keys projects by NAME (two definitions may share one checkout), resolve
// the Linear scope from the definition's binding rather than folder names, and
// narrow to a directory inside a project. See ProjectSelfTest.swift.
if ProcessInfo.processInfo.environment["MENUBAR_PROJECTS_TEST"] == "1" {
    ProjectSelfTest.run()
}

// Launch-guard self-test: exercise the remote-shell and argument predicates
// that gate the interactive mode below, print PASS/FAIL, exit. See Guards.swift.
if ProcessInfo.processInfo.environment["MENUBAR_GUARD_TEST"] == "1" {
    GuardsSelfTest.run()
}

// Single-instance self-test: take real flocks and assert the contention
// outcomes that keep exactly one status item alive. See SingleInstance.swift.
if ProcessInfo.processInfo.environment["MENUBAR_SINGLE_TEST"] == "1" {
    SingleInstanceSelfTest.run()
}

// Child-process self-test: spawn real processes and assert they are bounded by
// a deadline, killed as a group, and tracked so the next launch can reap them.
// See ChildProcess.swift.
if ProcessInfo.processInfo.environment["MENUBAR_CHILD_TEST"] == "1" {
    ChildProcessSelfTest.run()
}

// High-load warning self-test: exercise the load classifier + remote-cache
// filtering (reachable / freshness / cutoff / self-row skip), then print the live
// loadedDevices() for this box, print PASS/FAIL, exit. See LoadedDeviceSelfTest.swift.
if ProcessInfo.processInfo.environment["MENUBAR_LOAD_TEST"] == "1" {
    LoadedDeviceSelfTest.run()
}

// Active-session self-test (RUSH-2336): decode the CLI's pid/pidAlive/
// cloudProvider/cloudTaskId fields off a real `--active --json` payload and
// assert the machine:pid / provider · taskId locator they drive. See
// ActiveSessionSelfTest.swift.
if ProcessInfo.processInfo.environment["MENUBAR_ACTIVE_TEST"] == "1" {
    ActiveSessionSelfTest.run()
}

// Routine self-test (RUSH-2290): decode the CLI's readiness/failureCode/
// project-cwd/blocked/skipped fields off a real `routines list --json` row,
// exercise the pure attention-kind/reason/grouping/action-state helpers those
// fields drive, and confirm an older payload predating them still decodes.
// No GUI, no hotkey. See RoutineSelfTest.swift.
if ProcessInfo.processInfo.environment["MENUBAR_ROUTINE_TEST"] == "1" {
    RoutineSelfTest.run()
}

// Device-favorites self-test (PHNX-2376): decode the `preferred` flag off a real
// `menubar snapshot --json` devices payload and exercise the pure DEVICES-block
// ordering (this Mac → ★ favorites → divider → rest). See DeviceSelfTest.swift.
if ProcessInfo.processInfo.environment["MENUBAR_DEVICE_TEST"] == "1" {
    DeviceSelfTest.run()
}

// Doctor overview self-test (RUSH-2382): decode the additive fleet findings
// contract and exercise the bounded, doctor-ordered health presentation without
// constructing an AppKit menu. See DoctorSelfTest.swift.
if ProcessInfo.processInfo.environment["MENUBAR_DOCTOR_TEST"] == "1" {
    DoctorSelfTest.run()
}

// Daemon-liveness self-test: prove the separate menubar process distinguishes
// a fresh heartbeat from the alive-but-frozen sleep/wake failure.
if ProcessInfo.processInfo.environment["MENUBAR_DAEMON_LIVENESS_TEST"] == "1" {
    DaemonLivenessSelfTest.run()
}

// Feed data-layer self-test (PHNX-4002): replay a fixture NDJSON through the
// pure FeedState reducer and assert row counts, attention keys, reset-on-gap,
// backoff schedule, and the circuit breaker. No process, no network — a build
// gate. See FeedSelfTest.swift.
if ProcessInfo.processInfo.environment["MENUBAR_FEED_TEST"] == "1" {
    FeedSelfTest.run()
}

// Artifact-index self-test (PHNX-4002): scan a fixture tree (three sidecars, two
// ledger manifests) and assert the session map, revision counts, HTML
// resolution, and full-vs-prefix matching. Pure filesystem read — a build gate.
// See ArtifactSelfTest.swift.
if ProcessInfo.processInfo.environment["MENUBAR_ARTIFACT_TEST"] == "1" {
    ArtifactSelfTest.run()
}

// Notifier self-test (PHNX-4004): pin the pure argv → content mapping (category,
// userInfo, time-sensitivity) and the response → `agents feed answer` argv for
// each action, with a capturing runner in place of ChildProcess so the
// notification center is never touched. No GUI, a build gate. See NotifierSelfTest.swift.
if ProcessInfo.processInfo.environment["MENUBAR_NOTIFY_TEST"] == "1" {
    NotifierSelfTest.run()
}

// Feed live smoke (PHNX-4002): run FeedStream against THIS machine for ~60s and
// print row/attention/device counts + health, then exit cleanly. Spawns the real
// `agents feed watch` child, so it is NOT part of the build gate — like
// MENUBAR_DUMP it needs the live fleet. See FeedSmoke (FeedSelfTest.swift).
if ProcessInfo.processInfo.environment["MENUBAR_FEED_SMOKE"] == "1" {
    FeedSmoke.run()
}

// Screenshot OCR self-test (PHNX-4006): run real Vision recognition over the two
// committed fixture PNGs into a temp SQLite DB and assert the stored first_line,
// hash dedupe, and tokenized search, plus the pure grouping helper. No GUI, no
// hotkey. See ScreenshotOCRSelfTest.swift.
if ProcessInfo.processInfo.environment["MENUBAR_OCR_TEST"] == "1" {
    ScreenshotOCRSelfTest.run()
}

// Everything past here installs the status item and registers the global
// chords, so it must only run where those chords can actually be serviced.
// Refuses an ssh-started launch or an unrecognized flag — the two ways a helper
// that can never hold the Accessibility grant has ended up owning Cmd-Shift-V.
Guards.enforceForInteractiveLaunch()

// ...and only once. A second helper surfaces the running one's menu and exits
// rather than installing a duplicate status item (see SingleInstance.swift).
SingleInstance.enforceOrSurface()

// Kill whatever the previous helper left running. This runs BEFORE any AppKit
// call on purpose: the death being cleaned up after is a SIGSEGV inside
// `NSApplication.shared` itself (SLSNewConnection returns null when WindowServer
// is starved, AppKit dereferences it), so cleanup placed after that line would
// be skipped by the exact crash it exists to recover from — and the CLI children
// it abandons are what starve WindowServer in the first place. Only the winner
// of the single-instance lock reaps, so a surfacing duplicate never kills the
// incumbent's live children. See ChildProcess.swift.
let reaped = ChildProcess.reapOrphansFromPreviousLaunch()
if reaped > 0 {
    FileHandle.standardError.write(Data(
        "\(HelperIdentity.executableName): reaped \(reaped) orphaned CLI child process group(s) from a previous launch.\n".utf8
    ))
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let controller = StatusItemController()

final class AppDelegate: NSObject, NSApplicationDelegate {
    let controller: StatusItemController
    init(_ c: StatusItemController) { self.controller = c }
    let hotkey = HotkeyManager()
    // One panel, two entry points: the Cmd-Shift-O chord and the menu's
    // "New Task…" row. The status item owns it so both summon the same instance
    // and an interrupted capture is restored either way.
    var promptController: PromptPanelController { controller.promptController }
    func applicationDidFinishLaunching(_ notification: Notification) {
        controller.install()
        // Construct the static panel now and prewarm disk-backed content in the
        // background. Cmd-Shift-O then only orders an existing window and focuses
        // its text field; it never waits for session history or image decoding.
        promptController.prepare()
        // A duplicate launch surrenders (SingleInstance) and posts this instead
        // of adding a second status item — so answering it by opening the menu
        // is what makes "launch it again" show the helper the user already has.
        //
        // .deliverImmediately is load-bearing, and only the selector-based
        // overload accepts it: this app is `.accessory` and so never the active
        // app, and the default suspension behavior queues a distributed
        // notification for an inactive app rather than delivering it — the menu
        // would simply never open.
        DistributedNotificationCenter.default().addObserver(
            controller, selector: #selector(StatusItemController.surface(_:)),
            name: SingleInstance.surfaceNotification, object: nil,
            suspensionBehavior: .deliverImmediately
        )
        // Own notification responses (PHNX-4004): the daemon posts actionable
        // notifications via one-shot `--notify` processes, but THIS persistent
        // instance is the UNUserNotificationCenter delegate that runs the command
        // a tapped action maps to (`agents feed answer …`, open report/PR/session).
        // configureForLaunch registers the action categories, installs the
        // delegate, and requests authorization once.
        Notifier.configureForLaunch()
        let mods = UInt32(cmdKey | shiftKey)
        hotkey.register([
            .init(id: HotkeyManager.clipID, keyCode: UInt32(kVK_ANSI_V), modifiers: mods,
                  label: "Cmd-Shift-V (paste clip reference)",
                  onFire: { Clip.run() }),
            .init(id: HotkeyManager.promptID, keyCode: UInt32(kVK_ANSI_O), modifiers: mods,
                  label: "Cmd-Shift-O (quick capture)",
                  onFire: { [weak self] in self?.promptController.summon() }),
        ])
        // Preview the quick-issue panel without the global hotkey (QA / a machine
        // where synthesizing a system hotkey isn't possible): MENUBAR_PROMPT_PREVIEW=1.
        if ProcessInfo.processInfo.environment["MENUBAR_PROMPT_PREVIEW"] == "1" {
            promptController.summon()
        }
    }
}

let delegate = AppDelegate(controller)
app.delegate = delegate
if ProcessInfo.processInfo.environment["MENUBAR_DUMP"] == "1" {
    controller.install()
    exit(0)
}
app.run()
