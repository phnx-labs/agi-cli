import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import chalk from 'chalk';
import type { Command } from 'commander';
import type { SessionMeta, SessionAgentId } from '@phnx-labs/sessions-cli/reader';
import { discoverSessions, resolveSessionById } from '../lib/session/discover.js';
import { setHelpSections } from '../lib/help.js';
import { makeStreamRenderer } from '@phnx-labs/sessions-cli/reader';

const TAIL_SUPPORTED: SessionAgentId[] = ['claude', 'codex'];

export function isTailable(agent: SessionAgentId): boolean {
  return TAIL_SUPPORTED.includes(agent);
}

interface TailFileOptions {
  fromStart?: boolean;
}

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
      offset = 0;
      partial = '';
    }
    return true;
  };

  const closeFd = async (): Promise<void> => {
    const h = fd;
    fd = null;
    if (h) {
      try { await h.close(); } catch {  }
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
    if (filename !== null && filename !== base) return;
    void drain();
  });

  await drain();

  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      ac.signal.removeEventListener('abort', onAbort);
      try { watcher.close(); } catch {  }
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
