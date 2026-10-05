import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const BUN_VIRTUAL_ROOT = /[/\\]\$bunfs[/\\]root[/\\]/;

function resolveBunStandaloneEntry(entry: string, execPath: string): string {
  if (!BUN_VIRTUAL_ROOT.test(entry)) return entry;
  if (!execPath || BUN_VIRTUAL_ROOT.test(execPath) || !fs.existsSync(execPath)) {
    throw new Error(
      `Cannot resolve agents CLI: Bun standalone executable not found at ${execPath || '(empty path)'}`,
    );
  }
  return execPath;
}

export function getAgentsBinPath(
  argv1: string | undefined = process.argv[1],
  execPath: string = process.execPath,
): string {
  const runningEntry = argv1 ? resolveBunStandaloneEntry(argv1, execPath) : undefined;
  if (runningEntry && fs.existsSync(runningEntry)) {
    const entryName = path.basename(runningEntry);
    const compiledShim = /^(browser|computer)\.(c|m)?js$/.test(entryName);
    const installedShim = /^(browser|computer)$/.test(entryName);
    if (compiledShim || installedShim) {
      const agentsEntry = path.join(path.dirname(runningEntry), compiledShim ? 'index.js' : 'agents');
      if (!fs.existsSync(agentsEntry)) {
        throw new Error(`Cannot start agents daemon: main CLI entry not found at ${agentsEntry}`);
      }
      return agentsEntry;
    }
    return runningEntry;
  }
  try {
    return execFileSync('which', ['agents'], { encoding: 'utf-8' }).trim();
  } catch {
    return 'agents';
  }
}

export function getAgentsBinDir(): string {
  const bin = getAgentsBinPath();
  const base = path.basename(bin);
  if (base === 'agents' || base === 'agents.exe' || base === 'agents.cmd') {
    return path.dirname(bin);
  }
  const realBin = (() => {
    try { return fs.realpathSync(bin); }
    catch { return bin; }
  })();
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.dirname(process.execPath),
  ];
  for (const dir of candidates) {
    for (const name of ['agents', 'agents.exe', 'agents.cmd']) {
      const launcher = path.join(dir, name);
      try {
        if (fs.realpathSync(launcher) === realBin) return dir;
      } catch {  }
    }
  }
  return path.dirname(bin);
}

export function isNodeScriptEntry(agentsBin: string): boolean {
  let resolved = agentsBin;
  try {
    resolved = fs.realpathSync(agentsBin);
  } catch {
  }
  if (/\.(c|m)?js$/.test(resolved)) return true;
  try {
    const fd = fs.openSync(resolved, 'r');
    try {
      const buf = Buffer.alloc(128);
      const n = fs.readSync(fd, buf, 0, 128, 0);
      const firstLine = buf.toString('utf-8', 0, n).split('\n', 1)[0];
      return firstLine.startsWith('#!') && /\bnode\b/.test(firstLine);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function getCliLaunch(
  sub: string[],
  agentsBin: string = getAgentsBinPath(),
): { command: string; args: string[] } {
  const bin = resolveBunStandaloneEntry(agentsBin, process.execPath);
  if (isNodeScriptEntry(bin)) {
    return { command: process.execPath, args: [bin, ...sub] };
  }
  return { command: bin, args: [...sub] };
}
