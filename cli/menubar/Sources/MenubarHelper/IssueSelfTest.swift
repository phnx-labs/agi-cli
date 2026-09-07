import AppKit
import Foundation

// Self-test for the quick-issue capture logic (Cmd-Shift-O). Follows the repo's
// env-gated self-test idiom (see Bench.swift / MENUBAR_CLIP_TEST): no XCTest
// target exists for the menu-bar helper. Exercises the real code paths — newest
// clip selection over a fixture dir, ticket-id parsing, and the prompt contract
// — then exits nonzero on any failure so CI/a caller can gate on it.
//
//   MENUBAR_ISSUE_TEST=1 "AGI Menu"
enum IssueSelfTest {
    private static var failures = 0

    static func run() -> Never {
        print("menubar issue-capture self-test")
        testImageFilePick()
        testTicketIDParse()
        testPromptContract()
        testLinearBinaryResolution()
        testTicketCreateArgsAndParsing()
        testQuickFixContract()
        testQuickDispatchRoster()
        testRecentTicketsMerge()
        testDraftPreservation()
        testRoutineFailureReason()
        testRoutineGrouping()
        testRoutineGroupAccordion()
        testLinearTicketRanking()
        testLinearTicketFilter()
        testLinearTicketQuickFilterAndSort()
        testLinearCache()
        testTicketDispatchContract()
        testActiveDisplay()
        testCanonicalSessionStatuses()
        testAgentAvatar()
        if failures == 0 {
            print("\nALL PASS")
            exit(0)
        }
        print("\n\(failures) FAILED")
        exit(1)
    }

    private static func testCanonicalSessionStatuses() {
        let cases: [(SessionStatus, String, String)] = [
            (.running, "working", "●"), (.inputRequired, "waiting", "◐"),
            (.idle, "idle", "○"), (.queued, "queued", "○"),
            (.closed, "closed", "×"), (.abandoned, "abandoned", "⊘"),
            (.orphaned, "orphan", "◍"), (.crashed, "crashed", "✗"),
            (.unknown, "unknown", "◌"),
        ]
        for (status, label, glyph) in cases {
            check("canonical status label \(status.rawValue)", ActiveDisplay.statusLabel(status) == label)
            check("canonical status glyph \(status.rawValue)", ActiveDisplay.statusGlyph(status) == glyph)
        }
    }

    // imageFiles must return images newest-first ACROSS dirs, skip non-images and
    // `.json` sidecars, honor the limit, and collapse duplicate paths.
    private static func testImageFilePick() {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("menubar-img-test-\(ProcessInfo.processInfo.processIdentifier)",
                                    isDirectory: true)
        let dirA = base.appendingPathComponent("a"), dirB = base.appendingPathComponent("b")
        defer { try? FileManager.default.removeItem(at: base) }
        for d in [dirA, dirB] { try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true) }

        // dirA: an older png + a non-image + a sidecar (both must be skipped).
        write(dirA, "old.png", modified: -300)
        write(dirA, "notes.txt", modified: -1)      // non-image
        write(dirA, "old.png.json", modified: -1)   // sidecar
        // dirB holds the newest image, and a mid-age one.
        write(dirB, "newest.png", modified: -10)
        write(dirB, "mid.jpg", modified: -120)

        let got = AgentsCLI.imageFiles(inDirs: [dirA, dirB], limit: 6)
        check("newest image across dirs is first",
              (got.first as NSString?)?.lastPathComponent == "newest.png", detail: got.first ?? "nil")
        check("only the 3 images returned (txt + sidecar skipped)",
              got.count == 3 &&
              got.allSatisfy { AgentsCLI.imageExtensions.contains(($0 as NSString).pathExtension.lowercased()) },
              detail: got.map { ($0 as NSString).lastPathComponent }.joined(separator: ","))
        check("limit is honored", AgentsCLI.imageFiles(inDirs: [dirA, dirB], limit: 1).count == 1)
        check("no dirs yields empty", AgentsCLI.imageFiles(inDirs: [], limit: 6).isEmpty)
    }

    // parseCreatedTicketID pulls the identifier from the linear CLI success line,
    // prefers the `Created <ID>:` form, and returns nil when there is no ticket.
    private static func testTicketIDParse() {
        check("parses Created RUSH line",
              AgentsCLI.parseCreatedTicketID("Created RUSH-1532: Fix the thing") == "RUSH-1532")
        check("parses id from a noisy multi-line tail",
              AgentsCLI.parseCreatedTicketID("thinking...\nCreated ENG-42: Add retry [proj | me]\n") == "ENG-42")
        check("no ticket → nil", AgentsCLI.parseCreatedTicketID("could not create the issue") == nil)
        check("takes the final 'Created' over an earlier reasoning mention",
              AgentsCLI.parseCreatedTicketID("I saw Created RUSH-99 referenced.\nCreated RUSH-200: real") == "RUSH-200")

        // parseTicketURL pulls the Linear URL (for the clickable notification).
        check("parses the ticket URL",
              AgentsCLI.parseTicketURL("Created RUSH-200: real\nURL: https://linear.app/getrush/issue/RUSH-200/real")
              == "https://linear.app/getrush/issue/RUSH-200/real")
        check("trims trailing punctuation on the URL",
              AgentsCLI.parseTicketURL("see https://linear.app/getrush/issue/RUSH-9).") == "https://linear.app/getrush/issue/RUSH-9")
        check("no URL → nil", AgentsCLI.parseTicketURL("Created RUSH-200: real") == nil)
    }

    // The meta-prompt must carry the user's note and every user-provided file
    // forward for investigation, but must NOT tell the agent to run `linear create`
    // or to embed screenshot paths in the description — the helper owns both.
    private static func testPromptContract() {
        let oneShot = AgentsCLI.ticketAgentPrompt(note: "cards show raw uuids",
                                                  screenshotPaths: ["/tmp/clip one.png"])
        check("prompt embeds the note", oneShot.contains("cards show raw uuids"))
        check("prompt embeds the screenshot path", oneShot.contains("/tmp/clip one.png"))
        check("prompt asks for JSON output", oneShot.contains("JSON object"))
        check("prompt identifies user-provided ticket material",
              oneShot.contains("user-provided ticket material"))
        check("prompt forbids agent from running linear create",
              oneShot.contains("Do NOT run `linear create`"))
        check("prompt forbids screenshot paths in description",
              oneShot.contains("do NOT mention the screenshot paths here"))
        check("prompt does not make the agent run a proof upload",
              !oneShot.contains("--proof"))

        let multi = AgentsCLI.ticketAgentPrompt(note: "before/after",
                                                screenshotPaths: ["/tmp/a.png", "/tmp/b.png"])
        check("multi-shot prompt lists both paths",
              multi.contains("/tmp/a.png") && multi.contains("/tmp/b.png"))
        check("multi-shot prompt states the count", multi.contains("2 screenshots"))

        let noShot = AgentsCLI.ticketAgentPrompt(note: "flaky test", screenshotPaths: [])
        check("no-screenshot prompt says so", noShot.contains("No screenshots"))
        check("no-screenshot prompt has no /tmp path", !noShot.contains("/tmp/"))
        check("no-screenshot prompt has no upload command", !noShot.contains("--proof"))

        // RUSH-1636: the ticket agent must resolve a delegate and return it in JSON.
        let delegate = AgentsCLI.ticketAgentPrompt(note: "assign a delegate", screenshotPaths: ["/tmp/a.png"])
        check("prompt instructs delegate resolution", delegate.contains("agents sessions --active"))
        check("prompt lists the workspace delegate roster",
              delegate.contains("Antigravity") && delegate.contains("OpenClaw"))
        check("prompt returns delegate as JSON key", delegate.contains("\"delegate\""))
        check("prompt defaults to claude when inconclusive", delegate.contains("default to `claude`"))
    }

    // The helper parses the agent's JSON draft, builds `linear create` argv with
    // every selected screenshot as its own `--image` arg, and parses the created
    // ticket back from `linear create` stdout.
    private static func testTicketCreateArgsAndParsing() {
        let draft = TicketDraft(title: "Cards show raw uuids",
                                description: "The cards render raw uuids.",
                                priority: "high",
                                project: "Agents CLI",
                                label: "repo:agents-cli",
                                delegate: "claude")
        let args = AgentsCLI.ticketCreateArgs(
            draft: draft,
            screenshotPaths: ["/tmp/clip one.png", "/tmp/Muqsit's shot.png"],
            binary: "/test/bin/linear"
        )
        let expected = [
            "/test/bin/linear", "create", "Cards show raw uuids",
            "--priority", "high",
            "--project", "Agents CLI",
            "--label", "repo:agents-cli",
            "--description-file", "-",
            "--delegate", "claude",
            "--image", "/tmp/clip one.png",
            "--image", "/tmp/Muqsit's shot.png",
        ]
        check("create argv includes every selected screenshot as --image",
              args == expected,
              detail: args.joined(separator: " "))

        let noDelegate = TicketDraft(title: "T", description: "D", priority: "low",
                                     project: "P", label: "repo:x", delegate: nil)
        let noDelegateArgs = AgentsCLI.ticketCreateArgs(draft: noDelegate, screenshotPaths: [],
                                                        binary: "/test/bin/linear")
        check("nil delegate omits --delegate",
              !noDelegateArgs.contains("--delegate"),
              detail: noDelegateArgs.joined(separator: " "))

        let json = """
        Some reasoning here.
        {"title": "Fix it", "description": "Broken", "priority": "medium", "project": "P", "label": "repo:x", "delegate": null}
        """
        let parsed = AgentsCLI.parseTicketDraft(json)
        check("parseTicketDraft extracts JSON from surrounding text", parsed?.title == "Fix it")
        check("parseTicketDraft preserves null delegate", parsed?.delegate == nil)

        let createOutput = """
        Created RUSH-200: Cards show raw uuids
        URL: https://linear.app/getrush/issue/RUSH-200/cards-show-raw-uuids
        """
        let completion = AgentsCLI.ticketCompletion(output: createOutput)
        check("ticket completion parses the created id", completion?.id == "RUSH-200")
        check("ticket completion preserves the Linear URL",
              completion?.url == "https://linear.app/getrush/issue/RUSH-200/cards-show-raw-uuids")
        check("no created id yields no completion",
              AgentsCLI.ticketCompletion(output: "ticket create failed") == nil)
        check("uses final actionable failure line",
              AgentsCLI.ticketCreateFailureMessage("context\nauthentication failed\n") == "authentication failed")
        check("uses generic failure when process emitted nothing",
              AgentsCLI.ticketCreateFailureMessage("") == "linear create exited with an error.")
    }

    private static func testLinearBinaryResolution() {
        let dirs = AgentsCLI.linearSearchDirectories(home: "/Users/test", path: "/usr/bin:/opt/homebrew/bin")
        check("official linear install is first", dirs.first == "/Users/test/.local/bin")
        check("linear search dirs are deduped",
              dirs.filter { $0 == "/opt/homebrew/bin" }.count == 1)

        let fixture = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("menubar-linear-test-\(ProcessInfo.processInfo.processIdentifier)",
                                    isDirectory: true)
        let blockedDirectory = fixture.appendingPathComponent("blocked", isDirectory: true)
        let workingDirectory = fixture.appendingPathComponent("working", isDirectory: true)
        let executable = workingDirectory.appendingPathComponent("linear")
        let directoryNamedLinear = blockedDirectory.appendingPathComponent("linear", isDirectory: true)
        try? FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: workingDirectory, withIntermediateDirectories: true)
        try? Data("#!/bin/sh\nexit 0\n".utf8).write(to: executable)
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        try? FileManager.default.createDirectory(at: directoryNamedLinear, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: fixture) }

        check("resolves a real executable from supplied directories",
              AgentsCLI.executable(named: "linear", in: [workingDirectory.path]) == executable.path)
        check("skips an executable directory and falls back to a real file",
              AgentsCLI.executable(named: "linear", in: [blockedDirectory.path, workingDirectory.path])
                  == executable.path)
        check("missing executable resolves to nil",
              AgentsCLI.executable(named: "definitely-not-linear", in: [fixture.path]) == nil)
        check("missing CLI copy is actionable",
              AgentsCLI.linearNotFoundMessage.contains("~/.local/bin/linear"))
    }

    // The autonomous fix path must carry screenshots through and name runs with
    // a stable quick-dispatch handle so the tray/session index can surface them.
    private static func testQuickFixContract() {
        let prompt = AgentsCLI.quickFixPrompt(note: "button is off-screen",
                                              screenshotPaths: ["/tmp/panel.png"])
        check("quick-fix prompt embeds the request", prompt.contains("button is off-screen"))
        // The attachment travels as the SAME `<host>:<abs-path>` reference
        // Cmd-Shift-V types into a terminal, so a run dispatched to another
        // device can scp it. A bare path would only ever be readable here.
        let ref = "\(Clip.localHostName()):/tmp/panel.png"
        check("quick-fix prompt embeds the screenshot as a host-qualified ref",
              prompt.contains(ref), detail: ref)
        check("quick-fix prompt requires repo discovery", prompt.contains("agents sessions --all --limit 20"))
        check("quick-fix prompt requires verification", prompt.contains("Verify with the focused tests"))

        let name = AgentsCLI.quickDispatchName(note: "Fix the broken login button", date: Date(timeIntervalSince1970: 1234))
        check("dispatch name is a slug of the user's task", name == "fix-the-broken-login-button", detail: name)
        let emptyName = AgentsCLI.quickDispatchName(note: "   ", date: Date(timeIntervalSince1970: 1234))
        check("empty note falls back to a timestamped task name", emptyName == "task-1234", detail: emptyName)

        let args = AgentsCLI.quickFixRunArgs(agent: "codex", prompt: "<prompt>", name: "my-task")
        check("run is balanced + autonomous + self-notifying",
              args == ["run", "codex", "<prompt>", "--mode", "auto", "--balanced", "--notify", "--name", "my-task"],
              detail: args.joined(separator: " "))
        check("dispatch carries --notify so completion survives a helper restart",
              args.contains("--notify"))
        let scoped = AgentsCLI.quickFixRunArgs(agent: "codex", prompt: "<p>", name: "n", cwd: "/repo", device: "zion")
        check("run scopes to cwd + device when given",
              scoped == ["run", "codex", "<p>", "--mode", "auto", "--balanced", "--notify", "--name", "n", "--cwd", "/repo", "--device", "zion"],
              detail: scoped.joined(separator: " "))

        // A NAMED project is the palette's primary scoping (PHNX-4001): the CLI
        // resolves the project's base path and binds its sibling repos, which a
        // bare --cwd cannot express.
        let byProject = AgentsCLI.quickFixRunArgs(agent: "claude", prompt: "<p>", name: "n",
                                                  project: "agi")
        check("run scopes by project name when one is picked",
              byProject == ["run", "claude", "<p>", "--mode", "auto", "--balanced", "--notify",
                            "--name", "n", "--project", "agi"],
              detail: byProject.joined(separator: " "))
        // --project already sets the cwd, so passing both would be two answers to
        // one question; the narrowed directory is the only thing --cwd is for.
        let both = AgentsCLI.quickFixRunArgs(agent: "claude", prompt: "<p>", name: "n",
                                             cwd: "/repo/.agents/worktrees/x", project: "agi")
        check("--project wins over --cwd rather than emitting both",
              both.contains("--project") && !both.contains("--cwd"),
              detail: both.joined(separator: " "))

        // The full dispatched argv for a pasted attachment — the shape the palette
        // actually spawns, ref and all.
        let attached = AgentsCLI.quickFixRunArgs(
            agent: "claude",
            prompt: AgentsCLI.quickFixPrompt(
                note: "fix this",
                screenshotPaths: ["\(NSHomeDirectory())/.agents/.history/attachments/20260907-101112-a1b2c3.png"]),
            name: "fix-this", project: "agi")
        check("dispatched argv carries the attachment as a host ref",
              attached.contains { $0.contains("\(Clip.localHostName()):\(NSHomeDirectory())/.agents/.history/attachments/20260907-101112-a1b2c3.png") },
              detail: attached.joined(separator: " "))
    }

    // The picker roster is configurable but remains pinned to supported agents.
    private static func testQuickDispatchRoster() {
        let defaultRoster = LocalState.quickDispatchRoster(env: [:])
        check("default quick-dispatch roster uses desired agents",
              defaultRoster.map(\.id) == LocalState.desiredAgents.map(\.id))

        let filtered = LocalState.quickDispatchRoster(env: ["AGENTS_QUICK_DISPATCH_ROSTER": "codex,claude,missing,codex"])
        check("configured quick-dispatch roster preserves valid configured order and dedups",
              filtered.map(\.id) == ["codex", "claude"], detail: filtered.map(\.id).joined(separator: ","))

        let invalid = LocalState.quickDispatchRoster(env: ["AGENTS_QUICK_DISPATCH_ROSTER": "missing"])
        check("invalid quick-dispatch roster falls back to desired agents",
              invalid.map(\.id) == LocalState.desiredAgents.map(\.id))

        let preselected = IssueSelfTest.preselectedAgents(
            env: ["AGENTS_QUICK_DISPATCH_AGENTS": "codex,claude,missing,codex"],
            roster: filtered
        )
        check("configured quick-dispatch preselection stays visible and deduped",
              preselected == ["codex", "claude"], detail: preselected.joined(separator: ","))
    }

    // The recent-tickets ledger merge: newest-first, dedup by id, capped.
    private static func testRecentTicketsMerge() {
        func t(_ id: String) -> RecentTicket { RecentTicket(id: id, title: id, url: nil, createdAt: id) }
        let after = RecentTickets.merged([t("RUSH-1"), t("RUSH-2")], adding: t("RUSH-3"))
        check("new ticket is newest-first", after.first?.id == "RUSH-3")

        let deduped = RecentTickets.merged([t("RUSH-1"), t("RUSH-2")], adding: t("RUSH-2"))
        check("re-filing an id dedups (no stacking)",
              deduped.filter { $0.id == "RUSH-2" }.count == 1 && deduped.first?.id == "RUSH-2",
              detail: deduped.map { $0.id }.joined(separator: ","))

        var many = (1...12).map { t("RUSH-\($0)") }
        many = RecentTickets.merged(many, adding: t("RUSH-99"))
        check("capped at 10", many.count == 10 && many.first?.id == "RUSH-99")
    }

    // The draft state machine that survives a focus-steal: dismissing WITHOUT
    // submitting preserves an in-progress note (PromptDraft.forDismissal), while
    // submit/Escape clear it. summon() rehydrates from the saved draft, or a clean
    // slate when it was cleared. Exercised as pure logic — no live NSPanel needed.
    private static func testDraftPreservation() {
        // (a) An empty or whitespace-only note preserves nothing: the panel
        //     dismisses clean so the next summon starts fresh.
        check("empty note clears the draft",
              PromptDraft.forDismissal(note: "", selectedPaths: [],
                                       selectedAgents: [], action: .plan) == nil)
        check("whitespace/newline-only note clears the draft",
              PromptDraft.forDismissal(note: "  \n\t ", selectedPaths: ["/tmp/a.png"],
                                       selectedAgents: ["codex"], action: .run) == nil)

        // (b) A real note round-trips every field verbatim through save→restore.
        let saved = PromptDraft.forDismissal(note: "  cards show raw uuids  ",
                                             selectedPaths: ["/tmp/a.png", "/tmp/b.png"],
                                             selectedAgents: ["codex", "claude"],
                                             action: .run)
        check("non-empty note preserves a draft", saved != nil,
              detail: saved.map { $0.note } ?? "nil")
        check("draft preserves the raw (untrimmed) note",
              saved?.note == "  cards show raw uuids  ")
        check("draft preserves selectedPaths in order",
              saved?.selectedPaths == ["/tmp/a.png", "/tmp/b.png"],
              detail: (saved?.selectedPaths ?? []).joined(separator: ","))
        check("draft preserves selectedAgents",
              saved?.selectedAgents == ["codex", "claude"],
              detail: (saved?.selectedAgents ?? []).sorted().joined(separator: ","))
        check("draft preserves the dispatch action", saved?.action == .run)

        // The restore side (summon's `draft?.field ?? default`): a saved draft
        // rehydrates its fields; a nil draft — what submit and Escape leave behind
        // via clearDraft — restores to a clean slate.
        check("restore rehydrates note+action from a saved draft",
              (saved?.note ?? "") == "  cards show raw uuids  " &&
              (saved?.action ?? .plan) == .run)
        let cleared: PromptDraft? = nil   // what submit/Escape (clearDraft) leave
        check("submit/Escape leave no draft → restore yields empty note",
              (cleared?.note ?? "") == "")
        check("submit/Escape leave no draft → restore yields default action + no selection",
              (cleared?.action ?? .plan) == .plan &&
              (cleared?.selectedPaths ?? []).isEmpty &&
              (cleared?.selectedAgents ?? []).isEmpty)
    }

    // Overdue is a current scheduler condition, not proof that the previous run
    // failed. A last-successful routine with exitCode 0 must render as overdue,
    // not "exit 0", across summary, submenu header, and all-routines rows.
    private static func testRoutineFailureReason() {
        let succeededButOverdue = routine(
            lastStatus: "completed",
            exitCode: 0,
            failureReason: nil,
            overdue: true
        )
        check("overdue successful routine summary says overdue",
              routineFailureSummary(succeededButOverdue, max: 48) == "overdue",
              detail: routineFailureSummary(succeededButOverdue, max: 48))
        check("overdue successful routine detail says overdue",
              routineFailureDetail(succeededButOverdue, max: 72) == "overdue",
              detail: routineFailureDetail(succeededButOverdue, max: 72) ?? "nil")
        check("overdue successful routine all-row detail says overdue",
              routineFailureDetail(succeededButOverdue, max: 52) == "overdue",
              detail: routineFailureDetail(succeededButOverdue, max: 52) ?? "nil")

        let failed = routine(
            lastStatus: "failed",
            exitCode: 2,
            failureReason: nil,
            overdue: false
        )
        check("failed routine still falls back to exit code",
              routineFailureDetail(failed, max: 72) == "exit 2",
              detail: routineFailureDetail(failed, max: 72) ?? "nil")
    }

    // groupedRoutines preserves first-occurrence order, groups correctly, and puts
    // nil-projectGroup routines into the ungrouped tail.
    private static func testRoutineGrouping() {
        let cli1  = routine(name: "nightly-cli", projectGroup: "agents-cli")
        let web   = routine(name: "standup",     projectGroup: "rush-app")
        let cli2  = routine(name: "ci-check", lastStatus: "failed", exitCode: 1, overdue: false,
                            projectGroup: "agents-cli")
        let cross = routine(name: "healthcheck", projectGroup: nil)

        let (grouped, ungrouped) = groupedRoutines([cli1, web, cli2, cross])
        check("two project groups present", grouped.count == 2,
              detail: grouped.map { $0.0 }.joined(separator: ","))
        check("first group is agents-cli (first occurrence)",
              grouped.first.map { $0.0 } == "agents-cli",
              detail: grouped.first.map { $0.0 } ?? "nil")
        check("agents-cli group has both routines", grouped[0].1.count == 2,
              detail: "\(grouped[0].1.count)")
        check("rush-app group has one routine", grouped[1].1.count == 1)
        check("nil projectGroup lands in ungrouped",
              ungrouped.count == 1 && ungrouped[0].name == "healthcheck",
              detail: ungrouped.map { $0.name }.joined(separator: ","))

        // Within a group, insertion order (upcoming-first) is preserved.
        check("first agents-cli entry is the one that appeared first",
              grouped[0].1[0].name == "nightly-cli")

        // All-ungrouped: no groups, everything in the tail.
        let (g2, u2) = groupedRoutines([cross])
        check("no projectGroup means all ungrouped", g2.isEmpty && u2.count == 1)

        // Empty input.
        let (g3, u3) = groupedRoutines([])
        check("empty input yields empty output", g3.isEmpty && u3.isEmpty)
    }

    // The ROUTINES accordion: header summaries carry per-state glyph counts, the
    // header group count includes an ungrouped tail, and an expanded group orders
    // attention-first / next-run / paused-last.
    private static func testRoutineGroupAccordion() {
        let ok1     = routine(name: "seo-draft", nextRun: "2026-08-07T18:00:00Z")
        let ok2     = routine(name: "blog-draft", nextRun: "2026-08-07T09:00:00Z")
        let failing = routine(name: "usage-refresh", lastStatus: "failed", exitCode: 1)
        let missed  = routine(name: "device-probe", lastStatus: "missed", overdue: true)
        let paused  = routine(name: "release-train", enabled: false)

        // Summary: label + glyph counts (◔ ok, ✕ failing, ⃠ miss) + paused tail.
        // Whole-string equality — `⃠` is a combining scalar, so a `.contains("⃠1")`
        // substring check would split its grapheme cluster and spuriously fail.
        let summary = routineGroupSummary(label: "Operations",
                                          routines: [ok1, ok2, failing, missed, paused])
        check("summary is label + per-state glyph counts + paused tail",
              summary == "Operations  ·  ◔2 ✕1 ⃠1  ·  1 paused", detail: summary)

        // A clean, all-enabled group shows only the ◔ count, no paused tail.
        let clean = routineGroupSummary(label: "agents-cli", routines: [ok1])
        check("a clean single-routine group is just label + ◔1",
              clean == "agents-cli  ·  ◔1", detail: clean)

        // Header group count: named groups + one bucket for the ungrouped tail.
        let grouped = [routine(name: "a", projectGroup: "agents-cli"),
                       routine(name: "b", projectGroup: "rush-app"),
                       routine(name: "c", projectGroup: nil)]
        check("group count includes the ungrouped tail as one bucket",
              routineGroupCount(grouped) == 3, detail: "\(routineGroupCount(grouped))")
        check("no ungrouped tail is not counted",
              routineGroupCount([grouped[0], grouped[1]]) == 2)

        // Expanded order: attention first (failing + missed, in either order —
        // the assert sorts them), then enabled by next run (blog 09:00 before
        // seo 18:00), then paused last.
        let ordered = orderedGroupRoutines([ok1, paused, missed, ok2, failing]).map { $0.name }
        check("attention routines sort ahead of upcoming and paused",
              Array(ordered.prefix(2)).sorted() == ["device-probe", "usage-refresh"],
              detail: ordered.joined(separator: ","))
        check("upcoming routines sort by next run within the group",
              ordered[2] == "blog-draft" && ordered[3] == "seo-draft",
              detail: ordered.joined(separator: ","))
        check("paused routine sorts to the tail",
              ordered.last == "release-train", detail: ordered.joined(separator: ","))
    }

    // The ranking IS the suggestion: urgent leads, "no priority" sinks below low,
    // and within one priority overdue beats in-progress beats newest.
    private static func testLinearTicketRanking() {
        let now = date("2026-08-02T00:00:00Z")
        let urgent = ticket("A-1", priority: 1, createdAt: "2026-07-01T00:00:00.000Z")
        let none = ticket("A-2", priority: 0, createdAt: "2026-08-01T00:00:00.000Z")
        let low = ticket("A-3", priority: 4, createdAt: "2026-08-01T00:00:00.000Z")
        let highOld = ticket("A-4", priority: 2, createdAt: "2026-07-01T00:00:00.000Z")
        let highNew = ticket("A-5", priority: 2, createdAt: "2026-08-01T00:00:00.000Z")
        let highStarted = ticket("A-6", priority: 2, createdAt: "2026-06-01T00:00:00.000Z",
                                 stateType: "started")
        let highOverdue = ticket("A-7", priority: 2, createdAt: "2026-06-01T00:00:00.000Z",
                                 dueDate: "2026-07-30")

        let ranked = LinearTickets.rank([none, low, highNew, urgent, highOverdue, highStarted, highOld],
                                        now: now).map(\.identifier)
        check("urgent leads the list", ranked.first == "A-1", detail: ranked.joined(separator: ","))
        check("no-priority sinks below low", ranked.last == "A-2", detail: ranked.joined(separator: ","))
        check("inside one priority: overdue, then started, then newest",
              Array(ranked.dropFirst().prefix(4)) == ["A-7", "A-6", "A-5", "A-4"],
              detail: ranked.joined(separator: ","))
        check("an overdue ticket is only overdue against today",
              LinearTickets.isOverdue(highOverdue, now: now)
                  && !LinearTickets.isOverdue(highOverdue, now: date("2026-07-01T00:00:00Z")))
        check("priority labels read as Linear's scale",
              LinearTickets.priorityLabel(1) == "P1" && LinearTickets.priorityLabel(0) == "--")
    }

    // Typing narrows the list so an existing ticket surfaces before Return files a
    // duplicate.
    private static func testLinearTicketFilter() {
        let tickets = [
            ticket("RUSH-2078", title: "prix/code-reviewer is down"),
            ticket("RUSH-1968", title: "Passphrase exported in plaintext from .zshenv"),
        ]
        check("every term must match, in any order",
              LinearTickets.filter(tickets, query: "plaintext passphrase").map(\.identifier)
                  == ["RUSH-1968"])
        check("the identifier is searchable too",
              LinearTickets.filter(tickets, query: "rush-2078").map(\.identifier) == ["RUSH-2078"])
        check("an unmatched term yields nothing",
              LinearTickets.filter(tickets, query: "kubernetes").isEmpty)
        check("an empty query keeps the whole ranked list",
              LinearTickets.filter(tickets, query: "   ").count == 2)
    }

    // Quick filter + sort are single dropdowns (not chip blocks). list() is the
    // one path the panel uses: filter → text search → sort → cap. Flat list only.
    private static func testLinearTicketQuickFilterAndSort() {
        let now = date("2026-08-02T00:00:00Z")
        let todoP1 = ticket("T-1", title: "todo urgent", priority: 1,
                            createdAt: "2026-07-01T00:00:00.000Z", stateType: "unstarted")
        let doingP2 = ticket("T-2", title: "doing mid", priority: 2,
                             createdAt: "2026-08-01T00:00:00.000Z", stateType: "started")
        let backlog = ticket("T-3", title: "backlog item", priority: 3,
                             createdAt: "2026-06-01T00:00:00.000Z",
                             stateType: "unstarted", stateName: "Backlog")
        let overdue = ticket("T-4", title: "overdue low", priority: 4,
                             createdAt: "2026-05-01T00:00:00.000Z",
                             dueDate: "2026-07-01", stateType: "unstarted")
        let pool = [todoP1, doingP2, backlog, overdue]

        check("filter Doing keeps only started",
              LinearTickets.list(pool, filter: .doing, sort: .urgentFirst, now: now)
                  .map(\.identifier) == ["T-2"])
        check("filter P1 keeps only priority 1",
              LinearTickets.list(pool, filter: .p1, sort: .urgentFirst, now: now)
                  .map(\.identifier) == ["T-1"])
        check("filter Overdue keeps past due dates",
              LinearTickets.list(pool, filter: .overdue, sort: .urgentFirst, now: now)
                  .map(\.identifier) == ["T-4"])
        check("filter Backlog matches state name",
              LinearTickets.list(pool, filter: .backlog, sort: .urgentFirst, now: now)
                  .map(\.identifier) == ["T-3"])
        check("sort Newest leads with latest createdAt",
              LinearTickets.list(pool, filter: .all, sort: .newest, now: now)
                  .map(\.identifier).first == "T-2")
        check("sort Oldest leads with earliest createdAt",
              LinearTickets.list(pool, filter: .all, sort: .oldest, now: now)
                  .map(\.identifier).first == "T-4")
        check("sort Due puts dated tickets first",
              LinearTickets.list(pool, filter: .all, sort: .due, now: now)
                  .map(\.identifier).first == "T-4")
        check("text query ANDs with the filter",
              LinearTickets.list(pool, filter: .all, sort: .newest, query: "urgent", now: now)
                  .map(\.identifier) == ["T-1"])
        check("list cap truncates a long result",
              LinearTickets.list(Array(repeating: todoP1, count: 60),
                                 filter: .all, sort: .newest, now: now,
                                 cap: 10).count == 10)
        check("QuickFilter titles are human, not raw keys",
              LinearTickets.QuickFilter.p1.title == "P1 only"
                  && LinearTickets.QuickSort.urgentFirst.title == "Urgent first")
    }

    // The cache is what makes the panel appear instantly; a write for one project
    // must not disturb another, and staleness has to be honest.
    private static func testLinearCache() {
        let now = Date()
        var cache = LinearTickets.Cache()
        cache = LinearTickets.merged(cache, projects: [LinearProject(id: "p1", name: "Agents CLI")],
                                     at: now)
        cache = LinearTickets.merged(cache, project: "Agents CLI",
                                     tickets: [ticket("A-1")], at: now)
        cache = LinearTickets.merged(cache, project: "Rush App",
                                     tickets: [ticket("B-1"), ticket("B-2")], at: now)
        check("each project keeps its own tickets",
              cache.scopes["Agents CLI"]?.tickets.count == 1 && cache.scopes["Rush App"]?.tickets.count == 2)
        check("the project list survives a ticket write", cache.projects.count == 1)
        check("a just-fetched scope is fresh",
              LinearTickets.isFresh(cache, project: "Agents CLI", now: now))
        check("a scope older than the TTL is stale",
              !LinearTickets.isFresh(cache, project: "Agents CLI",
                                     now: now.addingTimeInterval(LinearTickets.cacheTTL + 1)))
        check("an unfetched scope is never fresh",
              !LinearTickets.isFresh(cache, project: "Prix", now: now))

        // The cache round-trips through JSON — it is read back on the next launch.
        guard let encoded = try? JSONEncoder().encode(cache),
              let decoded = try? JSONDecoder().decode(LinearTickets.Cache.self, from: encoded) else {
            check("cache round-trips through JSON", false)
            return
        }
        check("cache round-trips through JSON",
              decoded.scopes["Rush App"]?.tickets == cache.scopes["Rush App"]?.tickets)
    }

    // Dispatching an existing ticket must produce a real, scoped, self-reporting
    // run — and the Plan variant must not tell an agent to change code.
    private static func testTicketDispatchContract() {
        let t = ticket("RUSH-2098", title: "Surface the repo's open tickets", priority: 2)
        let args = AgentsCLI.ticketWorkRunArgs(
            agent: "claude",
            prompt: AgentsCLI.ticketWorkPrompt(ticket: t, action: .run),
            ticket: t, action: .run, cwd: "/Users/me/src/agents-cli")
        for flag in ["--mode", "auto", "--balanced", "--notify"] {
            check("ticket run argv carries \(flag)", args.contains(flag))
        }
        check("ticket run is scoped to the picked repo",
              args.contains("--cwd") && args.contains("/Users/me/src/agents-cli"))
        check("the session is named after the ticket",
              args.contains("rush-2098"), detail: args.joined(separator: " "))
        let planArgs = AgentsCLI.ticketWorkRunArgs(
            agent: "claude", prompt: "p", ticket: t, action: .plan, cwd: nil)
        check("a plan dispatch is named apart from the implementation run",
              planArgs.contains("rush-2098-plan"), detail: planArgs.joined(separator: " "))
        check("no --cwd when there is no repo to scope to", !planArgs.contains("--cwd"))
        let projectArgs = AgentsCLI.ticketWorkRunArgs(
            agent: "claude", prompt: "p", ticket: t, action: .run, project: "agi")
        check("a ticket dispatch scopes by project name when one is picked",
              projectArgs.contains("--project") && projectArgs.contains("agi")
                  && !projectArgs.contains("--cwd"),
              detail: projectArgs.joined(separator: " "))

        let runPrompt = AgentsCLI.ticketWorkPrompt(ticket: t, action: .run)
        check("the run brief names the ticket and how to read it",
              runPrompt.contains("RUSH-2098") && runPrompt.contains("linear tasks RUSH-2098"))
        // The brief must make the agent DISCOVER the in-progress state: state names
        // are per-workspace ("Doing" here, not "In Progress"), `--pickup` hardcodes
        // "In Progress", and `--status progress` is a `tasks` filter value, not a
        // state — both fail on a workspace that names it anything else.
        check("the run brief claims the ticket by discovering the started state",
              runPrompt.contains("linear states") && runPrompt.contains("--status")
                  && !runPrompt.contains("--pickup"))
        check("the run brief reports back on the ticket", runPrompt.contains("--comment"))
        let planPrompt = AgentsCLI.ticketWorkPrompt(ticket: t, action: .plan)
        check("the plan brief forbids code changes and a PR",
              planPrompt.contains("Do NOT change code") && planPrompt.contains("do NOT open a PR"))
        check("the plan brief posts the plan on the ticket",
              planPrompt.contains("linear update RUSH-2098 --comment"))

        // The click seam: a plain click on a row dispatches THAT ticket, and
        // Cmd-click opens it in Linear instead of spending an agent run on it.
        let row = TicketRowView(ticket: t, index: 0)
        var dispatched: LinearTicket?
        var opened: LinearTicket?
        row.onDispatch = { dispatched = $0 }
        row.onOpen = { opened = $0 }
        row.mouseDown(with: mouseEvent(modifiers: []))
        check("a click on a row dispatches that ticket",
              dispatched?.identifier == t.identifier && opened == nil)
        dispatched = nil
        row.mouseDown(with: mouseEvent(modifiers: [.command]))
        check("cmd-click opens the ticket instead of dispatching",
              opened?.identifier == t.identifier && dispatched == nil)

        let scopeArgs = AgentsCLI.linearTicketArgs(project: "Agents CLI", binary: "/test/bin/linear")
        check("the ticket query asks for every open ticket of the project",
              scopeArgs.contains("--all") && scopeArgs.contains("--status")
                  && scopeArgs.contains("open") && scopeArgs.contains("--cycle")
                  && scopeArgs.contains("all") && scopeArgs.contains("Agents CLI"),
              detail: scopeArgs.joined(separator: " "))
    }

    // ACTIVE accordion display helpers — title preference, age, locality, summary.
    private static func testActiveDisplay() {
        check("topic wins over terminal label and preview",
              ActiveDisplay.workTitle(topic: "Fix auth", label: "tab", preview: "long dump",
                                      terminalTitle: "term") == "Fix auth")
        check("label wins when topic is empty",
              ActiveDisplay.workTitle(topic: "  ", label: "My tab", preview: "x",
                                      terminalTitle: nil) == "My tab")
        check("preview falls back to first line only",
              ActiveDisplay.workTitle(topic: nil, label: nil,
                                      preview: "line one\nline two",
                                      terminalTitle: nil) == "line one")
        check("empty inputs yield empty work title",
              ActiveDisplay.workTitle(topic: nil, label: nil, preview: nil,
                                      terminalTitle: nil).isEmpty)

        let now: Double = 100_000_000
        check("age seconds", ActiveDisplay.ageLabel(fromMs: now - 15_000, nowMs: now) == "15s")
        check("age minutes", ActiveDisplay.ageLabel(fromMs: now - 180_000, nowMs: now) == "3m")
        check("age hours", ActiveDisplay.ageLabel(fromMs: now - 7_200_000, nowMs: now) == "2h")
        check("missing timestamp is empty", ActiveDisplay.ageLabel(fromMs: nil).isEmpty)

        check("same machine is local",
              ActiveDisplay.locality(machine: "zion", thisMachine: "zion") == "local")
        check("other machine is remote",
              ActiveDisplay.locality(machine: "yosemite-m0", thisMachine: "zion")
                  == "remote · yosemite-m0")
        check("nil machine is local (local-only listing)",
              ActiveDisplay.locality(machine: nil, thisMachine: "zion") == "local")
        // Parity with CLI machineId()/normalizeHost — engine tags rows as the
        // short lowercased hostname, never the Sharing computer name.
        check("normalizeHost strips domain and lowercases",
              ActiveDisplay.normalizeHost("Zion.local") == "zion")
        check("normalizeHost collapses non-alphanumerics",
              ActiveDisplay.normalizeHost("Muqsit's MacBook Pro") == "muqsit-s-macbook-pro")
        check("thisMachineId honors AGENTS_SYNC_MACHINE_ID",
              ActiveDisplay.thisMachineId(env: ["AGENTS_SYNC_MACHINE_ID": "ZION.tail"],
                                          hostname: "other.local") == "zion")
        check("locality matches after normalize (engine zion vs Host.local)",
              ActiveDisplay.locality(machine: "zion",
                                     thisMachine: ActiveDisplay.normalizeHost("Zion.local"))
                  == "local")

        let summary = ActiveDisplay.projectSummary(
            repo: "agents-cli",
            statuses: [.running: 8, .idle: 1, .queued: 2, .orphaned: 1],
            machines: ["zion", "zion"]
        )
        check("project summary carries every status and single host",
              summary.contains("agents-cli") && summary.contains("●8 working")
                  && summary.contains("○1 idle") && summary.contains("○2 queued")
                  && summary.contains("◍1 orphan") && summary.contains("zion"),
              detail: summary)
        let multi = ActiveDisplay.projectSummary(repo: "x", statuses: [.running: 2],
                                                 machines: ["a", "b"])
        check("multi-host summary says N hosts",
              multi.contains("2 hosts"), detail: multi)

        check("PR number from pull URL",
              ActiveDisplay.prNumber(from: "https://github.com/org/repo/pull/1753") == "1753")
        check("PR number nil for non-PR URL",
              ActiveDisplay.prNumber(from: "https://github.com/org/repo") == nil)
    }

    // MARK: helpers

    private static func ticket(_ identifier: String, title: String = "t", priority: Int = 2,
                               createdAt: String? = "2026-07-01T00:00:00.000Z",
                               dueDate: String? = nil,
                               stateType: String = "unstarted",
                               stateName: String? = nil) -> LinearTicket {
        let name = stateName
            ?? (stateType == "started" ? "Doing" : "Todo")
        return LinearTicket(identifier: identifier, title: title, priority: priority,
                            state: LinearTicketState(name: name, type: stateType),
                            url: "https://linear.app/getrush/issue/\(identifier)",
                            dueDate: dueDate, createdAt: createdAt)
    }

    private static func mouseEvent(modifiers: NSEvent.ModifierFlags) -> NSEvent {
        NSEvent.mouseEvent(with: .leftMouseDown, location: .zero, modifierFlags: modifiers,
                           timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0,
                           clickCount: 1, pressure: 1)!
    }

    private static func date(_ iso: String) -> Date {
        let f = ISO8601DateFormatter()
        return f.date(from: iso) ?? Date(timeIntervalSince1970: 0)
    }

    private static func write(_ dir: URL, _ name: String, modified offset: TimeInterval) {
        let url = dir.appendingPathComponent(name)
        try? Data("x".utf8).write(to: url)
        try? FileManager.default.setAttributes(
            [.modificationDate: Date().addingTimeInterval(offset)], ofItemAtPath: url.path)
    }

    // The notification's RIGHT-hand image. macOS draws the sending bundle's icon
    // on the left and `contentImage` on the right; AgentAvatar owns the right one,
    // so a banner reads "agents-cli, about <agent>". Pins the decisions that can
    // silently produce an unreadable or misleading badge.
    private static func testAgentAvatar() {
        // No agent yields NO image, not a blank tile and not a repeat of the left
        // icon — a heal notice or a multi-agent fan-out has nobody to depict.
        check("no agent renders no right-hand image", AgentAvatar.image(for: nil) == nil)
        check("blank agent renders no right-hand image", AgentAvatar.image(for: "   ") == nil)
        check("a known agent renders an image", AgentAvatar.image(for: "claude") != nil)

        // Marks must be unique, or two harnesses become the same badge. Four ids
        // start with `c` and two with `g`, which is why the mark is not an initial.
        let marks = AgentAvatar.brands.values.map(\.mark)
        check("every brand mark is unique", Set(marks).count == marks.count,
              detail: marks.sorted().joined(separator: ","))
        check("claude and codex are told apart",
              AgentAvatar.brand(for: "claude")?.mark != AgentAvatar.brand(for: "codex")?.mark)
        check("grok and goose are told apart",
              AgentAvatar.brand(for: "grok")?.mark != AgentAvatar.brand(for: "goose")?.mark)

        check("agent id is case/whitespace insensitive",
              AgentAvatar.brand(for: " Claude ")?.mark == AgentAvatar.brand(for: "claude")?.mark)

        // An unregistered id must still render — its initial on the fallback lime,
        // not a crash — so a harness added to the registry works before it is branded.
        check("unknown agent falls back to its initial",
              AgentAvatar.brand(for: "newharness")?.mark == "N")
        check("unknown agent still renders", AgentAvatar.image(for: "newharness") != nil)

        // Contrast: a dark brand takes white ink, a light one takes black.
        check("dark tile takes white ink",
              AgentAvatar.glyphColor(on: AgentAvatar.brand(for: "grok")!.color) == .white)
        check("light tile takes black ink",
              AgentAvatar.glyphColor(on: AgentAvatar.brand(for: "hermes")!.color) == .black)
    }

    private static func check(_ name: String, _ ok: Bool, detail: String? = nil) {
        if ok {
            print("  PASS  \(name)")
        } else {
            failures += 1
            print("  FAIL  \(name)" + (detail.map { "  (got: \($0))" } ?? ""))
        }
    }

    private static func preselectedAgents(env: [String: String], roster: [MenuAgent]) -> [String] {
        let visible = Set(roster.map(\.id))
        var seen = Set<String>()
        return env["AGENTS_QUICK_DISPATCH_AGENTS"]?
            .split(separator: ",")
            .map { LocalState.normalizeAgent(String($0).trimmingCharacters(in: .whitespacesAndNewlines)) }
            .filter { visible.contains($0) && seen.insert($0).inserted } ?? []
    }

    private static func routine(
        name: String = "nightly",
        lastStatus: String? = nil,
        exitCode: Int? = nil,
        failureReason: String? = nil,
        overdue: Bool = false,
        enabled: Bool = true,
        nextRun: String? = nil,
        projects: [String]? = nil,
        projectGroup: String? = nil
    ) -> Routine {
        Routine(
            name: name,
            agent: "claude",
            workflow: nil,
            repo: nil,
            projects: projects,
            projectGroup: projectGroup,
            schedule: "0 3 * * *",
            scheduleHuman: nil,
            enabled: enabled,
            overdue: overdue,
            nextRun: nextRun,
            nextRunHuman: "tomorrow",
            lastStatus: lastStatus,
            exitCode: exitCode,
            failureReason: failureReason,
            lastRunStartedAt: "2026-07-20T03:00:00.000Z",
            lastRunCompletedAt: "2026-07-20T03:00:05.000Z",
            ready: nil,
            readiness: nil,
            failureCode: nil,
            project: nil,
            requestedCwd: nil,
            resolvedCwd: nil,
            skipReason: nil,
            activeRunId: nil
        )
    }
}
