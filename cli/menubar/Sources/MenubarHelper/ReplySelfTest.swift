import Foundation

// Headless self-test for the pure Reply argv builders + routing (PHNX-4003,
// Track C).
//
//   MENUBAR_REPLY_TEST=1 — pin the exact `agents` argv for every reply
//   capability: an open feed block (choice + text), a terminal/tmux inject, a
//   cloud message, a teams message, and the disabled `none` rail. Pure — no
//   process, no network. A build gate (test-menubar.sh).

enum ReplySelfTest {
    static func run() -> Never {
        var pass = true
        func check(_ name: String, _ condition: Bool) {
            print("\(condition ? "PASS" : "FAIL") — \(name)")
            if !condition { pass = false }
        }

        // MARK: pure builders — exact argv shapes.

        check("answer choice argv",
              Reply.answerChoiceArgs(key: "zion/s-a/1", choiceId: "2")
                == ["feed", "answer", "zion/s-a/1", "--choice", "2"])
        check("answer text argv",
              Reply.answerTextArgs(key: "zion/s-a/1", text: "hi there")
                == ["feed", "answer", "zion/s-a/1", "--text", "hi there"])
        check("inject argv",
              Reply.injectArgs(sessionId: "abcd1234", text: "keep going")
                == ["sessions", "inject", "abcd1234", "keep going"])
        check("cloud message argv",
              Reply.cloudMessageArgs(id: "task-9", text: "status?")
                == ["cloud", "message", "task-9", "status?"])
        check("team message argv",
              Reply.teamMessageArgs(team: "squad", mate: "ocr", text: "sync up")
                == ["teams", "message", "squad", "ocr", "sync up"])

        // MARK: routing by capability.

        // An open feed block answers atomically, choice OR text, regardless of rail.
        let block = ReplyTarget(sessionId: "s1", attentionKey: "zion/s1/3", capability: .terminal)
        check("open block routes a choice through feed answer",
              Reply.choiceArgs(block, choiceId: "0") == ["feed", "answer", "zion/s1/3", "--choice", "0"])
        check("open block routes text through feed answer",
              Reply.textArgs(block, text: "use HDMI") == ["feed", "answer", "zion/s1/3", "--text", "use HDMI"])

        // No block: free text rides the session's reply capability.
        let terminal = ReplyTarget(sessionId: "term-1", capability: .terminal)
        check("terminal rail injects",
              Reply.textArgs(terminal, text: "Continue.") == ["sessions", "inject", "term-1", "Continue."])
        let tmux = ReplyTarget(sessionId: "tmux-1", capability: .tmux)
        check("tmux rail injects",
              Reply.textArgs(tmux, text: "go") == ["sessions", "inject", "tmux-1", "go"])
        let cloud = ReplyTarget(sessionId: "s2", capability: .cloud, cloudId: "ct-7")
        check("cloud rail messages the cloud task",
              Reply.textArgs(cloud, text: "resume") == ["cloud", "message", "ct-7", "resume"])
        let team = ReplyTarget(sessionId: "s3", capability: .team, team: "squad", mate: "ocr")
        check("team rail messages the teammate",
              Reply.textArgs(team, text: "help") == ["teams", "message", "squad", "ocr", "help"])

        // A choice can only be claimed through an open block.
        check("choice with no open block is nil", Reply.choiceArgs(terminal, choiceId: "0") == nil)

        // The `none` rail disables the field.
        let none = ReplyTarget(sessionId: "s4", capability: .none, disabledReason: "no live rail")
        check("none rail yields no text argv", Reply.textArgs(none, text: "x") == nil)
        check("none rail cannot reply", Reply.canReply(none) == false)
        check("open block can always reply", Reply.canReply(block) == true)
        check("terminal with a session can reply", Reply.canReply(terminal) == true)

        // Empty text never sends.
        check("empty text is nil", Reply.textArgs(terminal, text: "   ") == nil)

        // Missing ids disable the rail.
        let noSid = ReplyTarget(sessionId: nil, capability: .terminal)
        check("terminal with no session cannot reply", Reply.canReply(noSid) == false)
        let noMate = ReplyTarget(sessionId: "s5", capability: .team, team: "squad", mate: nil)
        check("team with no mate cannot reply", Reply.canReply(noMate) == false)

        // A peer-owned terminal row injects on its device.
        check("inject argv names a peer device",
              Reply.injectArgs(sessionId: "abcd1234", text: "go", device: "yosemite-s0")
                == ["sessions", "inject", "abcd1234", "go", "--device", "yosemite-s0"])
        let peer = ReplyTarget(sessionId: "term-9", capability: .terminal, device: "yosemite-s0")
        check("terminal rail on a peer routes with --device",
              Reply.textArgs(peer, text: "go") == ["sessions", "inject", "term-9", "go", "--device", "yosemite-s0"])

        // MARK: no-block fallback — the card's routing from the row itself.
        // Mirrors replyCapabilityForSession (cli/src/lib/feed/attention.ts).

        // (1) A teammate row (context: teams) messages its team + member —
        // never an inject, even though it is live.
        let mate = row(#"{"sessionId":"s-mate","context":"teams","teamName":"squad","agentId":"ag-ocr","label":"ocr","status":"running","host":"code","sourceDevice":"zion"}"#)
        let mateTarget = Reply.fallbackTarget(for: mate, localDevice: "zion")
        check("teams row routes to the team rail", mateTarget.capability == .team)
        check("teams row messages <teamName> <agentId>",
              Reply.textArgs(mateTarget, text: "sync up") == ["teams", "message", "squad", "ag-ocr", "sync up"])
        let mateNoTeam = row(#"{"sessionId":"s-m2","context":"teams","status":"running"}"#)
        check("teams row with no team name is disabled with a reason",
              Reply.fallbackTarget(for: mateNoTeam, localDevice: "zion").capability == .none
                && Reply.fallbackTarget(for: mateNoTeam, localDevice: "zion").disabledReason?.isEmpty == false)

        // spawnedTeam marks the ORCHESTRATOR — an ordinary terminal row, injectable.
        let lead = row(#"{"sessionId":"s-lead","context":"terminal","host":"ghostty","spawnedTeam":"squad","status":"running","sourceDevice":"zion"}"#)
        let leadTarget = Reply.fallbackTarget(for: lead, localDevice: "zion")
        check("orchestrator with spawnedTeam stays on the terminal rail", leadTarget.capability == .terminal)
        check("orchestrator injects locally with no --device",
              Reply.textArgs(leadTarget, text: "Continue.") == ["sessions", "inject", "s-lead", "Continue."])

        // (2) A live terminal row keeps the terminal rail only with a detected
        // host surface; tmux is its own rail; a peer's row carries --device.
        let iterm = row(#"{"sessionId":"s-it","context":"terminal","host":"iterm","status":"idle","sourceDevice":"zion"}"#)
        check("live iterm row injects", Reply.fallbackTarget(for: iterm, localDevice: "zion").capability == .terminal)
        let tmuxRow = row(#"{"sessionId":"s-tm","context":"headless","host":"tmux","status":"running","sourceDevice":"yosemite-s0"}"#)
        let tmuxTarget = Reply.fallbackTarget(for: tmuxRow, localDevice: "zion")
        check("tmux host is the tmux rail whatever the context", tmuxTarget.capability == .tmux)
        check("peer tmux row injects with --device",
              Reply.textArgs(tmuxTarget, text: "go") == ["sessions", "inject", "s-tm", "go", "--device", "yosemite-s0"])
        let bareShell = row(#"{"sessionId":"s-sh","context":"terminal","status":"running","sourceDevice":"zion"}"#)
        let bareTarget = Reply.fallbackTarget(for: bareShell, localDevice: "zion")
        check("terminal row with no host surface is disabled",
              bareTarget.capability == .none && bareTarget.disabledReason?.contains("no terminal surface") == true)
        let closed = row(#"{"sessionId":"s-cl","context":"terminal","host":"iterm","status":"closed","sourceDevice":"zion"}"#)
        let closedTarget = Reply.fallbackTarget(for: closed, localDevice: "zion")
        check("closed terminal row is disabled as not live",
              closedTarget.capability == .none && closedTarget.disabledReason == "the session is not live")
        let unknownLocal = Reply.fallbackTarget(for: iterm, localDevice: nil)
        check("unknown local device routes explicitly", unknownLocal.device == "zion")

        // Cloud rows carry no session id; the task id is the message target.
        let cloudRow = row(#"{"context":"cloud","cloudTaskId":"ct-42","kind":"codex","status":"running"}"#)
        let cloudTarget = Reply.fallbackTarget(for: cloudRow, localDevice: "zion")
        check("cloud row routes to the cloud rail", cloudTarget.capability == .cloud)
        check("cloud row messages its task id",
              Reply.textArgs(cloudTarget, text: "resume") == ["cloud", "message", "ct-42", "resume"])

        // (3) Everything else is .none with a clear reason.
        let headless = row(#"{"sessionId":"s-hl","context":"headless","host":"code","status":"running"}"#)
        let headlessTarget = Reply.fallbackTarget(for: headless, localDevice: "zion")
        check("headless row is disabled", headlessTarget.capability == .none)
        check("headless row says why", headlessTarget.disabledReason?.contains("headless") == true)
        let recent = row(#"{"sessionId":"s-rc","context":"recent","status":"done"}"#)
        check("history row is disabled with a reason",
              Reply.fallbackTarget(for: recent, localDevice: "zion").disabledReason?.contains("history") == true)
        let noContext = row(#"{"sessionId":"s-nc","status":"running","host":"iterm"}"#)
        let noContextTarget = Reply.fallbackTarget(for: noContext, localDevice: "zion")
        check("row with no context is disabled, never assumed terminal",
              noContextTarget.capability == .none && noContextTarget.disabledReason?.contains("no context") == true)
        check("every disabled fallback cannot reply",
              [mateNoTeam, bareShell, closed, headless, recent, noContext]
                .allSatisfy { !Reply.canReply(Reply.fallbackTarget(for: $0, localDevice: "zion")) })

        print(pass ? "ALL PASS" : "SOME FAILED")
        exit(pass ? 0 : 1)
    }

    /// Rows are built by DECODING JSON, so the fallback is exercised on the same
    /// decode path a stream line takes (and the new context/team/cloud fields
    /// are proven to decode).
    private static func row(_ json: String) -> SessionRow {
        guard let data = json.data(using: .utf8),
              let r = try? JSONDecoder().decode(SessionRow.self, from: data) else {
            print("FAIL — could not decode test row: \(json)")
            exit(1)
        }
        return r
    }
}
