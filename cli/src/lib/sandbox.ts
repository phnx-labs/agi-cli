
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
  'GH_TOKEN',
  'GH_HOST',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_TOKEN',
  'GH_CONFIG_DIR',
];

const SAFE_TOOLS: Record<string, string> = {
  web_search: 'WebSearch(*)',
  web_fetch: 'WebFetch(*)',
};

const DIR_SCOPED_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep', 'notebook_edit']);

function tomlString(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`TOML value contains newline: ${JSON.stringify(value)}`);
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function resolveHostGhConfigDir(): string | null {
  if (process.env.GH_CONFIG_DIR && fs.existsSync(process.env.GH_CONFIG_DIR)) {
    return process.env.GH_CONFIG_DIR;
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(resolveRealHome(), '.config');
  const ghDir = path.join(configHome, 'gh');
  return fs.existsSync(ghDir) ? ghDir : null;
}

export function hostHasGhAuth(): boolean {
  if (process.env.GH_TOKEN || process.env.GH_ENTERPRISE_TOKEN || process.env.GITHUB_TOKEN) {
    return true;
  }
  const dir = resolveHostGhConfigDir();
  if (!dir) return false;
  return fs.existsSync(path.join(dir, 'hosts.yml'));
}

export function buildSpawnEnv(overlayHome: string, extraEnv?: Record<string, string>): Record<string, string> {
  // Forward same-host GitHub auth, but never link the real ~/.agents master key or encrypted store into a prompt-driven child.
  const env: Record<string, string> = {
    HOME: overlayHome,
    AGENTS_USER_DIR: getUserAgentsDir(),
  };

  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) {
      env[key] = process.env[key]!;
    }
  }

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

export function getJobHomePath(name: string): string {
  // Routine names are untrusted; safeJoin contains recursive cleanup inside the routines root.
  return path.join(safeJoin(getRoutinesDir(), name), 'home');
}

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

  linkHostGhConfig(overlayHome);

  if (config.allow?.dirs) {
    symlinkAllowedDirs(overlayHome, config.allow.dirs);
  }

  return overlayHome;
}

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
    try { fs.rmSync(target, { force: true }); } catch {  }
    try { createLink(source, target); } catch {  }
  }
}

export function linkHostGhConfig(overlayHome: string): void {
  const realGhDir = resolveHostGhConfigDir();
  if (!realGhDir || !fs.existsSync(realGhDir)) return;

  const overlayGhDir = path.join(overlayHome, '.config', 'gh');
  if (fs.existsSync(overlayGhDir)) return;
  fs.mkdirSync(path.dirname(overlayGhDir), { recursive: true });
  try {
    createLink(realGhDir, overlayGhDir);
  } catch {
  }
}

export function assertSandboxForwardsHostGhAuth(spawnEnv: Record<string, string>): void {
  // Fail launch when sandboxing would silently hide host GitHub auth.
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

export function generateCursorConfig(overlayHome: string): void {
  const realCursorDir = path.join(process.env.AGENTS_REAL_HOME || resolveRealHome(), '.cursor');
  const realAuth = path.join(realCursorDir, 'auth.json');
  if (!fs.existsSync(realAuth)) return;

  const overlayCursorDir = path.join(overlayHome, '.cursor');
  fs.mkdirSync(overlayCursorDir, { recursive: true });
  const overlayAuth = path.join(overlayCursorDir, 'auth.json');
  // Windows uses same-volume hard links for Cursor auth, never credential copies.
  if (process.platform === 'win32') {
    try {
      fs.linkSync(realAuth, overlayAuth);
    } catch {  }
  } else {
    fs.symlinkSync(realAuth, overlayAuth);
  }

  const realCliConfig = path.join(realCursorDir, 'cli-config.json');
  if (fs.existsSync(realCliConfig)) {
    const overlayCliConfig = path.join(overlayCursorDir, 'cli-config.json');
    try {
      if (process.platform === 'win32') fs.linkSync(realCliConfig, overlayCliConfig);
      else fs.symlinkSync(realCliConfig, overlayCliConfig);
    } catch {  }
  }
}

export function cleanJobHome(name: string): void {
  const overlayHome = getJobHomePath(name);
  if (fs.existsSync(overlayHome)) {
    fs.rmSync(overlayHome, { recursive: true, force: true });
  }
}

export function symlinkAllowedDirs(overlayHome: string, dirs: string[]): void {
  const realHome = resolveRealHome();
  for (const dir of dirs) {
    const expanded = dir.replace(/^~/, realHome);

    // Resolve traversal and symlinks before enforcing the HOME boundary; reject anything outside HOME.
    let realPath: string;
    try {
      realPath = fs.realpathSync(expanded);
    } catch {
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
        createLink(realPath, symlinkTarget);
      } catch {  }
    }
  }
}

export function generateClaudeConfig(overlayHome: string, config: JobConfig): void {
  const realHome = resolveRealHome();
  const claudeDir = path.join(overlayHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  const allowPermissions: string[] = [];
  const enabledTools = new Set(config.allow?.tools || []);

  if (config.allow?.tools) {
    for (const tool of config.allow.tools) {
      if (tool in SAFE_TOOLS) {
        allowPermissions.push(SAFE_TOOLS[tool]);
        continue;
      }

      // Filesystem tools are granted only through directory-scoped permissions; bare Bash and wildcards stay forbidden.
      if (DIR_SCOPED_TOOLS.has(tool)) {
        continue;
      }

      if (tool === 'bash') {
        throw new Error(
          'Bare "bash" not allowed in sandbox — use scoped patterns like "Bash(git *)"'
        );
      }

      if (/^\w+\(\*\)$/.test(tool)) {
        throw new Error(
          `Wildcard "${tool}" not allowed in sandbox — use scoped patterns`
        );
      }

      allowPermissions.push(tool);
    }
  }

  if (config.allow?.dirs) {
    for (const dir of config.allow.dirs) {
      const resolved = dir.replace(/^~/, realHome);

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
