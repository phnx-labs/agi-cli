import Foundation
import UserNotifications

// Notifier self-test (PHNX-4004): pin the pure argv → content mapping (category
// identifier, userInfo, time-sensitivity, parsed choices) and the response →
// `agents feed answer` argv for every action, WITHOUT touching the notification
// center — a capturing runner stands in for ChildProcess. Gated by
// MENUBAR_NOTIFY_TEST=1 (main.swift); no GUI, no authorization, a build gate.
enum NotifierSelfTest {
    /// Records the argv a resolved response would run, so a test asserts the
    /// mapping without spawning `agents`. `handleResponse` runs the runner off
    /// the calling thread, so a test waits on `finished` before reading the argv.
    final class CapturingRunner: NotifyCommandRunning {
        var lastArgs: [String]?
        var exitCode: Int32 = 0
        let finished = DispatchSemaphore(value: 0)
        func run(agentsArgs: [String], timeout: TimeInterval) -> (code: Int32, stderr: String) {
            lastArgs = agentsArgs
            finished.signal()
            return (code: exitCode, stderr: "")
        }
        /// True when the runner ran within `timeout` seconds.
        func ran(within timeout: TimeInterval = 2) -> Bool {
            finished.wait(timeout: .now() + timeout) == .success
        }
    }

    /// A runner that blocks inside `run` until the test releases it, standing in
    /// for a `feed answer` that takes its full 20 s deadline — pins that
    /// `handleResponse` returns to the delegate while the child is still running,
    /// and that the child never runs on the caller's (possibly main) thread.
    final class SlowRunner: NotifyCommandRunning {
        var lastArgs: [String]?
        var ranOnMainThread: Bool?
        let started = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let finished = DispatchSemaphore(value: 0)
        func run(agentsArgs: [String], timeout: TimeInterval) -> (code: Int32, stderr: String) {
            lastArgs = agentsArgs
            ranOnMainThread = Thread.isMainThread
            started.signal()
            release.wait()
            finished.signal()
            return (code: 0, stderr: "")
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
        // A done banner offers both buttons but `--action` carries ONE link, so
        // the button whose target it did not carry must say so, never no-op.
        check("open-pr with the action on the report → unavailable(PR)",
              resolveNotifyResponse(actionIdentifier: NotifyAction.openPR, context: doneCtx, typedText: nil)
                == .unavailable(target: "PR"))
        check("open-report with the action on the PR → unavailable(report)",
              resolveNotifyResponse(actionIdentifier: NotifyAction.openReport, context: prCtx, typedText: nil)
                == .unavailable(target: "report"))
        let badUrlCtx = NotifyResponseContext(key: nil, sessionId: "sd", action: "url:javascript:alert(1)", choiceIds: [])
        check("open-pr with a non-web url → unavailable(PR)",
              resolveNotifyResponse(actionIdentifier: NotifyAction.openPR, context: badUrlCtx, typedText: nil)
                == .unavailable(target: "PR"))
        check("unavailable has no argv and is not an answer",
              NotifyResponse.unavailable(target: "PR").agentsArgs == nil
                && !NotifyResponse.unavailable(target: "PR").isAnswer)
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
              runner.ran() && runner.lastArgs == ["feed", "answer", "zion/abc/1", "--choice", "deny"])

        let runner2 = CapturingRunner()
        Notifier.handleResponse(questionCtx, actionIdentifier: NotifyAction.reply, typedText: "ship it",
                                agent: nil, runner: runner2)
        check("handleResponse(reply) runs feed answer --text",
              runner2.ran() && runner2.lastArgs == ["feed", "answer", "h/s/2", "--text", "ship it"])

        let runner3 = CapturingRunner()
        Notifier.handleResponse(failCtx, actionIdentifier: NotifyAction.openTerminal, typedText: nil,
                                agent: nil, runner: runner3)
        check("handleResponse(open-terminal) runs agents open agents://session",
              runner3.ran() && runner3.lastArgs == ["open", "agents://session/sf"])

        let runner4 = CapturingRunner()
        Notifier.handleResponse(permCtx, actionIdentifier: UNNotificationDismissActionIdentifier,
                                typedText: nil, agent: nil, runner: runner4)
        check("handleResponse(dismiss) runs nothing", !runner4.ran(within: 0.3) && runner4.lastArgs == nil)

        // MARK: handleResponse never blocks the delegate on the child
        // The delegate callback may arrive on the main thread and a `feed answer`
        // routing over a remote rail can take its full 20 s deadline, so the
        // call must return while the runner is still inside `run`, off-thread.
        let slow = SlowRunner()
        let calledAt = Date()
        Notifier.handleResponse(permCtx, actionIdentifier: NotifyAction.approve, typedText: nil,
                                agent: "claude", runner: slow)
        let returnedAfter = Date().timeIntervalSince(calledAt)
        let started = slow.started.wait(timeout: .now() + 2) == .success
        let stillRunning = slow.finished.wait(timeout: .now()) == .timedOut
        check("handleResponse returns before a slow runner completes", started && stillRunning)
        check("handleResponse returns without waiting on the runner (<100 ms)", returnedAfter < 0.1)
        check("the runner runs off the calling thread", slow.ranOnMainThread == false)
        slow.release.signal()
        check("the slow runner still ran the mapped argv",
              slow.finished.wait(timeout: .now() + 2) == .success
                && slow.lastArgs == ["feed", "answer", "zion/abc/1", "--choice", "approve"])

        print(pass ? "ALL PASS" : "SOME FAILED")
        exit(pass ? 0 : 1)
    }
}
