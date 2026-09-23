/**
 * The `agents __usage-ingest` receiver — the worker side of the usage exchange
 * (PHNX-3392 usage-sync, PHNX-4116 transport over SSH).
 *
 * A headed peer pipes its daemon-state envelope ({@link FleetStateExchangePayload},
 * v2) to our stdin. We store it as that peer's `devices/<peer>/daemon-state.json`
 * (stamped `receivedAt`) and merge its usage rows into the local cache
 * newest-wins ({@link applyPeerFleetState}). With `--reply` we then refresh our
 * own fields (session digests, reserved-auth verdict, and usage if this box is
 * headed) and print our own envelope to stdout after a marker line, so the
 * headed box holds this device's state without a second round-trip. Without
 * `--reply` nothing is written to stdout: the ready probe runs this verb ahead
 * of `agents --version`/`agents view --json` in one shell and parses that
 * stdout, so a silent ingest is what keeps the probe parseable.
 *
 * The legacy v1 envelope (`{v:1, rows}`) from an older headed peer is still
 * merged. Hidden internal verb — intercepted in index.ts before bootstrap, so
 * it never triggers an update check or a detached sync.
 *
 * Exit codes: 0 = applied (or nothing to apply — an empty payload is not an
 * error), 2 = malformed or oversized input. It fails loud on a bad envelope
 * rather than silently accepting a wrong shape, but a busy cache lock degrades
 * to best-effort inside `ingestPeerClaudeUsageRows` like every other cache
 * writer. Stdin is bounded at {@link REMOTE_STDOUT_MAX_BYTES} — the same ceiling
 * the dialer puts on a peer's reply — so a runaway pusher cannot grow this
 * every-15-min receiver's heap; an overflow stops the read, exits 2, and writes
 * nothing.
 *
 * The payload arrives on stdin, EXCEPT on a Windows receiver: the `agents.ps1`
 * shim does not forward ssh-piped stdin to the node process, so the pusher
 * writes the payload to a temp file and passes `--from <path>`
 * (`buildWindowsStdinAgentsCommand`).
 */
import * as fs from 'fs';
import { REMOTE_STDOUT_MAX_BYTES, RemoteUtf8Accumulator } from '../ssh-exec.js';
import { ingestPeerClaudeUsageRows } from './usage.js';
import {
  applyPeerFleetState,
  buildFleetStatePayload,
  formatFleetStateReply,
  parseFleetStateExchangeInput,
  publishOwnFleetState,
} from './usage-sync.js';

/** Stdin grew past {@link REMOTE_STDOUT_MAX_BYTES}; the payload was refused unread. */
export class UsageIngestInputTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`stdin payload exceeds ${limitBytes} bytes (${limitBytes / (1024 * 1024)} MiB); refusing it unread`);
    this.name = 'UsageIngestInputTooLargeError';
  }
}

/**
 * Read stdin to EOF, bounded at {@link REMOTE_STDOUT_MAX_BYTES}. On overflow the
 * stream is destroyed so the pusher gets EPIPE instead of a full drain, and the
 * promise rejects with {@link UsageIngestInputTooLargeError} — the caller exits
 * 2 without parsing or writing anything.
 */
function readStdin(limitBytes = REMOTE_STDOUT_MAX_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const acc = new RemoteUtf8Accumulator();
    let bytes = 0;
    let settled = false;
    process.stdin.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.byteLength;
      if (bytes > limitBytes) {
        settled = true;
        process.stdin.destroy();
        reject(new UsageIngestInputTooLargeError(limitBytes));
        return;
      }
      acc.write(chunk);
    });
    process.stdin.on('end', () => { if (!settled) { settled = true; resolve(acc.end()); } });
    process.stdin.on('error', () => { if (!settled) { settled = true; resolve(acc.end()); } });
  });
}

/** `--from <path>` reads the payload from a file instead of stdin (Windows path). */
function fromFileArg(argv: string[]): string | null {
  const i = argv.indexOf('--from');
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

export async function runUsageIngest(argv: string[] = process.argv.slice(3)): Promise<number> {
  const reply = argv.includes('--reply');
  const fromPath = fromFileArg(argv);
  let source: string;
  if (fromPath) {
    try {
      source = fs.readFileSync(fromPath, 'utf-8');
    } catch (err) {
      process.stderr.write(`[agents] __usage-ingest: cannot read --from ${fromPath}: ${(err as Error).message}\n`);
      return 2;
    }
  } else {
    try {
      source = await readStdin();
    } catch (err) {
      if (!(err instanceof UsageIngestInputTooLargeError)) throw err;
      process.stderr.write(`[agents] __usage-ingest: ${err.name}: ${err.message}\n`);
      return 2;
    }
  }
  const raw = source.trim();
  const errors: string[] = [];
  if (raw) {
    let payload;
    try {
      payload = parseFleetStateExchangeInput(raw);
    } catch (err) {
      process.stderr.write(`[agents] __usage-ingest: ${(err as Error).message}\n`);
      return 2;
    }
    if (payload.v === 1) {
      await ingestPeerClaudeUsageRows(payload.rows);
    } else {
      try {
        await applyPeerFleetState(payload.state);
      } catch (err) {
        // A well-formed envelope we refuse (it names this device) is the
        // sender's mistake, not malformed input: say so on stderr and in the
        // reply, and still answer so the sender learns what this box holds.
        const message = (err as Error).message;
        process.stderr.write(`[agents] __usage-ingest: ${message}\n`);
        errors.push(`ingest: ${message}`);
        if (!reply) return 2;
      }
    }
  }
  if (!reply) return 0;
  const published = await publishOwnFleetState();
  errors.push(...published.errors);
  for (const message of published.errors) process.stderr.write(`[agents] __usage-ingest: ${message}\n`);
  process.stdout.write(formatFleetStateReply(buildFleetStatePayload({ errors })));
  return 0;
}
