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

        // Screenshot OCR search latency on a 1,000-row fixture DB (PHNX-4006). The
        // palette's search field filters on every keystroke, so this is the read
        // that must stay well under a frame.
        // The rows point at one real placeholder file: the read path stats every
        // row (a deleted capture is dropped), so the bench must pay that cost too.
        let benchDir = NSTemporaryDirectory() + "menubar-ocr-bench-\(UUID().uuidString)"
        try? FileManager.default.createDirectory(atPath: benchDir, withIntermediateDirectories: true)
        let benchDB = "\(benchDir)/screenshots.db"
        let benchShot = "\(benchDir)/placeholder.png"
        FileManager.default.createFile(atPath: benchShot, contents: Data())
        let ocr = ScreenshotIndex.makeForTest(dbPath: benchDB, sourceDirs: [])
        ocr.seedSyntheticRowsForBench(1000, path: benchShot)
        let sIters = max(20, iters / 3)
        measure("ScreenshotIndex.search(\"needs you\")  [1,000-row db, \(sIters)x]", sIters) {
            _ = ocr.searchSyncForTest("needs you")
        }
        try? FileManager.default.removeItem(atPath: benchDir)

        // Real cold-index measurement over THIS machine's screenshot folders,
        // gated so an ordinary bench run doesn't OCR the user's real captures.
        // Reports count, OCR wall time, and RSS before/after (PHNX-4006).
        if ProcessInfo.processInfo.environment["MENUBAR_BENCH_OCR_REAL"] == "1" {
            benchRealIndex()
        }
    }

    private static func benchRealIndex() {
        emit("")
        emit("screenshot OCR — cold index of the real source folders (last 14 days)")
        let dirs = AgentsCLI.screenshotSourceDirs()
        emit("  source dirs: \(dirs.map { $0.path }.joined(separator: ", "))")
        let realDB = NSTemporaryDirectory() + "menubar-ocr-real-\(UUID().uuidString).db"
        let index = ScreenshotIndex.makeForTest(dbPath: realDB, sourceDirs: dirs)
        let rssBefore = residentBytes()
        let t0 = DispatchTime.now().uptimeNanoseconds
        index.indexSynchronouslyForTest()
        let wallMs = Double(DispatchTime.now().uptimeNanoseconds &- t0) / 1_000_000.0
        let rssAfter = residentBytes()
        let count = index.rowCountSyncForTest()
        emit(String(format: "  indexed %d captures in %.1f ms  (%.1f ms/capture)",
                    count, wallMs, count > 0 ? wallMs / Double(count) : 0))
        emit(String(format: "  RSS before %.1f MB -> after %.1f MB  (delta %+.1f MB)",
                    mb(rssBefore), mb(rssAfter), mb(rssAfter) - mb(rssBefore)))

        // Prove the search returns real captures by the text on them. Override the
        // query with MENUBAR_BENCH_OCR_QUERY (default "needs you").
        let query = ProcessInfo.processInfo.environment["MENUBAR_BENCH_OCR_QUERY"] ?? "needs you"
        let hits = index.searchSyncForTest(query)
        emit("  search \"\(query)\" -> \(hits.count) match(es):")
        let fmt = DateFormatter(); fmt.dateFormat = "yyyy-MM-dd HH:mm"
        for row in hits.prefix(8) {
            emit("    \(fmt.string(from: row.takenAt))  \(row.firstLine)  [\((row.path as NSString).lastPathComponent)]")
        }
        try? FileManager.default.removeItem(atPath: realDB)
    }

    private static func mb(_ bytes: UInt64) -> Double { Double(bytes) / (1024 * 1024) }

    private static func residentBytes() -> UInt64 {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
            }
        }
        return kr == KERN_SUCCESS ? info.resident_size : 0
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
