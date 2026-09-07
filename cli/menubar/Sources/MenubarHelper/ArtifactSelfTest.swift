import Foundation

// Headless self-test for the artifact index (PHNX-4002).
//   MENUBAR_ARTIFACT_TEST=1 — scan a fixture tree (three sidecars, two ledger
//   manifests) and assert the session map, revision counts, HTML resolution, and
//   full-vs-8-char-prefix matching. Pure filesystem read; a build gate.
enum ArtifactSelfTest {
    static func run() -> Never {
        var pass = true
        func check(_ name: String, _ condition: Bool) {
            print("\(condition ? "PASS" : "FAIL") — \(name)")
            if !condition { pass = false }
        }

        let root = ProcessInfo.processInfo.environment["MENUBAR_ARTIFACT_ROOT"]
            ?? "Tests/fixtures/artifacts-tree"
        let artifactsRoot = (root as NSString).appendingPathComponent("artifacts")
        let ledgerRoot = (root as NSString).appendingPathComponent("artifact-history")
        let index = ArtifactIndex.forTesting(artifactsRoot: artifactsRoot, ledgerRoot: ledgerRoot)

        // MARK: recent — all five, newest first.
        let recent = index.recent
        check("recent holds all three sidecars plus two ledger entries", recent.count == 5)
        check("recent is newest-first (plan-alpha at 09-07 leads)", recent.first?.id == "plan-alpha")

        // MARK: session map — full id and 8-char prefix both resolve the same set.
        let fullId = "0a1b2c3d-1111-2222-3333-444455556666"
        let byFull = index.artifacts(forSession: fullId)
        let byPrefix = index.artifacts(forSession: "0a1b2c3d")
        check("a full id resolves three artifacts (2 sidecars + 1 ledger)", byFull.count == 3)
        check("an 8-char prefix resolves the same set", byPrefix.map(\.id) == byFull.map(\.id))
        check("the session set is plan-alpha, viz-beta, hist-1",
              Set(byFull.map(\.id)) == ["plan-alpha", "viz-beta", "hist-1"])
        check("the session set is newest-first", byFull.first?.id == "plan-alpha")

        // MARK: revision count + source.
        let hist1 = byFull.first { $0.id == "hist-1" }
        check("the ledger entry counts three revisions", hist1?.revisionCount == 3)
        check("the ledger entry is sourced from the ledger", hist1?.source == .ledger)
        let planAlpha = byFull.first { $0.id == "plan-alpha" }
        check("a sidecar counts one revision", planAlpha?.revisionCount == 1)
        check("a sidecar is sourced from the sidecar", planAlpha?.source == .sidecar)

        // MARK: HTML resolution — slug-named, kind-named, and ledger render.html.
        check("plan-alpha resolves its slug-named HTML",
              planAlpha?.htmlPath.hasSuffix("plan-alpha/plan-alpha.html") == true)
        let vizBeta = byFull.first { $0.id == "viz-beta" }
        check("viz-beta resolves its kind-named HTML (report.html)",
              vizBeta?.htmlPath.hasSuffix("viz-beta/report.html") == true)
        check("the ledger entry resolves the newest revision's render.html",
              hist1?.htmlPath.hasSuffix("hist-1/revisions/0003/render.html") == true)
        let allHtmlExists = recent.allSatisfy { FileManager.default.fileExists(atPath: $0.htmlPath) }
        check("every resolved HTML path exists on disk", allHtmlExists)

        // MARK: sidecar metadata decode.
        check("sidecar decodes share_url + ticket",
              planAlpha?.shareURL == "https://example.test/p/alpha" && planAlpha?.ticket == "PHNX-4002")

        // MARK: a distinct session resolves only its own artifact.
        let gamma = index.artifacts(forSession: "deadbeef-1111-2222-3333-444455556666")
        check("a distinct session resolves just its one artifact",
              gamma.count == 1 && gamma.first?.id == "doc-gamma")

        // MARK: an unknown session resolves nothing.
        check("an unknown session resolves nothing", index.artifacts(forSession: "ffffffff").isEmpty)

        // MARK: notify() runs on the private queue without self-deadlocking.
        // A rescan is always dispatched ONTO `queue`; notify() must not queue.sync
        // back onto it. Pre-fix this hangs and the semaphore times out.
        check("rescan + notify complete on the queue (no self-deadlock)",
              index.forceRescanOnQueueForTest())

        print(pass ? "ALL PASS" : "SOME FAILED")
        exit(pass ? 0 : 1)
    }
}
