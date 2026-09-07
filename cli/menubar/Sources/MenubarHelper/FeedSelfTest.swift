import Foundation

// Headless self-tests + a live smoke runner for the feed data layer (PHNX-4002).
//
//   MENUBAR_FEED_TEST=1   — pure: replay a fixture NDJSON through FeedState and
//                           assert row counts, attention keys, reset-on-gap /
//                           new-streamId, the backoff schedule, and the breaker.
//                           No process, no network. A build gate (test-menubar.sh).
//   MENUBAR_FEED_SMOKE=1   — live: run FeedStream against this machine for N
//                           seconds and print row/attention counts + health. NOT a
//                           build gate — it spawns the real `feed watch` child and
//                           needs the fleet, like MENUBAR_DUMP.

enum FeedSelfTest {
    static func run() -> Never {
        var pass = true
        func check(_ name: String, _ condition: Bool) {
            print("\(condition ? "PASS" : "FAIL") — \(name)")
            if !condition { pass = false }
        }

        // MARK: fixture replay — row counts + attention keys across devices.
        let fixture = ProcessInfo.processInfo.environment["MENUBAR_FEED_FIXTURE"]
            ?? "Tests/fixtures/feed-sample.ndjson"
        guard let text = try? String(contentsOfFile: fixture, encoding: .utf8) else {
            print("FAIL — feed fixture not readable at \(fixture)")
            exit(1)
        }
        var state = FeedState()
        var decoded = 0
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let env = FeedEnvelope.decode(String(line)) else { continue }
            decoded += 1
            _ = state.apply(env, now: Date())
        }
        check("every fixture line decoded", decoded == 10)
        check("two device resets were folded", state.resetCount == 2)
        check("rows union across devices, minus the removed one",
              Set(state.rows.keys) == ["rk-zB", "rk-zC", "rk-yA"])
        check("the removed row is gone", state.rows["rk-zA"] == nil)
        check("row carries the decoded harness + phase",
              state.rows["rk-zC"]?.kind == "grok" && state.rows["rk-zC"]?.phase == "running")
        check("attention is keyed by sessionId", Set(state.attention.keys) == ["s-bbbbbbbb"])
        check("the answered attention was removed", state.attention["s-cccccccc"] == nil)
        check("attention decodes kind + reply rail",
              state.attention["s-bbbbbbbb"]?.kind == "permission"
                && state.attention["s-bbbbbbbb"]?.replyCapability == "tmux")
        check("attention choices decode id + deliveryKey",
              state.attention["s-bbbbbbbb"]?.choices?.first?.id == "0"
                && state.attention["s-bbbbbbbb"]?.choices?.first?.deliveryKey == "a")
        check("two devices are tracked in the heartbeat map",
              Set(state.deviceHeartbeat.keys) == ["host-a", "host-b"])
        // s-aaaaaaaa got an activity line (seq7) then its row was removed (seq8);
        // the pruning fix means no leaked activity entry survives the removal.
        check("activity for a removed session is pruned (no leak)",
              state.latestActivity["s-aaaaaaaa"] == nil && state.latestActivity.isEmpty)

        // MARK: activity is retained while the row lives, then pruned on removal.
        var churn = FeedState()
        _ = churn.apply(env(#"{"type":"reset","streamId":"c","sequence":1,"scope":"z","agents":[{"rowKey":"ck1","sessionId":"cs1"}],"attention":[]}"#))
        _ = churn.apply(env(#"{"type":"activity.append","streamId":"c","sequence":2,"scope":"z","event":{"sessionId":"cs1","event":"pr.opened"}}"#))
        check("activity is retained while the row lives", churn.latestActivity["cs1"]?.event == "pr.opened")
        _ = churn.apply(env(#"{"type":"agent.remove","streamId":"c","sequence":3,"scope":"z","rowKey":"ck1"}"#))
        check("activity is pruned when the row is removed", churn.latestActivity["cs1"] == nil)

        // MARK: reset-on-gap — a sequence gap drops rows and waits for the next reset.
        var gap = FeedState()
        _ = gap.apply(env("""
        {"type":"reset","streamId":"g","sequence":1,"scope":"z","agents":[{"rowKey":"rk1","sessionId":"s1"}],"attention":[]}
        """))
        _ = gap.apply(env(#"{"type":"agent.upsert","streamId":"g","sequence":2,"scope":"z","rowKey":"rk2","agent":{"rowKey":"rk2","sessionId":"s2"}}"#))
        check("rows accumulate before the gap", gap.rows.count == 2)
        _ = gap.apply(env(#"{"type":"agent.upsert","streamId":"g","sequence":5,"scope":"z","rowKey":"rk3","agent":{"rowKey":"rk3","sessionId":"s3"}}"#))
        check("a sequence gap clears rows and awaits a reset", gap.rows.isEmpty && gap.awaitingReset)
        _ = gap.apply(env(#"{"type":"agent.upsert","streamId":"g","sequence":6,"scope":"z","rowKey":"rk4","agent":{"rowKey":"rk4","sessionId":"s4"}}"#))
        check("upserts are ignored until the reset arrives", gap.rows.isEmpty)
        _ = gap.apply(env("""
        {"type":"reset","streamId":"g","sequence":7,"scope":"z","agents":[{"rowKey":"rk9","sessionId":"s9"}],"attention":[]}
        """))
        check("the next reset rebuilds from scratch", Set(gap.rows.keys) == ["rk9"] && !gap.awaitingReset)

        // MARK: new-streamId (a respawned coordinator) is a full reset.
        var restream = FeedState()
        _ = restream.apply(env(#"{"type":"reset","streamId":"A","sequence":1,"scope":"z","agents":[{"rowKey":"old","sessionId":"s0"}],"attention":[]}"#))
        _ = restream.apply(env(#"{"type":"reset","streamId":"B","sequence":1,"scope":"z","agents":[{"rowKey":"newX","sessionId":"sx"},{"rowKey":"newY","sessionId":"sy"}],"attention":[]}"#))
        check("a new streamId drops the old rows and adopts the new stream",
              Set(restream.rows.keys) == ["newX", "newY"] && restream.streamId == "B")

        // MARK: malformed lines are skipped, never fatal.
        check("a malformed line decodes to nil", FeedEnvelope.decode("{not json") == nil)
        check("an unknown type decodes to nil",
              FeedEnvelope.decode(#"{"type":"mystery","streamId":"x","sequence":1,"scope":"z"}"#) == nil)

        // MARK: backoff schedule — 1s doubling to a 30s cap.
        let policy = RespawnPolicy()
        let schedule = (1...7).map { policy.delay(forAttempt: $0) }
        check("backoff is 1,2,4,8,16,30,30", schedule == [1, 2, 4, 8, 16, 30, 30])

        // MARK: circuit breaker — trips at 10 consecutive failures, resets on health.
        var breaker = RespawnPolicy()
        for _ in 0..<9 { breaker.recordFailure() }
        check("breaker holds below the threshold", !breaker.isTripped)
        breaker.recordFailure()
        check("breaker trips at ten consecutive failures", breaker.isTripped)
        breaker.recordHealthy()
        check("a healthy connection clears the breaker", !breaker.isTripped)

        // MARK: argv — the child is `feed watch --json`, never --local.
        let argv = FeedStream.feedWatchArgv()
        check("argv ends in feed watch --json", argv.suffix(3) == ["feed", "watch", "--json"])
        check("argv never passes --local", !argv.contains("--local"))

        print(pass ? "ALL PASS" : "SOME FAILED")
        exit(pass ? 0 : 1)
    }

    /// Decode a crafted line or abort the test loudly — the crafted JSON is part
    /// of the test, so a decode miss is a test bug, not a soft skip.
    private static func env(_ line: String) -> FeedEnvelope {
        guard let e = FeedEnvelope.decode(line) else {
            print("FAIL — test could not decode crafted line: \(line)")
            exit(1)
        }
        return e
    }
}

// MARK: - Live smoke

enum FeedSmoke {
    static func run() -> Never {
        let seconds = TimeInterval(ProcessInfo.processInfo.environment["MENUBAR_FEED_SMOKE_SECONDS"].flatMap { Double($0) } ?? 60)
        FileHandle.standardError.write("feed smoke: starting FeedStream for \(Int(seconds))s\n".data(using: .utf8)!)
        FeedStream.shared.start()

        let deadline = Date().addingTimeInterval(seconds)
        var lastReport = Date()
        while Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(1))
            if Date().timeIntervalSince(lastReport) >= 10 {
                lastReport = Date()
                report(prefix: "  tick")
            }
        }
        report(prefix: "final")

        FeedStream.shared.stop()
        // Let stop() group-kill the child before we exit.
        RunLoop.main.run(until: Date().addingTimeInterval(2))
        exit(0)
    }

    private static func report(prefix: String) {
        let rows = FeedStream.shared.rows
        let attention = FeedStream.shared.attention
        let devices = FeedStream.shared.deviceHeartbeat.keys.sorted()
        let health = FeedStream.shared.health
        let msg = "\(prefix): rows=\(rows.count) attention=\(attention.count) devices=\(devices.count) [\(devices.joined(separator: ","))] health=\(health)\n"
        FileHandle.standardError.write(msg.data(using: .utf8)!)
    }
}
