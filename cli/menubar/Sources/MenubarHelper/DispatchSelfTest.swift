import Foundation

// Headless self-test for the dispatch form's pure layer (Track E, PHNX-4005):
// the `agents run` argv builder for every mode/surface/watchdog/run-on combo, the
// session-id minting, the watchdog policy command, the per-project remembered
// defaults + collapsed summary line, the Cmd-P non-persisting path on the form
// view itself, and the pending-launch placeholder row + registry
// (register / resolve / fail / expire).
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
        testForcePlanDoesNotPersist()
        testPendingResolve()
        testPendingExpire()
        testPlaceholderRow()
        testPlaceholderRegistry()
        testDetachedStderrTail()
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

    // MARK: Cmd-P — Plan for this dispatch only, never persisted

    /// Drives the real DispatchFormView (no window, no run loop): Cmd-P must move
    /// the control and the summary and change what the dispatch runs under,
    /// without firing `onChange` (the controller's persist hook) and without
    /// touching the remembered mode. Picking a mode afterwards persists again.
    private static func testForcePlanDoesNotPersist() {
        let form = DispatchFormView(frame: .zero)
        var changes = 0
        form.onChange = { changes += 1 }
        form.summaryProvider = { form.dispatchDefaults(agents: ["claude"]).summaryLine(project: "agi") }
        form.apply(DispatchDefaults(agents: ["claude"], runOn: "local", mode: .auto,
                                    surface: .interactive, watchdog: .keep))
        check("apply fires no onChange", changes == 0)

        form.forcePlanForThisDispatch()
        check("Cmd-P does not fire onChange", changes == 0, "\(changes)")
        check("Cmd-P sets the effective mode to plan", form.effectiveMode == .plan)
        check("Cmd-P leaves the remembered mode alone", form.mode == .auto)
        check("Cmd-P is not in the persisted defaults",
              form.rememberedDefaults(agents: ["claude"]).mode == .auto)
        check("Cmd-P is in the dispatch defaults",
              form.dispatchDefaults(agents: ["claude"]).mode == .plan)
        let summary = form.dispatchDefaults(agents: ["claude"]).summaryLine(project: "agi")
        check("summary shows Plan after Cmd-P", summary.contains(" · Plan · "), summary)

        // The next summon applies the remembered defaults, which clears the override.
        form.apply(DispatchDefaults(agents: ["claude"], runOn: "local", mode: .auto,
                                    surface: .interactive, watchdog: .keep))
        check("apply clears the Cmd-P override", form.effectiveMode == .auto && form.forcedMode == nil)
        check("still no onChange", changes == 0)
    }

    // MARK: pending launches

    private static func pending(key: String, byUuid: Bool, agent: String, name: String,
                                launchedAtMs: Double, project: String? = "agi") -> PendingLaunch {
        PendingLaunch(key: key, byUuid: byUuid, agent: agent, name: name,
                      project: project, cwd: nil, launchedAtMs: launchedAtMs, stderrTail: nil)
    }

    private static func testPendingResolve() {
        let now: Double = 1_000_000
        let byUuid = pending(key: "sid-1", byUuid: true, agent: "claude",
                             name: "task-a", launchedAtMs: now)
        let byName = pending(key: "task-b", byUuid: false, agent: "codex",
                             name: "task-b", launchedAtMs: now)
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
        var p = pending(key: "sid-x", byUuid: true, agent: "claude",
                        name: "task", launchedAtMs: launched)
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

    // MARK: placeholder row + registry (what FeedStream publishes)

    private static func testPlaceholderRow() {
        let p = pending(key: "sid-9", byUuid: true, agent: "claude",
                        name: "fix-the-thing", launchedAtMs: 5_000)
        let row = p.placeholderRow
        check("placeholder rowKey is namespaced", row.rowKey == "launching/sid-9", row.rowKey ?? "nil")
        check("placeholder phase is launching", row.phase == PendingLaunches.launchingPhase)
        check("placeholder carries the session id", row.sessionId == "sid-9")
        check("placeholder carries the harness + name",
              row.kind == "claude" && row.name == "fix-the-thing" && row.title == "fix-the-thing")
        check("placeholder is attributed to the project", row.project == "agi")
        check("placeholder is not a previous row", !row.isPrevious)
        let named = pending(key: "n-1", byUuid: false, agent: "codex", name: "n-1", launchedAtMs: 0)
        check("name-keyed placeholder has no session id", named.placeholderRow.sessionId == nil)
    }

    private static func testPlaceholderRegistry() {
        let t0: Double = 1_000_000
        var reg = LaunchPlaceholders()
        let claude = pending(key: "sid-a", byUuid: true, agent: "claude", name: "task-a", launchedAtMs: t0)
        let codex = pending(key: "task-b", byUuid: false, agent: "codex", name: "task-b", launchedAtMs: t0)

        let d1 = reg.register(claude)
        _ = reg.register(codex)
        check("register upserts the placeholder rowKey", d1.upserted == ["launching/sid-a"], "\(d1)")
        check("registry publishes both rows",
              Set(reg.rows.keys) == ["launching/sid-a", "launching/task-b"])
        check("published rows read launching",
              reg.rows.values.allSatisfy { $0.phase == PendingLaunches.launchingPhase })

        // Re-registering a key replaces, never duplicates.
        _ = reg.register(claude)
        check("re-register does not duplicate", reg.pending.count == 2)

        // A real row for the uuid resolves that one; the name-keyed one survives.
        let r1 = reg.reconcile(realRows: decodeRows(#"[{"rowKey":"z/sid-a","sessionId":"sid-a"}]"#),
                               now: t0 + 1_000)
        check("resolved placeholder is removed with a diff",
              r1.diff.removed == ["launching/sid-a"] && r1.expired.isEmpty, "\(r1.diff)")
        check("unresolved placeholder survives", reg.pending.map(\.key) == ["task-b"])

        // A placeholder must never resolve against its own synthetic row.
        let selfRows = Array(reg.rows.values)
        let r2 = reg.reconcile(realRows: [], now: t0 + 2_000)
        check("no real rows: nothing resolves before the ttl", r2.diff.isEmpty && reg.pending.count == 1)
        check("placeholder rows are not real rows (would self-resolve)",
              PendingLaunches.resolvedKeys(reg.pending, rows: selfRows).contains("task-b"))

        // Expiry at the ttl, reported for the notification.
        let r3 = reg.reconcile(realRows: [], now: t0 + PendingLaunches.defaultTTLMs)
        check("expired placeholder is removed with a diff", r3.diff.removed == ["launching/task-b"])
        check("expired launch is reported", r3.expired.map(\.key) == ["task-b"])
        check("registry is empty after expiry", reg.pending.isEmpty && reg.rows.isEmpty)

        // A non-zero exit fails the placeholder now, carrying the stderr tail.
        _ = reg.register(claude)
        let f = reg.fail(key: "sid-a", stderrTail: "error: unknown option '--bogus'")
        check("fail removes the row", f.diff.removed == ["launching/sid-a"])
        check("fail carries the stderr tail into the message",
              f.expired.map { PendingLaunches.expiredMessage($0) }?.contains("--bogus") == true)
        let again = reg.fail(key: "sid-a", stderrTail: "late")
        check("fail on a gone key is a no-op", again.diff.isEmpty && again.expired == nil)
    }

    // MARK: detached launch — the stderr tail is real

    /// Drives `runDetachedWithStderrTail` against real children (they exit at
    /// once, so nothing accumulates): a non-zero exit delivers its status and the
    /// LAST bytes of stderr, bounded to `stderrTailBytes`; a zero exit delivers
    /// status 0; an unspawnable binary reports 127 with the spawn error.
    private static func testDetachedStderrTail() {
        var results: [(Int32, String)] = []
        // 3000 bytes of filler then the line that matters — the tail must keep
        // the end, not the start.
        let script = "head -c 3000 /dev/zero | tr '\\0' x >&2; echo >&2; echo 'error: unknown option --bogus' >&2; exit 3"
        AgentsCLI.runDetachedWithStderrTail(["/bin/sh", "-c", script]) { results.append(($0, $1)) }
        AgentsCLI.runDetachedWithStderrTail(["/bin/sh", "-c", "exit 0"]) { results.append(($0, $1)) }
        AgentsCLI.runDetachedWithStderrTail(["/nonexistent/agents-bin", "run"]) { results.append(($0, $1)) }
        let deadline = Date().addingTimeInterval(5)
        while results.count < 3, Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        check("every detached child reported on the main queue", results.count == 3, "\(results.count)")
        guard results.count == 3 else { return }
        let failed = results.first { $0.0 == 3 }
        check("non-zero exit reports its status", failed != nil)
        check("stderr tail keeps the last line", failed?.1.hasSuffix("error: unknown option --bogus") == true,
              failed?.1.suffix(80).description ?? "nil")
        check("stderr tail is bounded", (failed?.1.utf8.count ?? .max) <= AgentsCLI.stderrTailBytes,
              "\(failed?.1.utf8.count ?? -1)")
        check("stderr tail dropped the head of a long stream", failed?.1.hasPrefix("xxxx") == true)
        check("zero exit reports status 0 with an empty tail",
              results.contains { $0.0 == 0 && $0.1.isEmpty })
        let spawnFail = results.first { $0.0 == 127 }
        check("unspawnable binary reports 127 with the spawn error",
              spawnFail != nil && !(spawnFail?.1.isEmpty ?? true), spawnFail?.1 ?? "nil")
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
