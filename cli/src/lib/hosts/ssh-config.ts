/**
 * Read the user's SSH config as a host directory — we never copy or rewrite it.
 *
 * `~/.ssh/config` is the source of truth for connection details; we only parse
 * `Host` stanzas to list candidate names and `ssh -G <name>` to resolve them for
 * display. `known_hosts` is a secondary candidate source for enrollment.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { assertValidSshTarget } from '../ssh-exec.js';

const SSH_DIR = path.join(os.homedir(), '.ssh');
const SSH_CONFIG = path.join(SSH_DIR, 'config');

/**
 * Parse `Host` stanza names from ssh config text. Wildcard/negated patterns
 * (`*`, `?`, `!`) are skipped — they're match rules, not concrete hosts.
 * Pure (text in, names out) so it's unit-testable.
 */
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

/**
 * Parse hostnames from known_hosts text. Hashed entries (`|1|…`) carry no
 * recoverable hostname and are skipped; `[host]:port` and comma lists are split.
 * Pure for testability.
 */
export function parseKnownHosts(content: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const first = line.split(/\s+/)[0];
    if (!first || first.startsWith('|')) continue; // hashed
    for (const entry of first.split(',')) {
      // strip [host]:port → host
      const host = entry.replace(/^\[/, '').replace(/\](:\d+)?$/, '');
      if (!host || /[*?]/.test(host) || seen.has(host)) continue;
      seen.add(host);
      names.push(host);
    }
  }
  return names;
}

/** `Host` names from ~/.ssh/config, following `Include` globs (best-effort). */
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
    // Follow Include directives (best-effort, relative to ~/.ssh).
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

/** Minimal glob: expand a single trailing `*` in the basename, else literal. */
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

/** True if `name` is a concrete `Host` stanza in ssh config. */
export function isSshConfigHost(name: string): boolean {
  return listSshConfigHosts().includes(name);
}

interface SshGResult {
  hostname?: string;
  user?: string;
  port?: string;
}

/**
 * Authoritative resolution of a host's effective ssh config via `ssh -G <name>`
 * (honors Match/Include). Returns undefined if `ssh` is unavailable. Note:
 * `ssh -G` returns defaults even for unknown names — pair with `isSshConfigHost`
 * to decide whether a name is actually configured.
 */
export function sshResolve(name: string): SshGResult | undefined {
  // Same target-injection guard as sshExec: a name starting with `-` (or
  // carrying shell metacharacters) must never reach `ssh` as a bare argv where
  // it could be parsed as a flag (e.g. `-oProxyCommand=…`).
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
