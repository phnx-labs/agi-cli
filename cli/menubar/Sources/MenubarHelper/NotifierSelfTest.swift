import Foundation
import UserNotifications

// Notifier self-test (PHNX-4004): pin the pure argv → content mapping (category
// identifier, userInfo, time-sensitivity, parsed choices) and the response →
// `agents feed answer` argv for every action, WITHOUT touching the notification
// center — a capturing runner stands in for ChildProcess. Gated by
// MENUBAR_NOTIFY_TEST=1 (main.swift); no GUI, no authorization, a build gate.
enum NotifierSelfTest {
    /// Records the argv a resolved response would run, so a test asserts the
    /// mapping without spawning `agents`.
    final class CapturingRunner: NotifyCommandRunning {
        var lastArgs: [String]?
        var exitCode: Int32 = 0
        func run(agentsArgs: [String], timeout: TimeInterval) -> (code: Int32, stderr: String) {
            lastArgs = agentsArgs
            return (code: exitCode, stderr: "")
        }
    }

    static func run() -> Never {
        var pass = true
        func check(_ name: String, _ cond: Bool) {
            print("\(cond ? "PASS" : "FAIL") — \(name)")
            if !cond { pass = false }
        }

        // MARK: argv → NotifyRequest / content mapping

        let permission = NotifyRequest(argv: [
            "--notify", "--title", "eve · Command approval", "--body", "May I run git push?",
            "--subtitle", "zion · agents-cli", "--category", "permission",
            "--key", "zion/abc/1", "--session", "0123", "--agent", "claude",
            "--choice", "approve=Approve", "--choice", "approve-session=Approve for session",
            "--choice", "deny=Deny",
        ])
        check("permission argv parses", permission != nil)
        check("permission category id", permission?.categoryIdentifier == NotifyCategory.permission)
        check("permission is time-sensitive", permission?.isTimeSensitive == true)
        check("permission key preserved", permission?.key == "zion/abc/1")
        check("permission session preserved", permission?.sessionId == "0123")
        check("permission agent preserved", permission?.agent == "claude")
        check("permission subtitle preserved", permission?.subtitle == "zion · agents-cli")
        check("permission choice ids", permission?.choices.map(\.id) == ["approve", "approve-session", "deny"])
        check("permission choice label split on first =",
              permission?.choices[1].label == "Approve for session")

        // missing body → nil (the exit(2) contract)
        check("missing --body → nil request",
              NotifyRequest(argv: ["--notify", "--title", "T"]) == nil)

        // question, discrete options → agents.question.<n>, time-sensitive
        let question2 = NotifyRequest(argv: [
            "--notify", "--title", "Q", "--body", "Which?", "--category", "question",
            "--key", "h/s/2", "--choice", "yes=Yes", "--choice", "no=No",
        ])
        check("question(2) category id", question2?.categoryIdentifier == "agents.question.2")
        check("question is time-sensitive", question2?.isTimeSensitive == true)

        let question0 = NotifyRequest(argv: [
            "--notify", "--title", "Q", "--body", "Open-ended?", "--category", "question", "--key", "h/s/3",
        ])
        check("question(0) → reply-only category", question0?.categoryIdentifier == NotifyCategory.questionReplyOnly)

        let question4 = NotifyRequest(argv: [
            "--notify", "--title", "Q", "--body", "?", "--category", "question", "--key", "h/s/4",
            "--choice", "a=A", "--choice", "b=B", "--choice", "c=C", "--choice", "d=D",
        ])
        check("question(4) caps at .3", question4?.categoryIdentifier == "agents.question.3")

        let planReview = NotifyRequest(argv: [
            "--notify", "--title", "Plan", "--body", "Approve?", "--category", "plan_review", "--key", "h/s/5",
            "--choice", "approve=Approve plan", "--choice", "send-back=Send back",
        ])
        check("plan_review category id", planReview?.categoryIdentifier == NotifyCategory.planReview)
        check("plan_review is time-sensitive", planReview?.isTimeSensitive == true)

        let done = NotifyRequest(argv: [
            "--notify", "--title", "run finished", "--body", "done", "--category", "done",
            "--action", "open:/tmp/report.md", "--choice", "open-report=Open report", "--choice", "open-pr=Open PR",
        ])
        check("done category id", done?.categoryIdentifier == NotifyCategory.done)
        check("done is NOT time-sensitive", done?.isTimeSensitive == false)
        check("done action preserved", done?.action == "open:/tmp/report.md")

        let failure = NotifyRequest(argv: [
            "--notify", "--title", "run failed", "--body", "boom", "--category", "failure",
            "--session", "sf", "--choice", "open-terminal=Open terminal",
        ])
        check("failure category id", failure?.categoryIdentifier == NotifyCategory.failure)
        check("failure is NOT time-sensitive", failure?.isTimeSensitive == false)

        let noCategory = NotifyRequest(argv: ["--notify", "--title", "T", "--body", "B"])
        check("no --category → nil category id (plain banner)", noCategory?.categoryIdentifier == nil)

        // MARK: response → command mapping

        let permCtx = NotifyResponseContext(key: "zion/abc/1", sessionId: "0123", action: nil,
                                            choiceIds: ["approve", "approve-session", "deny"])
        check("approve → --choice approve",
              resolveNotifyResponse(actionIdentifier: NotifyAction.approve, context: permCtx, typedText: nil)
                == .feedAnswerChoice(key: "zion/abc/1", choiceId: "approve"))
        check("deny → --choice deny",
              resolveNotifyResponse(actionIdentifier: NotifyAction.deny, context: permCtx, typedText: nil)
                == .feedAnswerChoice(key: "zion/abc/1", choiceId: "deny"))
        check("approve-session → --choice approve-session",
              resolveNotifyResponse(actionIdentifier: NotifyAction.approveSession, context: permCtx, typedText: nil)
                == .feedAnswerChoice(key: "zion/abc/1", choiceId: "approve-session"))
        check("body tap → open session",
              resolveNotifyResponse(actionIdentifier: UNNotificationDefaultActionIdentifier, context: permCtx, typedText: nil)
                == .openSession(sessionId: "0123"))
        check("dismiss → none",
              resolveNotifyResponse(actionIdentifier: UNNotificationDismissActionIdentifier, context: permCtx, typedText: nil)
                == NotifyResponse.none)
        check("missing key → none",
              resolveNotifyResponse(actionIdentifier: NotifyAction.approve,
                                    context: NotifyResponseContext(key: nil, sessionId: nil, action: nil, choiceIds: []),
                                    typedText: nil) == NotifyResponse.none)

        let questionCtx = NotifyResponseContext(key: "h/s/2", sessionId: "s2", action: nil,
                                                choiceIds: ["yes", "no", "maybe"])
        check("opt2 → 2nd choice id",
              resolveNotifyResponse(actionIdentifier: NotifyAction.option(2), context: questionCtx, typedText: nil)
                == .feedAnswerChoice(key: "h/s/2", choiceId: "no"))
        check("optN out of range → none",
              resolveNotifyResponse(actionIdentifier: NotifyAction.option(5), context: questionCtx, typedText: nil)
                == NotifyResponse.none)
        check("reply with text → --text",
              resolveNotifyResponse(actionIdentifier: NotifyAction.reply, context: questionCtx, typedText: "sounds good")
                == .feedAnswerText(key: "h/s/2", text: "sounds good"))
        check("reply empty → none",
              resolveNotifyResponse(actionIdentifier: NotifyAction.reply, context: questionCtx, typedText: "   ")
                == NotifyResponse.none)

        let planCtx = NotifyResponseContext(key: "h/s/5", sessionId: "s5", action: nil,
                                            choiceIds: ["approve", "send-back"])
        check("plan approve → --choice approve",
              resolveNotifyResponse(actionIdentifier: NotifyAction.approve, context: planCtx, typedText: nil)
                == .feedAnswerChoice(key: "h/s/5", choiceId: "approve"))
        check("send-back empty → --choice send-back",
              resolveNotifyResponse(actionIdentifier: NotifyAction.sendBack, context: planCtx, typedText: "")
                == .feedAnswerChoice(key: "h/s/5", choiceId: "send-back"))
        check("send-back with feedback → --text",
              resolveNotifyResponse(actionIdentifier: NotifyAction.sendBack, context: planCtx, typedText: "tighten the scope")
                == .feedAnswerText(key: "h/s/5", text: "tighten the scope"))

        let doneCtx = NotifyResponseContext(key: nil, sessionId: "sd", action: "open:/tmp/report.md", choiceIds: [])
        check("open-report → open file",
              resolveNotifyResponse(actionIdentifier: NotifyAction.openReport, context: doneCtx, typedText: nil)
                == .openFile(path: "/tmp/report.md"))
        let prCtx = NotifyResponseContext(key: nil, sessionId: "sd", action: "url:https://github.com/x/pull/1", choiceIds: [])
        check("open-pr → open web",
              resolveNotifyResponse(actionIdentifier: NotifyAction.openPR, context: prCtx, typedText: nil)
                == .openWeb(url: "https://github.com/x/pull/1"))
        check("open-pr with non-url action → none",
              resolveNotifyResponse(actionIdentifier: NotifyAction.openPR, context: doneCtx, typedText: nil)
                == NotifyResponse.none)
        let failCtx = NotifyResponseContext(key: nil, sessionId: "sf", action: nil, choiceIds: [])
        check("open-terminal → open session",
              resolveNotifyResponse(actionIdentifier: NotifyAction.openTerminal, context: failCtx, typedText: nil)
                == .openSession(sessionId: "sf"))

        // MARK: agentsArgs projection
        check("feedAnswerChoice argv",
              NotifyResponse.feedAnswerChoice(key: "h/s/1", choiceId: "deny").agentsArgs
                == ["feed", "answer", "h/s/1", "--choice", "deny"])
        check("feedAnswerText argv",
              NotifyResponse.feedAnswerText(key: "h/s/1", text: "no thanks").agentsArgs
                == ["feed", "answer", "h/s/1", "--text", "no thanks"])
        check("openSession argv",
              NotifyResponse.openSession(sessionId: "0123").agentsArgs
                == ["open", "agents://session/0123"])
        check("openFile has no argv", NotifyResponse.openFile(path: "/tmp/x").agentsArgs == nil)

        // MARK: handleResponse drives the runner (no notification center touched)
        let runner = CapturingRunner()
        Notifier.handleResponse(permCtx, actionIdentifier: NotifyAction.deny, typedText: nil,
                                agent: "claude", runner: runner)
        check("handleResponse(deny) runs feed answer --choice deny",
              runner.lastArgs == ["feed", "answer", "zion/abc/1", "--choice", "deny"])

        let runner2 = CapturingRunner()
        Notifier.handleResponse(questionCtx, actionIdentifier: NotifyAction.reply, typedText: "ship it",
                                agent: nil, runner: runner2)
        check("handleResponse(reply) runs feed answer --text",
              runner2.lastArgs == ["feed", "answer", "h/s/2", "--text", "ship it"])

        let runner3 = CapturingRunner()
        Notifier.handleResponse(failCtx, actionIdentifier: NotifyAction.openTerminal, typedText: nil,
                                agent: nil, runner: runner3)
        check("handleResponse(open-terminal) runs agents open agents://session",
              runner3.lastArgs == ["open", "agents://session/sf"])

        let runner4 = CapturingRunner()
        Notifier.handleResponse(permCtx, actionIdentifier: UNNotificationDismissActionIdentifier,
                                typedText: nil, agent: nil, runner: runner4)
        check("handleResponse(dismiss) runs nothing", runner4.lastArgs == nil)

        print(pass ? "ALL PASS" : "SOME FAILED")
        exit(pass ? 0 : 1)
    }
}
