import CryptoKit
import Foundation
import ImageIO
import SQLite3
import Vision

// On-device text recognition over the screenshots the user actually takes, so the
// palette can find a capture by the words ON it (PHNX-4006). Every image in
// `AgentsCLI.screenshotSourceDirs()` is OCR'd once — keyed by the SHA-256 of the
// file bytes, so a rename or a duplicate collapses onto one row and nothing is ever
// processed twice — and the recognized text is stored in SQLite so the search field
// and the grouped grid read it without re-running Vision.
//
// Nothing leaves the machine: Vision runs on-device, the DB is a local file, and no
// network call is made. This is NOT a fleet-affecting scheduler (spec SING-2): like
// ScreenshotWatcher it reacts to a LOCAL file change and writes a LOCAL cache; it
// never launches, resumes, kills, or dispatches anything.
//
// Concurrency contract (the "no main-thread work" success bar):
//   - `writeQueue` (serial, QoS .utility) owns the ONE read-write connection and is
//     where every file hash, downsample, VNRecognizeTextRequest, and INSERT runs.
//     WAL mode is set on it. The palette never blocks on this queue.
//   - `readQueue` (serial) owns a SEPARATE read-only connection for the palette's
//     search and grid reads. WAL is precisely what makes a reader connection safe
//     while the writer is mid-OCR, so a long index pass never stalls typing.

struct ScreenshotRow {
    let hash: String
    let path: String
    let takenAt: Date
    let width: Int
    let height: Int
    let ocrText: String
    let firstLine: String
}

final class ScreenshotIndex {
    static let shared = ScreenshotIndex()

    // Only the last 14 days are scanned — an initial index of a years-deep
    // screenshots folder is neither wanted nor cheap, and a capture the user wants
    // to find is recent by construction.
    static let indexWindow: TimeInterval = 14 * 24 * 60 * 60
    // A capture larger than this is skipped entirely: decoding + OCR'ing a huge
    // image is a cost the palette should never pay, and screenshots are small.
    static let maxFileBytes: Int = 20 * 1024 * 1024
    // Vision recognizes on the downsampled image; 2000px on the long edge keeps
    // screen text legible while bounding the work.
    static let downsampleMaxPixels: CGFloat = 2000

    private let dbPath: String
    private let writeQueue = DispatchQueue(label: "agents.screenshot-index.write", qos: .utility)
    private let readQueue = DispatchQueue(label: "agents.screenshot-index.read", qos: .userInitiated)
    private var writeDB: OpaquePointer?
    private var readDB: OpaquePointer?

    // Populated from the DB when the connection opens, then kept current on insert,
    // so a watcher burst re-enumerates and skips known files WITHOUT re-hashing.
    private var knownHashes: Set<String> = []
    private var pathToHash: [String: String] = [:]

    // Coalesce watcher bursts: a scan already queued absorbs further fires.
    private var scanQueued = false

    // The index owns its OWN watcher for the whole helper lifetime, independent of
    // whether the palette is open — so a capture taken with the palette closed is
    // still OCR'd promptly, not only on the next summon.
    private lazy var watcher = ScreenshotWatcher { [weak self] in self?.indexNow() }

    /// Source dirs override, for the self-test. Nil = the live screenshot dirs.
    private var sourceDirsOverride: [URL]?

    private init(dbPath: String? = nil) {
        self.dbPath = dbPath ?? Self.defaultDBPath()
    }

    static func defaultDBPath() -> String {
        "\(NSHomeDirectory())/.agents/.history/menubar/screenshots.db"
    }

    // MARK: Lifecycle

    /// Open the DB, kick an initial 14-day scan, and start watching. Idempotent —
    /// called once from PromptPanelController.prepare() at helper launch.
    func start() {
        writeQueue.async { [weak self] in
            guard let self, self.writeDB == nil else { return }
            self.openConnections()
            self.loadKnownFromDB()
            self.performScan()
        }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.watcher.start(paths: self.sourceDirs().map(\.path))
        }
    }

    /// Re-scan the source dirs on demand (the watcher callback). Coalesces bursts.
    func indexNow() {
        writeQueue.async { [weak self] in
            guard let self, self.writeDB != nil, !self.scanQueued else { return }
            self.scanQueued = true
            self.performScan()
            self.scanQueued = false
        }
    }

    private func sourceDirs() -> [URL] {
        sourceDirsOverride ?? AgentsCLI.screenshotSourceDirs()
    }

    // MARK: SQLite

    private func openConnections() {
        let dir = (dbPath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)

        if sqlite3_open_v2(dbPath, &writeDB,
                           SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) != SQLITE_OK {
            FileHandle.standardError.write(Data("screenshot-index: cannot open \(dbPath)\n".utf8))
            writeDB = nil
            return
        }
        exec("PRAGMA journal_mode=WAL;")
        exec("PRAGMA synchronous=NORMAL;")
        exec("""
            CREATE TABLE IF NOT EXISTS screenshots (
                hash TEXT PRIMARY KEY,
                path TEXT NOT NULL,
                taken_at REAL NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                ocr_text TEXT NOT NULL,
                first_line TEXT NOT NULL
            );
            """)
        exec("CREATE INDEX IF NOT EXISTS idx_screenshots_taken_at ON screenshots(taken_at);")

        // Read-only connection for the palette; safe concurrent with the writer
        // under WAL. Opened after the writer so the file + schema exist.
        if sqlite3_open_v2(dbPath, &readDB, SQLITE_OPEN_READONLY, nil) != SQLITE_OK {
            readDB = nil
        }
    }

    private func exec(_ sql: String) {
        guard let writeDB else { return }
        var err: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(writeDB, sql, nil, nil, &err) != SQLITE_OK, let err {
            FileHandle.standardError.write(Data("screenshot-index: \(String(cString: err))\n".utf8))
            sqlite3_free(err)
        }
    }

    private func loadKnownFromDB() {
        guard let writeDB else { return }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(writeDB, "SELECT hash, path FROM screenshots;", -1, &stmt, nil) == SQLITE_OK
        else { return }
        defer { sqlite3_finalize(stmt) }
        while sqlite3_step(stmt) == SQLITE_ROW {
            guard let h = sqlite3_column_text(stmt, 0), let p = sqlite3_column_text(stmt, 1) else { continue }
            let hash = String(cString: h)
            let path = String(cString: p)
            knownHashes.insert(hash)
            pathToHash[path] = hash
        }
    }

    // MARK: Scan + OCR (all on writeQueue)

    private func performScan() {
        let cutoff = Date().addingTimeInterval(-Self.indexWindow)
        for url in Self.imageURLs(inDirs: sourceDirs(), since: cutoff) {
            // Drain per file: decoding + OCR'ing a batch autoreleases large image
            // buffers, so without a pool per iteration RSS balloons across a big
            // initial scan (measured ~1.1 GB over 500 captures) and only falls when
            // the whole scan block returns. One pool per file keeps it flat.
            autoreleasepool {
                let path = url.standardizedFileURL.path
                // An already-indexed path is immutable (screenshot tools write
                // unique names), so skip it without hashing the whole file.
                if pathToHash[path] != nil { return }

                guard let size = fileSize(url), size <= Self.maxFileBytes,
                      let data = try? Data(contentsOf: url) else { return }
                let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()

                if knownHashes.contains(hash) {
                    // Same bytes under a new name (rename/duplicate): re-point the
                    // row to this path rather than OCR'ing again.
                    repointPath(hash: hash, to: path)
                    pathToHash[path] = hash
                    return
                }

                guard let ocr = Self.recognize(url: url) else { return }
                let takenAt = creationDate(url) ?? Date()
                insert(hash: hash, path: path, takenAt: takenAt,
                       width: ocr.width, height: ocr.height,
                       ocrText: ocr.text, firstLine: ocr.firstLine)
                knownHashes.insert(hash)
                pathToHash[path] = hash
            }
        }
    }

    private func insert(hash: String, path: String, takenAt: Date,
                        width: Int, height: Int, ocrText: String, firstLine: String) {
        guard let writeDB else { return }
        var stmt: OpaquePointer?
        let sql = "INSERT OR REPLACE INTO screenshots (hash, path, taken_at, width, height, ocr_text, first_line) VALUES (?, ?, ?, ?, ?, ?, ?);"
        guard sqlite3_prepare_v2(writeDB, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, hash)
        bindText(stmt, 2, path)
        sqlite3_bind_double(stmt, 3, takenAt.timeIntervalSince1970)
        sqlite3_bind_int(stmt, 4, Int32(width))
        sqlite3_bind_int(stmt, 5, Int32(height))
        bindText(stmt, 6, ocrText)
        bindText(stmt, 7, firstLine)
        _ = sqlite3_step(stmt)
    }

    private func repointPath(hash: String, to path: String) {
        guard let writeDB else { return }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(writeDB, "UPDATE screenshots SET path = ? WHERE hash = ?;", -1, &stmt, nil) == SQLITE_OK
        else { return }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, path)
        bindText(stmt, 2, hash)
        _ = sqlite3_step(stmt)
    }

    // MARK: Reads (readQueue, read-only connection)

    /// Newest-first rows whose OCR text matches ALL search tokens (case-insensitive
    /// substring, AND). Empty/whitespace query returns []. `completion` on main.
    func search(_ query: String, limit: Int = 200, completion: @escaping ([ScreenshotRow]) -> Void) {
        let tokens = Self.searchTokens(query)
        guard !tokens.isEmpty else { DispatchQueue.main.async { completion([]) }; return }
        readQueue.async { [weak self] in
            let rows = self?.querySearch(tokens: tokens, limit: limit) ?? []
            DispatchQueue.main.async { completion(rows) }
        }
    }

    /// All indexed rows, newest first, for the grouped grid. `completion` on main.
    func recentRows(limit: Int = 500, completion: @escaping ([ScreenshotRow]) -> Void) {
        readQueue.async { [weak self] in
            let rows = self?.queryRows(where: nil, params: [], limit: limit) ?? []
            DispatchQueue.main.async { completion(rows) }
        }
    }

    private func querySearch(tokens: [String], limit: Int) -> [ScreenshotRow] {
        let clause = Array(repeating: "LOWER(ocr_text) LIKE ? ESCAPE '\\'", count: tokens.count)
            .joined(separator: " AND ")
        let params = tokens.map { "%\(Self.escapeLike($0))%" }
        return queryRows(where: clause, params: params, limit: limit)
    }

    private func queryRows(where clause: String?, params: [String], limit: Int) -> [ScreenshotRow] {
        guard let readDB else { return [] }
        var sql = "SELECT hash, path, taken_at, width, height, ocr_text, first_line FROM screenshots"
        if let clause { sql += " WHERE \(clause)" }
        sql += " ORDER BY taken_at DESC LIMIT ?;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(readDB, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        var idx: Int32 = 1
        for p in params { bindText(stmt, idx, p); idx += 1 }
        sqlite3_bind_int(stmt, idx, Int32(limit))
        var out: [ScreenshotRow] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            out.append(ScreenshotRow(
                hash: colText(stmt, 0), path: colText(stmt, 1),
                takenAt: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 2)),
                width: Int(sqlite3_column_int(stmt, 3)), height: Int(sqlite3_column_int(stmt, 4)),
                ocrText: colText(stmt, 5), firstLine: colText(stmt, 6)))
        }
        return out
    }

    // MARK: Pure helpers (exercised by MENUBAR_OCR_TEST)

    /// Tokenize a search string: lowercased, whitespace-split, empties dropped.
    static func searchTokens(_ query: String) -> [String] {
        query.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init).filter { !$0.isEmpty }
    }

    /// Escape the LIKE metacharacters so a literal `%`/`_`/`\` in a token matches
    /// itself under `ESCAPE '\'`.
    static func escapeLike(_ s: String) -> String {
        var out = ""
        for ch in s {
            if ch == "\\" || ch == "%" || ch == "_" { out.append("\\") }
            out.append(ch)
        }
        return out
    }

    /// Newest-first image files across `dirs` whose creation date is at/after
    /// `since`. Non-images and JSON sidecars excluded, duplicate paths collapsed.
    static func imageURLs(inDirs dirs: [URL], since: Date) -> [URL] {
        let keys: [URLResourceKey] = [.creationDateKey, .isRegularFileKey, .fileSizeKey]
        var found: [(url: URL, created: Date)] = []
        var seen = Set<String>()
        for dir in dirs {
            guard let entries = try? FileManager.default.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else { continue }
            for url in entries {
                guard AgentsCLI.imageExtensions.contains(url.pathExtension.lowercased()),
                      (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile ?? false,
                      let created = (try? url.resourceValues(forKeys: [.creationDateKey]))?.creationDate,
                      created >= since else { continue }
                let p = url.standardizedFileURL.path
                if seen.insert(p).inserted { found.append((url, created)) }
            }
        }
        return found.sorted { $0.created > $1.created }.map { $0.url }
    }

    struct OCRResult { let text: String; let firstLine: String; let width: Int; let height: Int }

    /// Downsample to <=2000px on the long edge, then run VNRecognizeTextRequest
    /// (.fast, no language correction) on-device. Reading order is top-to-bottom;
    /// `firstLine` is the topmost recognized line. Returns nil if the image cannot
    /// be decoded. Runs synchronously on the caller's queue (writeQueue).
    static func recognize(url: URL) -> OCRResult? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let (fullW, fullH) = pixelSize(source)
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: downsampleMaxPixels,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, opts as CFDictionary) else { return nil }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .fast
        request.usesLanguageCorrection = false
        let handler = VNImageRequestHandler(cgImage: cg, options: [:])
        guard (try? handler.perform([request])) != nil,
              let observations = request.results else { return OCRResult(text: "", firstLine: "", width: fullW, height: fullH) }

        // Vision returns observations in no guaranteed order; sort top-to-bottom.
        // boundingBox is normalized bottom-left origin, so a larger midY is higher.
        let lines = observations
            .sorted { $0.boundingBox.midY > $1.boundingBox.midY }
            .compactMap { $0.topCandidates(1).first?.string }
        return OCRResult(text: lines.joined(separator: "\n"),
                         firstLine: lines.first ?? "",
                         width: fullW, height: fullH)
    }

    private static func pixelSize(_ source: CGImageSource) -> (Int, Int) {
        guard let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else { return (0, 0) }
        let w = (props[kCGImagePropertyPixelWidth] as? Int) ?? 0
        let h = (props[kCGImagePropertyPixelHeight] as? Int) ?? 0
        return (w, h)
    }

    // MARK: small SQLite/file helpers

    private func fileSize(_ url: URL) -> Int? {
        (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize
    }

    private func creationDate(_ url: URL) -> Date? {
        (try? url.resourceValues(forKeys: [.creationDateKey]))?.creationDate
    }

    // MARK: Self-test hook

    /// Rebuild an index against explicit source dirs and DB path, synchronously on
    /// the write queue, so MENUBAR_OCR_TEST drives real Vision + real SQLite over
    /// the committed fixtures. Returns the freshly-indexed rows (newest first).
    static func makeForTest(dbPath: String, sourceDirs: [URL]) -> ScreenshotIndex {
        let idx = ScreenshotIndex(dbPath: dbPath)
        idx.sourceDirsOverride = sourceDirs
        return idx
    }

    func indexSynchronouslyForTest() {
        writeQueue.sync {
            if writeDB == nil { openConnections(); loadKnownFromDB() }
            performScan()
        }
    }

    func searchSyncForTest(_ query: String) -> [ScreenshotRow] {
        let tokens = Self.searchTokens(query)
        guard !tokens.isEmpty else { return [] }
        return readQueue.sync { querySearch(tokens: tokens, limit: 200) }
    }

    func recentRowsSyncForTest() -> [ScreenshotRow] {
        readQueue.sync { queryRows(where: nil, params: [], limit: 500) }
    }

    /// True indexed row count (not capped by a display limit), for the bench.
    func rowCountSyncForTest() -> Int {
        readQueue.sync {
            guard let readDB else { return 0 }
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(readDB, "SELECT COUNT(*) FROM screenshots;", -1, &stmt, nil) == SQLITE_OK
            else { return 0 }
            defer { sqlite3_finalize(stmt) }
            return sqlite3_step(stmt) == SQLITE_ROW ? Int(sqlite3_column_int(stmt, 0)) : 0
        }
    }

    /// Report whether the write queue (where every hash/OCR/INSERT runs) executes
    /// off the main thread — the "no main-thread work" proof.
    func probeWriteQueueIsMainForTest(_ completion: @escaping (Bool) -> Void) {
        writeQueue.async { completion(Thread.isMainThread) }
    }

    /// Report whether the read queue (palette search/grid reads) is off-main.
    func probeReadQueueIsMainForTest(_ completion: @escaping (Bool) -> Void) {
        readQueue.async { completion(Thread.isMainThread) }
    }

    /// Seed `count` synthetic rows directly (no OCR), for the search-latency bench.
    func seedSyntheticRowsForBench(_ count: Int) {
        writeQueue.sync {
            if writeDB == nil { openConnections(); loadKnownFromDB() }
            let base = Date().timeIntervalSince1970
            for i in 0..<count {
                insert(hash: "bench-\(i)", path: "/tmp/bench-\(i).png",
                       takenAt: Date(timeIntervalSince1970: base - Double(i)),
                       width: 100, height: 100,
                       ocrText: "row \(i) needs you now deploy the release ship it today item \(i)",
                       firstLine: "row \(i)")
            }
        }
    }
}

// MARK: - free SQLite helpers

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

private func bindText(_ stmt: OpaquePointer?, _ idx: Int32, _ value: String) {
    sqlite3_bind_text(stmt, idx, value, -1, SQLITE_TRANSIENT)
}

private func colText(_ stmt: OpaquePointer?, _ idx: Int32) -> String {
    guard let c = sqlite3_column_text(stmt, idx) else { return "" }
    return String(cString: c)
}
