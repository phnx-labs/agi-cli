import Foundation

// Headless self-test for the dispatch form's pure layer (Track E, PHNX-4005):
// the `agents run` argv builder for every mode/surface/watchdog/run-on combo, the
// session-id minting, the watchdog policy command, the per-project remembered
// defaults + collapsed summary line, and the pending-launch resolve/expire logic.
//
// Exits before Guards.enforceForInteractiveLaunch like every other self-test —
// no GUI, no process, no network. build.sh runs it via test-menubar.sh, so a
// regression in the CLI contract these encode fails the build.
//
//   MENUBAR_DISPATCH_TEST=1 "AGI Menu"
enum DispatchSelfTest {
    private static var failures = 0

    static func run() -> Never {
        print("menubar dispatch self-test")
        testMintedSessionId()
        testDispatchArgsClaudeInteractive()
        testDispatchArgsEditHeadlessAuto()
        testDispatchArgsNonClaudeNoSessionId()
        testDispatchArgsCwdWhenNoProject()
        testModeMapping()
        testWatchdogArgs()
        testDefaultsRoundTrip()
        testDefaultsFallback()
        testSummaryLine()
        testPendingResolve()
        testPendingExpire()
        if failures == 0 {
            print("\nALL PASS")
            exit(0)
        }
        print("\n\(failures) FAILED")
        exit(1)
    }

    // MARK: session id

    private static func testMintedSessionId() {
        let id = AgentsCLI.mintedSessionId()
        check("minted id is lowercase", id == id.lowercased())
        // 8-4-4-4-12 hex uuid shape.
        let re = try? NSRegularExpression(
            pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        let range = NSRange(id.startIndex..., in: id)
        check("minted id is uuid-shaped", re?.firstMatch(in: id, range: range) != nil)
        check("two mints differ", AgentsCLI.mintedSessionId() != AgentsCLI.mintedSessionId())
    }

    // MARK: argv builder

    private static func testDispatchArgsClaudeInteractive() {
        let argv = AgentsCLI.dispatchArgs(
            agent: "claude", prompt: "fix the thing", name: "fix-the-thing",
            mode: .auto, surface: .interactive, runOn: "local",
            project: "agi", cwd: nil, sessionId: "abc-123")
        let expected = ["run", "claude", "fix the thing", "--mode", "auto",
                        "--balanced", "--notify", "--name", "fix-the-thing",
                        "--terminal", "--project", "agi", "--session-id", "abc-123"]
        check("claude auto interactive argv", argv == expected, "\(argv)")
    }

    private static func testDispatchArgsEditHeadlessAuto() {
        let argv = AgentsCLI.dispatchArgs(
            agent: "claude", prompt: "p", name: "n",
            mode: .edit, surface: .headless, runOn: "auto",
            project: nil, cwd: "/repo/dir", sessionId: "sid-9")
        let expected = ["run", "claude", "p", "--mode", "edit",
                        "--balanced", "--notify", "--name", "n",
                        "--cwd", "/repo/dir", "--device", "auto", "--session-id", "sid-9"]
        check("claude edit headless auto+cwd argv", argv == expected, "\(argv)")
        check("headless carries no --terminal", !argv.contains("--terminal"))
    }

    private static func testDispatchArgsNonClaudeNoSessionId() {
        let argv = AgentsCLI.dispatchArgs(
            agent: "codex", prompt: "p", name: "n",
            mode: .auto, surface: .interactive, runOn: "mark-1",
            project: "agi", cwd: nil, sessionId: "should-be-dropped")
        check("non-claude drops --session-id", !argv.contains("--session-id"), "\(argv)")
        check("non-claude keeps --device name", argv.contains("--device") && argv.contains("mark-1"))
    }

    private static func testDispatchArgsCwdWhenNoProject() {
        let argv = AgentsCLI.dispatchArgs(
            agent: "claude", prompt: "p", name: "n",
            mode: .auto, surface: .headless, runOn: "local",
            project: nil, cwd: "/some/dir", sessionId: nil)
        check("cwd used when no project", argv.contains("--cwd") && argv.contains("/some/dir"))
        check("no --project when absent", !argv.contains("--project"))
        check("local carries no --device", !argv.contains("--device"))
    }

    private static func testModeMapping() {
        check("plan runModeValue is nil", DispatchMode.plan.runModeValue == nil)
        check("auto runModeValue", DispatchMode.auto.runModeValue == "auto")
        check("edit runModeValue", DispatchMode.edit.runModeValue == "edit")
        check("plan is not a run", !DispatchMode.plan.isRun)
        check("auto is a run", DispatchMode.auto.isRun)
    }

    // MARK: watchdog

    private static func testWatchdogArgs() {
        check("keep needs no command", !WatchdogPolicy.keep.needsPolicyCommand)
        check("off needs a command", WatchdogPolicy.off.needsPolicyCommand)
        check("handsoff needs a command", WatchdogPolicy.handsoff.needsPolicyCommand)
        let argv = AgentsCLI.watchdogArgs(sessionId: "abc-123", policy: .handsoff)
        check("watchdog policy argv", argv == ["watchdog", "policy", "abc-123", "handsoff"], "\(argv)")
        check("off token", WatchdogPolicy.off.policyToken == "off")
    }

    // MARK: defaults

    private static func testDefaultsRoundTrip() {
        let store = scratchStore("roundtrip")
        let d = DispatchDefaults(agents: ["codex", "claude"], runOn: "mark-1",
                                 mode: .edit, surface: .headless, watchdog: .handsoff)
        d.save(project: "agi", store: store)
        let back = DispatchDefaults.load(project: "agi", store: store)
        check("defaults round-trip", back == d, "\(back)")
        // A different project has its own remembered set.
        let other = DispatchDefaults.load(project: "rush", store: store)
        check("per-project isolation", other == DispatchDefaults.fallback())
    }

    private static func testDefaultsFallback() {
        let store = scratchStore("fallback")
        let d = DispatchDefaults.load(project: "never-saved", fallbackAgent: "codex", store: store)
        check("fallback agent honored", d.agents == ["codex"], "\(d.agents)")
        check("fallback mode is auto", d.mode == .auto)
        check("fallback surface interactive", d.surface == .interactive)
        check("fallback watchdog keep", d.watchdog == .keep)
        check("fallback runOn local", d.runOn == "local")
        // A nil project never persists and always reads the fallback.
        DispatchDefaults.fallback().save(project: nil, store: store)
        check("nil project save is a no-op",
              DispatchDefaults.load(project: nil, store: store) == DispatchDefaults.fallback())
    }

    private static func testSummaryLine() {
        let d = DispatchDefaults(agents: ["claude"], runOn: "local", mode: .auto,
                                 surface: .interactive, watchdog: .keep)
        let line = d.summaryLine(project: "agi", primaryVersion: "2.1.263")
        check("summary line", line == "Claude 2.1.263 · this-mac · agi · Auto · Interactive · Keep moving", line)
        let noVersion = d.summaryLine(project: "agi")
        check("summary line without version",
              noVersion == "Claude · this-mac · agi · Auto · Interactive · Keep moving", noVersion)
        check("runOnLabel local", DispatchDefaults.runOnLabel("local") == "this-mac")
        check("runOnLabel device", DispatchDefaults.runOnLabel("mark-1") == "mark-1")
    }

    // MARK: pending launches

    private static func testPendingResolve() {
        let now: Double = 1_000_000
        let byUuid = PendingLaunch(key: "sid-1", byUuid: true, agent: "claude",
                                   name: "task-a", launchedAtMs: now, stderrTail: nil)
        let byName = PendingLaunch(key: "task-b", byUuid: false, agent: "codex",
                                   name: "task-b", launchedAtMs: now, stderrTail: nil)
        let rows = decodeRows("""
        [{"sessionId":"sid-1","project":"agi"},
         {"name":"task-b","project":"agi"}]
        """)
        let resolved = PendingLaunches.resolvedKeys([byUuid, byName], rows: rows)
        check("uuid placeholder resolves by session id", resolved.contains("sid-1"))
        check("name placeholder resolves by --name", resolved.contains("task-b"))
        let none = PendingLaunches.resolvedKeys([byUuid], rows: decodeRows("""
        [{"sessionId":"other"}]
        """))
        check("no false resolve", none.isEmpty)
    }

    private static func testPendingExpire() {
        let launched: Double = 1_000_000
        var p = PendingLaunch(key: "sid-x", byUuid: true, agent: "claude",
                              name: "task", launchedAtMs: launched, stderrTail: nil)
        let noRows: [SessionRow] = []
        check("not expired before ttl",
              PendingLaunches.expiredKeys([p], rows: noRows, now: launched + 30_000).isEmpty)
        check("expired after ttl",
              PendingLaunches.expiredKeys([p], rows: noRows, now: launched + 60_000).contains("sid-x"))
        // A resolved placeholder never expires even past the ttl.
        let rows = decodeRows("[{\"sessionId\":\"sid-x\"}]")
        check("resolved does not expire",
              PendingLaunches.expiredKeys([p], rows: rows, now: launched + 120_000).isEmpty)
        p.stderrTail = "spawn failed: ENOENT"
        check("expired message carries stderr tail",
              PendingLaunches.expiredMessage(p).contains("ENOENT"), PendingLaunches.expiredMessage(p))
    }

    // MARK: helpers

    private static func decodeRows(_ json: String) -> [SessionRow] {
        (try? JSONDecoder().decode([SessionRow].self, from: Data(json.utf8))) ?? []
    }

    private static func scratchStore(_ suite: String) -> UserDefaults {
        let name = "dispatch-selftest-\(suite)-\(UUID().uuidString)"
        let store = UserDefaults(suiteName: name)!
        store.removePersistentDomain(forName: name)
        return store
    }

    private static func check(_ label: String, _ ok: Bool, _ detail: String = "") {
        if ok {
            print("  PASS \(label)")
        } else {
            failures += 1
            print("  FAIL \(label)\(detail.isEmpty ? "" : " — \(detail)")")
        }
    }
}
