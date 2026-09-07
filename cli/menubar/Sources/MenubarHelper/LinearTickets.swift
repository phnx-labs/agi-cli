import Foundation

// The quick-dispatch panel's ticket half (Cmd-Shift-O). The panel captures NEW
// work, and this is what it shows about work that ALREADY exists: the open Linear
// tickets of the project the picker is pointed at, ranked so the ones that should
// be picked up next lead.
//
// Everything here is pure or file-local — no network, no AppKit — so the ordering,
// the project→Linear binding, and the cache are exercised by the headless
// self-tests (IssueSelfTest.swift, ProjectSelfTest.swift). The actual fetch lives
// in AgentsCLI, which shells the `linear` skill CLI the same way the
// ticket-create path does.
enum LinearTickets {
    // How many rows fit in the ticket scroll viewport before the user scrolls.
    // The list itself can be longer (see `viewportLimit` vs full filtered set).
    static let viewportRows = 5
    // Hard cap on rows kept after filter+sort so a huge project never materializes
    // hundreds of AppKit views; scrolling still covers a useful slice.
    static let listCap = 40
    static let cacheTTL: TimeInterval = 90
    // Back-compat name used by older call sites / docs.
    static let displayLimit = viewportRows

    // MARK: Quick filter (one dropdown) — status / priority / overdue

    // A single popup, not a chip matrix: each option is one predicate over the
    // open tickets already loaded for the project. Labels are not in the model
    // yet, so this stays status + priority + overdue.
    enum QuickFilter: String, CaseIterable {
        case all
        case todo
        case doing
        case backlog
        case p1
        case p2
        case overdue

        var title: String {
            switch self {
            case .all: return "All open"
            case .todo: return "Todo"
            case .doing: return "Doing"
            case .backlog: return "Backlog"
            case .p1: return "P1 only"
            case .p2: return "P2 only"
            case .overdue: return "Overdue"
            }
        }

        func matches(_ ticket: LinearTicket, now: Date = Date()) -> Bool {
            switch self {
            case .all:
                return true
            case .todo:
                // Linear "unstarted" with a Todo-like name, or plain unstarted.
                let t = ticket.state?.type ?? ""
                let n = ticket.stateName.lowercased()
                return t == "unstarted" && !n.contains("backlog")
            case .doing:
                return ticket.isStarted
            case .backlog:
                return ticket.stateName.lowercased().contains("backlog")
                    || (ticket.state?.type == "backlog")
            case .p1:
                return ticket.priority == 1
            case .p2:
                return ticket.priority == 2
            case .overdue:
                return isOverdue(ticket, now: now)
            }
        }
    }

    // MARK: Quick sort (one dropdown) — flat list, no grouping

    enum QuickSort: String, CaseIterable {
        case urgentFirst
        case newest
        case oldest
        case due
        case priority

        var title: String {
            switch self {
            case .urgentFirst: return "Urgent first"
            case .newest: return "Newest"
            case .oldest: return "Oldest"
            case .due: return "Due date"
            case .priority: return "Priority"
            }
        }
    }

    /// Apply the quick filter, then the chosen sort. No status-group headers —
    /// one flat list. `query` is the capture field's text search (AND).
    static func list(_ tickets: [LinearTicket],
                     filter: QuickFilter = .all,
                     sort: QuickSort = .urgentFirst,
                     query: String = "",
                     now: Date = Date(),
                     cap: Int = listCap) -> [LinearTicket] {
        let filtered = tickets.filter { filter.matches($0, now: now) }
        let searched = Self.filter(filtered, query: query)
        let ordered = applySort(searched, sort: sort, now: now)
        return Array(ordered.prefix(cap))
    }

    static func applySort(_ tickets: [LinearTicket],
                          sort: QuickSort,
                          now: Date = Date()) -> [LinearTicket] {
        switch sort {
        case .urgentFirst:
            return rank(tickets, now: now)
        case .newest:
            return tickets.sorted { a, b in
                let (ca, cb) = (a.createdAt ?? "", b.createdAt ?? "")
                if ca != cb { return ca > cb }
                return a.identifier < b.identifier
            }
        case .oldest:
            return tickets.sorted { a, b in
                let (ca, cb) = (a.createdAt ?? "", b.createdAt ?? "")
                if ca != cb { return ca < cb }
                return a.identifier < b.identifier
            }
        case .due:
            // Soonest due first; undated sink to the end; overdue still compare by date.
            return tickets.sorted { a, b in
                let (da, db) = (a.dueDate ?? "", b.dueDate ?? "")
                switch (da.isEmpty, db.isEmpty) {
                case (false, false) where da != db: return da < db
                case (false, true): return true
                case (true, false): return false
                default: return a.identifier < b.identifier
                }
            }
        case .priority:
            return tickets.sorted { a, b in
                let (pa, pb) = (priorityOrder(a.priority), priorityOrder(b.priority))
                if pa != pb { return pa < pb }
                return a.identifier < b.identifier
            }
        }
    }

    // MARK: Project -> Linear project

    // The Linear project whose tickets belong to a chosen `agents projects`
    // definition. The binding is the DEFINITION's own `linear:` block — never the
    // folder name.
    //
    // Folder-name matching is what this replaced (PHNX-4001): it reduced a repo
    // directory name and a Linear project name to lowercase alphanumerics and
    // compared them, so `agents-cli` found "Agents CLI" by luck of spelling while
    // `agi` (bound to Linear "AGI") found nothing, and two definitions sharing a
    // checkout — `prix` and `rush` both live in the `muqsitnawaz/agents` monorepo
    // — could not be told apart at all. `agents projects link <name> --linear`
    // records the answer; this reads it.
    //
    // `override` is a project NAME the user pinned for this project definition
    // (remembered per project by the palette) and always wins. Resolution against
    // the live `linear projects` list is preferred so the id is exact, but a
    // binding that names a project the list does not carry (an empty/failed
    // `linear projects` call) still yields a usable scope from the binding
    // itself — `linear tasks --project <name>` needs the name, not the id.
    static func linearProject(for def: ProjectDef?,
                              projects: [LinearProject] = [],
                              override: String? = nil) -> LinearProject? {
        if let override, !override.isEmpty {
            return projects.first { $0.name == override } ?? LinearProject(id: "", name: override)
        }
        guard let binding = def?.linear else { return nil }
        if let id = binding.projectId, !id.isEmpty,
           let byId = projects.first(where: { $0.id == id }) {
            return byId
        }
        guard let name = binding.name, !name.isEmpty else { return nil }
        return projects.first { $0.name == name } ?? LinearProject(id: binding.projectId ?? "", name: name)
    }

    // What the ticket area says when the chosen project has no Linear binding —
    // the exact command that creates one, rather than an empty list that reads
    // like "no tickets".
    static func unboundProjectHint(_ name: String) -> String {
        "No Linear project bound · agents projects link \(name) --linear"
    }

    // MARK: Ranking — "what should I pick up next?"

    // Linear's priority scale is 1=urgent … 4=low with 0 meaning "no priority",
    // so 0 has to be pushed past 4 instead of sorting first.
    static func priorityOrder(_ priority: Int) -> Int {
        priority <= 0 ? 5 : priority
    }

    static func priorityLabel(_ priority: Int) -> String {
        priority <= 0 ? "--" : "P\(priority)"
    }

    // Dates arrive as ISO-8601 UTC (`createdAt`) and plain `yyyy-MM-dd`
    // (`dueDate`), both of which compare correctly as strings — so the ordering
    // needs no date parsing and no locale.
    static func today(_ now: Date = Date()) -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .iso8601)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: now)
    }

    static func isOverdue(_ ticket: LinearTicket, now: Date = Date()) -> Bool {
        guard let due = ticket.dueDate, !due.isEmpty else { return false }
        return due < today(now)
    }

    // Urgent first, then overdue, then already in progress — ascending, so a
    // smaller key leads. Exposed so the self-test asserts the rule itself, not
    // just one sorted example. Recency is the tiebreak, applied in `rank` because
    // it runs the other way (newest first).
    static func rankKey(_ ticket: LinearTicket, now: Date = Date()) -> (Int, Int, Int) {
        (priorityOrder(ticket.priority),
         isOverdue(ticket, now: now) ? 0 : 1,
         ticket.isStarted ? 0 : 1)
    }

    static func rank(_ tickets: [LinearTicket], now: Date = Date()) -> [LinearTicket] {
        tickets.sorted { a, b in
            let (ka, kb) = (rankKey(a, now: now), rankKey(b, now: now))
            if ka != kb { return ka < kb }
            // ISO-8601 UTC timestamps compare correctly as strings; a ticket with
            // no timestamp sorts after one that has it.
            let (ca, cb) = (a.createdAt ?? "", b.createdAt ?? "")
            if ca != cb { return ca > cb }
            return a.identifier < b.identifier
        }
    }

    // MARK: Filtering — type to find an existing ticket before filing a new one

    // Match the typed note against identifier + title, every whitespace-separated
    // term having to appear somewhere (so "menubar ticket" finds a ticket titled
    // "Menu bar: dispatch a ticket"). An empty query matches everything, which is
    // what keeps the unfiltered list showing the top-ranked tickets.
    static func filter(_ tickets: [LinearTicket], query: String) -> [LinearTicket] {
        let terms = query.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard !terms.isEmpty else { return tickets }
        return tickets.filter { ticket in
            let haystack = "\(ticket.identifier) \(ticket.title)".lowercased()
            return terms.allSatisfy { haystack.contains($0) }
        }
    }

    // MARK: Cache

    // Warm cache so a summon renders tickets immediately instead of waiting on a
    // `linear tasks` round trip (measured 0.4-3.6s). Same durable, gitignored home
    // as the recent-tickets ledger.
    struct Cache: Codable {
        var projects: [LinearProject] = []
        var projectsFetchedAt: Double = 0
        var scopes: [String: Scope] = [:]

        struct Scope: Codable {
            var fetchedAt: Double
            var tickets: [LinearTicket]
        }
    }

    private static var cacheURL: URL {
        URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".agents/.history/menubar/linear-cache.json")
    }

    static func loadCache() -> Cache {
        guard let data = try? Data(contentsOf: cacheURL),
              let cache = try? JSONDecoder().decode(Cache.self, from: data) else { return Cache() }
        return cache
    }

    static func saveCache(_ cache: Cache) {
        try? FileManager.default.createDirectory(
            at: cacheURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let out = try? JSONEncoder().encode(cache) { try? out.write(to: cacheURL) }
    }

    /// Pure cache update for one project's tickets — replaces that scope and
    /// leaves every other scope (and the project list) untouched.
    static func merged(_ cache: Cache, project: String, tickets: [LinearTicket],
                       at now: Date = Date()) -> Cache {
        var next = cache
        next.scopes[project] = Cache.Scope(fetchedAt: now.timeIntervalSince1970, tickets: tickets)
        return next
    }

    static func merged(_ cache: Cache, projects: [LinearProject], at now: Date = Date()) -> Cache {
        var next = cache
        next.projects = projects
        next.projectsFetchedAt = now.timeIntervalSince1970
        return next
    }

    /// True when a scope was fetched recently enough that the panel can show it
    /// without kicking a refresh.
    static func isFresh(_ cache: Cache, project: String, now: Date = Date(),
                        ttl: TimeInterval = cacheTTL) -> Bool {
        guard let scope = cache.scopes[project] else { return false }
        return now.timeIntervalSince1970 - scope.fetchedAt <= ttl
    }
}
