import Foundation

// Reply — the ONE place the Sessions card turns an operator gesture (answer an
// option, allow a permission, approve a plan, type a reply, nudge with Cmd-K)
// into one bounded `agents` argv (PHNX-4003, Track C).
//
// It is a PROJECTION over the CLI's own reply rails, never a second reply engine:
//   - An open feed BLOCK (the attention item carries a `key`) is answered
//     atomically through `agents feed answer <key>`, choice or text — the CLI
//     claims the first reply and routes it over the recorded session rail
//     (cli/docs/menubar.md, "Answers go through agents feed answer").
//   - A free-text reply with no open block routes by the session's reply
//     capability: terminal/tmux inject, cloud message, or a teams message.
//   - `none` disables the reply field with the CLI's stated reason; only Terminal
//     remains.
//
// The argv builders are PURE and pinned by `MENUBAR_REPLY_TEST=1`; the executor
// is one bounded `ChildProcess.runResult` (a deadline, group-killed, reaped) so a
// wedged CLI can never hang the card, and the ok/stderr result renders inline in
// the card — never as a toast.

/// The reply rail for a session, as reported by the feed. Mirrors
/// `AttentionItem.replyCapability` (terminal | tmux | cloud | team | none).
enum ReplyCapability: String, Equatable {
    case terminal
    case tmux
    case cloud
    case team
    case none

    init(_ raw: String?) {
        self = raw.flatMap { ReplyCapability(rawValue: $0) } ?? .none
    }
}

/// Everything Reply needs to build an argv for one session's reply. Assembled by
/// the card from the row + its attention item.
struct ReplyTarget: Equatable {
    let sessionId: String?
    /// An open feed block's key, when the session has a pending structured ask.
    let attentionKey: String?
    let capability: ReplyCapability
    /// Cloud task/session id for the `cloud` rail.
    let cloudId: String?
    /// Team + teammate for the `team` rail.
    let team: String?
    let mate: String?
    /// The CLI's stated reason the rail is unavailable, shown when `capability`
    /// is `.none` (the reply field is disabled and only Terminal remains).
    let disabledReason: String?

    init(sessionId: String?, attentionKey: String? = nil, capability: ReplyCapability,
         cloudId: String? = nil, team: String? = nil, mate: String? = nil,
         disabledReason: String? = nil) {
        self.sessionId = sessionId
        self.attentionKey = attentionKey
        self.capability = capability
        self.cloudId = cloudId
        self.team = team
        self.mate = mate
        self.disabledReason = disabledReason
    }
}

enum Reply {
    // MARK: - Pure argv builders (pinned by MENUBAR_REPLY_TEST)

    /// Answer an open feed block with a structured choice id.
    static func answerChoiceArgs(key: String, choiceId: String) -> [String] {
        ["feed", "answer", key, "--choice", choiceId]
    }

    /// Answer an open feed block with free text.
    static func answerTextArgs(key: String, text: String) -> [String] {
        ["feed", "answer", key, "--text", text]
    }

    /// Inject free text into a live terminal/tmux session.
    static func injectArgs(sessionId: String, text: String) -> [String] {
        ["sessions", "inject", sessionId, text]
    }

    /// Message a cloud task/session.
    static func cloudMessageArgs(id: String, text: String) -> [String] {
        ["cloud", "message", id, text]
    }

    /// Message a teammate on a team.
    static func teamMessageArgs(team: String, mate: String, text: String) -> [String] {
        ["teams", "message", team, mate, text]
    }

    // MARK: - Routing

    /// The argv to answer a structured choice. Requires an open feed block — a
    /// choice can only be claimed atomically through `feed answer`, so a target
    /// with no `attentionKey` yields nil (nothing to answer).
    static func choiceArgs(_ target: ReplyTarget, choiceId: String) -> [String]? {
        guard let key = target.attentionKey, !key.isEmpty, !choiceId.isEmpty else { return nil }
        return answerChoiceArgs(key: key, choiceId: choiceId)
    }

    /// The argv to send free text. An open feed block is answered atomically;
    /// otherwise the text rides the session's reply capability. Returns nil when
    /// the rail is `none` or a required id is missing (the field is disabled).
    static func textArgs(_ target: ReplyTarget, text: String) -> [String]? {
        let body = text
        guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        if let key = target.attentionKey, !key.isEmpty {
            return answerTextArgs(key: key, text: body)
        }
        switch target.capability {
        case .terminal, .tmux:
            guard let sid = target.sessionId, !sid.isEmpty else { return nil }
            return injectArgs(sessionId: sid, text: body)
        case .cloud:
            guard let id = target.cloudId ?? target.sessionId, !id.isEmpty else { return nil }
            return cloudMessageArgs(id: id, text: body)
        case .team:
            guard let team = target.team, !team.isEmpty, let mate = target.mate, !mate.isEmpty else { return nil }
            return teamMessageArgs(team: team, mate: mate, text: body)
        case .none:
            return nil
        }
    }

    /// Whether the reply field should be enabled for this target. It is disabled
    /// only when there is no open block AND no usable free-text rail.
    static func canReply(_ target: ReplyTarget) -> Bool {
        if let key = target.attentionKey, !key.isEmpty { return true }
        switch target.capability {
        case .terminal, .tmux: return target.sessionId?.isEmpty == false
        case .cloud:           return (target.cloudId ?? target.sessionId)?.isEmpty == false
        case .team:            return target.team?.isEmpty == false && target.mate?.isEmpty == false
        case .none:            return false
        }
    }

    // MARK: - Bounded execution

    /// Deadline for a reply action. A reply either lands fast or fails — it must
    /// never hang the card, so it is bounded like every other ChildProcess call.
    static let timeout: TimeInterval = 30

    /// Resolve bare `agents` args into a full argv. Prefers the daemon-exported
    /// node + entry (a launchd/GUI process has a minimal PATH), else the resolved
    /// `agents` binary — the same preference AgentsCLI.argv / FeedStream use,
    /// mirrored here because that resolver is private in a file this track does
    /// not edit.
    static func resolveArgv(_ args: [String]) -> [String] {
        let env = ProcessInfo.processInfo.environment
        if let node = env["AGENTS_NODE"], let entry = env["AGENTS_ENTRY"],
           FileManager.default.isExecutableFile(atPath: node),
           FileManager.default.fileExists(atPath: entry) {
            return [node, entry] + args
        }
        return [AgentsCLI.binary] + args
    }

    /// The outcome of one reply action as the card renders it: whether the CLI
    /// exited 0, and the text to quote inline (the CLI's own stdout/stderr lines,
    /// or why there is no result at all).
    struct Outcome: Equatable {
        /// The child started, stayed inside its deadline, and exited 0.
        let ok: Bool
        /// stdout then stderr, each trimmed, joined by a newline. Never empty for
        /// a run that produced no usable result.
        let output: String

        init(ok: Bool, output: String) {
            self.ok = ok
            self.output = output
        }

        /// Project a bounded run. `nil` means the child never started or blew its
        /// deadline (`ChildProcess.runResult`), which the card must say rather than
        /// render as a bare "failed".
        init(_ result: ChildProcess.RunResult?) {
            guard let result else {
                ok = false
                output = "no result: the command did not start or timed out after \(Int(Reply.timeout))s"
                return
            }
            ok = result.code == 0
            let out = String(decoding: result.stdout, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            let err = String(decoding: result.stderr, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            output = [out, err].filter { !$0.isEmpty }.joined(separator: "\n")
        }
    }

    /// Run one reply argv bounded, off the main queue, and deliver the outcome
    /// back on the main queue for inline rendering in the card.
    static func perform(_ args: [String], onResult: @escaping (Outcome) -> Void) {
        let argv = resolveArgv(args)
        DispatchQueue.global(qos: .userInitiated).async {
            let outcome = Outcome(ChildProcess.runResult(argv, timeout: timeout))
            DispatchQueue.main.async { onResult(outcome) }
        }
    }
}
