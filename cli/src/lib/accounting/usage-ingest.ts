/** The `agents __usage-ingest` receiver (PHNX-3392, PHNX-4116): stores a peer's v2/v1 envelope,
 * merges usage newest-wins; `--reply` prints ours, else stdout stays empty (probe parses it).
 * Windows reads `--from <path>`. Exit 2 on malformed or oversized (REMOTE_STDOUT_MAX_BYTES) input. */
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

/** Read stdin to EOF, bounded at REMOTE_STDOUT_MAX_BYTES. On overflow the stream is destroyed
 * (pusher gets EPIPE) and it rejects with UsageIngestInputTooLargeError; the caller exits 2 and
 * writes nothing. */
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
