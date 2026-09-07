import Foundation

// Micro-benchmark for the menu-bar data layer. The whole design claim is that
// the dropdown populates instantly on click without shelling the CLI, so this
// times the methods that actually build the menu items against real machine
// state. Run with: MENUBAR_BENCH=1 "AGI Menu"  (optional MENUBAR_BENCH_ITERS).
enum Bench {
    static func run() {
        let iters = Int(ProcessInfo.processInfo.environment["MENUBAR_BENCH_ITERS"] ?? "300") ?? 300
        let teams = LocalState.sessions(includeTeams: true).count
        let agents = LocalState.installedAgents().count
        emit("menubar data-layer benchmark — \(iters) iters/method  (context: \(teams) sessions, \(agents) installed agents)")
        emit("")

        measure("LocalState.sessions(includeTeams:false)  [10s badge poll]", iters) {
            _ = LocalState.sessions(includeTeams: false)
        }
        measure("LocalState.sessions(includeTeams:true)   [full menu open]", iters) {
            _ = LocalState.sessions(includeTeams: true)
        }
        measure("LocalState.installedAgents()             [roster]", iters) {
            _ = LocalState.installedAgents()
        }
        // The actual menuWillOpen critical path AFTER the routines-cache fix:
        // everything that runs synchronously on a click (no CLI shell).
        measure("menu-open critical path (post-fix)        [ON CLICK]", iters) {
            _ = LocalState.sessions(includeTeams: true)
            _ = LocalState.installedAgents()
            _ = AgentsCLI.daemonPid()
        }
        // routines() shells `agents routines list --json` — a real subprocess,
        // ~300ms. BEFORE the fix it ran on every click; now it runs throttled on
        // the background poll and is cached, so it's OFF the click path.
        let rIters = max(5, iters / 30)
        measure("AgentsCLI.routines()  [now BACKGROUND, \(rIters)x]", rIters) {
            _ = AgentsCLI.routines()
        }

        // FeedStream parse throughput (PHNX-4002): decode + fold every fixture
        // line through the pure reducer. This is the hot path the streaming child
        // drives off the main thread, so its per-line cost bounds how large a
        // fleet the feed can project without falling behind.
        let fixture = ProcessInfo.processInfo.environment["MENUBAR_FEED_FIXTURE"]
            ?? "Tests/fixtures/feed-sample.ndjson"
        if let text = try? String(contentsOfFile: fixture, encoding: .utf8) {
            let lines = text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
            emit("")
            emit("feed fixture: \(lines.count) NDJSON lines")
            measure("FeedEnvelope.decode + FeedState.apply  [\(lines.count) lines/iter]", iters) {
                var state = FeedState()
                for line in lines {
                    if let env = FeedEnvelope.decode(line) { _ = state.apply(env) }
                }
            }
        } else {
            emit("feed fixture not found at \(fixture) — skipping feed parse bench")
        }
    }

    private static func measure(_ label: String, _ iters: Int, _ body: () -> Void) {
        body() // warmup (prime page cache / dyld)
        var ms: [Double] = []
        ms.reserveCapacity(iters)
        for _ in 0..<iters {
            let t0 = DispatchTime.now().uptimeNanoseconds
            body()
            let t1 = DispatchTime.now().uptimeNanoseconds
            ms.append(Double(t1 &- t0) / 1_000_000.0)
        }
        ms.sort()
        let mean = ms.reduce(0, +) / Double(ms.count)
        let p50 = ms[ms.count / 2]
        let p95 = ms[Swift.min(ms.count - 1, Int(Double(ms.count) * 0.95))]
        func f(_ v: Double) -> String { String(format: "%7.3f", v) }
        emit("\(label)")
        emit("    p50 \(f(p50))   p95 \(f(p95))   min \(f(ms.first!))   max \(f(ms.last!))   mean \(f(mean))  ms")
    }

    private static func emit(_ s: String) {
        FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
    }
}
