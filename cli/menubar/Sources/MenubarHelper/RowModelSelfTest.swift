import Foundation

// Headless self-test for the pure SessionRowModel (PHNX-4003, Track C).
//
//   MENUBAR_ROWMODEL_TEST=1 — decode real feed-row JSON, drive
//   `SessionRowModel.present`, and assert every status-color branch, the PR-chip
//   states, the progress tally, the phase line, the subagents glyph, and the
//   latest-action ladder. Pure — no process, no network. A build gate
//   (test-menubar.sh).
//
// Rows are built by DECODING JSON (SessionRow/AttentionItem are the decode-only
// feed mirrors), so this also exercises the real decode path a stream line takes.

enum RowModelSelfTest {
    static func run() -> Never {
        var pass = true
        func check(_ name: String, _ condition: Bool) {
            print("\(condition ? "PASS" : "FAIL") — \(name)")
            if !condition { pass = false }
        }

        // A fixed clock so relative ages are deterministic.
        let now = Date(timeIntervalSince1970: 1_000_000)
        func ms(_ minutesAgo: Double) -> Double { (now.timeIntervalSince1970 - minutesAgo * 60) * 1000 }

        // MARK: status color — every branch.

        let working = row(#"{"phase":"running","machine":"s0","startedAtMs":\#(ms(18 * 60))}"#)
        check("phase running → working (green)",
              SessionRowModel.statusColor(working, attention: nil) == .working)

        let waitingPhase = row(#"{"phase":"waiting","machine":"m1"}"#)
        check("phase waiting → needsYou (yellow)",
              SessionRowModel.statusColor(waitingPhase, attention: nil) == .needsYou)

        let idlePhase = row(#"{"phase":"idle","machine":"m1","lastActivityMs":\#(ms(41))}"#)
        check("phase idle → idle (red)",
              SessionRowModel.statusColor(idlePhase, attention: nil) == .idle)

        let failedPhase = row(#"{"phase":"failed","machine":"m1"}"#)
        check("phase failed → idle (red)",
              SessionRowModel.statusColor(failedPhase, attention: nil) == .idle)

        let donePhase = row(#"{"phase":"done","machine":"m1"}"#)
        check("phase done → done (grey)",
              SessionRowModel.statusColor(donePhase, attention: nil) == .done)

        // Attention overrides a running phase.
        let question = attn(#"{"key":"h/s/1","sessionId":"s-q","kind":"question"}"#)
        check("attention question → needsYou even over a running phase",
              SessionRowModel.statusColor(working, attention: question) == .needsYou)
        let permission = attn(#"{"key":"h/s/1","sessionId":"s-p","kind":"permission"}"#)
        check("attention permission → needsYou",
              SessionRowModel.statusColor(working, attention: permission) == .needsYou)
        let plan = attn(#"{"key":"h/s/1","sessionId":"s-pl","kind":"plan_review"}"#)
        check("attention plan_review → needsYou",
              SessionRowModel.statusColor(working, attention: plan) == .needsYou)
        let failure = attn(#"{"key":"h/s/1","sessionId":"s-f","kind":"failure"}"#)
        check("attention failure → idle (red)",
              SessionRowModel.statusColor(working, attention: failure) == .idle)
        let stall = attn(#"{"key":"h/s/1","sessionId":"s-st","kind":"stall"}"#)
        check("attention stall → idle (red)",
              SessionRowModel.statusColor(working, attention: stall) == .idle)

        // MARK: phase text — the three shapes from the brief.

        let p1 = SessionRowModel.phaseText(working, attention: nil,
                                           status: .working, now: now)
        check("phase text working · 18h · s0", p1 == "working · 18h · s0")

        let qRow = row(#"{"phase":"waiting","machine":"zion","lastActivityMs":\#(ms(13))}"#)
        let p2 = SessionRowModel.phaseText(qRow, attention: question, status: .needsYou, now: now)
        check("phase text question · 13m · zion", p2 == "question · 13m · zion")

        let p3 = SessionRowModel.phaseText(idlePhase, attention: nil, status: .idle, now: now)
        check("phase text idle 41m · m1", p3 == "idle 41m · m1")

        // MARK: progress tally.

        let prog = row(#"{"phase":"running","todos":{"done":3,"total":7}}"#)
        check("progress reads done/total", SessionRowModel.progress(prog).map { "\($0.done)/\($0.total)" } == "3/7")
        let noProg = row(#"{"phase":"running","todos":{"done":0,"total":0}}"#)
        check("progress nil when total is zero", SessionRowModel.progress(noProg) == nil)
        check("progress nil when no todos", SessionRowModel.progress(working) == nil)

        // MARK: PR chip — every state.

        check("PR merged → merged chip (purple)",
              SessionRowModel.prChip(row(#"{"pr":{"number":12,"state":"merged"}}"#)) == .merged(12))
        check("PR draft → draft chip (dimmed)",
              SessionRowModel.prChip(row(#"{"pr":{"number":13,"isDraft":true}}"#)) == .draft(13))
        check("PR clean + approved → approved chip (green)",
              SessionRowModel.prChip(row(#"{"pr":{"number":14,"state":"open","mergeable":"clean","reviewDecision":"APPROVED"}}"#)) == .approved(14))
        check("PR unstable → checksFailed chip (red)",
              SessionRowModel.prChip(row(#"{"pr":{"number":15,"state":"open","mergeable":"unstable"}}"#)) == .checksFailed(15))
        check("PR unknown mergeable → checksRunning chip (grey)",
              SessionRowModel.prChip(row(#"{"pr":{"number":16,"state":"open","mergeable":"unknown"}}"#)) == .checksRunning(16))
        check("PR open, no verdict yet → open chip",
              SessionRowModel.prChip(row(#"{"pr":{"number":17,"state":"open","mergeable":"clean"}}"#)) == .open(17))
        check("no PR → nil chip", SessionRowModel.prChip(working) == nil)
        check("PR chip text renders merged",
              PRChip.merged(12).text == "PR #12 · merged ✓")
        check("PR chip text renders approved",
              PRChip.approved(14).text == "PR #14 · checks ✓ · approved")

        // MARK: subagents glyph.

        check("subAgentCount>0 → count",
              SessionRowModel.subagents(row(#"{"subAgentCount":3}"#)) == 3)
        check("pidCount>1 → count",
              SessionRowModel.subagents(row(#"{"pidCount":4}"#)) == 4)
        check("spawnedTeam → count",
              SessionRowModel.subagents(row(#"{"spawnedTeam":"squad"}"#)) == 1)
        check("lone process → nil",
              SessionRowModel.subagents(row(#"{"pidCount":1}"#)) == nil)

        // MARK: latest action ladder.

        let tl = row(#"{"timeline":{"steps":[{"text":"earlier"},{"text":"Running tests","now":"bun test"}]},"lastAgentLine":"fallback"}"#)
        check("latest action = last timeline step + tool",
              SessionRowModel.latestAction(tl) == "Running tests · bun test")
        let noTl = row(#"{"lastAgentLine":"only the line"}"#)
        check("latest action falls back to lastAgentLine",
              SessionRowModel.latestAction(noTl) == "only the line")
        check("latest action nil when nothing", SessionRowModel.latestAction(working) == nil)

        // MARK: group key + title ladder.

        check("group key = project", SessionRowModel.groupKey(row(#"{"project":"AGI"}"#)) == "AGI")
        check("group key falls back to cwd basename",
              SessionRowModel.groupKey(row(#"{"cwd":"/Users/x/src/agents-cli"}"#)) == "agents-cli")
        check("group key default other", SessionRowModel.groupKey(working) == "other")
        check("title prefers label",
              SessionRowModel.title(row(#"{"label":"L","name":"N","title":"T","topic":"O"}"#)) == "L")
        check("title falls to topic",
              SessionRowModel.title(row(#"{"topic":"O"}"#)) == "O")

        // MARK: full present() ties it together.

        let full = row(#"{"label":"Fix auth","phase":"running","project":"AGI","machine":"s0","startedAtMs":\#(ms(18 * 60)),"todos":{"done":2,"total":5},"pr":{"number":99,"state":"merged"},"subAgentCount":2}"#)
        let p = SessionRowModel.present(full, attention: nil, now: now)
        check("present composes the row",
              p.title == "Fix auth" && p.status == .working
                && p.phaseText == "working · 18h · s0"
                && p.progress?.done == 2 && p.progress?.total == 5
                && p.prChip == .merged(99) && p.subagents == 2 && p.groupKey == "AGI")

        print(pass ? "ALL PASS" : "SOME FAILED")
        exit(pass ? 0 : 1)
    }

    /// Decode a partial SessionRow from JSON, aborting loudly on a test-JSON bug.
    private static func row(_ json: String) -> SessionRow {
        guard let data = json.data(using: .utf8),
              let r = try? JSONDecoder().decode(SessionRow.self, from: data) else {
            print("FAIL — could not decode test row: \(json)")
            exit(1)
        }
        return r
    }

    private static func attn(_ json: String) -> AttentionItem {
        guard let data = json.data(using: .utf8),
              let a = try? JSONDecoder().decode(AttentionItem.self, from: data) else {
            print("FAIL — could not decode test attention: \(json)")
            exit(1)
        }
        return a
    }
}
