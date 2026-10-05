
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { assertValidSshTarget } from '../ssh-exec.js';

const SSH_DIR = path.join(os.homedir(), '.ssh');
const SSH_CONFIG = path.join(SSH_DIR, 'config');

export function parseSshConfigHosts(content: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^Host\s+(.+)$/i.exec(line);
    if (!m) continue;
    for (const tok of m[1].split(/\s+/)) {
      if (!tok || /[*?!]/.test(tok)) continue;
      if (seen.has(tok)) continue;
      seen.add(tok);
      names.push(tok);
    }
  }
  return names;
}

export function parseKnownHosts(content: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const first = line.split(/\s+/)[0];
    if (!first || first.startsWith('|')) continue;
    for (const entry of first.split(',')) {
      const host = entry.replace(/^\[/, '').replace(/\](:\d+)?$/, '');
      if (!host || /[*?]/.test(host) || seen.has(host)) continue;
      seen.add(host);
      names.push(host);
    }
  }
  return names;
}

export function listSshConfigHosts(): string[] {
  const names = new Set<string>();
  const visit = (file: string, depth: number): void => {
    if (depth > 8) return;
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      return;
    }
    for (const name of parseSshConfigHosts(content)) names.add(name);
    for (const rawLine of content.split('\n')) {
      const m = /^\s*Include\s+(.+)$/i.exec(rawLine);
      if (!m) continue;
      for (const pat of m[1].trim().split(/\s+/)) {
        const abs = path.isAbsolute(pat) ? pat : path.join(SSH_DIR, pat.replace(/^~\//, ''));
        for (const f of globMaybe(abs)) visit(f, depth + 1);
      }
    }
  };
  visit(SSH_CONFIG, 0);
  return [...names];
}

function globMaybe(pattern: string): string[] {
  if (!pattern.includes('*')) {
    return fs.existsSync(pattern) ? [pattern] : [];
  }
  const dir = path.dirname(pattern);
  const base = path.basename(pattern);
  const re = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  try {
    return fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export function isSshConfigHost(name: string): boolean {
  return listSshConfigHosts().includes(name);
}

interface SshGResult {
  hostname?: string;
  user?: string;
  port?: string;
}

export function sshResolve(name: string): SshGResult | undefined {
  // Validate before `ssh -G`; an option-shaped target must never reach OpenSSH.
  try {
    assertValidSshTarget(name);
  } catch {
    return undefined;
  }
  const res = spawnSync('ssh', ['-G', name], { encoding: 'utf-8', timeout: 5000 });
  if (res.status !== 0 || !res.stdout) return undefined;
  const out: SshGResult = {};
  for (const line of res.stdout.split('\n')) {
    const [key, ...rest] = line.trim().split(/\s+/);
    const val = rest.join(' ');
    if (key === 'hostname') out.hostname = val;
    else if (key === 'user') out.user = val;
    else if (key === 'port') out.port = val;
  }
  return out;
}
