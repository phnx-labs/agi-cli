/**
 * Sandbox environment for routine job execution.
 *
 * Creates an overlay HOME directory per job with symlinked allowed
 * directories and agent-specific config files (permissions, settings).
 * The spawned agent process sees only the overlay, limiting filesystem
 * access to explicitly allowed paths.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { JobConfig } from './scheduling/routines.js';
import { getRoutinesDir, getUserAgentsDir } from './state.js';
import { safeJoin } from './paths.js';
import { createLink } from './platform/index.js';
import type { AgentId } from './types.js';
import { getVersionHomePath } from './installations/versions.js';

function resolveRealHome(): string {
  const home = os.homedir();
  try {
    return fs.realpathSync(home);
  } catch {
    return home;
  }
}

/** Environment variables forwarded from the parent process into the sandbox. */
const ENV_ALLOWLIST = [
  'PATH',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'NODE_PATH',
  'NVM_DIR',
  'BUN_INSTALL',
  'EDITOR',
  'VISUAL',
  'NO_COLOR',
  'FORCE_COLOR',
  // GitHub CLI — same host credentials interactive `agents run` already sees.
  // Without these, a sandboxed monitor `--run` child has no gh auth even when
  // the daemon user is logged in (RUSH-2860).
  'GH_TOKEN',
  'GH_HOST',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_TOKEN',
  'GH_CONFIG_DIR',
];

/** Tools safe to grant as wildcards (no filesystem access). */
const SAFE_TOOLS: Record<string, string> = {
  web_search: 'WebSearch(*)',
  web_fetch: 'WebFetch(*)',
};

/** Bare tool names that get scoped to allow.dirs, never wildcarded. */
const DIR_SCOPED_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep', 'notebook_edit']);

function tomlString(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`TOML value contains newline: ${JSON.stringify(value)}`);
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Absolute path to this host's `gh` config directory (`hosts.yml` + `config.yml`),
 * or null when the host has never run `gh auth login`. Prefer `GH_CONFIG_DIR` when
 * the parent already pinned one; otherwise `$XDG_CONFIG_HOME/gh` or `~/.config/gh`.
 */
export function resolveHostGhConfigDir(): string | null {
  // Honor an explicit pin only when it actually exists; otherwise fall through
  // to the default locations so a stale/broken GH_CONFIG_DIR cannot hide a
  // healthy ~/.config/gh (RUSH-2860).
  if (process.env.GH_CONFIG_DIR && fs.existsSync(process.env.GH_CONFIG_DIR)) {
    return process.env.GH_CONFIG_DIR;
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(resolveRealHome(), '.config');
  const ghDir = path.join(configHome, 'gh');
  return fs.existsSync(ghDir) ? ghDir : null;
}

/** True when this host holds usable GitHub CLI auth (hosts.yml or a token env). */
export function hostHasGhAuth(): boolean {
  if (process.env.GH_TOKEN || process.env.GH_ENTERPRISE_TOKEN || process.env.GITHUB_TOKEN) {
    return true;
  }
  const dir = resolveHostGhConfigDir();
  if (!dir) return false;
  return fs.existsSync(path.join(dir, 'hosts.yml'));
}

/** Build a restricted environment for a sandboxed process, setting HOME to the overlay. */
export function buildSpawnEnv(overlayHome: string, extraEnv?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {
    HOME: overlayHome,
    AGENTS_USER_DIR: getUserAgentsDir(),
  };

  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) {
      env[key] = process.env[key]!;
    }
  }

  // Pin GH_CONFIG_DIR at the REAL host config so `gh` does not look under the
  // disposable overlay HOME (which has no hosts.yml). Same posture as linking
  // Cursor's auth.json — forward the credentials the daemon user already holds
  // (RUSH-2860). Always prefer resolveHostGhConfigDir over a stale allowlisted
  // value; an explicit extraEnv GH_CONFIG_DIR still wins below.
  const hostGh = resolveHostGhConfigDir();
  if (hostGh) {
    env.GH_CONFIG_DIR = hostGh;
  } else {
    delete env.GH_CONFIG_DIR;
  }

  if (extraEnv) {
    Object.assign(env, extraEnv);
  }

  return env;
}

/**
 * Get the overlay HOME directory path for a named job.
 *
 * The job name originates from routine YAML (`name:` field or file basename),
 * which can arrive from a synced user/system config repo. `safeJoin` contains
 * it to a single segment beneath the routines dir so a crafted name such as
 * `../../../..` cannot steer `prepareJobHome`/`cleanJobHome` (which does a
 * recursive `rmSync`) at a path outside `~/.agents/routines`.
 */
export function getJobHomePath(name: string): string {
  return path.join(safeJoin(getRoutinesDir(), name), 'home');
}

/** Create a fresh overlay HOME for a job, including agent config and allowed-dir symlinks. */
export function prepareJobHome(config: JobConfig, version?: string): string {
  const overlayHome = getJobHomePath(config.name);

  cleanJobHome(config.name);
  fs.mkdirSync(overlayHome, { recursive: true });

  if (config.agent === 'claude') {
    generateClaudeConfig(overlayHome, config);
  } else if (config.agent === 'codex') {
    generateCodexConfig(overlayHome, config);
    linkVersionAuth(overlayHome, 'codex', version);
  } else if (config.agent === 'cursor') {
    generateCursorConfig(overlayHome);
  }

  // Host tool credentials / setup the overlay HOME would otherwise hide.
  // Cursor already links its own auth above; gh is harness-agnostic and needed
  // by every sandboxed `--run` that shells out to `gh` (RUSH-2860 — monitor
  // merge agents saw "not logged into any GitHub hosts" while the daemon user
  // was fine).
  //
  // Deliberately NOT linking the real ~/.agents here. It would put the secrets
  // master key (.secrets-key) and the encrypted store (.cache/secrets) together
  // at a predictable path inside the overlay, through a writable symlink, in a
  // child whose prompt can carry untrusted text from a watched source. The
  // separate "agents-cli is not set up" defect (state.ts ignores AGENTS_USER_DIR)
  // gets its own scoped change: RUSH-2954.
  linkHostGhConfig(overlayHome);

  if (config.allow?.dirs) {
    symlinkAllowedDirs(overlayHome, config.allow.dirs);
  }

  return overlayHome;
}

/** Link only the selected harness login into the disposable routine HOME. */
export function linkVersionAuth(overlayHome: string, agent: AgentId, version?: string): void {
  if (!version) return;
  const versionHome = getVersionHomePath(agent, version);
  const pairs = agent === 'claude'
    ? [
        [path.join(versionHome, '.claude', '.claude.json'), path.join(overlayHome, '.claude', '.claude.json')],
        [path.join(versionHome, '.claude', '.credentials.json'), path.join(overlayHome, '.claude', '.credentials.json')],
      ]
    : agent === 'codex'
      ? [[path.join(versionHome, '.codex', 'auth.json'), path.join(overlayHome, '.codex', 'auth.json')]]
      : [];

  for (const [source, target] of pairs) {
    if (!fs.existsSync(source)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try { fs.rmSync(target, { force: true }); } catch { /* absent */ }
    try { createLink(source, target); } catch { /* the harness fails auth loudly if linking is unavailable */ }
  }
}

/**
 * Link this host's `gh` config directory into the disposable overlay so
 * `$HOME/.config/gh` resolves even when `GH_CONFIG_DIR` is unset. Mirrors
 * `generateCursorConfig`: same-host credentials, never copied to another box.
 */
export function linkHostGhConfig(overlayHome: string): void {
  const realGhDir = resolveHostGhConfigDir();
  if (!realGhDir || !fs.existsSync(realGhDir)) return;

  const overlayGhDir = path.join(overlayHome, '.config', 'gh');
  if (fs.existsSync(overlayGhDir)) return;
  fs.mkdirSync(path.dirname(overlayGhDir), { recursive: true });
  try {
    createLink(realGhDir, overlayGhDir);
  } catch {
    /* cross-volume or link creation refused: GH_CONFIG_DIR in buildSpawnEnv is the backup */
  }
}

/**
 * Refuse to launch a sandboxed child when THIS host holds GitHub auth but the
 * spawn env would hide it. The RUSH-2860 failure mode was silent: the monitor
 * fire recorded `ok` (spawn succeeded) while every `gh` call inside the child
 * failed. Prefer forwarding (buildSpawnEnv / linkHostGhConfig); this assert is
 * the regression tripwire — if forwarding ever regresses, fail loud at spawn
 * instead of recording a hollow success. No-ops when the host has no gh auth
 * (jobs that do not need GitHub still run).
 */
export function assertSandboxForwardsHostGhAuth(spawnEnv: Record<string, string>): void {
  if (!hostHasGhAuth()) return;
  if (spawnEnv.GH_TOKEN || spawnEnv.GH_ENTERPRISE_TOKEN || spawnEnv.GITHUB_TOKEN) return;
  if (spawnEnv.GH_CONFIG_DIR && fs.existsSync(path.join(spawnEnv.GH_CONFIG_DIR, 'hosts.yml'))) return;
  if (spawnEnv.HOME && fs.existsSync(path.join(spawnEnv.HOME, '.config', 'gh', 'hosts.yml'))) return;
  throw new Error(
    "sandbox spawn would hide this host's GitHub auth from the child " +
      '(no GH_CONFIG_DIR / ~/.config/gh / GH_TOKEN). Refusing to launch — ' +
      'the agent would record ok then fail every gh call (RUSH-2860).',
  );
}

/** Link this host's Cursor login and CLI config into the disposable overlay. */
export function generateCursorConfig(overlayHome: string): void {
  const realCursorDir = path.join(process.env.AGENTS_REAL_HOME || resolveRealHome(), '.cursor');
  const realAuth = path.join(realCursorDir, 'auth.json');
  if (!fs.existsSync(realAuth)) return;

  const overlayCursorDir = path.join(overlayHome, '.cursor');
  fs.mkdirSync(overlayCursorDir, { recursive: true });
  const overlayAuth = path.join(overlayCursorDir, 'auth.json');
  if (process.platform === 'win32') {
    // File symlinks need Developer Mode on Windows. A same-volume hard link
    // shares the credential inode without copying its contents to another host.
    try {
      fs.linkSync(realAuth, overlayAuth);
    } catch { /* cross-volume or link creation refused: Cursor will fail auth loudly */ }
  } else {
    fs.symlinkSync(realAuth, overlayAuth);
  }

  // cli-config.json carries account identity alongside the file-store token, so
  // it must remain linked rather than copied.
  const realCliConfig = path.join(realCursorDir, 'cli-config.json');
  if (fs.existsSync(realCliConfig)) {
    const overlayCliConfig = path.join(overlayCursorDir, 'cli-config.json');
    try {
      if (process.platform === 'win32') fs.linkSync(realCliConfig, overlayCliConfig);
      else fs.symlinkSync(realCliConfig, overlayCliConfig);
    } catch { /* cross-volume or link creation refused: Cursor will fail auth loudly */ }
  }
}

/** Remove a job's overlay HOME directory entirely. */
export function cleanJobHome(name: string): void {
  const overlayHome = getJobHomePath(name);
  if (fs.existsSync(overlayHome)) {
    fs.rmSync(overlayHome, { recursive: true, force: true });
  }
}

/** Symlink allowed directories into the overlay HOME, skipping paths outside the real HOME. */
export function symlinkAllowedDirs(overlayHome: string, dirs: string[]): void {
  const realHome = resolveRealHome();
  for (const dir of dirs) {
    const expanded = dir.replace(/^~/, realHome);

    // Resolve .. and symlinks to prevent path traversal outside HOME
    let realPath: string;
    try {
      // Use realpath if the directory exists (resolves symlinks)
      realPath = fs.realpathSync(expanded);
    } catch {
      // Directory doesn't exist yet — resolve .. components without following symlinks
      realPath = path.resolve(expanded);
    }

    if (!realPath.startsWith(realHome + path.sep) && realPath !== realHome) {
      continue;
    }

    const relativePath = path.relative(realHome, realPath);
    const symlinkTarget = path.join(overlayHome, relativePath);
    const parentDir = path.dirname(symlinkTarget);

    fs.mkdirSync(parentDir, { recursive: true });

    if (!fs.existsSync(symlinkTarget)) {
      try {
        // createLink uses a junction for directories on Windows (no elevation),
        // a plain symlink on POSIX — allowed dirs are directories.
        createLink(realPath, symlinkTarget);
      } catch { /* link already exists or refused */ }
    }
  }
}

/** Generate a Claude settings.json in the overlay with scoped permissions from the job config. */
export function generateClaudeConfig(overlayHome: string, config: JobConfig): void {
  const realHome = resolveRealHome();
  const claudeDir = path.join(overlayHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  const allowPermissions: string[] = [];
  const enabledTools = new Set(config.allow?.tools || []);

  if (config.allow?.tools) {
    for (const tool of config.allow.tools) {
      // Safe wildcards (no filesystem access)
      if (tool in SAFE_TOOLS) {
        allowPermissions.push(SAFE_TOOLS[tool]);
        continue;
      }

      // Bare filesystem tool names — permissions come from allow.dirs
      if (DIR_SCOPED_TOOLS.has(tool)) {
        continue;
      }

      // Bare "bash" — must use scoped pattern like "Bash(git *)"
      if (tool === 'bash') {
        throw new Error(
          'Bare "bash" not allowed in sandbox — use scoped patterns like "Bash(git *)"'
        );
      }

      // Reject wildcard patterns like Bash(*), Read(*)
      if (/^\w+\(\*\)$/.test(tool)) {
        throw new Error(
          `Wildcard "${tool}" not allowed in sandbox — use scoped patterns`
        );
      }

      // Scoped pattern like "Bash(git *)" — pass through
      allowPermissions.push(tool);
    }
  }

  // Scope filesystem tools to allowed dirs
  if (config.allow?.dirs) {
    for (const dir of config.allow.dirs) {
      const resolved = dir.replace(/^~/, realHome);

      // Read always granted for allowed dirs
      allowPermissions.push(`Read(${resolved}/**)`);

      if (config.mode === 'edit') {
        allowPermissions.push(`Write(${resolved}/**)`);
        allowPermissions.push(`Edit(${resolved}/**)`);
      }

      if (enabledTools.has('glob')) {
        allowPermissions.push(`Glob(${resolved}/**)`);
      }
      if (enabledTools.has('grep')) {
        allowPermissions.push(`Grep(${resolved}/**)`);
      }
      if (enabledTools.has('notebook_edit') && config.mode === 'edit') {
        allowPermissions.push(`NotebookEdit(${resolved}/**)`);
      }
    }
  }

  const settings: Record<string, unknown> = {
    permissions: {
      allow: allowPermissions,
      deny: [],
    },
  };

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify(settings, null, 2),
    'utf-8'
  );
}

/** Generate a Codex config.toml in the overlay with model and approval-mode settings. */
export function generateCodexConfig(overlayHome: string, config: JobConfig): void {
  const codexDir = path.join(overlayHome, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });

  const lines: string[] = [];

  const model = config.config?.model as string | undefined;
  if (model) {
    lines.push(`model = ${tomlString(model)}`);
  }

  if (config.mode === 'edit') {
    lines.push('approval_mode = "full-auto"');
  } else {
    lines.push('approval_mode = "suggest"');
  }

  if (config.config) {
    for (const [key, value] of Object.entries(config.config)) {
      if (key === 'model') continue;
      if (typeof value === 'string') {
        lines.push(`${key} = ${tomlString(value)}`);
      } else if (typeof value === 'boolean' || typeof value === 'number') {
        lines.push(`${key} = ${value}`);
      }
    }
  }

  fs.writeFileSync(
    path.join(codexDir, 'config.toml'),
    lines.join('\n') + '\n',
    'utf-8'
  );
}
