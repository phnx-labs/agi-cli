import AppKit
import Foundation

// Self-test for the palette's PROJECT layer (PHNX-4001) — the surface that
// replaced "the last eight session cwds" with the real `agents projects`
// definitions:
//
//   • decoding `agents projects list --json`, including a definition from a newer
//     CLI that carries fields this helper does not know,
//   • keying projects by NAME, because two definitions legitimately share one
//     checkout (`prix` and `rush` both point at the `muqsitnawaz/agents` monorepo)
//     and a root-keyed list would silently collapse them into one row,
//   • resolving the Linear scope from the definition's own BINDING rather than by
//     matching folder names, and saying so when a project has no binding,
//   • narrowing to a worktree/subdirectory inside the chosen project,
//   • and the shared Cmd-V / drag-and-drop attachment reader, driven over a REAL
//     NSPasteboard rather than a mock.
//
// Headless: fixtures, real files, and a real pasteboard — no window, no CLI, no
// network. Exits before `Guards.enforceForInteractiveLaunch`, like every other
// self-test mode.
//
//   MENUBAR_PROJECTS_TEST=1 "AGI Menu"
enum ProjectSelfTest {
    private static var failures = 0

    static func run() -> Never {
        print("menubar projects self-test")
        testDecoding()
        testNameKeying()
        testFilter()
        testLinearBinding()
        testRecentDirsInsideProject()
        testAttachmentNaming()
        testPasteAndDrop()
        testPinPolicy()
        if failures == 0 {
            print("\nALL PASS")
            exit(0)
        }
        print("\n\(failures) FAILED")
        exit(1)
    }

    // The real payload shape, taken from `agents projects list --json`: a
    // multi-repo project with a Linear binding, one with no binding at all, and
    // an unknown field a newer CLI added.
    private static let fixture = """
    [
      {
        "name": "agi",
        "description": "Agents CLI and Factory",
        "root": "~/src/github.com/me/agents-cli",
        "defaultPath": "~/src/github.com/me/agents-cli",
        "repo": "phnx-labs/agents-cli",
        "repos": [
          { "slug": "phnx-labs/agents-cli", "path": "~/src/github.com/me/agents-cli" },
          { "slug": "phnx-labs/linear-cli", "path": "~/src/github.com/me/linear-cli" }
        ],
        "linear": { "projectId": "8eb8f5b1", "name": "AGI" },
        "somethingNewerCLIsEmit": true
      },
      {
        "name": "prix",
        "root": "~/src/github.com/me/agents",
        "defaultPath": "~/src/github.com/me/agents/prix",
        "linear": { "projectId": "84849630", "name": "Prix" }
      },
      {
        "name": "rush",
        "root": "~/src/github.com/me/agents",
        "defaultPath": "~/src/github.com/me/agents/rush",
        "linear": { "projectId": "8fa120d1", "name": "Rush" }
      },
      {
        "name": "scratch",
        "root": "~/src/scratch"
      }
    ]
    """

    private static func decoded() -> [ProjectDef] {
        guard let data = fixture.data(using: .utf8),
              let defs = try? JSONDecoder().decode([ProjectDef].self, from: data) else { return [] }
        return ProjectCatalog.ordered(defs)
    }

    private static func testDecoding() {
        let defs = decoded()
        check("every definition decodes", defs.count == 4, detail: "\(defs.count)")
        guard let agi = ProjectCatalog.named("agi", in: defs) else {
            check("agi decodes", false); return
        }
        check("description decodes", agi.description == "Agents CLI and Factory")
        check("bound repos decode", agi.repos?.count == 2, detail: "\(agi.repos?.count ?? -1)")
        check("the Linear binding decodes",
              agi.linear?.projectId == "8eb8f5b1" && agi.linear?.name == "AGI")
        // The CLI stores paths home-relative so one definition resolves on every
        // fleet box; the palette has to expand them against THIS home.
        check("home-relative root expands against this home",
              agi.rootAbs == "\(NSHomeDirectory())/src/github.com/me/agents-cli",
              detail: agi.rootAbs ?? "nil")
        check("a project with no linear block decodes with no binding",
              ProjectCatalog.named("scratch", in: defs)?.linear == nil)
        // Version skew is routine: the helper and the on-PATH CLI release apart.
        check("an unknown field from a newer CLI does not break decoding",
              ProjectCatalog.named("agi", in: defs) != nil)
    }

    // Two definitions sharing one checkout must stay two rows. Keying by root —
    // the shape the old recent-cwd picker had — collapses them.
    private static func testNameKeying() {
        let defs = decoded()
        let prix = ProjectCatalog.named("prix", in: defs)
        let rush = ProjectCatalog.named("rush", in: defs)
        check("prix and rush both resolve", prix != nil && rush != nil)
        check("prix and rush share one root",
              prix?.rootAbs == rush?.rootAbs, detail: prix?.rootAbs ?? "nil")
        check("but remain distinct definitions", prix != rush)
        check("and land in different directories",
              prix?.basePathAbs != rush?.basePathAbs,
              detail: "\(prix?.basePathAbs ?? "nil") vs \(rush?.basePathAbs ?? "nil")")
        check("names are listed alphabetically",
              defs.map(\.name) == ["agi", "prix", "rush", "scratch"],
              detail: defs.map(\.name).joined(separator: ","))
        check("an unknown name resolves to nothing",
              ProjectCatalog.named("nope", in: defs) == nil)
    }

    private static func testFilter() {
        let defs = decoded()
        check("an empty query keeps every project",
              ProjectCatalog.filter(defs, query: "").count == defs.count)
        check("a name prefix narrows the list",
              ProjectCatalog.filter(defs, query: "ru").map(\.name) == ["rush"])
        check("the description is searched too",
              ProjectCatalog.filter(defs, query: "factory").map(\.name) == ["agi"])
        check("every term must match",
              ProjectCatalog.filter(defs, query: "agi factory").map(\.name) == ["agi"])
        check("a non-matching query yields nothing",
              ProjectCatalog.filter(defs, query: "zzz").isEmpty)
    }

    // The whole point of the change: scope comes from the BINDING, not from the
    // folder name. `agi` is bound to Linear "AGI" — no spelling coincidence could
    // have found that.
    private static func testLinearBinding() {
        let defs = decoded()
        let live = [
            LinearProject(id: "8eb8f5b1", name: "AGI"),
            LinearProject(id: "8fa120d1", name: "Rush"),
        ]
        let agi = ProjectCatalog.named("agi", in: defs)
        check("the bound Linear project resolves by id",
              LinearTickets.linearProject(for: agi, projects: live)?.name == "AGI")
        check("resolution keeps the live project's id",
              LinearTickets.linearProject(for: agi, projects: live)?.id == "8eb8f5b1")

        // A binding whose project the live list does not carry (an empty or failed
        // `linear projects` call) still yields a usable scope: `linear tasks
        // --project <name>` needs the NAME.
        let prix = ProjectCatalog.named("prix", in: defs)
        check("a binding still scopes when the live project list is empty",
              LinearTickets.linearProject(for: prix, projects: [])?.name == "Prix")

        check("an unbound project has no Linear scope",
              LinearTickets.linearProject(for: ProjectCatalog.named("scratch", in: defs),
                                          projects: live) == nil)
        check("the unbound hint names the exact command that binds it",
              LinearTickets.unboundProjectHint("scratch")
                  == "No Linear project bound · agents projects link scratch --linear")

        check("no project means no scope",
              LinearTickets.linearProject(for: nil, projects: live) == nil)
        check("a manual override wins over the binding",
              LinearTickets.linearProject(for: agi, projects: live, override: "Rush")?.id == "8fa120d1")
        check("an override naming no live project still scopes by name",
              LinearTickets.linearProject(for: agi, projects: live, override: "Wispr")?.name == "Wispr")
    }

    // Recent session cwds only NARROW the chosen project — they never form the
    // project list. A cwd outside the project, the home dir, and the project's own
    // base path are all excluded.
    private static func testRecentDirsInsideProject() {
        let defs = decoded()
        guard let agi = ProjectCatalog.named("agi", in: defs) else {
            check("agi decodes for recentDirs", false); return
        }
        let home = NSHomeDirectory()
        let base = "\(home)/src/github.com/me/agents-cli"
        let sessions = [
            session("\(base)/.agents/worktrees/menubar-palette"),
            session(home),
            session("\(base)"),                                  // the project itself
            session("\(home)/src/github.com/me/some-other-repo"), // not this project
            session("\(home)/src/github.com/me/linear-cli"),      // a BOUND sibling repo
            session(nil),
            session("\(base)/.agents/worktrees/menubar-palette"), // duplicate
        ]
        let got = AgentsCLI.recentDirs(in: agi, from: sessions)
        check("only directories inside the project are offered",
              got == ["\(base)/.agents/worktrees/menubar-palette",
                      "\(home)/src/github.com/me/linear-cli"],
              detail: got.joined(separator: ","))

        check("a project's own base path is inside it",
              ProjectCatalog.contains(agi, dir: base))
        check("a sibling repo bound by the definition is inside it",
              ProjectCatalog.contains(agi, dir: "\(home)/src/github.com/me/linear-cli"))
        check("an unrelated repo is not",
              !ProjectCatalog.contains(agi, dir: "\(home)/src/github.com/me/some-other-repo"))
        // Prefix matching must respect path boundaries: `agents-cli-old` is not
        // inside `agents-cli`.
        check("a sibling whose name merely starts the same is not inside it",
              !ProjectCatalog.contains(agi, dir: "\(base)-old"))
    }

    // A pasted image lands on a timestamped, collision-proof name so the strip's
    // newest-first ordering stays stable.
    private static func testAttachmentNaming() {
        let at = Date(timeIntervalSince1970: 1_757_260_272)
        let name = AgentsCLI.attachmentFileName(at: at, suffix: "a1b2c3")
        check("attachment name is <yyyyMMdd-HHmmss>-<6hex>.png",
              name.hasSuffix("-a1b2c3.png") && name.count == "yyyyMMdd-HHmmss-a1b2c3.png".count,
              detail: name)
        check("two pastes in the same second do not collide",
              AgentsCLI.attachmentFileName(at: at, suffix: "aaaaaa")
                  != AgentsCLI.attachmentFileName(at: at, suffix: "bbbbbb"))

        // Round-trip real bytes through the durable attachments dir and back out
        // as the reference an agent receives.
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        guard let written = AgentsCLI.writeAttachment(png: png) else {
            check("a pasted image is written to the attachments dir", false); return
        }
        defer { try? FileManager.default.removeItem(atPath: written) }
        check("a pasted image lands in the durable attachments dir",
              written.hasPrefix(Clip.attachmentsDir.path + "/"), detail: written)
        check("the written bytes are the pasted bytes",
              (try? Data(contentsOf: URL(fileURLWithPath: written))) == png)
        check("the attachment travels as a host-qualified ref",
              AgentsCLI.attachmentRefs([written]) == ["\(Clip.localHostName()):\(written)"],
              detail: AgentsCLI.attachmentRefs([written]).joined(separator: ","))
    }

    // Cmd-V and drag-and-drop share ONE reader, driven here over a REAL
    // NSPasteboard (not a mock): raw bitmap bytes, an image FILE url, and a
    // pasteboard carrying neither.
    private static func testPasteAndDrop() {
        let pb = NSPasteboard(name: NSPasteboard.Name("agents.menubar.selftest"))

        // 1. A screenshot that lives only on the clipboard (Ctrl-Shift-Cmd-4).
        guard let png = onePixelPNG() else {
            check("built a fixture PNG", false); return
        }
        pb.clearContents()
        pb.setData(png, forType: .png)
        // The pasteboard server (`pbs`) is per LOGIN SESSION. This gate runs from
        // build.sh, which may be driven over ssh on a signing box with no session,
        // and a pasteboard that cannot store bytes is the runner's limitation, not
        // a regression — skip rather than fail the build on it.
        guard pb.data(forType: .png) != nil else {
            print("  SKIP  pasteboard unavailable in this session (no pbs) — paste/drop not exercised")
            pb.releaseGlobally()
            return
        }
        let pasted = AgentsCLI.imageAttachments(from: pb)
        defer { for p in pasted { try? FileManager.default.removeItem(atPath: p) } }
        check("clipboard bitmap becomes exactly one attachment", pasted.count == 1,
              detail: "\(pasted.count)")
        check("the pasted attachment is named <yyyyMMdd-HHmmss>-<6hex>.png",
              pasted.first.map { (($0 as NSString).lastPathComponent).range(
                  of: "^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}\\.png$", options: .regularExpression) != nil } ?? false,
              detail: pasted.first.map { ($0 as NSString).lastPathComponent } ?? "nil")
        check("the pasted bytes round-trip",
              pasted.first.flatMap { try? Data(contentsOf: URL(fileURLWithPath: $0)) } == png)

        // 2. A dropped/copied image FILE — the drag pasteboard shape.
        let src = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("menubar-drop-\(ProcessInfo.processInfo.processIdentifier).png")
        try? png.write(to: src)
        defer { try? FileManager.default.removeItem(at: src) }
        pb.clearContents()
        pb.writeObjects([src as NSURL])
        let dropped = AgentsCLI.imageAttachments(from: pb)
        defer { for p in dropped { try? FileManager.default.removeItem(atPath: p) } }
        check("a dropped image file becomes one attachment", dropped.count == 1,
              detail: "\(dropped.count)")
        // Copied, not referenced in place: the source can be swept away between
        // the drop and the agent reading it.
        check("the dropped file is COPIED into the durable attachments dir",
              dropped.first.map { $0 != src.path && $0.hasPrefix(Clip.attachmentsDir.path + "/") } ?? false,
              detail: dropped.first ?? "nil")

        // 3. Plain text must fall through to an ordinary paste.
        pb.clearContents()
        pb.setString("just some text", forType: .string)
        check("a text-only pasteboard attaches nothing",
              AgentsCLI.imageAttachments(from: pb).isEmpty)
        // A non-image file (the drop handler's own filter also rejects these).
        let doc = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("menubar-drop-\(ProcessInfo.processInfo.processIdentifier).txt")
        try? Data("nope".utf8).write(to: doc)
        defer { try? FileManager.default.removeItem(at: doc) }
        pb.clearContents()
        pb.writeObjects([doc as NSURL])
        check("a non-image file attaches nothing",
              AgentsCLI.imageAttachments(from: pb).isEmpty)
        pb.releaseGlobally()
    }

    // The pin does exactly two things: it survives a relaunch, and it stops the
    // palette being swept away by a Space switch / Mission Control.
    private static func testPinPolicy() {
        let unpinned = PromptPanel.collectionBehavior(pinned: false)
        let pinned = PromptPanel.collectionBehavior(pinned: true)
        check("an UNpinned palette is transient (goes away with its space)",
              unpinned.contains(.transient))
        check("a PINNED palette is not transient", !pinned.contains(.transient))
        check("a PINNED palette is stationary across spaces", pinned.contains(.stationary))
        check("both join all spaces",
              unpinned.contains(.canJoinAllSpaces) && pinned.contains(.canJoinAllSpaces))

        // Persistence: the pin is a standing preference, not a per-summon toggle.
        let key = PromptPanel.pinnedDefaultsKey
        let restore = UserDefaults.standard.object(forKey: key)
        defer {
            if let restore { UserDefaults.standard.set(restore, forKey: key) }
            else { UserDefaults.standard.removeObject(forKey: key) }
        }
        UserDefaults.standard.set(true, forKey: key)
        check("a pinned palette reads back pinned on the next launch",
              UserDefaults.standard.bool(forKey: key))
        UserDefaults.standard.set(false, forKey: key)
        check("unpinning reads back unpinned",
              !UserDefaults.standard.bool(forKey: key))
    }

    /// A real 1x1 PNG, encoded through the same ImageIO path the app uses.
    private static func onePixelPNG() -> Data? {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1, pixelsHigh: 1,
                                   bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                   isPlanar: false, colorSpaceName: .deviceRGB,
                                   bytesPerRow: 4, bitsPerPixel: 32)
        rep?.setColor(.white, atX: 0, y: 0)
        return rep?.representation(using: .png, properties: [:])
    }

    private static func session(_ cwd: String?) -> RecentSession {
        RecentSession(id: nil, shortId: nil, agent: "claude", timestamp: nil,
                      project: nil, cwd: cwd, filePath: nil, gitBranch: nil,
                      topic: nil, version: nil)
    }

    private static func check(_ name: String, _ ok: Bool, detail: String? = nil) {
        if ok {
            print("  PASS  \(name)")
        } else {
            failures += 1
            print("  FAIL  \(name)" + (detail.map { "  (got: \($0))" } ?? ""))
        }
    }
}
