import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';

const execFileAsync = promisify(execFile);

export interface SshOrigin {
  clientIp: string;
  clientPort: number;
  serverIp: string;
  serverPort: number;
}

export interface MuxLocation {
  kind: 'tmux' | 'screen';
  socket?: string;
  pane?: string;
  session?: string;
}

export type ReplyRail =
  | { rail: 'tmux'; target: string; socket?: string }
  | { rail: 'iterm'; session: string }
  | null;

export interface SessionProvenance {
  host: string;
  transport: 'local' | 'ssh';
  ssh?: SshOrigin;
  term?: string;
  mux?: MuxLocation;
  reply: ReplyRail;
  origin?: { device: string; user?: string };
}

export const PROVENANCE_ENV_KEYS = [
  'SSH_CONNECTION',
  'SSH_TTY',
  'TMUX',
  'TMUX_PANE',
  'TERM_PROGRAM',
  'STY',
  'ITERM_SESSION_ID',
] as const;

export function parseItermSession(value?: string): string | undefined {
  if (!value) return undefined;
  const uuid = value.includes(':') ? value.slice(value.lastIndexOf(':') + 1) : value;
  return uuid.trim() || undefined;
}

export function parseProcEnviron(buf: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of buf.split('\0')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}

const ENV_VALUE_TOKENS: Record<string, number> = { SSH_CONNECTION: 4 };

// macOS ps flattens env; consume SSH_CONNECTION at fixed four-token arity so following values survive.
export function extractKnownEnv(text: string, keys: readonly string[]): Record<string, string> {
  const alt = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const boundary = new RegExp(`(?:^|\\s)(${alt})=`, 'g');
  const env: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(text)) !== null) {
    const key = m[1];
    const rest = text.slice(m.index + m[0].length);
    const tokens = rest.split(/\s+/);
    const want = ENV_VALUE_TOKENS[key] ?? 1;
    env[key] = tokens.slice(0, want).join(' ');
  }
  return env;
}

export function parseSshConnection(value: string): SshOrigin | undefined {
  const parts = value.trim().split(/\s+/);
  if (parts.length < 4) return undefined;
  const clientPort = parseInt(parts[1], 10);
  const serverPort = parseInt(parts[3], 10);
  if (!Number.isFinite(clientPort) || !Number.isFinite(serverPort)) return undefined;
  return { clientIp: parts[0], clientPort, serverIp: parts[2], serverPort };
}

// Exact tmux pane outranks iTerm; without an evidence rail report null, never fabricated local provenance.
export function deriveProvenance(env: Record<string, string>, hostname: string): SessionProvenance {
  const ssh = env.SSH_CONNECTION ? parseSshConnection(env.SSH_CONNECTION) : undefined;

  let mux: MuxLocation | undefined;
  if (env.TMUX) {
    mux = {
      kind: 'tmux',
      socket: env.TMUX.split(',')[0] || undefined,
      pane: env.TMUX_PANE || undefined,
    };
  } else if (env.STY) {
    mux = { kind: 'screen', session: env.STY };
  }

  const itermSession = parseItermSession(env.ITERM_SESSION_ID);
  const reply: ReplyRail =
    mux?.kind === 'tmux' && mux.pane
      ? { rail: 'tmux', target: mux.pane, socket: mux.socket }
      : itermSession
        ? { rail: 'iterm', session: itermSession }
        : null;

  return {
    host: hostname,
    transport: ssh ? 'ssh' : 'local',
    ssh,
    term: env.TERM_PROGRAM || undefined,
    mux,
    reply,
  };
}

async function readProcEnv(pid: number): Promise<Record<string, string> | undefined> {
  if (process.platform === 'linux') {
    try {
      const buf = await readFile(`/proc/${pid}/environ`, 'utf8');
      return parseProcEnviron(buf);
    } catch {
      return undefined;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('ps', ['eww', '-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      if (!stdout.trim()) return undefined;
      return extractKnownEnv(stdout, PROVENANCE_ENV_KEYS);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function detectProvenance(pid: number): Promise<SessionProvenance | undefined> {
  if (!pid || pid < 1) return undefined;
  const env = await readProcEnv(pid);
  if (!env) return undefined;
  return deriveProvenance(env, os.hostname());
}
