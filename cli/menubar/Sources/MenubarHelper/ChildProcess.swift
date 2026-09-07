import Darwin
import Foundation

// Bounded, reapable child processes for the menu-bar helper.
//
// The helper shells the `agents` CLI on a 10s timer. Every one of those calls
// used to run through a bare `Process` + `readDataToEndOfFile()`, which has two
// properties that compose into a machine-killing runaway:
//
//   1. No deadline. `agents doctor --json` probes every installed version of
//      every harness with a `node -e` subprocess each. On a busy box that goes
//      from ~2s to over 12 MINUTES, and the call simply waits.
//   2. No ownership after the parent dies. A helper killed mid-call leaves the
//      child reparented to launchd (PPID 1) with nothing to reap it, and the
//      child's own `node -e` probes leak the same way.
//
// Both fire together because the helper crashes under exactly the conditions
// that make the CLI slow. `NSApplication.sharedApplication` segfaults in
// `SLSNewConnection` when WindowServer is too starved to hand out a connection
// (EXC_BAD_ACCESS at 0x10 — AppKit dereferencing the null connection it just
// failed to get), launchd's `KeepAlive` restarts the helper, and the restart
// spawns a fresh doctor while the previous one keeps burning a core forever.
// Measured on a real machine: 38 orphaned doctors plus 92 orphaned `node -e`
// probes, ~13 of 18 cores consumed, load average 490. The slower the box got,
// the more it crashed, and every crash added another permanent orphan.
//
// So a child of this helper must satisfy three invariants:
//
//   * **It is bounded.** Every spawn carries a deadline; past it the child is
//     terminated. A doctor that takes minutes is broken, and a stale menu is
//     strictly better than an unresponsive machine.
//   * **It dies as a group.** The child is spawned as its own process-group
//     leader (`POSIX_SPAWN_SETPGROUP`), so `kill(-pgid)` takes its whole
//     subtree — the CLI *and* the `node -e` probes it forked. Signalling just
//     the pid is what let the 92 probes survive their own parent.
//   * **It cannot outlive the helper.** No exit handler can be trusted here:
//     the observed death is SIGSEGV, where nothing of ours runs. Instead each
//     live child is recorded on disk and the NEXT launch reaps whatever the
//     previous one left behind. Self-healing beats cleanup that a crash skips.
enum ChildProcess {
    /// Deadline for a routine CLI call. Every menu-bar refresher is a cache
    /// warmer — missing one poll costs a stale menu for 10s, while an unbounded
    /// one costs a core until reboot.
    static let defaultTimeout: TimeInterval = 30

    /// `doctor --json` probes every installed version of every harness, and it is
    /// genuinely expensive: measured at **136s** on an idle machine (load ~11,
    /// 169 KB of JSON), not the couple of seconds one might assume.
    ///
    /// The ceiling has to clear that real cost, or the deadline fires on every
    /// single poll and the menu's System row reads "unavailable" forever while
    /// still paying full CPU for a result that is always discarded — a timeout
    /// tuned low enough to look tidy would just hide the command's true cost.
    /// 180s clears the measurement with headroom and is still decisive about
    /// wedged. See also `StatusItemController.doctorRefreshInterval`, which must
    /// stay well above this number.
    static let doctorTimeout: TimeInterval = 180

    // MARK: - Spawn

    /// Run `argv` to completion and return its stdout, or nil if it failed,
    /// could not start, or blew the deadline.
    ///
    /// stderr goes to /dev/null: callers here parse JSON and must never get
    /// diagnostics interleaved into the payload.
    static func run(_ argv: [String], timeout: TimeInterval = defaultTimeout,
                    registryFile: String = Registry.path()) -> Data? {
        guard !argv.isEmpty else { return nil }

        let commandKind = argv.dropFirst().prefix(2).joined(separator: " ")
        let launch: Registry.Entry
        do {
            launch = try Registry.begin(argv: argv, commandKind: commandKind, file: registryFile)
        } catch {
            fputs("menubar: cannot persist child launch intent: \(error)\n", stderr)
            return nil
        }

        var fds: [Int32] = [-1, -1]
        guard pipe(&fds) == 0 else {
            removeRegistryEntry(token: launch.token, file: registryFile)
            return nil
        }
        let readFD = fds[0]
        let writeFD = fds[1]

        guard let pid = spawn(argv, stdout: writeFD, closeInChild: readFD, provenance: launch.token) else {
            close(readFD)
            close(writeFD)
            removeRegistryEntry(token: launch.token, file: registryFile)
            return nil
        }

        // The parent MUST drop its copy of the write end, or the read below
        // never sees EOF even after the child exits — the classic pipe hang.
        close(writeFD)

        do {
            try Registry.complete(token: launch.token, pid: pid, file: registryFile)
        } catch {
            // The child is already live. Kill it now rather than allow a process
            // whose durable ownership could not be completed to escape tracking.
            _ = terminateGroup(pid)
            close(readFD)
            var status: Int32 = 0
            while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
            removeRegistryEntry(token: launch.token, file: registryFile)
            return nil
        }
        var removeOnReturn = true
        defer {
            if removeOnReturn { removeRegistryEntry(token: launch.token, file: registryFile) }
        }

        // Drain on a background thread so the deadline is enforceable. Draining
        // WHILE the child runs also keeps a child that outputs more than the
        // ~64 KiB pipe buffer from blocking on write forever.
        //
        // The reader OWNS readFD and closes it itself. That ownership is what
        // lets the abandon path below be safe: closing a descriptor out from
        // under a thread blocked in read(2) races that fd's reuse by any other
        // thread, so the only correct way to walk away from a stuck reader is to
        // leave the descriptor with it.
        var output = Data()
        let drained = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .utility).async {
            output = readToEnd(readFD)
            close(readFD)
            drained.signal()
        }

        var timedOut = false
        if drained.wait(timeout: .now() + timeout) == .timedOut {
            timedOut = true
            // Kill the GROUP: the CLI plus every probe it forked. Every write end
            // of the pipe closes as those processes die, which is what releases
            // the reader.
            terminateGroup(pid)
            // Bounded, because this whole type exists to abolish unbounded waits
            // — including its own. SIGKILL cannot be caught, so EOF must follow;
            // if it somehow does not, abandon the reader (it owns its fd) and
            // reap off-thread rather than hanging the caller's queue forever.
            if drained.wait(timeout: .now() + 5) == .timedOut {
                removeOnReturn = false
                reapDetached(pid, token: launch.token)
                return nil
            }
        }

        // Always reap, even on timeout, so a killed child never lingers as a
        // zombie occupying a pid slot.
        var status: Int32 = 0
        while waitpid(pid, &status, 0) == -1 && errno == EINTR {}

        if timedOut { return nil }
        let exited = (status & 0x7F) == 0
        let code = (status >> 8) & 0xFF
        guard exited, code == 0 else { return nil }
        return output
    }

    /// Reap a child we have stopped waiting on, without blocking the caller.
    /// Skipping the reap entirely would leave a zombie holding its pid slot.
    private static func reapDetached(_ pid: pid_t, token: String) {
        DispatchQueue.global(qos: .utility).async {
            var status: Int32 = 0
            while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
            removeRegistryEntry(token: token)
        }
    }

    /// posix_spawn with the child as its own process-group leader.
    ///
    /// Foundation's `Process` exposes no way to set the child's process group,
    /// and without that a `kill` reaches only the CLI while its `node -e` probes
    /// survive as orphans — the exact leak this type exists to stop.
    private static func spawn(_ argv: [String], stdout writeFD: Int32, closeInChild readFD: Int32, provenance: String) -> pid_t? {
        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        // pgroup 0 == "use the child's own pid as the group id".
        // CLOEXEC_DEFAULT closes every inherited FD (including the single-instance
        // menubar.lock flock) unless a file action re-opens it — otherwise a killed
        // helper leaves doctor/sessions children holding the lock at PPID 1 and the
        // next launch exits as "already running".
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT))
        posix_spawnattr_setpgroup(&attr, 0)

        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&actions, writeFD, STDOUT_FILENO)
        posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0)
        posix_spawn_file_actions_addclose(&actions, readFD)
        posix_spawn_file_actions_addclose(&actions, writeFD)

        // Keep a tiny group-leading supervisor alive around the real command.
        // macOS 26 exposes argv but not another process's environment through
        // KERN_PROCARGS2, so the same unguessable token also rides as the
        // shell's $0. "$@" forwards the original argv without interpolation;
        // the status assignment prevents sh from tail-execing the CLI away.
        let supervisedArgv = ["/bin/sh", "-c", "\"$@\"; status=$?; exit $status", provenance] + argv
        var cArgs: [UnsafeMutablePointer<CChar>?] = supervisedArgv.map { strdup($0) }
        cArgs.append(nil)
        defer { for a in cArgs where a != nil { free(a) } }

        var environment = ProcessInfo.processInfo.environment
        environment[Registry.provenanceVariable] = provenance
        var cEnvironment: [UnsafeMutablePointer<CChar>?] = environment.map { strdup("\($0.key)=\($0.value)") }
        cEnvironment.append(nil)
        defer { for item in cEnvironment where item != nil { free(item) } }

        var pid: pid_t = 0
        let rc = posix_spawn(&pid, "/bin/sh", &actions, &attr, &cArgs, &cEnvironment)
        return rc == 0 ? pid : nil
    }

    private static func readToEnd(_ fd: Int32) -> Data {
        var data = Data()
        var buf = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let n = buf.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
            if n > 0 {
                data.append(contentsOf: buf[0..<n])
            } else if n == 0 {
                break
            } else if errno == EINTR {
                continue
            } else {
                break
            }
        }
        return data
    }

    /// SIGTERM the group, then SIGKILL anything that ignored it. The negative
    /// pid is the whole process group — `kill(pid)` alone leaves the subtree.
    @discardableResult
    private static func terminateGroup(_ pgid: pid_t, confirmAbsence: Bool = false) -> Bool {
        kill(-pgid, SIGTERM)
        // A wedged node process under memory pressure does not always service
        // SIGTERM promptly; escalate rather than wait on it indefinitely.
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline {
            if processGroupIsAbsent(pgid) { return true }
            usleep(50_000)
        }
        kill(-pgid, SIGKILL)
        if !confirmAbsence { return true }
        let killDeadline = Date().addingTimeInterval(3)
        while Date() < killDeadline {
            if processGroupIsAbsent(pgid) { return true }
            usleep(50_000)
        }
        return processGroupIsAbsent(pgid)
    }

    private static func processGroupIsAbsent(_ pgid: pid_t) -> Bool {
        kill(-pgid, 0) != 0 && errno == ESRCH
    }

    // MARK: - Cross-launch reaping

    /// Kill anything a previous helper left running.
    ///
    /// Called at launch, before the status item exists. This is the only cleanup
    /// that survives the failure mode that actually happens: a SIGSEGV runs no
    /// handler of ours, so the *next* process has to do it.
    @discardableResult
    static func reapOrphansFromPreviousLaunch(file: String = Registry.path()) -> Int {
        let stale: [Registry.Entry]
        do {
            stale = try Registry.readAll(file: file)
        } catch {
            fputs("menubar: cannot read child registry; retaining it for retry: \(error)\n", stderr)
            return 0
        }
        var reaped = 0
        for original in stale {
            let candidates: [Registry.Entry]
            if original.pid == nil {
                let recovery = recoverProcesses(provenance: original.token, template: original)
                candidates = recovery.entries
                if candidates.isEmpty && recovery.complete {
                    removeRegistryEntry(token: original.token, file: file)
                }
            } else {
                candidates = [original]
            }

            for entry in candidates {
                guard let pid = entry.pid, pid != getpid(), let pgid = entry.pgid else { continue }
                guard kill(pid, 0) == 0 else {
                    if errno == ESRCH {
                        if processGroupIsAbsent(pgid) {
                            removeRegistryEntry(token: entry.token, file: file)
                        } else if processGroupContainsProvenance(pgid, token: entry.token),
                                  terminateGroup(pgid, confirmAbsence: true) {
                            removeRegistryEntry(token: entry.token, file: file)
                            reaped += 1
                        }
                    }
                    continue
                }
                // A different start time conclusively means pid reuse. Any
                // unreadable or merely mismatched field is ambiguous and stays
                // durable for a later validation pass.
                guard let actualStart = processStartTime(pid) else { continue }
                if let recordedStart = entry.startTime, recordedStart != actualStart {
                    removeRegistryEntry(token: entry.token, file: file)
                    continue
                }
                guard processHasProvenance(pid, token: entry.token) == true else { continue }
                guard let resolved = executablePath(pid) else { continue }
                if let recorded = entry.resolvedExecutable, recorded != resolved { continue }

                if terminateGroup(pgid, confirmAbsence: true) {
                    removeRegistryEntry(token: entry.token, file: file)
                    reaped += 1
                }
            }
        }
        return reaped
    }

    /// Absolute path of a running pid's executable, or nil if it is gone or
    /// unreadable. Used only as a pid-reuse guard, never to identify work.
    static func executablePath(_ pid: pid_t) -> String? {
        var buf = [CChar](repeating: 0, count: Int(MAXPATHLEN) * 4)
        let n = proc_pidpath(pid, &buf, UInt32(buf.count))
        guard n > 0 else { return nil }
        return String(cString: buf)
    }

    static func processStartTime(_ pid: pid_t) -> UInt64? {
        var info = proc_bsdinfo()
        let size = MemoryLayout<proc_bsdinfo>.size
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(size)) == size else { return nil }
        return UInt64(info.pbi_start_tvsec) * 1_000_000 + UInt64(info.pbi_start_tvusec)
    }

    static func parentPID(_ pid: pid_t) -> pid_t? {
        var info = proc_bsdinfo()
        let size = MemoryLayout<proc_bsdinfo>.size
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(size)) == size else { return nil }
        return pid_t(info.pbi_ppid)
    }

    static func processEnvironment(_ pid: pid_t) -> [String: String]? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var bytes = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &bytes, &size, nil, 0) == 0 else { return nil }
        let intSize = MemoryLayout<Int32>.size
        guard size > intSize else { return nil }
        var index = intSize
        while index < size && bytes[index] != 0 { index += 1 }
        while index < size && bytes[index] == 0 { index += 1 }
        // Skip argc argv strings; the first Int32 is argc.
        let argc = bytes.withUnsafeBytes { $0.load(as: Int32.self) }
        for _ in 0..<argc {
            while index < size && bytes[index] != 0 { index += 1 }
            while index < size && bytes[index] == 0 { index += 1 }
        }
        var result: [String: String] = [:]
        while index < size {
            let start = index
            while index < size && bytes[index] != 0 { index += 1 }
            guard index > start, let item = String(bytes: bytes[start..<index], encoding: .utf8),
                  let equals = item.firstIndex(of: "=") else { index += 1; continue }
            result[String(item[..<equals])] = String(item[item.index(after: equals)...])
            index += 1
        }
        return result
    }

    static func processArguments(_ pid: pid_t) -> [String]? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
        var bytes = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &bytes, &size, nil, 0) == 0 else { return nil }
        let argc = Int(bytes.withUnsafeBytes { $0.load(as: Int32.self) })
        guard argc >= 0 else { return nil }
        var index = MemoryLayout<Int32>.size
        while index < size && bytes[index] != 0 { index += 1 }
        while index < size && bytes[index] == 0 { index += 1 }
        var arguments: [String] = []
        for _ in 0..<argc {
            let start = index
            while index < size && bytes[index] != 0 { index += 1 }
            guard index > start, let argument = String(bytes: bytes[start..<index], encoding: .utf8) else { return nil }
            arguments.append(argument)
            index += 1
        }
        return arguments
    }

    private static func processHasProvenance(_ pid: pid_t, token: String) -> Bool? {
        if let arguments = processArguments(pid), arguments.contains(token) { return true }
        if let environment = processEnvironment(pid) {
            return environment[Registry.provenanceVariable] == token
        }
        return processArguments(pid).map { _ in false }
    }

    private struct RecoveryResult { let entries: [Registry.Entry]; let complete: Bool }

    private static func processGroupContainsProvenance(_ pgid: pid_t, token: String) -> Bool {
        var pids = [pid_t](repeating: 0, count: 4096)
        let bytes = proc_listpids(UInt32(PROC_ALL_PIDS), 0, &pids, Int32(pids.count * MemoryLayout<pid_t>.size))
        guard bytes > 0 else { return false }
        return pids.prefix(Int(bytes) / MemoryLayout<pid_t>.size).contains { pid in
            pid > 1 && getpgid(pid) == pgid && processHasProvenance(pid, token: token) == true
        }
    }

    private static func recoverProcesses(provenance: String, template: Registry.Entry) -> RecoveryResult {
        var pids = [pid_t](repeating: 0, count: 4096)
        let bytes = proc_listpids(UInt32(PROC_ALL_PIDS), 0, &pids, Int32(pids.count * MemoryLayout<pid_t>.size))
        guard bytes > 0 else {
            fputs("menubar: cannot scan child provenance; retaining launch intent for retry\n", stderr)
            return RecoveryResult(entries: [], complete: false)
        }
        var complete = true
        let entries = pids.prefix(Int(bytes) / MemoryLayout<pid_t>.size).compactMap { pid -> Registry.Entry? in
            guard pid > 1 else { return nil }
            var info = proc_bsdinfo()
            let infoSize = MemoryLayout<proc_bsdinfo>.size
            guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(infoSize)) == infoSize,
                  info.pbi_ppid == 1,
                  info.pbi_uid == getuid() else { return nil }
            guard let hasProvenance = processHasProvenance(pid, token: provenance) else {
                complete = false; return nil
            }
            guard hasProvenance,
                  let start = processStartTime(pid), let resolved = executablePath(pid) else { return nil }
            let pgid = getpgid(pid)
            guard pgid == pid else { return nil }
            return Registry.Entry(pid: pid, pgid: pgid, startTime: start,
                                  resolvedExecutable: resolved, argv: template.argv,
                                  commandKind: template.commandKind, token: provenance)
        }
        if !complete {
            fputs("menubar: provenance scan was incomplete; retaining unmatched launch intent for retry\n", stderr)
        }
        return RecoveryResult(entries: entries, complete: complete)
    }

    private static func removeRegistryEntry(token: String, file: String = Registry.path()) {
        do { try Registry.remove(token: token, file: file) }
        catch { fputs("menubar: cannot update child registry; retaining entry for retry: \(error)\n", stderr) }
    }

    // MARK: - Live-child registry

    /// The on-disk record of children this helper currently has in flight.
    ///
    /// Lives beside the single-instance lock in the CLI's runtime state dir
    /// (`getRuntimeStateDir()`, src/lib/state.ts). Version 2 is JSON; the old
    /// `<pid> <path>` line format remains readable for safe migration.
    enum Registry {
        static let provenanceVariable = "AGENTS_MENUBAR_CHILD_TOKEN"

        struct Entry: Codable, Equatable {
            var pid: pid_t?
            var pgid: pid_t?
            var startTime: UInt64?
            var resolvedExecutable: String?
            let argv: [String]
            let commandKind: String
            let token: String
        }

        private struct Document: Codable { let version: Int; var children: [Entry] }

        enum RegistryError: Error { case invalidDocument, lockFailed(String) }

        static func path(home: String = NSHomeDirectory()) -> String {
            "\(home)/.agents/.cache/state/menubar-children"
        }

        private static let queue = DispatchQueue(label: "com.phnx-labs.agents-menubar.children")

        static func begin(argv: [String], commandKind: String, file: String = path()) throws -> Entry {
            guard !argv.isEmpty else { throw RegistryError.invalidDocument }
            let entry = Entry(pid: nil, pgid: nil, startTime: nil, resolvedExecutable: nil,
                              argv: argv, commandKind: commandKind,
                              token: UUID().uuidString)
            try mutate(file: file) { $0.append(entry) }
            return entry
        }

        static func complete(token: String, pid: pid_t, file: String = path()) throws {
            let pgid = getpgid(pid)
            guard pgid > 0, let start = processStartTime(pid), let executable = executablePath(pid) else {
                throw RegistryError.invalidDocument
            }
            try mutate(file: file) { entries in
                guard let index = entries.firstIndex(where: { $0.token == token }) else { throw RegistryError.invalidDocument }
                entries[index].pid = pid
                entries[index].pgid = pgid
                entries[index].startTime = start
                entries[index].resolvedExecutable = executable
            }
        }

        static func remove(token: String, file: String = path()) throws {
            try mutate(file: file) { $0.removeAll { $0.token == token } }
        }

        static func readAll(file: String = path()) throws -> [Entry] {
            try queue.sync { try withLock(file: file) { try read(file) } }
        }

        static func parse(_ text: String) throws -> [Entry] {
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return [] }
            if text.first == "{" {
                guard let object = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                      object["version"] as? Int == 2,
                      let children = object["children"] as? [Any] else {
                    throw RegistryError.invalidDocument
                }
                let decoder = JSONDecoder()
                let entries: [Entry] = children.compactMap { child in
                    guard JSONSerialization.isValidJSONObject(child),
                          let data = try? JSONSerialization.data(withJSONObject: child) else { return nil }
                    return try? decoder.decode(Entry.self, from: data)
                }
                guard children.isEmpty || !entries.isEmpty else { throw RegistryError.invalidDocument }
                return entries
            }
            // Safe migration: old `<pid> <path>` entries remain durable but
            // intentionally lack enough identity to be signalled.
            let entries = text.split(separator: "\n").compactMap { line -> Entry? in
                let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
                guard parts.count == 2, let pid = pid_t(parts[0]), pid > 0 else { return nil }
                return Entry(pid: pid, pgid: pid, startTime: nil, resolvedExecutable: parts[1],
                             argv: [parts[1]], commandKind: "legacy", token: "legacy-\(pid)")
            }
            guard !entries.isEmpty else { throw RegistryError.invalidDocument }
            return entries
        }

        static func serialize(_ entries: [Entry]) throws -> String {
            let data = try JSONEncoder().encode(Document(version: 2, children: entries))
            return String(decoding: data, as: UTF8.self)
        }

        private static func mutate(file: String, _ body: (inout [Entry]) throws -> Void) throws {
            try queue.sync {
                try withLock(file: file) {
                    // A corrupt durable registry must not brick every future
                    // menu refresh. Salvageable entries are retained by parse;
                    // wholly unreadable content is replaced on this write path.
                    var entries = try readForMutation(file)
                    try body(&entries)
                    try write(entries, to: file)
                }
            }
        }

        private static func withLock<T>(file: String, _ body: () throws -> T) throws -> T {
            let dir = (file as NSString).deletingLastPathComponent
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            let fd = open(file + ".lock", O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
            guard fd >= 0 else { throw RegistryError.lockFailed(String(cString: strerror(errno))) }
            defer { flock(fd, LOCK_UN); close(fd) }
            guard flock(fd, LOCK_EX) == 0 else { throw RegistryError.lockFailed(String(cString: strerror(errno))) }
            return try body()
        }

        private static func read(_ file: String) throws -> [Entry] {
            guard FileManager.default.fileExists(atPath: file) else { return [] }
            return try parse(String(contentsOfFile: file, encoding: .utf8))
        }

        private static func readForMutation(_ file: String) throws -> [Entry] {
            guard FileManager.default.fileExists(atPath: file) else { return [] }
            let text = try String(contentsOfFile: file, encoding: .utf8)
            return (try? parse(text)) ?? []
        }

        private static func write(_ entries: [Entry], to file: String) throws {
            try serialize(entries).write(toFile: file, atomically: true, encoding: .utf8)
        }
    }
}

// MARK: - Long-lived streaming child (PHNX-4002)

extension ChildProcess {
    /// A handle to a long-lived streaming child (e.g. `agents feed watch --json`).
    /// `stop()` group-kills the child; the reader thread performs the single
    /// reap + registry cleanup on EOF, whether the child exited on its own or was
    /// killed. If the helper dies without calling `stop()`, the NEXT launch reaps
    /// it via `reapOrphansFromPreviousLaunch` exactly like a bounded `run` child.
    final class StreamHandle {
        private let pid: pid_t
        private let stateLock = NSLock()
        private var finished = false

        fileprivate init(pid: pid_t) { self.pid = pid }

        /// Idempotent. Signals the whole process group; the group's write ends
        /// close as those processes die, which forces the reader to EOF and run
        /// the reap. Never reaps here — the reader is the single owner of that.
        func stop() {
            stateLock.lock()
            let alreadyDone = finished
            stateLock.unlock()
            if alreadyDone { return }
            ChildProcess.terminateGroup(pid)
        }

        /// Called by the reader once, on EOF, to claim ownership of the reap.
        fileprivate func markFinished() -> Bool {
            stateLock.lock(); defer { stateLock.unlock() }
            if finished { return false }
            finished = true
            return true
        }
    }

    /// Spawn `argv` as a long-lived child and deliver each stdout LINE to `onLine`
    /// as it arrives, running until the child exits or `StreamHandle.stop()` is
    /// called; `onExit` fires exactly once when the child is gone. Returns nil if
    /// the child could not be started.
    ///
    /// This shares the SAME durable registry + provenance token + process-group
    /// kill + next-launch reaping as `run` (see the file docblock) — the streaming
    /// case is exactly the one launchd KeepAlive would orphan on a helper crash,
    /// so it MUST be tracked identically. Unlike `run`, it does not drain to EOF
    /// and return; it streams line-by-line, so a caller never buffers an unbounded
    /// stream in memory. `onLine`/`onExit` run on a private utility queue — the
    /// caller hops to its own queue.
    static func stream(_ argv: [String],
                       onLine: @escaping (String) -> Void,
                       onExit: @escaping () -> Void,
                       registryFile: String = Registry.path()) -> StreamHandle? {
        guard !argv.isEmpty else { return nil }

        let commandKind = argv.dropFirst().prefix(2).joined(separator: " ")
        let launch: Registry.Entry
        do {
            launch = try Registry.begin(argv: argv, commandKind: commandKind, file: registryFile)
        } catch {
            fputs("menubar: cannot persist stream launch intent: \(error)\n", stderr)
            return nil
        }

        var fds: [Int32] = [-1, -1]
        guard pipe(&fds) == 0 else {
            removeRegistryEntry(token: launch.token, file: registryFile)
            return nil
        }
        let readFD = fds[0]
        let writeFD = fds[1]

        guard let pid = spawn(argv, stdout: writeFD, closeInChild: readFD, provenance: launch.token) else {
            close(readFD); close(writeFD)
            removeRegistryEntry(token: launch.token, file: registryFile)
            return nil
        }
        // The parent MUST drop its write end, or the read below never sees EOF.
        close(writeFD)

        do {
            try Registry.complete(token: launch.token, pid: pid, file: registryFile)
        } catch {
            _ = terminateGroup(pid)
            close(readFD)
            var status: Int32 = 0
            while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
            removeRegistryEntry(token: launch.token, file: registryFile)
            return nil
        }

        let handle = StreamHandle(pid: pid)
        DispatchQueue.global(qos: .utility).async {
            var pending = [UInt8]()
            var chunk = [UInt8](repeating: 0, count: 64 * 1024)
            func flush() {
                var start = 0
                var index = 0
                while index < pending.count {
                    if pending[index] == 0x0A {
                        if index > start, let line = String(bytes: pending[start..<index], encoding: .utf8) {
                            onLine(line)
                        }
                        start = index + 1
                    }
                    index += 1
                }
                if start > 0 { pending.removeFirst(start) }
            }
            while true {
                let n = chunk.withUnsafeMutableBytes { read(readFD, $0.baseAddress, $0.count) }
                if n > 0 {
                    pending.append(contentsOf: chunk[0..<n])
                    flush()
                } else if n == 0 {
                    break
                } else if errno == EINTR {
                    continue
                } else {
                    break
                }
            }
            close(readFD)
            // The reader OWNS the reap: whether the child EOF'd on its own or
            // stop() killed it, exactly one waitpid + registry removal happens.
            _ = handle.markFinished()
            var status: Int32 = 0
            while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
            removeRegistryEntry(token: launch.token, file: registryFile)
            onExit()
        }
        return handle
    }
}
