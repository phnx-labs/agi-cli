/** Session provenance read from process env (`/proc/<pid>/environ`, `ps eww`): machine, local vs
 * SSH, tmux pane; undefined if unreadable. `reply` hints a rail that can type back: tmux
 * (`$TMUX_PANE`, wins), then iTerm. */
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
  /** tmux server socket path (first comma-field of $TMUX). Undefined for screen. */
  socket?: string;
  /** Exact pane id from $TMUX_PANE, e.g. '%3' — the send-keys target. */
  pane?: string;
  /** screen session name from $STY, e.g. '12345.pts-0.host'. */
  session?: string;
}

/** How the feed can type back into a session, derived from env rails that exist today. */
export type ReplyRail =
  | { rail: 'tmux'; target: string; socket?: string }
  /** iTerm2 split addressed by its session UUID (the part of $ITERM_SESSION_ID after ':'). */
  | { rail: 'iterm'; session: string }
  | null;

export interface SessionProvenance {
  /** Machine the process runs on — os.hostname(). Drives HOSTS grouping. */
  host: string;
  /** 'ssh' when SSH_CONNECTION is present in the process env, else 'local'. */
  transport: 'local' | 'ssh';
  /** Populated when transport === 'ssh'. */
  ssh?: SshOrigin;
  /** TERM_PROGRAM: 'iTerm.app', 'vscode', 'WezTerm', 'tmux', 'Apple_Terminal', … */
  term?: string;
  /** Multiplexer the process sits inside, from $TMUX / $STY. */
  mux?: MuxLocation;
  /** Whether an existing rail can type back into this session (see module doc). */
  reply: ReplyRail;
  /** The initiating device, resolved at query time from ssh.clientIp against the
   * device registry (ssh transport only). Answers "who launched this and from
   * where" without scraping ps/who/tailscale. */
  origin?: { device: string; user?: string };
}

/** Env vars that carry provenance. Kept small so the macOS `ps` scan stays cheap. */
export const PROVENANCE_ENV_KEYS = [
  'SSH_CONNECTION',
  'SSH_TTY',
  'TMUX',
  'TMUX_PANE',
  'TERM_PROGRAM',
  'STY',
  'ITERM_SESSION_ID',
] as const;

/** Extract the iTerm2 session UUID from `$ITERM_SESSION_ID` (`w<window>t<tab>p<pane>:<UUID>`),
 * the address for `tell session id`. Undefined when empty; tolerates a bare value. */
export function parseItermSession(value?: string): string | undefined {
  if (!value) return undefined;
  const uuid = value.includes(':') ? value.slice(value.lastIndexOf(':') + 1) : value;
  return uuid.trim() || undefined;
}

/** Parse the NUL-separated body of /proc/<pid>/environ into a plain object. */
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

/** Token count per key's value. macOS `ps eww` space-joins the env, so SSH_CONNECTION (four
 * fields) cannot be recovered by boundary guessing; every other key is one token. */
const ENV_VALUE_TOKENS: Record<string, number> = { SSH_CONNECTION: 4 };

/** Pull known env vars out of a macOS `ps eww` line, consuming each key's declared token count
 * so SSH_CONNECTION survives and a following unknown var is not swallowed. */
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

/** `<client_ip> <client_port> <server_ip> <server_port>` → structured origin. */
export function parseSshConnection(value: string): SshOrigin | undefined {
  const parts = value.trim().split(/\s+/);
  if (parts.length < 4) return undefined;
  const clientPort = parseInt(parts[1], 10);
  const serverPort = parseInt(parts[3], 10);
  if (!Number.isFinite(clientPort) || !Number.isFinite(serverPort)) return undefined;
  return { clientIp: parts[0], clientPort, serverIp: parts[2], serverPort };
}

/** Build a SessionProvenance from a raw env map + the local hostname. Pure. */
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

  // Env-addressable rails in precedence order: tmux wins (`send-keys -t <pane>` works under any
  // host app), then an iTerm2 split by session UUID. Anything else is not env-addressable; the
  // resolver may still find an IDE rail off disk.
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

/** Read a process's environment. Linux: /proc. macOS: `ps eww`. Best-effort. */
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

/** Resolve provenance for a live pid; undefined when its env cannot be read (gone, foreign uid,
 * unsupported platform). Never fabricates a 'local' answer. */
export async function detectProvenance(pid: number): Promise<SessionProvenance | undefined> {
  if (!pid || pid < 1) return undefined;
  const env = await readProcEnv(pid);
  if (!env) return undefined;
  return deriveProvenance(env, os.hostname());
}
