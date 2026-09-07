import Foundation

// Headless self-test for the project pulse (Track E, PHNX-4005): decode a real
// `agents projects status <name> --json` payload into ProjectPulse (milestones,
// linear counts, PRs, release), and fold a fixture feed-row set into the live
// rollup (running / need-you / idle counts and the not-progressing-first NOW
// ordering). Pure — no process, no AppKit — so build.sh gates on it.
//
//   MENUBAR_PULSE_TEST=1 "AGI Menu"
enum PulseSelfTest {
    private static var failures = 0

    static func run() -> Never {
        print("menubar pulse self-test")
        testDecode()
        testDecodeTolerance()
        testHeadlineMilestone()
        testLiveRollup()
        testLiveOrdering()
        if failures == 0 {
            print("\nALL PASS")
            exit(0)
        }
        print("\n\(failures) FAILED")
        exit(1)
    }

    // The real element shape of `agents projects status agi --json` (an array;
    // a named lookup carries one element with the ProjectDef spread + rollup
    // fields). Fields that can be null (schedule, latestRelease) are included so
    // the decoder is proven against them.
    private static let fixture = """
    [
      {
        "name": "agi",
        "description": "Agents CLI and Factory",
        "agents": 3,
        "byStatus": { "running": 2, "idle": 1 },
        "plan": { "done": 6, "total": 8 },
        "schedule": null,
        "openPrs": [ { "url": "https://github.com/x/y/pull/1", "number": 1 },
                     { "url": "https://github.com/x/y/pull/2" } ],
        "mergedPrs": 5,
        "latestRelease": { "tag": "v2.1.263", "publishedAt": "2026-09-06T00:00:00Z" },
        "linear": {
          "projectId": "8eb8f5b1",
          "name": "AGI",
          "done": 40,
          "total": 61,
          "inProgress": 7,
          "milestones": [
            { "name": "Distribution", "targetDate": "2026-08-18", "done": 12, "total": 12, "isNext": false },
            { "name": "Dispatch app", "targetDate": "2026-09-14", "done": 3, "total": 9, "isNext": true }
          ],
          "nextMilestone": { "name": "Dispatch app", "targetDate": "2026-09-14", "done": 3, "total": 9, "isNext": true }
        },
        "tickets": [ "PHNX-4005" ],
        "worktrees": 2,
        "somethingNewerCLIsEmit": true
      },
      {
        "name": "rush",
        "agents": 0,
        "openPrs": [],
        "mergedPrs": 0,
        "linear": { "done": 1, "total": 2, "inProgress": 0 }
      }
    ]
    """

    private static func testDecode() {
        guard let pulse = ProjectPulse.decode(Data(fixture.utf8), project: "agi") else {
            check("decode agi element", false); return
        }
        check("picks the named element", pulse.project == "agi")
        check("plan progress", pulse.plan?.done == 6 && pulse.plan?.total == 8)
        check("agent count", pulse.agentCount == 3)
        check("open pr count", pulse.openPrCount == 2)
        check("merged prs", pulse.mergedPrs == 5)
        check("latest release", pulse.latestReleaseTag == "v2.1.263")
        check("linear done/total", pulse.linear?.done == 40 && pulse.linear?.total == 61)
        check("linear open = total-done", pulse.linear?.open == 21)
        check("linear in progress", pulse.linear?.inProgress == 7)
        check("milestone count", pulse.linear?.milestones.count == 2)
    }

    private static func testDecodeTolerance() {
        // A second project element with a null schedule and missing fields still
        // decodes, and selecting by name is order-independent.
        guard let rush = ProjectPulse.decode(Data(fixture.utf8), project: "rush") else {
            check("decode second element", false); return
        }
        check("second element by name", rush.project == "rush")
        check("second element open pr count", rush.openPrCount == 0)
        check("second element no release", rush.latestReleaseTag == nil)
        // Falls back to the first element when the name is not present.
        let fallback = ProjectPulse.decode(Data(fixture.utf8), project: "not-here")
        check("unknown name falls back to first", fallback?.project == "agi")
        // Garbage is nil, never a throw.
        check("garbage is nil", ProjectPulse.decode(Data("not json".utf8), project: "agi") == nil)
    }

    private static func testHeadlineMilestone() {
        guard let pulse = ProjectPulse.decode(Data(fixture.utf8), project: "agi") else {
            check("headline decode", false); return
        }
        let m = pulse.headlineMilestone
        check("headline is the next milestone", m?.name == "Dispatch app")
        check("headline percent", m?.percent == 33, "\(m?.percent ?? -1)")
    }

    private static func testLiveRollup() {
        let rows = decodeRows("""
        [ {"sessionId":"a","project":"agi","phase":"running","activity":"working"},
          {"sessionId":"b","project":"agi","phase":"waiting","activity":"waiting_input"},
          {"sessionId":"c","project":"agi","phase":"idle","activity":"idle"},
          {"sessionId":"d","project":"AGI","phase":"running"},
          {"sessionId":"e","project":"agi","phase":"idle","previous":true},
          {"sessionId":"f","project":"rush","phase":"running"} ]
        """)
        let r = ProjectLiveRollup.rollup(rows: rows, project: "agi")
        check("running count", r.running == 2, "\(r.running)")   // a + d (case-insensitive)
        check("need-you count", r.needYou == 1, "\(r.needYou)")  // b
        check("idle count", r.idle == 1, "\(r.idle)")            // c (e is previous, excluded)
        check("excludes other project + previous", r.running + r.needYou + r.idle == 4)
        check("belongs is case-insensitive",
              ProjectLiveRollup.belongs(rows[3], to: "agi"))
    }

    private static func testLiveOrdering() {
        let rows = decodeRows("""
        [ {"sessionId":"run","project":"agi","phase":"running","lastActivityMs":100},
          {"sessionId":"idle","project":"agi","phase":"idle","lastActivityMs":200},
          {"sessionId":"need","project":"agi","phase":"waiting","lastActivityMs":50} ]
        """)
        let r = ProjectLiveRollup.rollup(rows: rows, project: "agi", nowLimit: 3)
        let order = r.nowRows.compactMap { $0.sessionId }
        // Not-progressing first: need-you, then idle, then running last.
        check("NOW ordering not-progressing first", order == ["need", "idle", "run"], "\(order)")
        let capped = ProjectLiveRollup.rollup(rows: rows, project: "agi", nowLimit: 2)
        check("NOW respects the limit", capped.nowRows.count == 2)
    }

    private static func decodeRows(_ json: String) -> [SessionRow] {
        (try? JSONDecoder().decode([SessionRow].self, from: Data(json.utf8))) ?? []
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
