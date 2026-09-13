- **Browser tasks and computer runs ride the feed stream, and N readers now cost one
  connection per peer (PHNX-3999).** `agents feed watch --json` carries a third row
  kind alongside agents and attention: canonical tool rows for each browser task and
  computer run, with the driven device, the owning agent session, captures, and — for
  a still-bound browser task only — the commands that show a tab or close the task.
  Switching an All/Agents/Browser/Computer filter launches no commands: every row for
  every tab is already on the one stream. Computer runs are ledger history: they report `live: false` and carry no
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
- **The standalone browser and computer engines are read at their real source
  (PHNX-3999).** The standalone `computer` engine always appends to its own
  `<cache>/computer/actions/<day>.jsonl`, which never reaches agents-cli's
  recorder — so a `computer` command run directly was invisible to every
  agents-cli surface. `agents computer sessions` and the feed now merge that
  ledger, deduped on `invocationId` (forwarding rewrites `ts`/`pid`, so a
  timestamp dedupe double-counts), and attribute a record the producer left
  unidentified to the machine whose ledger it came from instead of `unknown`.
  Live browser tasks are read from `tasks.json`, so a task that has produced no
  capture yet now appears — with its real tabs, and a `show`/`close` command that
  names the host to run it on. Source: `cli/src/lib/computer/sessions-list.ts`,
  `cli/src/lib/feed/tool-activity.ts`.
- **Tool setup readiness rides the feed (PHNX-3999).** `reset.setup` and
  `setup.snapshot` carry each device's browser/computer/secrets readiness from the
  setup cache, so a Settings surface needs no per-tool polling and no probe of its
  own. Source: `cli/src/lib/feed/watch.ts`.
- **A long-offline peer is retired instead of dialed forever (PHNX-3999).** The 60 s
  backoff cap bounded the delay but not the total work: a box off for a weekend was
  dialed every 60 s for two days. After ten consecutive failures the re-dial drops to
  15 minutes, still waking immediately on a device-registry change. Source:
  `cli/src/lib/session/remote/peer-stream.ts`.
- **`agents ssh --argv` delivers exact argv tokens (PHNX-3999).** The remote command
  was assembled by joining tokens with a space, so any token containing a space or a
  shell metacharacter was destroyed on the way to the peer — `--title "two words"`
  arrived as two arguments and `a & b` arrived as a backgrounded command. Pass
  `--argv '["prog","two words","a & b"]'` to deliver each element as exactly one
  token. The positional form is unchanged and still parsed by the remote shell, so
  the two are mutually exclusive. Source: `cli/src/lib/devices/connect.ts`.
- **`agents browser show <path> --device <host>` views a capture held on another
  machine (PHNX-3999).** The file is fetched into a private local path (0600 inside a
  0700 dir), bounded as it streams so an oversized file is refused rather than
  transferred, and then opened with the normal local viewer — nothing is opened on
  the remote box. `--device` here names where the FILE is; it requires an absolute
  path and is refused together with a URL. Source: `cli/src/commands/browser.ts`.
