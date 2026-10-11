import * as fs from 'fs';
import * as path from 'path';
import { getLogsDir } from './state.js';

// A launch that must open straight into the agent (a tab, a CLI-made SSH hop) keeps
// everything agents itself says out of the terminal: it goes to a per-launch log on
// the machine doing the work. Only a failed launch prints, naming the cause and the
// log. Child processes of the same launch append to the same log
// (LAUNCH_LOG_ENV); the agent's own TUI is untouched because it writes to the
// terminal directly, not through this process's stderr.
export const LAUNCH_LOG_ENV = 'AGENTS_LAUNCH_LOG';

export interface LaunchFailure {
  status: 'failed';
  cause: string;
  log: string;
  exitCode: number;
  at: string;
}

export function launchesDir(): string {
  return path.join(getLogsDir(), 'launches');
}

export function launchFailurePath(sessionId: string): string {
  return path.join(launchesDir(), `${sessionId}.json`);
}

export function readLaunchFailure(sessionId: string): LaunchFailure | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(launchFailurePath(sessionId), 'utf8'));
    return value?.status === 'failed' && typeof value.cause === 'string' && typeof value.log === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

// `sessions resume <id>`, `sessions focus <id>`, `run … --resume <id>`.
export function launchSessionId(argv: string[]): string | undefined {
  const resume = argv.indexOf('--resume');
  if (resume >= 0 && argv[resume + 1] && !argv[resume + 1].startsWith('-')) return argv[resume + 1];
  const verbs = ['resume', 'focus'];
  if (argv[0] === 'sessions' && verbs.includes(argv[1] ?? '') && argv[2] && !argv[2].startsWith('-')) return argv[2];
  return undefined;
}

// A command that ends in a running agent never stops to ask about anything else first.
export function launchesAgent(argv: string[]): boolean {
  const words = argv.filter((a) => !a.startsWith('-'));
  return words[0] === 'run' || (words[0] === 'sessions' && (words[1] === 'resume' || words[1] === 'focus'));
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

// The cause is the last top-level line written (indented lines are hints under it).
export function failureCause(log: string): string {
  const lines = log.replace(ANSI, '').split('\n').filter((l) => l.trim() && !/^\s/.test(l));
  return lines.at(-1)?.trim() || 'it exited before the agent started, without saying why';
}

export function startQuietLaunch(argv: string[], env: NodeJS.ProcessEnv = process.env): string {
  // Only the first process of a launch on this machine reports; its children share the log.
  const outermost = !env[LAUNCH_LOG_ENV];
  const log = env[LAUNCH_LOG_ENV] || path.join(launchesDir(), `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.log`);
  env[LAUNCH_LOG_ENV] = log;
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const sessionId = launchSessionId(argv);
  if (sessionId) fs.rmSync(launchFailurePath(sessionId), { force: true });
  const ownStart = fs.existsSync(log) ? fs.statSync(log).size : 0;

  const write = (chunk: unknown, encodingOrCb?: unknown, cb?: unknown): boolean => {
    try {
      fs.appendFileSync(log, typeof chunk === 'string' || Buffer.isBuffer(chunk) ? chunk : String(chunk));
    } catch {
    }
    const done = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    if (typeof done === 'function') (done as () => void)();
    return true;
  };
  process.stderr.write = write as typeof process.stderr.write;

  if (!outermost) return log;
  process.on('exit', (code) => {
    const exitCode = code || (typeof process.exitCode === 'number' ? process.exitCode : 0);
    if (!exitCode) return;
    let mine = '';
    try {
      const fd = fs.openSync(log, 'r');
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.max(0, size - ownStart));
      fs.readSync(fd, buf, 0, buf.length, ownStart);
      fs.closeSync(fd);
      mine = buf.toString('utf8');
    } catch {
    }
    const cause = failureCause(mine);
    if (sessionId) {
      try {
        const record: LaunchFailure = { status: 'failed', cause, log, exitCode, at: new Date().toISOString() };
        fs.writeFileSync(launchFailurePath(sessionId), JSON.stringify(record));
      } catch {
      }
    }
    try {
      fs.writeSync(2, `\nThe agent did not start: ${cause}\nFull output: ${log}\n`);
    } catch {
    }
  });
  return log;
}
