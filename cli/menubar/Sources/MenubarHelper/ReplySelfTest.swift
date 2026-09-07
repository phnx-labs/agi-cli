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

        print(pass ? "ALL PASS" : "SOME FAILED")
        exit(pass ? 0 : 1)
    }
}
