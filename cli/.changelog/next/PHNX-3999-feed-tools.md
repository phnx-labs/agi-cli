- **Browser tasks and computer runs ride the feed stream, and N readers now cost one
  connection per peer (PHNX-3999).** `agents feed watch --json` carries a third row
  kind alongside agents and attention: canonical tool rows for each browser task and
  computer run, with the driven device, the owning agent session, captures, and — for
  a still-bound browser task only — the command that closes it. A consumer switching
  an All/Agents/Browser/Computer filter now spawns zero commands, where it previously
  shelled out to `browser sessions` and `computer sessions` per tool, per device, on a
  timer. Computer runs are ledger history: they report `live: false` and carry no
  stop/close affordance, because the process that performed them has exited. Task URLs
  are redacted (userinfo stripped, credential-shaped query parameters replaced) before
  they leave the producing machine. Source: `cli/src/lib/feed/tools.ts`,
  `cli/src/lib/feed/tool-activity.ts`.
- **One shared fleet feed collector, owned by the daemon (PHNX-3999).** `watchFleetFeed`
  opened a persistent `ssh <peer> agents feed watch --json --local` per dialable
  device *per caller*, so three readers on a thirteen-device fleet held thirty-nine
  ssh children carrying byte-identical NDJSON. The new `feed-stream` daemon service
  runs exactly one fan-out and serves every reader over a socket; a late reader is
  brought up to date from held per-scope state with no re-dial, and the fan-out is
  demand-gated so a box with no reader open holds no peer connections at all.
  `agents feed watch --json --local` is unchanged — it is the per-machine stream the
  collector itself subscribes to. Source: `cli/src/lib/feed/hub.ts`,
  `cli/src/lib/daemon/feed-stream-service.ts`.
- **A long-offline peer is retired instead of dialed forever (PHNX-3999).** The 60 s
  backoff cap bounded the delay but not the total work: a box off for a weekend was
  dialed every 60 s for two days. After ten consecutive failures the re-dial drops to
  15 minutes, still waking immediately on a device-registry change. Source:
  `cli/src/lib/session/remote/peer-stream.ts`.

- **Setup from the menu uses a real terminal.** `agents setup browser|computer|secrets --terminal` hands interactive onboarding to the existing terminal engine and reports launch errors. Installation and readiness remain separate; only explicit checks run health probes, and concurrent checks share one probe.
