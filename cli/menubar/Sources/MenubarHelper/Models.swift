import Foundation

// Shape of `agents routines list --json` (added in src/commands/routines.ts).
// Routines are secondary in the menu bar — fetched only when the menu opens.
//
// RUSH-2290 (routine reliability): `ready`/`readiness`/`failureCode`/
// `project`/`requestedCwd`/`resolvedCwd`/`skipReason`/`activeRunId` are all
// optional additions from the runtime-core track. Every one of them must
// decode as nil against a payload from an older installed CLI that predates
// them — the menu bar and the CLI release independently, so version skew
// between this helper and the on-PATH `agents` binary is routine, not an
// edge case. Do NOT make any of them non-optional.
struct Routine: Decodable {
    let name: String
    let agent: String?
    let workflow: String?
    let repo: String?
    // project membership decoded from CLI JSON; absent keys decode as nil for both fields.
    let projects: [String]?    // repos this routine belongs to
    let projectGroup: String?  // menu display grouping label; nil = cross-project / ungrouped
    let schedule: String
    let scheduleHuman: String?
    let enabled: Bool
    let overdue: Bool
    let nextRun: String?
    let nextRunHuman: String?
    // completed | failed | timeout | running | missed | blocked | skipped | null.
    // `blocked` / `skipped` are new outcomes (a readiness gate refused the run, or
    // the daemon deliberately skipped a duplicate/overlapping fire) — every switch
    // over this field must have a default arm rather than an exhaustive one.
    let lastStatus: String?
    let exitCode: Int?
    let failureReason: String?
    let lastRunStartedAt: String?
    let lastRunCompletedAt: String?

    // Explicit readiness verdict for the NEXT run, independent of how the last
    // one went. `nil` (an older CLI, or a routine the readiness check never
    // covers) must behave exactly like `true` — only an explicit `false` gates
    // Run/Resume in the UI.
    let ready: Bool?
    let readiness: RoutineReadiness?
    // A short machine code alongside `failureReason`'s free text (e.g. "auth_failed").
    let failureCode: String?
    // Execution target, for naming WHERE a failure/block happened.
    let project: String?
    let requestedCwd: String?
    let resolvedCwd: String?
    // Present when lastStatus == "skipped": why the daemon skipped this fire
    // (duplicate_slot | active_run | wrong_owner).
    let skipReason: String?
    // The run this one was skipped in favor of, when skipReason == "active_run".
    let activeRunId: String?
}

// `readiness` on `Routine`: why the daemon would refuse to start the next run
// right now. `code` is a stable machine token (e.g. "project_path_missing"),
// `message` is the human-readable reason, `repair` is an optional suggested fix.
struct RoutineReadiness: Decodable {
    let code: String
    let message: String
    let repair: String?
}

struct MenuAgent {
    let id: String
    let label: String
}

// One entry of `linear projects --json` (the linear skill CLI). Only the fields
// the quick-dispatch panel needs to name and scope a project are decoded.
struct LinearProject: Codable, Equatable {
    let id: String
    let name: String
}

// Shape of `linear tasks --json`: a scope envelope around the issue list.
struct LinearTasksResponse: Decodable {
    let count: Int
    let issues: [LinearTicket]
}

// One open Linear issue as the quick-dispatch panel shows it. `priority` is
// Linear's own scale — 1 urgent, 2 high, 3 medium, 4 low, 0 none (0 sorts last,
// see LinearTickets.rank). Cached to disk, so Codable both ways.
struct LinearTicket: Codable, Equatable {
    let identifier: String
    let title: String
    let priority: Int
    let state: LinearTicketState?
    let url: String?
    let dueDate: String?
    let createdAt: String?

    // "started" is Linear's state type for in-progress workflow states.
    var isStarted: Bool { state?.type == "started" }
    var stateName: String { state?.name ?? "" }
}

struct LinearTicketState: Codable, Equatable {
    let name: String
    let type: String
}

struct RecentSession: Decodable {
    let id: String?
    let shortId: String?
    let agent: String
    let timestamp: String?
    let project: String?
    let cwd: String?
    let filePath: String?
    let gitBranch: String?
    let topic: String?
    let version: String?
}

struct BrowserTask {
    let name: String
    let profile: String
    let tabCount: Int
    let createdAt: Double
    let pid: Int
}

struct DoctorOverview: Decodable {
    let clis: [String: DoctorCli]?
    let sync: [DoctorSync]?
    let orphans: [DoctorOrphan]?
    // Additive in agents doctor JSON. Nil, rather than an empty list, means the
    // installed CLI predates prioritized findings and the menu must retain its
    // legacy install/sync summary.
    let findings: [DoctorFinding]?
}

/// One doctor health finding. Keep every field optional except the stable core
/// emitted by current agents-cli: the menu bar and CLI release independently,
/// and a newer remote device must never make the whole overview undecodable.
struct DoctorFinding: Decodable {
    let severity: String
    let kind: String
    let device: String?
    let agent: String?
    let version: String?
    let versions: [String]?
    let message: String
    let remediation: String?
}

/// Pure presentation policy for doctor findings. Keeping it out of AppKit makes
/// the cap, ordering and version-skew fallback executable in a headless test.
enum DoctorHealth {
    static let maxVisibleFindings = 5

    static func actionable(_ findings: [DoctorFinding]?) -> [DoctorFinding]? {
        findings.map { $0.filter { $0.severity == "critical" || $0.severity == "warning" } }
    }

    static func summary(_ findings: [DoctorFinding]?) -> String? {
        guard let findings = actionable(findings) else { return nil }
        let critical = findings.filter { $0.severity == "critical" }.count
        let warning = findings.filter { $0.severity == "warning" }.count
        var parts: [String] = []
        if critical > 0 { parts.append("\(critical) critical") }
        if warning > 0 { parts.append("\(warning) warning\(warning == 1 ? "" : "s")") }
        return parts.isEmpty ? "all set" : parts.joined(separator: " · ")
    }

    /// Keeps doctor-provided order; the CLI is the canonical prioritizer.
    static func visible(_ findings: [DoctorFinding]?) -> [DoctorFinding] {
        Array((actionable(findings) ?? []).prefix(maxVisibleFindings))
    }

    static func remainderCount(_ findings: [DoctorFinding]?) -> Int {
        max(0, (actionable(findings) ?? []).count - maxVisibleFindings)
    }

    static func context(_ finding: DoctorFinding) -> String {
        var parts = [finding.severity]
        if let device = finding.device, !device.isEmpty { parts.append(device) }
        if let agent = finding.agent, !agent.isEmpty {
            // Mirror the CLI's subjectLabel (doctor-findings.ts): a collapsed row
            // reads `agent (N versions)`, a single-version row `agent @version`.
            if let versions = finding.versions, versions.count > 1 {
                parts.append("\(agent) (\(versions.count) versions)")
            } else {
                let version = finding.version ?? finding.versions?.first
                parts.append(version.map { "\(agent) @\($0)" } ?? agent)
            }
        }
        return parts.joined(separator: " · ")
    }

    /// The second display row: the problem plus the exact fix doctor computed,
    /// so a finding is actionable from the menu itself. Display-only — the menu
    /// never runs the remediation. Pure so the headless self-test can pin it.
    static func detail(_ finding: DoctorFinding, max: Int = 96) -> String {
        let fix = finding.remediation ?? ""
        let full = fix.isEmpty ? finding.message : "\(finding.message) → \(fix)"
        if full.count <= max { return full }
        return String(full.prefix(max - 1)) + "…"
    }
}

struct DoctorCli: Decodable {
    let installed: Bool
    let path: String?
    let error: String?
}

struct DoctorSync: Decodable {
    let agent: String
    let version: String?
    let status: String
}

// `agents watchdog --json` tick result (RUSH-1415). The menu-bar reads the
// convenience counts; `didNudge` reflects whether this tick was allowed to inject.
struct WatchdogTick: Decodable {
    let didNudge: Bool
    let counts: WatchdogCounts
}

struct WatchdogCounts: Decodable {
    let total: Int
    let stalled: Int
    let nudged: Int
    let unaddressable: Int
    let skipped: Int
}

// One registered fleet device from `agents menubar snapshot --json` (sourced
// from the local device registry — no network probe). Live load% is merged in
// at render time from the daemon-warmed .fleet-stats.json (LocalState.deviceLoads);
// online/offline is deliberately NOT carried (the registry's tailscale flag is
// stale in both directions), so the menu never claims a status it can't back.
struct Device: Decodable, Equatable {
    let name: String
    let platform: String
    let interactive: Bool
    let isLocal: Bool
    // The device's `auto-launch.preferred` flag (a "favorite"): the same
    // per-device config that boosts a box in AGI EXT's auto-launch ranking
    // (cli/CLAUDE.md → auto-launch.preferred). Optional so a snapshot from an
    // older installed `agents` CLI that predates the field still decodes —
    // version skew between the helper and the on-PATH CLI is real.
    let preferred: Bool?

    // Nil (an older snapshot with no field) reads as not-favorited.
    var isPreferred: Bool { preferred ?? false }
}

// `agents menubar snapshot --json` — the single repeating CLI read owned by
// AGI Menu. Doctor remains a separate 15-minute diagnostic refresh.
struct MenubarSnapshot: Decodable {
    let version: Int
    let capturedAt: String
    // The installed CLI version that produced this snapshot — the value
    // `agents --version` prints, resolved at runtime so the header shows it and
    // a stale menu bar is visible at a glance (RUSH-2688). Optional so a snapshot
    // from an older `agents` CLI that predates the field still decodes.
    let cliVersion: String?
    let routines: [Routine]
    let recentSessions: [RecentSession]
    let activeSessions: [ActiveSession]
    // Optional so a snapshot from an older installed `agents` CLI (no devices
    // field) still decodes — version skew between the helper and the on-PATH CLI
    // is real (see the multi-install notes in cli/CLAUDE.md).
    let devices: [Device]?
    let watchdog: MenubarWatchdogSnapshot
}

struct MenubarWatchdogSnapshot: Decodable {
    let enabled: Bool
    let lastTick: WatchdogTick?
}

struct DoctorOrphan: Decodable {
    let agent: String
    let version: String?
    let commands: Int?
    let skills: Int?
    let hooks: Int?
}

// One row of `agents sessions --active --local --json` — the session engine's
// authoritative live view (terminals, tmux, IDE, headless). Richer coverage than
// the cheap live-terminals.json file, which only carries extension-registered
// terminals; used to feed the ACTIVE section from a warm cache.
//
// Field names match the engine JSON (camelCase). Optional fields are omitted by
// some kinds of session (cloud vs tmux); decode must not require them.
struct ActiveSession: Decodable {
    let kind: String?
    let sessionId: String?
    let cwd: String?
    let status: String       // running | idle | queued | …
    let context: String?
    /// Host that owns the process (e.g. zion, yosemite-m0). Always present on a
    /// bare-active row (RUSH-2336): a process row without a known machine never
    /// clears the CLI's canonical `isRunningLiveSession` selector.
    let machine: String?
    /// Surface on that machine: tmux, codium, terminal, …
    let host: String?
    /// OS process id (terminal/tmux/headless/team rows only — absent for cloud).
    let pid: Int?
    /// Whether `pid` was POSITIVELY verified alive at scan time — never merely
    /// "not known dead". Absent for cloud rows and older-peer payloads.
    let pidAlive: Bool?
    /// Cloud provider (e.g. "rush") for a `context == "cloud"` row — no local pid.
    let cloudProvider: String?
    /// Cloud provider's own task id for a `context == "cloud"` row.
    let cloudTaskId: String?
    /// First-prompt / assigned task — best "what is it doing" signal.
    let topic: String?
    /// Latest-turn snippet (can be long; UI trims).
    let preview: String?
    let ticketId: String?
    let prLink: String?
    let startedAtMs: Double?
    let lastActivityMs: Double?
    let owner: String?
    let label: String?
    let origin: String?
    let routineName: String?
}

// MARK: - Projects (`agents projects list --json`)

// One bound repo of a project definition. `path` is stored home-relative (`~/…`)
// by the CLI so the same definition resolves on every fleet box; `absPath`
// expands it against THIS machine's home.
struct ProjectRepoRef: Codable, Equatable {
    let slug: String?
    let path: String?
    /// The subdirectory of this repo the project actually cares about. When set,
    /// the bound directory is `path/subpath`, NOT the whole `path` tree —
    /// `projectDirsAbs`'s `joinSubpath` in src/lib/projects.ts. Dropping it would
    /// over-bind the checkout and reintroduce the sibling-directory leak that
    /// `boundDirsAbs` excludes `root` to avoid.
    let subpath: String?

    var absPath: String? {
        guard let path else { return nil }
        let base = ProjectDef.expandTilde(path)
        guard let subpath, !subpath.isEmpty else { return base }
        return (base as NSString).appendingPathComponent(subpath)
    }
}

// The project's Linear binding — the ONLY thing that scopes the palette's ticket
// list. There is deliberately no name-matching fallback: an unbound project says
// so instead of listing some other project's tickets (PHNX-4001).
struct ProjectLinearBinding: Codable, Equatable {
    let projectId: String?
    let name: String?
    let url: String?
}

// One entry of `agents projects list --json` (src/lib/projects.ts `ProjectDef`).
// Only `name` is required; every other field is optional because the helper and
// the on-PATH `agents` CLI release independently, so a definition written by a
// newer CLI must still decode here.
//
// Two definitions may share one `root` — `prix` and `rush` both point at the
// `muqsitnawaz/agents` monorepo and differ only by `defaultPath` — so the palette
// keys projects by NAME, never by root.
struct ProjectDef: Codable, Equatable {
    let name: String
    let description: String?
    let root: String?
    let defaultPath: String?
    let repos: [ProjectRepoRef]?
    let linear: ProjectLinearBinding?

    // The CLI stores `root`/`defaultPath`/`repos[].path` home-relative. Expand
    // against this machine's home; anything else passes through untouched.
    static func expandTilde(_ p: String) -> String {
        if p == "~" { return NSHomeDirectory() }
        if p.hasPrefix("~/") { return NSHomeDirectory() + String(p.dropFirst(1)) }
        return p
    }

    var rootAbs: String? { root.map(Self.expandTilde) }

    /// Where an agent lands for this project: `defaultPath` when the definition
    /// narrowed itself to a subproject, else the checkout root. Mirrors
    /// `definedProjectBasePath` in src/lib/projects.ts.
    var basePathAbs: String? { (defaultPath ?? root).map(Self.expandTilde) }

    /// Every local directory this project binds — the base path plus each
    /// `repos[].path`, mirroring `projectDirsAbs` in src/lib/projects.ts.
    ///
    /// `root` is deliberately NOT in here. A monorepo subproject narrows itself
    /// with `defaultPath` (`prix` -> `<root>/prix`, `rush` -> `<root>/rush`) while
    /// sharing one `root`, so treating the root as bound would offer each of them
    /// the other's directories. Worktrees are handled separately
    /// (`ProjectCatalog.contains`), because they land under the repo ROOT.
    var boundDirsAbs: [String] {
        var out: [String] = []
        var seen = Set<String>()
        for candidate in [basePathAbs].compactMap({ $0 })
            + (repos ?? []).compactMap({ $0.absPath }) {
            let norm = (candidate as NSString).standardizingPath
            if seen.insert(norm).inserted { out.append(norm) }
        }
        return out
    }

    /// Where this project's git worktrees live: `<root>/.agents/worktrees`. A
    /// worktree is created off the repo ROOT, not off a subproject's
    /// `defaultPath` (root AGENTS.md), so a subproject would otherwise never see
    /// its own worktrees.
    var worktreesDirAbs: String? {
        rootAbs.map { (($0 as NSString).standardizingPath as NSString)
            .appendingPathComponent(".agents/worktrees") }
    }
}

// Pure catalog helpers over the decoded project list. Kept free of AppKit and of
// the CLI call so MENUBAR_PROJECTS_TEST can drive them over fixtures.
enum ProjectCatalog {
    /// Stable display order: alphabetical by name, case-insensitively. The CLI
    /// already sorts, but the cache round-trips through JSON and the palette must
    /// not reorder itself between a cached render and a fresh fetch.
    static func ordered(_ defs: [ProjectDef]) -> [ProjectDef] {
        defs.sorted { $0.name.lowercased() < $1.name.lowercased() }
    }

    /// Look a definition up by its NAME. Root is not an identity here: `prix` and
    /// `rush` share one root and are two distinct projects.
    static func named(_ name: String?, in defs: [ProjectDef]) -> ProjectDef? {
        guard let name, !name.isEmpty else { return nil }
        return defs.first { $0.name == name }
    }

    /// Type-ahead filter for the project popup: every whitespace-separated term
    /// must appear in the name or the description. An empty query keeps the list.
    static func filter(_ defs: [ProjectDef], query: String) -> [ProjectDef] {
        let terms = query.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard !terms.isEmpty else { return defs }
        return defs.filter { def in
            let haystack = "\(def.name) \(def.description ?? "")".lowercased()
            return terms.allSatisfy { haystack.contains($0) }
        }
    }

    /// True when `dir` is the project's base path, sits inside one of its bound
    /// directories (a monorepo subdirectory, a sibling repo), or is one of its
    /// git worktrees. Prefix matching respects path boundaries, so `agents-cli-old`
    /// is not inside `agents-cli`.
    static func contains(_ def: ProjectDef, dir: String) -> Bool {
        let norm = (dir as NSString).standardizingPath
        func under(_ base: String) -> Bool { norm == base || norm.hasPrefix(base + "/") }
        if def.boundDirsAbs.contains(where: under) { return true }
        return def.worktreesDirAbs.map(under) ?? false
    }
}
