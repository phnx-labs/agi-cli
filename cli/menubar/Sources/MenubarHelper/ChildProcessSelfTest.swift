import Darwin
import Foundation

// Self-test for bounded, group-killable child processes. Follows the repo's
// env-gated self-test idiom (see GuardsSelfTest.swift / SingleInstanceSelfTest.swift):
// no XCTest target exists for the menu-bar helper.
//
//   MENUBAR_CHILD_TEST=1 "AGI Menu"
//
// These spawn REAL processes — no mocking, per the repo convention. Each case is
// one of the properties whose absence produced the runaway: an unbounded call, a
// subtree that survived its parent's death, and a stale registry entry that must
// not be allowed to kill an unrelated pid.
enum ChildProcessSelfTest {
    private static var failures = 0

    static func run() -> Never {
        print("menubar child-process self-test")
        testCapturesStdout()
        testNonZeroExitIsFailure()
        testTimeoutKillsAndReportsFailure()
        testTimeoutKillsTheWholeProcessGroup()
        testRegistryTracksInFlightChildren()
        testRegistryRoundTrip()
        testRegistryReadFailureIsNotAnEmptyRegistry()
        testRegistryWriteSelfHealsCorruption()
        testRegistryWriteFailureIsReported()
        testReapRetainsEntryAfterFailedValidation()
        testReapRecoversChildSpawnedBeforeRegistrationCompletes()
        testReapKillsARealOrphanFromAPreviousLaunch()
        testChildDoesNotInheritSingleInstanceFlock()
        if failures == 0 {
            print("\nALL PASS")
            exit(0)
        }
        print("\n\(failures) FAILED")
        exit(1)
    }

    // MARK: Baseline — the behavior every caller already depended on.

    private static func testCapturesStdout() {
        let out = ChildProcess.run(["/bin/echo", "hello"], timeout: 10)
        check(out.flatMap { String(data: $0, encoding: .utf8) } == "hello\n",
              "stdout is captured verbatim")
    }

    private static func testNonZeroExitIsFailure() {
        check(ChildProcess.run(["/usr/bin/false"], timeout: 10) == nil,
              "non-zero exit -> nil (callers must not parse a failed run)")
    }

    // MARK: The bug — an unbounded call never returns.

    // `agents doctor --json` went from ~2s to over 12 minutes on a loaded box and
    // the old capture() simply waited, holding a core the whole time.
    private static func testTimeoutKillsAndReportsFailure() {
        let started = Date()
        let out = ChildProcess.run(["/bin/sleep", "30"], timeout: 1)
        let elapsed = Date().timeIntervalSince(started)
        check(out == nil, "timed-out call -> nil")
        check(elapsed < 10, "timed-out call returns promptly (took \(String(format: "%.1f", elapsed))s, child asked for 30s)")
    }

    // The 92 orphaned `node -e` probes: the doctor forked them, and signalling
    // only the doctor's pid left every one of them running. The child must be its
    // own process-group leader so kill(-pgid) takes the subtree.
    private static func testTimeoutKillsTheWholeProcessGroup() {
        // Parent spawns a grandchild that outlives it, then sleeps. Killing only
        // the parent pid leaves the grandchild; killing the group takes both.
        //
        // The survivor check is scoped to THIS child's process group, never to a
        // generic command string: a global `sleep 45` match counted any unrelated
        // process on the box (a sibling agent's poll loop made it fail
        // deterministically while group-kill worked). The child's pgid is not
        // returned by `run`, so it is observed live from the process table while
        // the child is still running, located by the unguessable marker the
        // script carries in its argv.
        let marker = "\(NSTemporaryDirectory())menubar-childtest-\(getpid())-\(UUID().uuidString)"
        let script = "/bin/sh -c 'sleep 45 && touch \(marker)' & sleep 45"

        let finished = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .utility).async {
            _ = ChildProcess.run(["/bin/sh", "-c", script], timeout: 3)
            finished.signal()
        }
        var pgid: pid_t?
        for _ in 0..<40 where pgid == nil {
            pgid = processTable().first { $0.command.contains(marker) }?.pgid
            if pgid == nil { usleep(50_000) }
        }
        finished.wait()

        guard let group = pgid else {
            check(false, "observed the child's process group while it ran"); return
        }
        // Give the kill a beat to propagate, then assert nothing from that group
        // is still alive: the grandchild's own `sleep 45` must be gone.
        usleep(1_500_000)
        let survivors = processTable().filter { $0.pgid == group }
        check(survivors.isEmpty,
              "timeout kills the whole process group (pgid \(group): \(survivors.count) survivor(s)\(survivors.isEmpty ? "" : " — " + survivors.map(\.command).joined(separator: "; ")))")
        try? FileManager.default.removeItem(atPath: marker)
    }

    // MARK: The registry — what makes cross-launch reaping possible at all.

    private static func testRegistryTracksInFlightChildren() {
        let file = "\(NSTemporaryDirectory())menubar-children-test-\(getpid())"
        try? FileManager.default.removeItem(atPath: file)
        let first = try? ChildProcess.Registry.begin(argv: ["/bin/echo"], commandKind: "test", file: file)
        let second = try? ChildProcess.Registry.begin(argv: ["/bin/sleep"], commandKind: "test", file: file)
        check((try? ChildProcess.Registry.readAll(file: file).count) == 2, "two pre-spawn launch intents recorded")
        if let first { try? ChildProcess.Registry.remove(token: first.token, file: file) }
        let left = try? ChildProcess.Registry.readAll(file: file)
        check(left == (second.map { [$0] } ?? []),
              "a completed child is removed, the other is untouched")
        try? FileManager.default.removeItem(atPath: file)
    }

    // Paths can contain spaces, so the split must be bounded to the first one.
    private static func testRegistryRoundTrip() {
        let entries = [
            ChildProcess.Registry.Entry(pid: 11, pgid: 11, startTime: 123, resolvedExecutable: "/opt/homebrew/bin/node", argv: ["/opt/homebrew/bin/agents", "doctor", "--json"], commandKind: "doctor --json", token: "one"),
            ChildProcess.Registry.Entry(pid: 12, pgid: 12, startTime: 456, resolvedExecutable: "/usr/bin/env", argv: ["/Users/x/Application Support/a b/agents", "sessions"], commandKind: "sessions --active", token: "two"),
        ]
        let parsed = try? ChildProcess.Registry.parse(ChildProcess.Registry.serialize(entries))
        check(parsed == entries, "registry round-trips pids and paths containing spaces")
        check((try? ChildProcess.Registry.parse("garbage\n0 /bin/x\n-1 /bin/y")) == nil,
              "a malformed legacy registry fails loud instead of becoming empty")
        let legacy = try? ChildProcess.Registry.parse("garbage\n42 /opt/old agents")
        check(legacy?.first?.pid == 42 && legacy?.first?.startTime == nil,
              "valid legacy records survive malformed neighboring lines")
        let mixedJSON = """
        {"version":2,"children":[{"pid":11,"pgid":11,"startTime":123,"resolvedExecutable":"/bin/echo","argv":["/bin/echo"],"commandKind":"test","token":"valid"},{"pid":"broken"}]}
        """
        check((try? ChildProcess.Registry.parse(mixedJSON))?.map(\.token) == ["valid"],
              "valid JSON entries survive a malformed neighboring entry")
    }

    private static func testRegistryReadFailureIsNotAnEmptyRegistry() {
        let file = "\(NSTemporaryDirectory())menubar-children-unreadable-\(getpid())"
        try? "not-json".write(toFile: file, atomically: true, encoding: .utf8)
        let before = try? Data(contentsOf: URL(fileURLWithPath: file))
        check(ChildProcess.reapOrphansFromPreviousLaunch(file: file) == 0,
              "an unreadable registry fails the reap without claiming children")
        check((try? Data(contentsOf: URL(fileURLWithPath: file))) == before,
              "a registry read failure leaves the durable file untouched")
        try? FileManager.default.removeItem(atPath: file)
        try? FileManager.default.removeItem(atPath: file + ".lock")
    }

    private static func testRegistryWriteSelfHealsCorruption() {
        let file = "\(NSTemporaryDirectory())menubar-children-corrupt-\(getpid())"
        try? "not-json".write(toFile: file, atomically: true, encoding: .utf8)
        let out = ChildProcess.run(["/bin/echo", "healed"], timeout: 10, registryFile: file)
        check(out.flatMap { String(data: $0, encoding: .utf8) } == "healed\n",
              "a real child spawn succeeds when the registry starts corrupt")
        check((try? ChildProcess.Registry.readAll(file: file)) == [],
              "the successful child write rewrites corruption as a clean registry")
        try? FileManager.default.removeItem(atPath: file)
        try? FileManager.default.removeItem(atPath: file + ".lock")
    }

    private static func testRegistryWriteFailureIsReported() {
        let dir = "\(NSTemporaryDirectory())menubar-children-readonly-\(getpid())"
        let file = dir + "/children"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        chmod(dir, 0o500)
        let result = try? ChildProcess.Registry.begin(argv: ["/bin/sleep"], commandKind: "write-failure", file: file)
        check(result == nil, "a registry write failure is reported to the caller")
        chmod(dir, 0o700)
        try? FileManager.default.removeItem(atPath: dir)
    }

    // Pid reuse: by the next launch the recorded pid may belong to something else
    // entirely. Reaping on pid alone would kill an innocent process, so the
    // executable path must still match.
    private static func testReapRetainsEntryAfterFailedValidation() {
        let file = "\(NSTemporaryDirectory())menubar-children-reuse-\(getpid())"
        try? FileManager.default.removeItem(atPath: file)
        guard let launch = try? ChildProcess.Registry.begin(argv: ["/bin/sleep", "300"], commandKind: "test", file: file),
              let child = spawnDetachedGroupLeader(provenance: "different-token") else {
            check(false, "could not arrange failed-validation child"); return
        }
        try? ChildProcess.Registry.complete(token: launch.token, pid: child, file: file)
        check(ChildProcess.reapOrphansFromPreviousLaunch(file: file) == 0,
              "a live child with failed provenance validation is not signalled")
        check((try? ChildProcess.Registry.readAll(file: file).contains { $0.token == launch.token }) == true,
              "one failed validation retains its registry entry for the next pass")
        kill(-child, SIGKILL)
        var status: Int32 = 0
        while waitpid(child, &status, 0) == -1 && errno == EINTR {}
        try? ChildProcess.Registry.remove(token: launch.token, file: file)

        // Production builds may name the binary "AGI Menu-universal" (lipo of
        // arm64+x86_64). Match the last path component's prefix, not a hard
        // suffix of the executable name alone — that failed every home-base
        // publish of 1.22.2 with got …/MenubarHelper-universal (RUSH-3101 renamed
        // the bundled executable; the same lipo-suffix caveat still applies).
        let exe = ChildProcess.executablePath(getpid()) ?? ""
        let base = (exe as NSString).lastPathComponent
        check(base.hasPrefix(HelperIdentity.executableName),
              "executablePath resolves a live pid (got \(exe.isEmpty ? "nil" : exe))")
        try? FileManager.default.removeItem(atPath: file)
    }

    // The helper can die after posix_spawn returns but before the pid identity is
    // written. The durable pre-spawn token must find that now-PPID-1 child and
    // reap it even though the registry still contains only launch intent.
    private static func testReapRecoversChildSpawnedBeforeRegistrationCompletes() {
        let file = "\(NSTemporaryDirectory())menubar-children-mid-crash-\(getpid())"
        let pidFile = file + ".pid"
        try? FileManager.default.removeItem(atPath: file)
        try? FileManager.default.removeItem(atPath: pidFile)
        guard let launch = try? ChildProcess.Registry.begin(argv: ["/bin/sleep", "300"], commandKind: "crash-window", file: file),
              let orphan = spawnOrphanedGroupLeader(provenance: launch.token, pidFile: pidFile) else {
            check(false, "could not spawn crash-window orphan"); return
        }
        check(kill(orphan, 0) == 0, "child spawned in the crash window survives at PPID 1")
        check(ChildProcess.parentPID(orphan) == 1,
              "crash-window child is adopted by launchd (ppid \(ChildProcess.parentPID(orphan) ?? -1))")
        check(ChildProcess.processArguments(orphan)?.contains(launch.token) == true,
              "crash-window child exposes its inherited provenance marker")
        let reaped = ChildProcess.reapOrphansFromPreviousLaunch(file: file)
        check(reaped == 1, "pre-spawn provenance recovers and reaps the unregistered child")
        check((try? ChildProcess.Registry.readAll(file: file).isEmpty) == true,
              "recovered launch intent is removed only after group absence")
        try? FileManager.default.removeItem(atPath: file)
        try? FileManager.default.removeItem(atPath: pidFile)
    }

    // The whole point of the on-disk registry: a helper killed by SIGSEGV or
    // SIGKILL runs none of its own cleanup, so the NEXT launch has to do it.
    // This is the end-to-end version — a real surviving process, killed by a real
    // call to the real reaper, driven off a real registry file.
    private static func testReapKillsARealOrphanFromAPreviousLaunch() {
        let file = "\(NSTemporaryDirectory())menubar-children-reap-\(getpid())"
        try? FileManager.default.removeItem(atPath: file)

        // Stand in for the abandoned child: a process that is its own
        // process-group leader (as ChildProcess.spawn makes every child), so the
        // reaper's kill(-pgid) has a group to take.
        let pidFile = file + ".pid"
        guard let launch = try? ChildProcess.Registry.begin(argv: ["/bin/sleep", "300"], commandKind: "orphan-test", file: file),
              let orphan = spawnOrphanedGroupLeader(provenance: launch.token, pidFile: pidFile) else {
            check(false, "could not spawn a stand-in orphan")
            return
        }
        try? ChildProcess.Registry.complete(token: launch.token, pid: orphan, file: file)
        check(kill(orphan, 0) == 0, "stand-in orphan (pid \(orphan)) is alive before the reap")

        let reaped = ChildProcess.reapOrphansFromPreviousLaunch(file: file)
        check(reaped == 1, "reaper reports exactly 1 group reaped (got \(reaped))")

        // Poll rather than sleep a fixed amount: SIGTERM then SIGKILL is not
        // instantaneous, but it must be bounded.
        var alive = true
        for _ in 0..<40 where alive {
            usleep(100_000)
            alive = kill(orphan, 0) == 0
        }
        check(!alive, "the orphan is dead after the reap")
        check((try? ChildProcess.Registry.readAll(file: file).isEmpty) == true,
              "the confirmed-dead entry is removed without clearing unrelated records")
        try? FileManager.default.removeItem(atPath: file)
        try? FileManager.default.removeItem(atPath: pidFile)
    }

    // The flock-inheritance leak that bricked the single-instance guard: a child
    // spawned while the helper holds the menubar.lock flock must NOT inherit that
    // fd. If it does, an orphaned child (helper crashed) keeps the open-file-
    // description — and its flock — alive at PPID 1, and every later launch
    // deadlocks as "already running". Guarded at the source by O_CLOEXEC on the
    // lock open (SingleInstance.acquire) — the fd is close-on-exec, so no exec'd
    // child inherits it. Real flock, real child via raw posix_spawn (the leak
    // vehicle Foundation.Process can't reproduce) — no mock.
    private static func testChildDoesNotInheritSingleInstanceFlock() {
        let path = "\(NSTemporaryDirectory())menubar-flock-inherit-\(getpid()).lock"
        try? FileManager.default.removeItem(atPath: path)
        defer { try? FileManager.default.removeItem(atPath: path) }

        // Take the lock exactly as SingleInstance.acquire does — WITH O_CLOEXEC.
        let held = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0o644)
        guard held >= 0, flock(held, LOCK_EX | LOCK_NB) == 0 else {
            check(false, "parent could not take the lock (fd \(held))"); return
        }
        // Direct invariant: the lock fd is close-on-exec, so no exec'd child keeps it.
        check((fcntl(held, F_GETFD) & FD_CLOEXEC) != 0,
              "lock fd is O_CLOEXEC (close-on-exec)")

        // End-to-end: a child spawned via a RAW posix_spawn with NO
        // CLOEXEC_DEFAULT and no file actions — the exact pre-#1841 spawn shape —
        // inherits every fd that is not itself close-on-exec. If the lock fd were
        // not O_CLOEXEC it would ride into /bin/sleep and keep the open-file-
        // description (and its flock) alive after the parent drops its own. This is
        // the real leak vehicle: Foundation.Process closes inherited fds itself and
        // so cannot reproduce the bug, which is why this uses posix_spawn directly.
        var childPid: pid_t = 0
        var argv: [UnsafeMutablePointer<CChar>?] = (["/bin/sleep", "300"] as [String]).map { strdup($0) } + [nil]
        defer { for a in argv where a != nil { free(a) } }
        let rc = posix_spawn(&childPid, "/bin/sleep", nil, nil, &argv, environ)
        guard rc == 0 else {
            check(false, "could not posix_spawn a stand-in child (rc \(rc))"); close(held); return
        }

        // Parent drops its reference. If the child never inherited the fd, this
        // closes the last reference to the open-file-description and frees the lock.
        close(held)

        // A fresh open+flock MUST succeed — proof no child kept the lock alive.
        let probe = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0o644)
        let free = probe >= 0 && flock(probe, LOCK_EX | LOCK_NB) == 0
        if probe >= 0 { close(probe) }
        kill(childPid, SIGKILL)
        var st: Int32 = 0
        while waitpid(childPid, &st, 0) == -1 && errno == EINTR {}
        check(free, "flock is free after the holder drops its fd (child never inherited it)")
    }

    /// `sleep 300` in its own process group, reparented away from this process.
    /// macOS ships no `setsid(1)`, so python does the `setpgrp` + `exec`.
    private static func spawnDetachedGroupLeader(provenance: String) -> pid_t? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        p.arguments = ["-c", "import os,sys; os.setpgrp(); os.execv('/bin/sleep', [sys.argv[1], '300'])", provenance]
        p.environment = ProcessInfo.processInfo.environment.merging([ChildProcess.Registry.provenanceVariable: provenance]) { _, new in new }
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        // Wait for the exec to land so proc_pidpath reports /bin/sleep, not python.
        let pid = p.processIdentifier
        for _ in 0..<50 {
            usleep(100_000)
            if ChildProcess.executablePath(pid) == "/bin/sleep" { return pid }
        }
        return nil
    }

    private static func spawnOrphanedGroupLeader(provenance: String, pidFile: String) -> pid_t? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        p.arguments = ["-c", "import os,sys; p=os.fork(); (open(r'\(pidFile)', 'w').write(str(p)), os._exit(0)) if p else (os.setpgrp(), os.execve('/bin/sleep', [sys.argv[1],'300'], os.environ))", provenance]
        p.environment = ProcessInfo.processInfo.environment.merging([ChildProcess.Registry.provenanceVariable: provenance]) { _, new in new }
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        p.waitUntilExit()
        for _ in 0..<50 {
            if let text = try? String(contentsOfFile: pidFile, encoding: .utf8), let pid = pid_t(text),
               ChildProcess.executablePath(pid) == "/bin/sleep" { return pid }
            usleep(100_000)
        }
        return nil
    }

    // MARK: helpers

    private struct TableRow { let pid: pid_t; let pgid: pid_t; let command: String }

    /// The live process table as (pid, pgid, command) rows, excluding the `ps`
    /// itself. Real `ps`, no mock — the point is to observe real survivors, and
    /// the pgid column is what lets a check stay scoped to one spawned subtree.
    private static func processTable() -> [TableRow] {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/ps")
        p.arguments = ["-Ao", "pid=,pgid=,command="]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return [] }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let text = String(data: data, encoding: .utf8) ?? ""
        return text.split(separator: "\n").compactMap { line in
            let parts = line.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
            guard parts.count == 3, let pid = pid_t(parts[0]), let pgid = pid_t(parts[1]),
                  pid != p.processIdentifier else { return nil }
            return TableRow(pid: pid, pgid: pgid, command: String(parts[2]))
        }
    }

    private static func check(_ condition: Bool, _ label: String) {
        if condition {
            print("  PASS  \(label)")
        } else {
            failures += 1
            print("  FAIL  \(label)")
        }
    }
}
