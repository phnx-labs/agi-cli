
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from './types.js';
import { expandLocalHome } from './project-root.js';

type AddDirStrategy = 'native-flag' | 'codex-policy' | 'grok-sandbox' | 'none';

export const ADD_DIR_STRATEGY: Record<AgentId, AddDirStrategy> = {
  claude: 'native-flag',
  kimi: 'native-flag',
  cursor: 'native-flag',
  codex: 'codex-policy',
  grok: 'grok-sandbox',
  opencode: 'none',
  openclaw: 'none',
  copilot: 'none',
  amp: 'none',
  goose: 'none',
  antigravity: 'none',
  droid: 'none',
  hermes: 'none',
  muse: 'none',
  warp: 'none',
};

export function normalizeAddDirs(dirs: string[] | undefined): string[] {
  if (!dirs?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of dirs) {
    const expanded = expandLocalHome(raw);
    if (!expanded || seen.has(expanded)) continue;
    seen.add(expanded);
    out.push(expanded);
  }
  return out;
}

function appendNativeAddDirFlags(cmd: string[], dirs: string[]): void {
  for (const dir of dirs) {
    cmd.push('--add-dir', dir);
  }
}

export const GROK_PROJECT_SANDBOX_PROFILE = 'agents-project';

function grokActiveSandboxProfile(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.GROK_SANDBOX ?? '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === 'off' || lower === 'devbox') return null;
  if (lower === GROK_PROJECT_SANDBOX_PROFILE.toLowerCase()) return 'workspace';
  return raw;
}

export function grokNeedsSandboxWiden(env: NodeJS.ProcessEnv = process.env): boolean {
  return grokActiveSandboxProfile(env) !== null;
}

export function ensureGrokProjectSandboxProfile(
  cwd: string,
  dirs: string[],
  opts: { extendsBase?: string } = {},
): string | null {
  if (!dirs.length) return null;
  if (!cwd) return null;

  const base = opts.extendsBase ?? 'workspace';
  const extendsBase =
    !base || base.toLowerCase() === GROK_PROJECT_SANDBOX_PROFILE.toLowerCase()
      ? 'workspace'
      : base;

  const grokDir = path.join(cwd, '.grok');
  const sandboxPath = path.join(grokDir, 'sandbox.toml');

  const readWriteLines = dirs
    .map((d) => `  ${JSON.stringify(d)},`)
    .join('\n');

  const managedBlock = [
    '# BEGIN agents-cli managed — project multi-repo grants (do not edit by hand)',
    `[profiles.${GROK_PROJECT_SANDBOX_PROFILE}]`,
    `extends = ${JSON.stringify(extendsBase)}`,
    'read_write = [',
    readWriteLines,
    ']',
    '# END agents-cli managed',
    '',
  ].join('\n');

  let existing = '';
  try {
    existing = fs.readFileSync(sandboxPath, 'utf-8');
  } catch {
  }

  const begin = '# BEGIN agents-cli managed';
  const end = '# END agents-cli managed';
  let next: string;
  const beginIdx = existing.indexOf(begin);
  const endIdx = existing.indexOf(end);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const afterEnd = existing.indexOf('\n', endIdx);
    const endCut = afterEnd === -1 ? existing.length : afterEnd + 1;
    next = existing.slice(0, beginIdx) + managedBlock + existing.slice(endCut);
  } else if (existing.trim()) {
    const bare = new RegExp(
      `\\[profiles\\.${GROK_PROJECT_SANDBOX_PROFILE}\\]`,
    );
    if (bare.test(existing)) {
      return null;
    }
    next = existing.replace(/\s*$/, '\n\n') + managedBlock;
  } else {
    next = managedBlock;
  }

  fs.mkdirSync(grokDir, { recursive: true });
  fs.writeFileSync(sandboxPath, next, 'utf-8');
  return GROK_PROJECT_SANDBOX_PROFILE;
}

export function grokAddDirRules(dirs: string[], opts: { writeGranted?: boolean } = {}): string {
  const list = dirs.map((d) => `- ${d}`).join('\n');
  const access = opts.writeGranted === false
    ? 'intended as first-class workspace roots (OS sandbox may still restrict writes unless GROK_SANDBOX is set so agents-cli can widen it)'
    : 'read + write';
  return [
    `Project sibling directories (part of this multi-repo project; ${access}):`,
    list,
    'Treat these as first-class workspace roots alongside the primary cwd.',
  ].join('\n');
}

export function applyAddDirs(
  agent: AgentId,
  cmd: string[],
  dirs: string[] | undefined,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const normalized = normalizeAddDirs(dirs);
  if (normalized.length === 0) return false;

  const strategy = ADD_DIR_STRATEGY[agent];
  if (strategy === 'native-flag') {
    appendNativeAddDirFlags(cmd, normalized);
    return true;
  }

  if (strategy === 'grok-sandbox') {
    const env = opts.env ?? process.env;
    const activeBase = grokActiveSandboxProfile(env);
    let writeGranted = true;
    if (activeBase) {
      const cwd = opts.cwd ?? process.cwd();
      const profile = ensureGrokProjectSandboxProfile(cwd, normalized, {
        extendsBase: activeBase,
      });
      if (profile) {
        for (let i = cmd.length - 2; i >= 0; i--) {
          if (cmd[i] === '--sandbox') {
            cmd.splice(i, 2);
          }
        }
        cmd.push('--sandbox', profile);
        writeGranted = true;
      } else {
        writeGranted = false;
      }
    }
    cmd.push('--rules', grokAddDirRules(normalized, { writeGranted }));
    return true;
  }

  return false;
}

export function supportsAddDir(agent: AgentId): boolean {
  const s = ADD_DIR_STRATEGY[agent];
  return s === 'native-flag' || s === 'codex-policy' || s === 'grok-sandbox';
}

export function addDirUnsupportedNote(agent: AgentId): string | null {
  if (supportsAddDir(agent)) return null;
  return (
    `${agent} has no multi-root / --add-dir surface; project sibling directory ` +
    `grants are ignored (cwd only). Claude, Codex, Cursor, Kimi, and Grok consume them.`
  );
}
