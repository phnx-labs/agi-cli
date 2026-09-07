import Foundation

// Self-test for the screenshot OCR index (PHNX-4006). Follows the env-gated
// self-test idiom (GuardsSelfTest / IssueSelfTest): no XCTest target exists for
// the menu-bar helper. Runs REAL Vision recognition over the two committed fixture
// PNGs into a REAL temp SQLite DB, then asserts the stored first_line, hash
// dedupe (a renamed duplicate collapses onto one row and is not re-OCR'd), and the
// tokenized case-insensitive search. Also pins the pure grouping helper.
//
//   MENUBAR_OCR_TEST=1 "AGI Menu"
//
// Fixtures resolve from MENUBAR_OCR_FIXTURES (set by test-menubar.sh) else the
// working-directory-relative Tests/fixtures.
enum ScreenshotOCRSelfTest {
    private static var failures = 0

    static func run() -> Never {
        print("menubar screenshot-OCR self-test")
        let fixtures = fixturesDir()
        let needsYou = "\(fixtures)/ocr-needs-you.png"
        let deploy = "\(fixtures)/ocr-deploy.png"
        guard FileManager.default.fileExists(atPath: needsYou),
              FileManager.default.fileExists(atPath: deploy) else {
            print("  FAIL  fixtures not found under \(fixtures) — set MENUBAR_OCR_FIXTURES")
            exit(1)
        }

        // Stage the fixtures in a temp source dir so their creation dates are now
        // (inside the 14-day window) and the index does not touch the real folders.
        let tmp = NSTemporaryDirectory() + "menubar-ocr-test-\(UUID().uuidString)"
        let srcDir = "\(tmp)/shots"
        try? FileManager.default.createDirectory(atPath: srcDir, withIntermediateDirectories: true)
        copy(needsYou, "\(srcDir)/shot-needs-you.png")
        copy(deploy, "\(srcDir)/shot-deploy.png")
        let dbPath = "\(tmp)/screenshots.db"

        let index = ScreenshotIndex.makeForTest(dbPath: dbPath, sourceDirs: [URL(fileURLWithPath: srcDir)])
        index.indexSynchronouslyForTest()

        let rows = index.recentRowsSyncForTest()
        check(rows.count == 2, "two fixtures OCR'd into two rows (got \(rows.count))")

        let firstLines = Set(rows.map(\.firstLine))
        check(firstLines.contains("Needs you now"),
              "stored first_line 'Needs you now' (got \(rows.map(\.firstLine)))")
        check(firstLines.contains("Deploy the release"),
              "stored first_line 'Deploy the release'")

        // ocr_text carries every recognized line, not just the first.
        let deployRow = rows.first { $0.firstLine == "Deploy the release" }
        check(deployRow?.ocrText.contains("ship it today") ?? false,
              "ocr_text carries the second line 'ship it today'")

        // Hash dedupe: a byte-identical copy under a NEW name must collapse onto the
        // existing row (same SHA-256) rather than create a third row or re-OCR.
        copy(needsYou, "\(srcDir)/duplicate-of-needs-you.png")
        index.indexSynchronouslyForTest()
        let afterDup = index.recentRowsSyncForTest()
        check(afterDup.count == 2, "renamed duplicate deduped by hash (still \(afterDup.count) rows)")

        // Search: tokenized AND, case-insensitive substring over ocr_text.
        check(index.searchSyncForTest("Needs you").count == 1,
              "search 'Needs you' -> the needs-you capture")
        check(index.searchSyncForTest("needs YOU now").count == 1,
              "search is case-insensitive and tokenized ('needs YOU now')")
        check(index.searchSyncForTest("deploy ship").count == 1,
              "tokens AND across lines ('deploy ship' -> deploy capture)")
        check(index.searchSyncForTest("needs deploy").isEmpty,
              "tokens AND is per-row ('needs deploy' -> no single row)")
        check(index.searchSyncForTest("nonexistent").isEmpty,
              "no match -> empty")
        check(index.searchSyncForTest("   ").isEmpty,
              "whitespace-only query -> empty")

        // Pure tokenizer.
        check(ScreenshotIndex.searchTokens("  Needs   YOU ") == ["needs", "you"],
              "searchTokens lowercases, splits, drops empties")

        testGrouping()
        testOffMainThread(index)

        try? FileManager.default.removeItem(atPath: tmp)

        if failures == 0 { print("\nALL PASS"); exit(0) }
        print("\n\(failures) FAILED"); exit(1)
    }

    // Grouping is a pure function over rows: last-24h captures bucket by hour, older
    // ones by day, group order follows the newest-first rows.
    private static func testGrouping() {
        let now = Date(timeIntervalSince1970: 1_700_000_000) // fixed instant
        func row(_ offset: TimeInterval, _ line: String) -> ScreenshotRow {
            ScreenshotRow(hash: line, path: "/\(line).png",
                          takenAt: now.addingTimeInterval(offset),
                          width: 100, height: 100, ocrText: line, firstLine: line)
        }
        let rows = [
            row(-60, "a"),            // this hour
            row(-120, "b"),           // this hour
            row(-2 * 3600, "c"),      // ~2h ago (different hour)
            row(-3 * 24 * 3600, "d"), // 3 days ago (day bucket)
        ]
        let groups = ScreenshotGrouping.groupRows(rows, now: now)
        check(groups.count == 3, "hour + hour + day => 3 groups (got \(groups.count))")
        check(groups.first?.rows.count == 2, "first hour group holds the two recent captures")
        check(groups.last?.rows.first?.firstLine == "d", "oldest day group holds the day-old capture")
    }

    // The palette must never do OCR or DB work on the main thread; both queues
    // run off-main. This is the "palette stays responsive" proof.
    private static func testOffMainThread(_ index: ScreenshotIndex) {
        var writeOnMain = true
        var readOnMain = true
        let sem = DispatchSemaphore(value: 0)
        index.probeWriteQueueIsMainForTest { writeOnMain = $0; sem.signal() }
        sem.wait()
        index.probeReadQueueIsMainForTest { readOnMain = $0; sem.signal() }
        sem.wait()
        check(!writeOnMain, "index (hash/OCR/insert) runs off the main thread")
        check(!readOnMain, "search/grid reads run off the main thread")
    }

    private static func fixturesDir() -> String {
        if let env = ProcessInfo.processInfo.environment["MENUBAR_OCR_FIXTURES"], !env.isEmpty {
            return env
        }
        return FileManager.default.currentDirectoryPath + "/Tests/fixtures"
    }

    private static func copy(_ from: String, _ to: String) {
        try? FileManager.default.removeItem(atPath: to)
        try? FileManager.default.copyItem(atPath: from, toPath: to)
    }

    private static func check(_ condition: Bool, _ label: String) {
        if condition { print("  PASS  \(label)") }
        else { failures += 1; print("  FAIL  \(label)") }
    }
}
