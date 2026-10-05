/** Resolve how to re-invoke this CLI as a child: JS install runs `node <entry> <sub>`; Bun
 * standalone (#315) runs the physical binary, as argv[1] is the virtual `/$bunfs/root/agents`.
 * Daemon and broker spawns route here; this leaf module imports nothing from `lib/` (cycle). */
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
  // Prefer the binary actually executing this code, not `which agents`, which may pick a stale
  // registry install over a side-by-side dev build. Bun standalone: virtual entry at argv[1].
  const runningEntry = argv1 ? resolveBunStandaloneEntry(argv1, execPath) : undefined;
  if (runningEntry && fs.existsSync(runningEntry)) {
    // The package's browser/computer entrypoints are sibling shims without a
    // `daemon` command. A daemon started as their IPC side effect must launch
    // through the main agents entrypoint instead of replaying the shim path.
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

/** Directory of the `agents` launcher usable for PATH resolution: dirname of the bin when the entry
 * is the launcher, else that of a launcher whose realpath matches, else the entry's directory. */
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
      } catch { /* ignore */ }
    }
  }
  return path.dirname(bin);
}

/** An entry needs the Node runtime when it is a .js/.cjs/.mjs file or a symlink/extension-less shim
 * with a `node` shebang; a compiled binary has none and is run directly. */
export function isNodeScriptEntry(agentsBin: string): boolean {
  let resolved = agentsBin;
  try {
    resolved = fs.realpathSync(agentsBin);
  } catch {
    // Unresolvable (e.g. a template path that does not exist on this box): fall
    // back to the extension check on the path as given.
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

/** Build the `{ command, args }` to re-invoke this CLI with `sub`, resolving JS vs standalone.
 * Never hand-roll `[process.execPath, process.argv[1], ...]`: it passes the bun virtual entry. */
export function getCliLaunch(
  sub: string[],
  agentsBin: string = getAgentsBinPath(),
): { command: string; args: string[] } {
  // Resolve a bun virtual entry to the physical executable even when a caller
  // passes agentsBin explicitly (getAgentsBinPath already does this for the
  // default), so a `/$bunfs/root/agents` never becomes the command or an argv.
  const bin = resolveBunStandaloneEntry(agentsBin, process.execPath);
  if (isNodeScriptEntry(bin)) {
    return { command: process.execPath, args: [bin, ...sub] };
  }
  return { command: bin, args: [...sub] };
}
