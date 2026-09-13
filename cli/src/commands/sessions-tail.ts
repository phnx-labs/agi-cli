/**
 * Live-tail a session file and stream new events as they're written.
 *
 * Implements `agents sessions tail` — position-tracked reader on the session
 * JSONL, driven by an fs.watch on the parent directory. Claude and Codex
 * only for v1 (both use append-only JSONL). Output is compact by default;
 * --json keeps the raw JSONL stream.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import chalk from 'chalk';
import type { Command } from 'commander';
import type { SessionMeta, SessionAgentId } from '../lib/session/types.js';
import { discoverSessions, resolveSessionById } from '../lib/session/discover.js';
import { setHelpSections } from '../lib/help.js';
import { makeStreamRenderer } from '../lib/session/stream-render.js';

const TAIL_SUPPORTED: SessionAgentId[] = ['claude', 'codex'];

/** Whether a session's transcript can be live-tailed (append-only JSONL agents). */
export function isTailable(agent: SessionAgentId): boolean {
  return TAIL_SUPPORTED.includes(agent);
}

interface TailFileOptions {
  /** If true, emit every line from byte 0 first, then follow. Default false (EOF). */
  fromStart?: boolean;
}

/**
 * Tail a file: emit each newline-terminated line via onLine as it's written.
 *
 * Returns a promise that resolves when the AbortController fires. Uses
 * fs.watch on the parent directory (more reliable on macOS than watching
 * the file directly) and tracks byte offset to avoid re-reading content.
 *
 * Emits each line exactly once. Handles partial lines across reads, file
 * truncation (offset reset), and files that don't exist yet (watches the
 * parent dir until the file appears).
 */
export async function tailFile(
  filePath: string,
  onLine: (line: string) => void,
  ac: AbortController,
  opts: TailFileOptions = {},
): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  let fd: fsp.FileHandle | null = null;
  let offset = 0;
  let partial = '';
  let reading = false;
  let dirty = false;

  const openIfPossible = async (initial: boolean): Promise<boolean> => {
    try {
      fd = await fsp.open(filePath, 'r');
    } catch {
      return false;
    }
    if (initial) {
      const st = await fd.stat();
      offset = opts.fromStart ? 0 : st.size;
    } else {
      // File appeared after we started watching — emit from byte 0.
      offset = 0;
      partial = '';
    }
    return true;
  };

  const closeFd = async (): Promise<void> => {
    const h = fd;
    fd = null;
    if (h) {
      try { await h.close(); } catch { /* already closed */ }
    }
  };

  const drain = async (): Promise<void> => {
    if (reading) { dirty = true; return; }
    reading = true;
    try {
      while (!ac.signal.aborted) {
        if (!fd) {
          const ok = await openIfPossible(false);
          if (!ok) return;
        }
        const st = await fd!.stat();
        if (st.size < offset) {
          // Truncation or rotation: reset to start of the new content.
          offset = 0;
          partial = '';
        }
        if (st.size === offset) {
          if (dirty) { dirty = false; continue; }
          return;
        }
        const len = st.size - offset;
        const buf = Buffer.alloc(len);
        await fd!.read(buf, 0, len, offset);
        offset = st.size;
        const text = partial + buf.toString('utf-8');
        const lines = text.split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) {
          if (ac.signal.aborted) return;
          if (line.length > 0) onLine(line);
        }
        if (!dirty) return;
        dirty = false;
      }
    } finally {
      reading = false;
    }
  };

  if (fs.existsSync(filePath)) {
    await openIfPossible(true);
  }

  const watcher = fs.watch(dir, { recursive: false }, (_event, filename) => {
    if (ac.signal.aborted) return;
    // On macOS, filename is sometimes null — don't filter in that case.
    if (filename !== null && filename !== base) return;
    // Stat detects append, truncation, or reappearance in drain(); trust that
    // over the event type, which macOS coalesces inconsistently.
    void drain();
  });

  // Initial drain in case the file has content beyond EOF-of-our-offset
  // (e.g. --from-start, or a write between stat and watch attach).
  await drain();

  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      ac.signal.removeEventListener('abort', onAbort);
      try { watcher.close(); } catch { /* noop */ }
      void closeFd().then(() => resolve());
    };
    if (ac.signal.aborted) onAbort();
    else ac.signal.addEventListener('abort', onAbort);
  });
}

interface TailOptions {
  latest?: boolean;
  fromStart?: boolean;
  json?: boolean;
}

async function findLatestTailable(): Promise<SessionMeta | undefined> {
  const sessions = await discoverSessions({ all: true, limit: 100 });
  const eligible = sessions.filter(s => TAIL_SUPPORTED.includes(s.agent));
  if (eligible.length === 0) return undefined;
  eligible.sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  return eligible[0];
}

async function resolveTailable(sessionId: string): Promise<SessionMeta | undefined | 'unsupported'> {
  const sessions = await discoverSessions({ all: true, limit: 5000 });
  const matches = resolveSessionById(sessions, sessionId);
  if (matches.length === 0) return undefined;
  // Prefer a supported agent among matches; if only unsupported match, signal.
  const supported = matches.find(s => TAIL_SUPPORTED.includes(s.agent));
  if (supported) return supported;
  return 'unsupported';
}

async function runTail(sessionId: string | undefined, options: TailOptions): Promise<void> {
  let session: SessionMeta | undefined;

  if (options.latest) {
    session = await findLatestTailable();
    if (!session) {
      console.log(chalk.gray('No tailable sessions found (claude or codex).'));
      return;
    }
  } else {
    if (!sessionId) {
      console.error(chalk.red('Missing session ID. Pass an ID or use --latest.'));
      process.exit(2);
    }
    const resolved = await resolveTailable(sessionId);
    if (resolved === 'unsupported') {
      console.error(chalk.red(
        `Tailing is supported for append-only JSONL agents only (claude, codex).`
      ));
      process.exit(2);
    }
    if (!resolved) {
      console.error(chalk.red(`No session found matching: ${sessionId}`));
      process.exit(1);
    }
    session = resolved;
  }

  await streamSessionTail(session, { fromStart: options.fromStart, raw: options.json });
}

/**
 * Live-tail one already-resolved session's transcript to stdout until Ctrl+C.
 * Shared by `agents sessions tail` and `agents logs -f`.
 */
export async function streamSessionTail(
  session: SessionMeta,
  options: { fromStart?: boolean; raw?: boolean } = {},
): Promise<void> {
  const filePath = session.filePath.split('#')[0];
  const render = options.raw ? undefined : makeStreamRenderer(session.agent, session.cwd);

  if (process.stderr.isTTY) {
    process.stderr.write(
      chalk.gray(`Tailing ${session.agent} ${session.shortId} — ${filePath}\n`) +
      chalk.gray('Ctrl+C to stop.\n')
    );
  }

  const ac = new AbortController();
  const onSig = (): void => { ac.abort(); };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  try {
    await tailFile(filePath, (line) => {
      if (!render) {
        process.stdout.write(line + '\n');
        return;
      }
      const out = render(line);
      if (out) process.stdout.write(out + '\n');
    }, ac, { fromStart: options.fromStart });
  } finally {
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
  }
}

/** Attach the `tail` subcommand to an existing `sessions` command. */
export function registerSessionsTailCommand(sessionsCmd: Command): void {
  const tailCmd = sessionsCmd
    .command('tail [sessionId]')
    .description('Stream compact live lines from a session file as events are written. Long-running: Ctrl+C to stop. Claude and Codex only.')
    .option('--latest', 'Tail the most recent tailable session (claude or codex)')
    .option('--from-start', 'Emit the full file first, then follow (default: start at EOF)')
    .option('--json', 'Emit raw JSONL events instead of compact live lines');

  setHelpSections(tailCmd, {
    examples: `
      # Follow the most recent active Claude or Codex session
      agents sessions tail --latest

      # Follow a specific session by short or full ID
      agents sessions tail a1b2c3d4

      # Replay from the beginning, then follow
      agents sessions tail a1b2c3d4 --from-start

      # Pipe raw events through jq to extract just user messages
      agents sessions tail --latest --json | jq 'select(.type == "user")'
    `,
    notes: `
      - Only Claude and Codex sessions are tailable — they append JSONL one event per line.
      - Live tail is compact by default; pass --json for the raw JSONL stream.
      - Gemini, OpenCode, and OpenClaw use formats that rewrite the file or store state elsewhere.
    `,
  });

  tailCmd.action(async (sessionId: string | undefined, _options: TailOptions, command: Command) => {
    await runTail(sessionId, command.optsWithGlobals() as TailOptions);
  });
}
