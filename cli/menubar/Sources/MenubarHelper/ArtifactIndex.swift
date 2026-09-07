import CoreServices
import Foundation

// ArtifactIndex — the helper's index of the rendered HTML pages agents produce
// (PHNX-4002, Track B). It joins two on-disk sources into one queryable model so
// the Sessions window (track C) and the dispatch form / project pulse (track E)
// can show a session's artifacts and the recent set without shelling anything or
// parsing transcripts.
//
// Two sources:
//   1. Sidecars — ~/.agents/artifacts/<date>/<slug>/.artifact.json
//      `{v, slug, title, kind, session, agent, host, share_url, ticket,
//        created_at, updated_at}`; the HTML is `<slug or kind>.html` beside it.
//   2. The render ledger — ~/.agents/artifact-history/<id>/manifest.json
//      `{schema:"artifacts.revisions.v1", id, sourcePath,
//        revisions:[{number, createdAt, htmlFile, …}]}`; the newest HTML is at
//        `revisions/<NNNN>/render.html`.
//
// The opening scan runs once on a background queue and streams the directory
// listing (one manifest read at a time — there are hundreds of ledger entries on
// a real box, so they are never all held in memory). FSEvents on both roots then
// triggers a debounced rescan. A sidecar `session` may be a full UUID or an
// 8-char prefix; the index normalizes both to an 8-char key so either matches.
//
// ── API (the seam tracks C and E code against — keep it exactly) ────────────────
//
//   final class ArtifactIndex {
//       static let shared: ArtifactIndex
//       func artifacts(forSession id: String) -> [Artifact]   // full id or 8-char prefix
//       var recent: [Artifact] { get }
//       func addObserver(_ id: AnyObject, _ handler: @escaping () -> Void)
//       func start()
//   }

// MARK: - Model

enum ArtifactSource: String, Equatable {
    case sidecar
    case ledger
}

/// One rendered HTML page an agent produced.
struct Artifact: Equatable {
    /// Slug (sidecar) or ledger id.
    let id: String
    let title: String
    let kind: String?
    /// The producing session — full UUID or 8-char prefix as recorded.
    let sessionId: String?
    let agent: String?
    let host: String?
    let shareURL: String?
    let ticket: String?
    /// Absolute path to the newest HTML render.
    let htmlPath: String
    let createdAt: Date?
    let updatedAt: Date?
    /// 1 for a sidecar; the ledger's revision count otherwise.
    let revisionCount: Int
    let source: ArtifactSource

    /// The time used for "newest first" ordering.
    var sortDate: Date { updatedAt ?? createdAt ?? .distantPast }
}

/// The result of one scan — the two maps the query surface reads.
struct ArtifactScanResult: Equatable {
    var bySession: [String: [Artifact]] = [:]  // normalized 8-char session key -> newest-first
    var recent: [Artifact] = []
}

// MARK: - Decodable sidecar / manifest shapes

private struct ArtifactSidecar: Decodable {
    let slug: String?
    let title: String?
    let kind: String?
    let session: String?
    let agent: String?
    let host: String?
    let shareURL: String?
    let ticket: String?
    let createdAt: String?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case slug, title, kind, session, agent, host, ticket
        case shareURL = "share_url"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

private struct ArtifactManifest: Decodable {
    let schema: String?
    let id: String?
    let sourcePath: String?
    let title: String?
    let kind: String?
    let session: String?
    let agent: String?
    let host: String?
    let revisions: [ManifestRevision]?
}

private struct ManifestRevision: Decodable {
    let number: Int?
    let createdAt: String?
    let htmlFile: String?
}

// MARK: - Pure scanner

/// The pure scan. No singleton, no FSEvents — takes the two roots and returns the
/// joined result, so `MENUBAR_ARTIFACT_TEST=1` can point it at a fixture tree.
enum ArtifactScanner {
    static let recentLimit = 200

    static func scan(artifactsRoot: String, ledgerRoot: String) -> ArtifactScanResult {
        var all: [Artifact] = []
        all.append(contentsOf: scanSidecars(root: artifactsRoot))
        all.append(contentsOf: scanLedger(root: ledgerRoot))

        var bySession: [String: [Artifact]] = [:]
        for artifact in all {
            guard let key = normalizeSession(artifact.sessionId) else { continue }
            bySession[key, default: []].append(artifact)
        }
        for key in bySession.keys {
            bySession[key]?.sort(by: newestFirst)
        }
        let recent = Array(all.sorted(by: newestFirst).prefix(recentLimit))
        return ArtifactScanResult(bySession: bySession, recent: recent)
    }

    /// Normalize a session id to the join key: the lowercased 8-char prefix (a
    /// full UUID and its 8-char prefix collapse to the same key). Nil/empty → nil.
    static func normalizeSession(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        let lower = raw.lowercased()
        return lower.count >= 8 ? String(lower.prefix(8)) : lower
    }

    private static func newestFirst(_ a: Artifact, _ b: Artifact) -> Bool {
        if a.sortDate != b.sortDate { return a.sortDate > b.sortDate }
        return a.id < b.id
    }

    private static func scanSidecars(root: String) -> [Artifact] {
        let fm = FileManager.default
        guard let dates = try? fm.contentsOfDirectory(atPath: root) else { return [] }
        var out: [Artifact] = []
        for date in dates.sorted(by: >) {
            let dateDir = (root as NSString).appendingPathComponent(date)
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: dateDir, isDirectory: &isDir), isDir.boolValue else { continue }
            guard let slugs = try? fm.contentsOfDirectory(atPath: dateDir) else { continue }
            for slug in slugs {
                let slugDir = (dateDir as NSString).appendingPathComponent(slug)
                let sidecarPath = (slugDir as NSString).appendingPathComponent(".artifact.json")
                guard fm.fileExists(atPath: sidecarPath),
                      let data = fm.contents(atPath: sidecarPath),
                      let sidecar = try? JSONDecoder().decode(ArtifactSidecar.self, from: data) else { continue }
                let realSlug = sidecar.slug ?? slug
                guard let html = resolveSidecarHTML(dir: slugDir, slug: realSlug, kind: sidecar.kind) else { continue }
                out.append(Artifact(
                    id: realSlug,
                    title: sidecar.title ?? realSlug,
                    kind: sidecar.kind,
                    sessionId: sidecar.session,
                    agent: sidecar.agent,
                    host: sidecar.host,
                    shareURL: sidecar.shareURL,
                    ticket: sidecar.ticket,
                    htmlPath: html,
                    createdAt: parseDate(sidecar.createdAt),
                    updatedAt: parseDate(sidecar.updatedAt),
                    revisionCount: 1,
                    source: .sidecar))
            }
        }
        return out
    }

    /// The HTML beside a sidecar: `<slug>.html`, else `<kind>.html`, else the
    /// first `*.html` in the dir. Nil when the dir carries no rendered HTML.
    private static func resolveSidecarHTML(dir: String, slug: String, kind: String?) -> String? {
        let fm = FileManager.default
        var candidates = ["\(slug).html"]
        if let kind, !kind.isEmpty { candidates.append("\(kind).html") }
        for name in candidates {
            let path = (dir as NSString).appendingPathComponent(name)
            if fm.fileExists(atPath: path) { return path }
        }
        if let entries = try? fm.contentsOfDirectory(atPath: dir) {
            if let html = entries.first(where: { $0.hasSuffix(".html") }) {
                return (dir as NSString).appendingPathComponent(html)
            }
        }
        return nil
    }

    private static func scanLedger(root: String) -> [Artifact] {
        let fm = FileManager.default
        guard let ids = try? fm.contentsOfDirectory(atPath: root) else { return [] }
        var out: [Artifact] = []
        for id in ids {
            let idDir = (root as NSString).appendingPathComponent(id)
            let manifestPath = (idDir as NSString).appendingPathComponent("manifest.json")
            guard fm.fileExists(atPath: manifestPath),
                  let data = fm.contents(atPath: manifestPath),
                  let manifest = try? JSONDecoder().decode(ArtifactManifest.self, from: data) else { continue }
            let revisions = manifest.revisions ?? []
            guard !revisions.isEmpty else { continue }
            let newest = revisions.max(by: { ($0.number ?? 0) < ($1.number ?? 0) }) ?? revisions[revisions.count - 1]
            guard let html = resolveLedgerHTML(idDir: idDir, revision: newest) else { continue }
            let realId = manifest.id ?? id
            let createdDates = revisions.compactMap { parseDate($0.createdAt) }
            out.append(Artifact(
                id: realId,
                title: manifest.title ?? realId,
                kind: manifest.kind,
                sessionId: manifest.session,
                agent: manifest.agent,
                host: manifest.host,
                shareURL: nil,
                ticket: nil,
                htmlPath: html,
                createdAt: createdDates.min(),
                updatedAt: parseDate(newest.createdAt) ?? createdDates.max(),
                revisionCount: revisions.count,
                source: .ledger))
        }
        return out
    }

    /// The newest render: the revision's `htmlFile` (relative to the id dir) if it
    /// exists, else the conventional `revisions/<NNNN>/render.html`.
    private static func resolveLedgerHTML(idDir: String, revision: ManifestRevision) -> String? {
        let fm = FileManager.default
        if let rel = revision.htmlFile, !rel.isEmpty {
            let path = (idDir as NSString).appendingPathComponent(rel)
            if fm.fileExists(atPath: path) { return path }
        }
        if let number = revision.number {
            let padded = String(format: "%04d", number)
            let path = (idDir as NSString).appendingPathComponent("revisions/\(padded)/render.html")
            if fm.fileExists(atPath: path) { return path }
        }
        return nil
    }

    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain = ISO8601DateFormatter()

    static func parseDate(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        return isoFractional.date(from: raw) ?? isoPlain.date(from: raw)
    }
}

// MARK: - Singleton

final class ArtifactIndex {
    static let shared = ArtifactIndex()

    private let queue = DispatchQueue(label: "com.phnx-labs.agents-menubar.artifactindex")
    private let lock = NSLock()
    private var result = ArtifactScanResult()
    private var started = false
    private var eventStream: FSEventStreamRef?
    private var rescanScheduled = false

    private let artifactsRoot: String
    private let ledgerRoot: String

    private struct Observer {
        weak var owner: AnyObject?
        let handler: () -> Void
    }
    private var observers: [ObjectIdentifier: Observer] = [:]

    private init(home: String = NSHomeDirectory()) {
        artifactsRoot = "\(home)/.agents/artifacts"
        ledgerRoot = "\(home)/.agents/artifact-history"
    }

    private init(artifactsRoot: String, ledgerRoot: String) {
        self.artifactsRoot = artifactsRoot
        self.ledgerRoot = ledgerRoot
    }

    /// Test seam: an index rooted at explicit dirs, scanned synchronously, so the
    /// headless self-test drives the real `artifacts(forSession:)`/`recent` query
    /// surface against a fixture tree (no FSEvents, no `~/.agents`).
    static func forTesting(artifactsRoot: String, ledgerRoot: String) -> ArtifactIndex {
        let index = ArtifactIndex(artifactsRoot: artifactsRoot, ledgerRoot: ledgerRoot)
        index.result = ArtifactScanner.scan(artifactsRoot: artifactsRoot, ledgerRoot: ledgerRoot)
        return index
    }

    /// Test seam: run one rescan ON the private queue — the exact context every
    /// real caller uses (`start()`/`scheduleRescan()` dispatch onto `queue`) —
    /// with `changed == true` forced so `notify()` runs. Returns whether it
    /// completed within `timeout`; false means `notify()` self-deadlocked on the
    /// serial queue. Regression guard for the `queue.sync`-from-`queue` bug.
    func forceRescanOnQueueForTest(timeout: TimeInterval = 3) -> Bool {
        let done = DispatchSemaphore(value: 0)
        queue.async {
            self.lock.lock(); self.result = ArtifactScanResult(); self.lock.unlock()
            self.rescan()
            done.signal()
        }
        return done.wait(timeout: .now() + timeout) == .success
    }

    // MARK: Query (thread-safe)

    /// Every artifact for a session, newest first. Matches a full id or an 8-char
    /// prefix (both normalize to the same key).
    func artifacts(forSession id: String) -> [Artifact] {
        guard let key = ArtifactScanner.normalizeSession(id) else { return [] }
        lock.lock(); defer { lock.unlock() }
        return result.bySession[key] ?? []
    }

    /// The most recent artifacts across all sessions, newest first.
    var recent: [Artifact] {
        lock.lock(); defer { lock.unlock() }
        return result.recent
    }

    // MARK: Lifecycle

    func start() {
        queue.async {
            guard !self.started else { return }
            self.started = true
            self.rescan()
            self.startWatching()
        }
    }

    func addObserver(_ id: AnyObject, _ handler: @escaping () -> Void) {
        let key = ObjectIdentifier(id)
        queue.async { self.observers[key] = Observer(owner: id, handler: handler) }
    }

    func removeObserver(_ id: AnyObject) {
        let key = ObjectIdentifier(id)
        queue.async { self.observers[key] = nil }
    }

    // MARK: Scan

    private func rescan() {
        let scanned = ArtifactScanner.scan(artifactsRoot: artifactsRoot, ledgerRoot: ledgerRoot)
        lock.lock()
        let changed = scanned != result
        result = scanned
        lock.unlock()
        if changed { notify() }
    }

    private func scheduleRescan() {
        queue.async {
            guard !self.rescanScheduled else { return }
            self.rescanScheduled = true
            self.queue.asyncAfter(deadline: .now() + 0.3) {
                self.rescanScheduled = false
                self.rescan()
            }
        }
    }

    /// Always invoked already running ON `queue` — `rescan()` (its only caller) is
    /// dispatched onto `queue` by both `start()` and `scheduleRescan()`. So the
    /// observer set is read directly here; a `queue.sync` would be a self-deadlock
    /// on this serial queue. (FeedStream.notify uses `queue.sync` safely because
    /// its callers run on the MAIN queue, not `queue` — the contexts differ.)
    private func notify() {
        var handlers: [() -> Void] = []
        for (key, observer) in observers {
            if observer.owner == nil { observers[key] = nil }
            else { handlers.append(observer.handler) }
        }
        DispatchQueue.main.async { for handler in handlers { handler() } }
    }

    // MARK: FSEvents

    private func startWatching() {
        let fm = FileManager.default
        for dir in [artifactsRoot, ledgerRoot] {
            try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        }
        var context = FSEventStreamContext(version: 0,
                                            info: Unmanaged.passUnretained(self).toOpaque(),
                                            retain: nil, release: nil, copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, _, _, _, _ in
            guard let info else { return }
            Unmanaged<ArtifactIndex>.fromOpaque(info).takeUnretainedValue().scheduleRescan()
        }
        let paths = [artifactsRoot, ledgerRoot] as CFArray
        let flags = FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer)
        guard let stream = FSEventStreamCreate(kCFAllocatorDefault, callback, &context, paths,
                                               FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
                                               0.5, flags) else { return }
        FSEventStreamSetDispatchQueue(stream, queue)
        FSEventStreamStart(stream)
        eventStream = stream
    }
}
