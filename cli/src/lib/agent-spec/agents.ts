/**
 * Core agent configuration and detection module.
 *
 * Defines the canonical registry of current and legacy AI coding agents (Claude,
 * Codex, Gemini, Cursor, OpenCode, OpenClaw, Copilot, Amp, Goose, Grok)
 * with their CLI commands, config paths, capability flags, and MCP integration
 * points.
 *
 * Provides functions for detecting installed CLIs, resolving version-managed binaries,
 * reading account/auth info, and managing MCP server registrations across agents.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as TOML from 'smol-toml';
import * as yaml from 'yaml';
import chalk from 'chalk';
import type { AgentConfig, AgentId } from '../types.js';
import { execFileShellSpec } from '../platform/index.js';
import { latestFileMtimeMs } from '../fs-walk.js';
import { damerauLevenshtein } from '../fuzzy.js';
import { probeCapture } from '../probe.js';
import { getCacheDir, getVersionsDir, getShimsDir, getHistoryDir, getCliVersionCachePath, readMeta } from '../state.js';
import { registeredNativeAccountForEmail, parseNativeIdentityKey } from '../native-accounts.js';
import { resolveVersion, getVersionHomePath, getBinaryPath } from '../installations/versions.js';
import { supports } from '../capabilities.js';
import { MCP_TARGETS } from '../mcp-registry.js';
import { VERSION_RE } from './primitives.js';

/** Represents the installation state of an agent's CLI binary. */
export interface CliState {
  installed: boolean;
  version: string | null;
  path: string | null;
}

const execFileAsync = promisify(execFile);

const HOME = os.homedir();

/**
 * Minimum Codex CLI version that supports hooks.
 * Mirrored on `AGENTS.codex.capabilities.hooks.since` -- kept exported for
 * legacy import sites that haven't migrated to `supports()` yet.
 */
export const CODEX_HOOKS_MIN_VERSION = '0.116.0';

/** Minimum Gemini CLI version that supports the hooks system (v0.26.0, Jan 2026). */
export const GEMINI_HOOKS_MIN_VERSION = '0.26.0';

const CLI_VERSION_CACHE_PATH = getCliVersionCachePath();

interface CliVersionCacheEntry {
  binaryPath: string;
  mtime: number;
  version: string | null;
}

let cliVersionCache: Record<string, CliVersionCacheEntry> | null = null;

function loadCliVersionCache(): Record<string, CliVersionCacheEntry> {
  if (cliVersionCache) return cliVersionCache;
  try {
    cliVersionCache = JSON.parse(fs.readFileSync(CLI_VERSION_CACHE_PATH, 'utf-8'));
  } catch {
    /* missing or corrupt cache, rebuild */
    cliVersionCache = {};
  }
  return cliVersionCache!;
}

function saveCliVersionCache(): void {
  if (!cliVersionCache) return;
  try {
    const dir = path.dirname(CLI_VERSION_CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CLI_VERSION_CACHE_PATH, JSON.stringify(cliVersionCache));
  } catch {
    /* best-effort cache persist */
  }
}

/**
 * Synchronous PATH search -- no subprocess. Returns first matching binary path.
 *
 * Skips our own shims dir (`~/.agents/.cache/shims/`) — those shims are
 * dispatch helpers, not real installs. Counting them as installed produced a
 * false positive where agents with NO real binary on the host (e.g. a
 * never-installed Cursor whose only PATH entry was our `cursor-agent` shim
 * dispatcher) showed up under `agents view`'s "Not Managed by Agents CLI"
 * section, even though the user had nothing to import.
 */
interface NativeBinaryResolutionOptions {
  accept?: (candidate: string) => boolean;
  shimsDir?: string;
  historyDir?: string;
}

function pathIsWithin(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Resolve a PATH candidate to the immutable native executable agents-cli may
 * safely register. An adopted launcher can live outside the shims directory
 * while resolving back into it; in that case its durable adoption record is
 * the source of truth for the original executable.
 */
export function resolveNativeBinaryPath(
  command: string,
  candidate: string,
  options: NativeBinaryResolutionOptions = {},
): string | null {
  const shimsDir = options.shimsDir ?? getShimsDir();
  const historyDir = options.historyDir ?? getHistoryDir();

  let canonicalCandidate: string;
  try {
    canonicalCandidate = fs.realpathSync(candidate);
  } catch {
    return null;
  }

  let canonicalShimsDir = path.resolve(shimsDir);
  try {
    canonicalShimsDir = fs.realpathSync(shimsDir);
  } catch {
    /* An absent shims dir cannot make an existing native binary invalid. */
  }

  if (!pathIsWithin(canonicalCandidate, canonicalShimsDir)) return canonicalCandidate;

  const recordPath = path.join(historyDir, 'adopted-launchers', command);
  try {
    const [original] = fs.readFileSync(recordPath, 'utf-8').split(/\r?\n/, 1);
    if (!original) return null;
    const canonicalOriginal = fs.realpathSync(original);
    if (pathIsWithin(canonicalOriginal, canonicalShimsDir)) return null;
    const stat = fs.statSync(canonicalOriginal);
    if (!stat.isFile()) return null;
    fs.accessSync(canonicalOriginal, fs.constants.X_OK);
    return canonicalOriginal;
  } catch {
    return null;
  }
}

export function findInPath(command: string, options: NativeBinaryResolutionOptions = {}): string | null {
  const pathEnv = process.env.PATH || '';
  const pathExt = process.platform === 'win32' ? (process.env.PATHEXT || '').split(';') : [''];
  const shimsDir = options.shimsDir ?? getShimsDir();
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    if (path.resolve(dir) === path.resolve(shimsDir)) continue;
    for (const ext of pathExt) {
      const full = path.join(dir, command + ext);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        // A shell only runs an executable file; `which` skips a mode-644 namesake and
        // so must this, or a stray non-executable `secrets`/`claude` file earlier on
        // PATH would shadow the real binary further down. On win32 the mode bit is
        // meaningless (PATHEXT decides), so the check is POSIX-only.
        if (process.platform !== 'win32') fs.accessSync(full, fs.constants.X_OK);
        const native = resolveNativeBinaryPath(command, full, options);
        if (native && (!options.accept || options.accept(native))) return native;
      } catch {
        /* not in this dir */
      }
    }
  }
  return null;
}

/** Grok-specific binary resolution.
 * Grok does not live in node_modules/.bin. Its versioned binaries live in each
 * managed version home under `.grok/downloads/`, so detection must not follow
 * the host ~/.grok config symlink.
 */
function resolveGrokBinary(version?: string): string | null {
  if (version && version !== 'latest') {
    const binaryPath = getBinaryPath('grok', version);
    if (fs.existsSync(binaryPath)) return binaryPath;
    return null;
  }

  const resolvedVersion = resolveVersion('grok', process.cwd());
  if (resolvedVersion) {
    const binaryPath = getBinaryPath('grok', resolvedVersion);
    if (fs.existsSync(binaryPath)) return binaryPath;
  }

  const grokVersionsDir = path.join(getVersionsDir(), 'grok');
  if (!fs.existsSync(grokVersionsDir)) return null;

  let latest: string | null = null;
  let latestMtime = 0;
  for (const entry of fs.readdirSync(grokVersionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const binaryPath = getBinaryPath('grok', entry.name);
    if (!fs.existsSync(binaryPath)) continue;
    try {
      const stat = fs.statSync(binaryPath);
      if (stat.mtimeMs > latestMtime) {
        latestMtime = stat.mtimeMs;
        latest = binaryPath;
      }
    } catch {}
  }
  return latest;
}

function splitCommandLine(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let tokenStarted = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (quote) {
      if (char === quote) {
        quote = null;
        tokenStarted = true;
      } else if (char === '\\' && quote === '"' && i + 1 < command.length) {
        current += command[++i];
        tokenStarted = true;
      } else {
        current += char;
        tokenStarted = true;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        args.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }

    if (char === '\\' && i + 1 < command.length) {
      current += command[++i];
      tokenStarted = true;
      continue;
    }

    current += char;
    tokenStarted = true;
  }

  if (quote) {
    throw new Error('Unterminated quote in MCP command');
  }

  if (tokenStarted) {
    args.push(current);
  }

  if (args.length === 0) {
    throw new Error('MCP command is required');
  }

  return args;
}

/**
 * Per-harness dispatch data that used to live in `if (agentId === …)` /
 * `switch (agentId)` arms inside this file. These are stable properties of a
 * harness, not per-call-site quirks — a new AgentId must declare every field
 * (the completeness test in agents.test.ts pins that).
 *
 * Left as call-site specials (not registry data): `getAccountInfo` and
 * `readAuthAccountIdentity` — those are parsers, not flags.
 */
export type VersionStdoutMatch = 'semver' | 'openclaw';
export type UnmanagedBinaryResolver = 'path' | 'grok-downloads';
export type McpRegisterPath = 'cli' | 'config';
export type McpAddHttpStyle = 'transport' | 'url';
export type McpAddStdioStyle = 'scope' | 'simple';
export type McpConfigWriteStyle = 'json-mcpServers' | 'yaml-mcp_servers';

export interface AgentRegistryConfig extends AgentConfig {
  /**
   * Session-transcript directory as path segments under a HOME root, or null
   * when this harness has no local session tree `agents` can walk.
   */
  sessionDir: string[] | null;
  /** File extension of session transcripts, or null when unknown. */
  sessionFileExt: '.jsonl' | '.json' | null;
  /** How to parse `cli --version` stdout. */
  versionStdoutMatch: VersionStdoutMatch;
  /** How to find an unmanaged (non-version-home) binary. */
  unmanagedBinary: UnmanagedBinaryResolver;
  /**
   * How `registerMcp` / `unregisterMcp` talk to the harness. `config` writes
   * the file directly (no `mcp add` CLI); `cli` shells out.
   */
  mcpRegister: McpRegisterPath;
  /** Argv shape for `mcp add` over HTTP. */
  mcpAddHttp: McpAddHttpStyle;
  /** Argv shape for `mcp add` over stdio. */
  mcpAddStdio: McpAddStdioStyle;
  /** On-disk map key + serialization when writing MCP config directly. */
  mcpConfigWrite: McpConfigWriteStyle;
}

/**
 * Master registry of all supported agents keyed by AgentId.
 *
 * Each entry defines the agent's CLI command, npm package, config directory layout,
 * instructions file name, slash-command format, and capability flags. This is the
 * single source of truth for agent metadata consumed throughout the codebase.
 */
export const AGENTS: Record<AgentId, AgentRegistryConfig> = {
  claude: {
    id: 'claude',
    name: 'Claude',
    sessionDir: ['.claude', 'projects'],
    sessionFileExt: '.jsonl',
    versionStdoutMatch: 'semver',
    unmanagedBinary: 'path',
    mcpRegister: 'cli',
    mcpAddHttp: 'transport',
    mcpAddStdio: 'scope',
    mcpConfigWrite: 'json-mcpServers',
    color: 'magenta',
    cliCommand: 'claude',
    npmPackage: '@anthropic-ai/claude-code',
    configDir: path.join(HOME, '.claude'),
    homeFiles: ['.claude.json'],
    commandsDir: path.join(HOME, '.claude', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.claude', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'CLAUDE.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: true,
    // Claude Code grew a native `claude --cloud "<prompt>"` (Anthropic-managed
    // infra, claude.ai/code; requires claude.ai subscription auth). Routing
    // still goes to Rush Cloud deliberately — it keeps cloud tasks in one
    // tracked fleet (agents cloud list/status/logs) regardless of harness.
    cloudProvider: 'rush',
    capabilities: { hooks: true, mcp: true, mcpHttp: true, mcpHeaders: true, allowlist: true, skills: true, commands: true, plugins: true, subagents: true, rules: { file: 'CLAUDE.md' }, workflows: true, memory: true, modes: ['plan', 'edit', 'auto', 'skip'], rulesImports: true, interactiveRepl: true },
  },
  // codex hooks: gated to >= 0.116.0 (introduced [features] codex_hooks flag).
  codex: {
    id: 'codex',
    name: 'Codex',
    sessionDir: ['.codex', 'sessions'],
    sessionFileExt: '.jsonl',
    versionStdoutMatch: 'semver',
    unmanagedBinary: 'path',
    mcpRegister: 'cli',
    mcpAddHttp: 'url',
    mcpAddStdio: 'simple',
    mcpConfigWrite: 'json-mcpServers',
    color: 'green',
    cliCommand: 'codex',
    npmPackage: '@openai/codex',
    configDir: path.join(HOME, '.codex'),
    commandsDir: path.join(HOME, '.codex', 'prompts'),
    commandsSubdir: 'prompts',
    skillsDir: path.join(HOME, '.codex', 'skills'),
    hooksDir: 'hooks',
    pluginManifestDir: '.codex-plugin',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: true,
    cloudProvider: 'codex',
    // Subagents: multi-agent plumbing since 0.117.0; custom agents as
    // ~/.codex/agents/*.toml (name, description, developer_instructions).
    capabilities: { hooks: { since: '0.116.0' }, mcp: true, mcpHttp: true, mcpHeaders: false, allowlist: { since: '0.138.0' }, skills: true, commands: { until: '0.117.0' }, plugins: { since: '0.128.0' }, subagents: { since: '0.117.0' }, rules: { file: 'AGENTS.md' }, workflows: false, memory: true, modes: ['plan', 'edit', 'auto', 'skip'], interactiveRepl: true },
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    sessionDir: ['.gemini', 'tmp'],
    sessionFileExt: '.json',
    versionStdoutMatch: 'semver',
    unmanagedBinary: 'path',
    mcpRegister: 'cli',
    mcpAddHttp: 'transport',
    mcpAddStdio: 'simple',
    mcpConfigWrite: 'json-mcpServers',
    color: 'blue',
    cliCommand: 'gemini',
    npmPackage: '@google/gemini-cli',
    configDir: path.join(HOME, '.gemini'),
    commandsDir: path.join(HOME, '.gemini', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.gemini', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'GEMINI.md',
    format: 'toml',
    variableSyntax: '{{args}}',
    supportsHooks: true,
    nativeAgentsSkillsDir: true,
    // Google retired the Gemini CLI (announced at Google I/O 2026, May 19); the `gemini`
    // command stopped serving free/Pro/Ultra requests on June 18, 2026. Antigravity CLI
    // (`agy`) is the official successor. Hard deprecation keeps legacy Gemini
    // sessions/config parseable while blocking install/import/sync.
    deprecated: {
      by: 'Google',
      date: 'June 18, 2026',
      reason: 'The Gemini CLI was retired for free, Pro, and Ultra tiers and no longer serves requests (announced at Google I/O 2026 on May 19).',
      replacement: 'antigravity',
      url: 'https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/',
      hard: true,
    },
    // gemini hooks: shipped in v0.26.0 (Jan 2026); older binaries silently ignore the `hooks` key.
    // extensions: gemini-extension.json bundles shipped in v0.8.0; custom subagents in v0.36.0.
    capabilities: { hooks: { since: '0.26.0' }, mcp: true, mcpHttp: true, mcpHeaders: false, allowlist: true, skills: true, commands: true, plugins: { since: '0.8.0' }, subagents: { since: '0.36.0' }, rules: { file: 'GEMINI.md' }, workflows: false, memory: false, modes: ['plan', 'edit', 'skip'], rulesImports: true, interactiveRepl: false },
  },
  cursor: {
    id: 'cursor',
    name: 'Cursor',
    sessionDir: null,
    sessionFileExt: null,
    versionStdoutMatch: 'semver',
    unmanagedBinary: 'path',
    mcpRegister: 'cli',
    mcpAddHttp: 'transport',
    mcpAddStdio: 'simple',
    mcpConfigWrite: 'json-mcpServers',
    color: 'cyan',
    cliCommand: 'cursor-agent',
    npmPackage: '',
    cloudProvider: 'cursor',
    installScript: 'curl https://cursor.com/install -fsS | bash && mv ~/.local/bin/agent ~/.local/bin/cursor-agent && grep -q "/.local/bin" ~/.zshrc || echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.zshrc',
    configDir: path.join(HOME, '.cursor'),
    commandsDir: path.join(HOME, '.cursor', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.cursor', 'skills'),
    // Hooks: ~/.cursor/hooks.json (`{ "version": 1, "hooks": { event: [{ command }] } }`).
    // CLI hooks since 2026-01-16. See registerHooksForCursor — only CLI-fired events.
    hooksDir: 'hooks',
    // Plugins: `.cursor-plugin/plugin.json` (re-enabled in CLI 2026-05). Mirror the
    // Claude marketplace layout into ~/.cursor/plugins/ and copy the manifest into
    // pluginManifestDir so Cursor's native loader sees it (same pattern as droid/
    // codex).
    pluginManifestDir: '.cursor-plugin',
    instructionsFile: '.cursorrules',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: true,
    // Subagents: `.cursor/agents/<name>.md` (project) or `~/.cursor/agents/<name>.md`
    // (user), Markdown with YAML frontmatter (name, description, model, readonly,
    // is_background — no `color`). Shipped in cursor-agent CLI 2026.01 (Cursor 2.4,
    // 2026-01-22); cursor-agent uses CalVer build tags (e.g. 2025.11.25-<hash>), so
    // gate at `>= 2026.1.22`. The `agents sync` path enforces this (versions.ts skips
    // + warns for pre-2.4 installs); the direct `subagents add --agents cursor` path
    // writes unconditionally, same as the other since-gated agents.
    // See transformSubagentForCursor / https://cursor.com/docs/subagents.
    // Current cursor-agent builds open their interactive TUI with no argv.
    capabilities: { hooks: true, mcp: true, mcpHttp: false, mcpHeaders: false, allowlist: true, skills: true, commands: true, plugins: true, subagents: { since: '2026.1.22' }, rules: { file: '.cursorrules' }, workflows: false, memory: false, modes: ['plan', 'edit', 'skip'], interactiveRepl: true }, // allowlist: ~/.cursor/cli-config.json
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    sessionDir: null,
    sessionFileExt: null,
    versionStdoutMatch: 'semver',
    unmanagedBinary: 'path',
    mcpRegister: 'cli',
    mcpAddHttp: 'transport',
    mcpAddStdio: 'simple',
    mcpConfigWrite: 'json-mcpServers',
    color: 'yellowBright',
    cliCommand: 'opencode',
    npmPackage: 'opencode-ai',
    configDir: path.join(HOME, '.opencode'),
    commandsDir: path.join(HOME, '.opencode', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.opencode', 'skills'),
    // Plugins: TS/JS modules auto-loaded from ~/.config/opencode/plugins/ (global)
    // and .opencode/plugins/ (project). Not Claude marketplace format — see
    // installOpenCodePlugin in plugins.ts. OpenCode v1.18.4 exposes lifecycle
    // hooks through plugin modules (event/tool/etc. functions), not a native
    // opencode.json shell-command hooks block.
    hooksDir: 'hooks',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: true,
    capabilities: { hooks: { since: '0.3.130' }, mcp: true, mcpHttp: false, mcpHeaders: false, allowlist: { since: '1.1.1' }, skills: true, commands: true, plugins: true, subagents: true, rules: { file: 'AGENTS.md' }, workflows: false, memory: false, modes: ['plan', 'edit'], interactiveRepl: true },
  },
  openclaw: {
    id: 'openclaw',
    name: 'OpenClaw',
    sessionDir: null,
    sessionFileExt: null,
    versionStdoutMatch: 'openclaw',
    unmanagedBinary: 'path',
    mcpRegister: 'cli',
    mcpAddHttp: 'transport',
    mcpAddStdio: 'simple',
    mcpConfigWrite: 'json-mcpServers',
    color: 'redBright',
    cliCommand: 'openclaw',
    npmPackage: 'openclaw',
    configDir: path.join(HOME, '.openclaw'),
    commandsDir: '', // OpenClaw uses Gateway-based slash commands, not file-based
    commandsSubdir: '',
    skillsDir: path.join(HOME, '.openclaw', 'skills'),
    nativeCommandRuntime: true, // Gateway resolves slash commands — don't convert commands to skills

    hooksDir: 'hooks',
    instructionsFile: 'workspace/AGENTS.md', // Primary memory file (also has SOUL.md, IDENTITY.md, etc.)
    format: 'markdown',
    variableSyntax: '{{ARGUMENTS}}',
    // hooks: NOT supported. OpenClaw only exposes a fixed set of internal,
    // named hooks (e.g. `boot-md`, which runs BOOT.md on gateway restart) —
    // there is no general event->shell-command registration surface (no
    // PreToolUse/PostToolUse/UserPromptSubmit equivalent an agents-cli
    // hooks.yaml manifest could target). registerHooksToSettings has no
    // `openclaw` case and silently no-ops (RUSH-2122: capability claimed
    // hooks:true with zero hooks ever installed). Flip back to `true` only
    // alongside a real registerHooksForOpenClaw implementation.
    supportsHooks: false,
    // allowlist: maps blanket (whole-tool) rules to ~/.openclaw/openclaw.json
    // tools.alsoAllow (allow) / tools.deny (deny). OpenClaw gates at tool
    // granularity only, so sub-command/path/domain patterns are skipped.
    // OpenClaw is self-updating (no pinned since), so `true` is correct.
    // Workflows sync as Lobster `.lobster` files under `.openclaw/workflows/`;
    // the Lobster tool runs them by receiving the file path as `pipeline`.
    capabilities: { hooks: false, mcp: true, mcpHttp: false, mcpHeaders: false, allowlist: true, skills: true, commands: false, plugins: true, subagents: true, rules: { file: 'workspace/AGENTS.md' }, workflows: true, memory: true, modes: ['plan', 'edit', 'skip'], interactiveRepl: true },
  },
  copilot: {
    id: 'copilot',
    name: 'Copilot',
    sessionDir: ['.copilot', 'session-state'],
    sessionFileExt: '.jsonl',
    versionStdoutMatch: 'semver',
    unmanagedBinary: 'path',
    mcpRegister: 'cli',
    mcpAddHttp: 'transport',
    mcpAddStdio: 'simple',
    mcpConfigWrite: 'json-mcpServers',
    color: 'whiteBright',
    cliCommand: 'copilot',
    npmPackage: '@github/copilot',
    configDir: path.join(HOME, '.copilot'),
    commandsDir: path.join(HOME, '.copilot', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.copilot', 'skills'),
    // Hooks: user-level `~/.copilot/hooks/*.json` (GA @github/copilot, every
    // 1.x). Schema `{ "version": 1, "hooks": { event: [...] } }` with camelCase
    // event names (sessionStart, preToolUse, …). See registerHooksForCopilot.
    hooksDir: 'hooks',
    // Copilot reads a plugin's manifest from the plugin ROOT (plugin.json),
    // not `.claude-plugin/plugin.json`. Mirror it there. Verified against the
    // GitHub Copilot CLI (1.0.56): `copilot plugin install` produces an
    // installed plugin dir whose manifest sits at the root.
    pluginManifestDir: '.',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: true,
    // interactiveRepl: false — copilot requires a prompt for meaningful work; bare invocation
    // opens a welcome screen but not a persistent coding REPL suitable for agents focus.
    capabilities: { hooks: true, mcp: true, mcpHttp: false, mcpHeaders: false, allowlist: true, skills: true, commands: true, plugins: true, subagents: { since: '0.0.353' }, rules: { file: 'AGENTS.md' }, workflows: false, memory: false, modes: ['plan', 'edit', 'auto', 'skip'], interactiveRepl: false },
  },
  amp: {
    id: 'amp',
    name: 'Amp',
    sessionDir: null,
    sessionFileExt: null,
    versionStdoutMatch: 'semver',
    unmanagedBinary: 'path',
    mcpRegister: 'cli',
    mcpAddHttp: 'transport',
    mcpAddStdio: 'simple',
    mcpConfigWrite: 'json-mcpServers',
    color: 'blueBright',
    cliCommand: 'amp',
    npmPackage: '@sourcegraph/amp',
    configDir: path.join(HOME, '.config', 'amp'),
    commandsDir: path.join(HOME, '.config', 'amp', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.config', 'amp', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: false,
    // interactiveRepl: false — amp requires a prompt; bare invocation exits immediately.
    capabilities: { hooks: false, mcp: true, mcpHttp: false, mcpHeaders: false, allowlist: false, skills: true, commands: true, plugins: false, subagents: false, rules: { file: 'AGENTS.md' }, workflows: false, memory: false, modes: ['plan', 'edit'], interactiveRepl: false },
  },
  goose: {
    id: 'goose',
    name: 'Goose',
    sessionDir: null,
    sessionFileExt: null,
    versionStdoutMatch: 'semver',
    unmanagedBinary: 'path',
    mcpRegister: 'cli',
    mcpAddHttp: 'transport',
    mcpAddStdio: 'simple',
    mcpConfigWrite: 'json-mcpServers',
    color: 'magentaBright',
    cliCommand: 'goose',
    npmPackage: '',
    installScript: 'brew install block-goose-cli',
    configDir: path.join(HOME, '.config', 'goose'),
    commandsDir: path.join(HOME, '.config', 'goose', 'commands'),
    commandsSubdir: 'commands',
    // Goose reads skills directly from central ~/.agents/skills/ via the Summon
    // extension (block-goose-cli ≥ 1.25.0). No per-version copy is written.
    skillsDir: path.join(HOME, '.agents', 'skills'),
    nativeAgentsSkillsDir: true,
    // Hooks: Open Plugins format — auto-discovered from
    // ~/.agents/plugins/<name>/hooks/hooks.json (shipped block-goose-cli
    // ≥ 1.34.0). See registerHooksForGoose.
    hooksDir: 'hooks',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: true,
    // Plugins: Open Plugins under ~/.agents/plugins/<name>/ (same layout as
    // agents-cli source). Version isolation copies into versionHome/.agents/plugins/.
    // Workflows sync as Goose recipe YAML. Permissions are NOT supported:
    // permission.yaml gates whole tools, so canonical rules cannot round-trip.
    // Commands: a Goose slash command is a recipe YAML under
    // ~/.config/goose/commands/<name>.yaml, registered in ~/.config/goose/config.yaml
    // under `slash_commands: [{ command, recipe_path }]` (see goose-commands.ts).
    // Subagents: recipe YAML named agents under ~/.config/goose/agents/<name>.yaml
    // (goose auto-discovers and delegates to them by name in autonomous mode).
    capabilities: { hooks: { since: '1.34.0' }, mcp: true, mcpHttp: false, mcpHeaders: false, allowlist: false, skills: { since: '1.25.0' }, commands: true, plugins: true, subagents: true, rules: { file: 'AGENTS.md' }, workflows: true, memory: false, modes: ['edit'], interactiveRepl: true },
  },
  // Google Antigravity CLI (`agy`) — official replacement for Gemini CLI as of IO 2026.
  // configDir nests inside `~/.gemini/` since agy shares the parent dir with the Gemini
  // CLI but isolates its own state in the `antigravity-cli/` subdir. Per-version HOME
  // isolation works because the shim's configDirName carries the full nested path.
  // Auth: Google OAuth on first launch, or ANTIGRAVITY_API_KEY env var for headless.
  // Hooks: JSON entries under a top-level `hooks` key in settings.json; events are
  // before_tool_call, after_model_call, on_loop_stop, on_error. Plugins are the
  // renamed Gemini CLI extensions. Permissions live in settings.json under a
  // `permissions` key with allow/deny arrays.
  antigravity: {
    id: 'antigravity',
    name: 'Antigravity',
    sessionDir: null,
    sessionFileExt: null,
    versionStdoutMatch: 'semver',
    unmanagedBinary: 'path',
    mcpRegister: 'cli',
    mcpAddHttp: 'transport',
    mcpAddStdio: 'simple',
    mcpConfigWrite: 'json-mcpServers',
    color: 'blueBright',
    cliCommand: 'agy',
    npmPackage: '',
    installScript: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    configDir: path.join(HOME, '.gemini', 'antigravity-cli'),
    authFiles: ['antigravity-oauth-token'],
    commandsDir: path.join(HOME, '.gemini', 'antigravity-cli', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.gemini', 'antigravity-cli', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '{{args}}',
    supportsHooks: true,
    cloudProvider: 'antigravity',
    capabilities: { hooks: true, mcp: true, mcpHttp: false, mcpHeaders: false, allowlist: true, skills: true, commands: true, plugins: true, subagents: { since: '1.0.16' }, rules: { file: 'AGENTS.md' }, workflows: { since: '1.0.6' }, memory: false, modes: ['edit', 'skip'], rulesImports: false, interactiveRepl: true }, // workflows: markdown files in the shared, HOME-global ~/.gemini/config/global_workflows/ (agy scans it at startup; not version-isolated — see workflows.ts), invoked as /<name> slash commands
  },
  // xAI Grok Build CLI (`grok`) — early beta, SuperGrok Heavy. Auth via OAuth on
  // first launch, or XAI_API_KEY env var for headless. MCP servers configured inline
  // under [mcp_servers] in ~/.grok/config.toml. Hooks auto-discovered from
  // ~/.grok/hooks/ (+ project .grok/hooks/) — events PreToolUse, PostToolUse, etc.
  // Plugins live in ~/.grok/plugins/ with marketplaces. Permissions: --allow/--deny
  // CLI flags or [permission] TOML block in ~/.grok/config.toml.
  // Workflows (native Rhai orchestration) enabled by default as of v0.2.111 —
  // projected into ~/.grok/workflows/<name>.rhai (under GROK_HOME isolation).
  grok: {
    id: 'grok',
    name: 'Grok',
    sessionDir: ['.grok', 'sessions'],
    sessionFileExt: '.json',
    versionStdoutMatch: 'semver',
    unmanagedBinary: 'grok-downloads',
    mcpRegister: 'cli',
    mcpAddHttp: 'transport',
    mcpAddStdio: 'simple',
    mcpConfigWrite: 'json-mcpServers',
    color: 'cyanBright',
    cliCommand: 'grok',
    npmPackage: '',
    installScript: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    configDir: path.join(HOME, '.grok'),
    // Grok discovers file-based slash commands from ~/.agents/commands/ (the
    // cross-agent compat dir it mirrors from Claude Code) as well as the legacy
    // ~/.claude/commands/ symlink. We write there directly so the per-agent
    // install path and the central user repo stay in sync.
    commandsDir: path.join(HOME, '.agents', 'commands'),
    commandsSubdir: path.join('..', '.agents', 'commands'),
    skillsDir: path.join(HOME, '.grok', 'skills'),
    hooksDir: path.join(HOME, '.grok', 'hooks'),
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: true,
    capabilities: {
      hooks: true,
      mcp: true,
      mcpHttp: false,
      mcpHeaders: false,
      allowlist: true, // maps to Grok's granular Bash/Edit/Write/Read/Grep/WebFetch/MCPTool rules
      skills: true,
      commands: true, // Grok >= 0.2.111: file-based slash commands from ~/.agents/commands/ (docs) + ~/.claude/commands/ (Claude Code compat)
      plugins: true,
      subagents: true, // ~/.grok/agents/*.md (Claude-compatible agent defs)
      rules: { file: 'AGENTS.md' },
      // Native workflows (`.rhai` under ~/.grok/workflows/) shipped on-by-default
      // in v0.2.111 (2026-07-22). See transformWorkflowForGrok in workflows.ts.
      workflows: { since: '0.2.111' },
      memory: true,
      modes: ['plan', 'edit', 'skip'],
      // grok's `--permission-mode plan` silently stalls a headless `-p` run at
      // its ExitPlanMode gate (no TTY to approve). Headless plan auto-downgrades
      // to auto (→ edit via resolveMode). Interactive plan is unaffected.
      headlessPlan: false,
      rulesImports: true,
      interactiveRepl: true,
    },
  },
  // Kimi Code CLI (`kimi`) — Moonshot AI coding agent.
  // Install: `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`
  //    or: `npm install -g @moonshot-ai/kimi-code`
  // Config: `~/.kimi-code/config.toml`, `~/.kimi-code/mcp.json`,
  //         `~/.kimi-code/skills/`, `~/.kimi-code/hooks/`
  kimi: {
    id: 'kimi',
    name: 'Kimi',
    sessionDir: null,
    sessionFileExt: null,
    versionStdoutMatch: 'semver',
    unmanagedBinary: 'path',
    mcpRegister: 'cli',
    mcpAddHttp: 'transport',
    mcpAddStdio: 'simple',
    mcpConfigWrite: 'json-mcpServers',
    color: 'magentaBright',
    cliCommand: 'kimi',
    npmPackage: '@moonshot-ai/kimi-code',
    installScript: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
    configDir: path.join(HOME, '.kimi-code'),
    authFiles: ['credentials/kimi-code.json'],
    commandsDir: '',
    commandsSubdir: '',
    skillsDir: path.join(HOME, '.kimi-code', 'skills'),
    hooksDir: path.join(HOME, '.kimi-code', 'hooks'),
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: true,
    capabilities: {
      hooks: true,
      mcp: true,
      mcpHttp: false,
      mcpHeaders: false,
      allowlist: true,
      skills: true,
      commands: false,
      plugins: true,
      // Claude-shaped agent markdown under ~/.kimi-code/agents/. kimi-code
      // discovers that dir from `USER_BRAND_DIRS = ["agents"]` (agent-file
      // discovery, added in 0.29.0); 0.28.x and older compile their four agent
      // profiles into the bundle with no filesystem loader at all, so a synced
      // file there is never read.
      subagents: { since: '0.29.0' },
      rules: { file: 'AGENTS.md' },
      workflows: true,
      memory: false,
      modes: ['plan', 'edit', 'auto', 'skip'],
      // kimi's headless `-p` refuses to combine with `--plan` (`Cannot combine
      // --prompt with --plan`). Headless plan auto-downgrades to auto (kimi -p
      // auto-runs). Interactive plan is unaffected.
      headlessPlan: false,
      rulesImports: false,
      interactiveRepl: true,
    },
  },
  // Factory AI Droid CLI (`droid`) — agentic coding CLI from factory.ai.
  // Install: `curl -fsSL https://app.factory.ai/cli | sh` (no npm package).
  // Binary is NOT in node_modules/.bin — the shim resolves the fixed install
  // path ~/.local/bin/droid directly (see the droid branch in shims.ts).
  // Config: `~/.factory/` (settings.json, mcp.json, droids/, commands/, hooks/,
  // plugins/). Memory: native AGENTS.md. Subagents = custom droids (top-level
  // .md files in ~/.factory/droids/). Config isolation rides the ~/.factory
  // symlink switch (no FACTORY_HOME env var exists). Headless:
  // `droid exec "<prompt>"` with --auto low|medium|high, -o stream-json,
  // -m <model>, -r <effort>.
  //
  // Hooks: Claude-shaped. settings.json carries a top-level `hooks` object keyed
  // by event (PreToolUse, PostToolUse, UserPromptSubmit, SessionStart,
  // SessionEnd, Stop, SubagentStop, Notification, PreCompact), each an array of
  // `{ matcher?, hooks: [{ type: "command", command, timeout? }] }` matcher
  // groups — verified against the droid binary's zod schema. So the Claude
  // registrar is reused verbatim, just targeting `.factory/settings.json`.
  //
  // Plugins: native `droid plugin` command group + ~/.factory/plugins/ with the
  // same marketplace layout Claude uses (known_marketplaces.json +
  // marketplaces/<name>/plugins/<plugin>/). Droid's plugin manifest dir is
  // `.factory-plugin/` (it also reads `.claude-plugin/` for compatibility) — set
  // pluginManifestDir so syncPluginToVersion mirrors the manifest into it, the
  // same pattern codex uses with `.codex-plugin`.
  //
  // Workflows / Factory Missions (RUSH-1864, probed droid v0.177.0; ticket cited
  // v0.161.0 — self-updating, no pinnable semver): Factory ships genuine multi-
  // step orchestration ("Missions") via `/missions` (interactive) and
  // `droid exec --mission` (headless; optional `-f <prompt.md>` is a *prompt*
  // file, not a named mission template). Docs:
  // https://docs.factory.ai/cli/features/missions and
  // https://docs.factory.ai/docs/droid-exec/overview (Mission Mode).
  //
  // Mission state may land under `~/.factory/missions/<sessionId>/` at runtime
  // (`getMissionsDir` = join(home, ".factory", "missions") + per-session
  // mission.md / features.json / progress_log.jsonl) — that is **session
  // runtime state**, not a discovery directory of installable named workflows.
  // There is no discoverMission / template registry, and a cold install has no
  // `~/.factory/missions/` until a mission is run. agents-cli's workflows
  // capability means "sync WORKFLOW.md into an auto-discovered dir" — Droid
  // has no such dir, so workflows stays false (invoke-only; do not fabricate a
  // writer target).
  droid: {
    id: 'droid',
    name: 'Droid',
    sessionDir: ['.factory', 'sessions'],
    sessionFileExt: '.jsonl',
    versionStdoutMatch: 'semver',
    unmanagedBinary: 'path',
    mcpRegister: 'cli',
    mcpAddHttp: 'transport',
    mcpAddStdio: 'simple',
    mcpConfigWrite: 'json-mcpServers',
    color: 'yellowBright',
    cliCommand: 'droid',
    npmPackage: '',
    installScript: 'curl -fsSL https://app.factory.ai/cli | sh',
    configDir: path.join(HOME, '.factory'),
    authFiles: ['auth.v2.file', 'auth.v2.key'],
    commandsDir: path.join(HOME, '.factory', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.factory', 'skills'),
    hooksDir: 'hooks',
    pluginManifestDir: '.factory-plugin',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: true,
    // Factory Droid Computers (cloud VMs) reached via `droid computer ssh` +
    // remote headless `droid exec`.
    cloudProvider: 'factory',
    capabilities: {
      hooks: true,
      mcp: true,
      mcpHttp: false,
      mcpHeaders: false,
      allowlist: { since: '0.57.5' },
      skills: { since: '0.26.0' },
      commands: true,
      plugins: true,
      subagents: true,
      rules: { file: 'AGENTS.md' },
      // Factory Missions are invoke-only — no installable discovery dir (RUSH-1864).
      workflows: false,
      memory: false,
      modes: ['plan', 'edit', 'auto', 'skip'],
      rulesImports: false,
      interactiveRepl: true,
    },
  },
  // Nous Hermes Agent. Config lives under ~/.hermes/config.yaml; MCP servers
  // are YAML `mcp_servers`, skills are local SKILL.md directories, and durable
  // memory is file-backed.
  hermes: {
    id: 'hermes',
    name: 'Hermes',
    sessionDir: null,
    sessionFileExt: null,
    versionStdoutMatch: 'semver',
    unmanagedBinary: 'path',
    mcpRegister: 'config',
    mcpAddHttp: 'transport',
    mcpAddStdio: 'simple',
    mcpConfigWrite: 'yaml-mcp_servers',
    color: 'cyanBright',
    cliCommand: 'hermes',
    npmPackage: '',
    installScript: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
    configDir: path.join(HOME, '.hermes'),
    commandsDir: '',
    commandsSubdir: '',
    skillsDir: path.join(HOME, '.hermes', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'MEMORY.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: true,
    // Plugins: Hermes loads plugins from a flat `~/.hermes/plugins/<name>/` dir
    // with a `plugin.yaml` manifest; a plugin only loads once its name is in the
    // `plugins.enabled` allowlist in `~/.hermes/config.yaml` (deny-list
    // `plugins.disabled` wins). Not the Claude marketplace layout, so it installs
    // via a flat-copy branch (mirrors goose) plus a YAML allowlist toggle.
    // See https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins
    capabilities: {
      // Lifecycle hooks land in ~/.hermes/config.yaml under a `hooks:` block
      // (YAML, shared with `mcp_servers`); gated to Hermes ≥ 0.11.0 which
      // introduced the configurable hook runner.
      hooks: { since: '0.11.0' },
      mcp: true,
      mcpHttp: true,
      mcpHeaders: false,
      // Permissions: ~/.hermes/config.yaml carries `command_allowlist` for
      // always-approved command globs and `approvals.deny` for unconditional
      // command blocks. It is command-glob only; session `/tools` toggles are
      // intentionally not persisted by agents-cli.
      allowlist: true,
      skills: true,
      commands: false,
      plugins: true,
      subagents: false,
      rules: { file: 'MEMORY.md' },
      workflows: false,
      memory: true,
      modes: ['edit'],
      rulesImports: false,
      interactiveRepl: true,
    },
  },
  // Meta Muse Code (`muse`) — first-class harness for Meta's coding agent (terminal/CI), built on
  // Muse Spark. Native binary via curl installer (self-updating; no npm package).
  // Config: `~/.config/muse/settings.json` (requires `"schema_version": 1`).
  // Sessions: `~/.local/share/muse/sessions/YYYY/MM/DD/<uuid>/session.jsonl`.
  // Skills: `~/.config/muse/skills` + `~/.agents/skills` + project `.agents/skills`.
  // MCP: `mcp_servers` in settings.json (stdio / streamable_http transports).
  // Headless: `muse exec "<prompt>"` with --model, --reasoning-effort, --json,
  // --yolo / --disable-approval / --disable-sandbox. Auth: META_API_KEY or
  // browser OAuth stored at `~/.config/muse/auth.json`. Default model:
  // muse-spark-1.2. Docs: https://dev.meta.ai/docs/muse-code
  muse: {
    id: 'muse',
    name: 'Muse',
    sessionDir: ['.local', 'share', 'muse', 'sessions'],
    sessionFileExt: '.jsonl',
    versionStdoutMatch: 'semver',
    unmanagedBinary: 'path',
    mcpRegister: 'cli',
    mcpAddHttp: 'transport',
    mcpAddStdio: 'simple',
    mcpConfigWrite: 'json-mcpServers',
    color: 'blueBright',
    cliCommand: 'muse',
    npmPackage: '',
    installScript: 'curl -fsSL https://dev.meta.ai/install.sh | sh',
    configDir: path.join(HOME, '.config', 'muse'),
    authFiles: ['auth.json'],
    commandsDir: '',
    commandsSubdir: '',
    skillsDir: path.join(HOME, '.config', 'muse', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    // Muse hooks use the Claude-shaped settings.json hooks block (matcher +
    // command groups) under ~/.config/muse/settings.json, plus project
    // `.muse/hooks.json`. registerHooksForClaude is reused with Muse's config
    // dir and schema_version: 1.
    supportsHooks: true,
    // Claude-compatible marketplace layout + native `.muse-plugin/` manifest.
    pluginManifestDir: '.muse-plugin',
    capabilities: {
      // Hooks: Claude-compatible event→matcher→command groups in settings.json.
      hooks: true,
      mcp: true,
      mcpHttp: true,
      mcpHeaders: true,
      // Muse's safety model is approval-mode + OS sandbox (CLI flags), not a
      // Claude-style tool-name allow/deny list. No settings.permissions writer.
      allowlist: false,
      skills: true,
      // No slash-command file dir; skills double as reusable workflows.
      commands: false,
      // Plugins: Claude marketplace + .muse-plugin (syncPluginToVersion).
      plugins: true,
      // Runtime multi-agent / subagents exist, but there is no installable
      // subagent-definition directory for agents-cli to sync into (capability
      // table must stay truthful — see subagents-registry completeness).
      subagents: false,
      rules: { file: 'AGENTS.md' },
      workflows: false,
      // Portable memory at <repo>/.agents/memory/ + personal scopes.
      memory: true,
      modes: ['plan', 'edit', 'auto', 'skip'],
      rulesImports: false,
      interactiveRepl: true,
    },
  },
  // Warp Agent CLI (`warp`) — Warp's standalone interactive TUI coding agent
  // (docs.warp.dev/cli). Installed by the official cross-platform installer
  // `curl -fsSL https://app.warp.dev/download/agent-cli | bash` (Windows: the
  // sibling agent-cli.ps1), which drops a self-updating `warp` binary at
  // ~/.local/bin/warp — NOT the older `oz` platform runner (brew cask `oz` /
  // apt `oz-stable`), a separate headless product that no longer matches this
  // CLI. Config lives under `~/.warp/` (`.mcp.json`, `skills/`, `tui/`). It is
  // interactive-only: bare `warp` opens the TUI (streamed responses, diffs,
  // inline approvals). There is NO headless one-shot form — the documented
  // flags are --api-key / --auto-approve / --resume <token> /
  // --set-provider-api-key / --clear-provider-api-key / --version / --help; no
  // -p/--prompt, no --model (model is the `/model` picker), no JSON output.
  // Auth: interactive browser sign-in on launch, or the `WARP_API_KEY` env
  // token / `--api-key` for CI. Rules/context file is `AGENTS.md` (also reads
  // WARP.md / CLAUDE.md). Conversations sync SERVER-SIDE to the Warp/Oz
  // platform (resume a prior one with `warp --resume <token>`), so there is no
  // local transcript for `agents sessions` to index — warp is intentionally
  // absent from SESSION_AGENTS.
  // Docs: https://docs.warp.dev/cli/quickstart
  warp: {
    id: 'warp',
    name: 'Warp',
    sessionDir: null,
    sessionFileExt: null,
    versionStdoutMatch: 'semver',
    unmanagedBinary: 'path',
    mcpRegister: 'cli',
    mcpAddHttp: 'transport',
    mcpAddStdio: 'simple',
    mcpConfigWrite: 'json-mcpServers',
    color: 'blueBright',
    cliCommand: 'warp',
    npmPackage: '',
    installScript: 'curl -fsSL https://app.warp.dev/download/agent-cli | bash',
    configDir: path.join(HOME, '.warp'),
    commandsDir: '',
    commandsSubdir: '',
    skillsDir: path.join(HOME, '.warp', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    // Warp has no event->shell-command hook registration surface (its startup
    // flags are --api-key/--auto-approve/--resume/--set-provider-api-key/
    // --clear-provider-api-key — no hooks).
    supportsHooks: false,
    capabilities: {
      hooks: false,
      // MCP: Warp reads the Claude `{ "mcpServers": {...} }` schema from
      // `.warp/.mcp.json` (user `~/.warp/.mcp.json`, project `<root>/.warp/.mcp.json`),
      // stdio + http with headers, same schema as Claude's .mcp.json.
      mcp: true,
      mcpHttp: true,
      mcpHeaders: true,
      // Autonomy is a single toggle (`--auto-approve`), not a Claude-style
      // tool-name allow/deny list agents-cli can write — so no allowlist writer
      // (mirrors muse).
      allowlist: false,
      // Skills searched in `.agents/skills/`, `.warp/skills/`, `.claude/skills/`,
      // `.codex/skills/`.
      skills: true,
      // Slash-commands are native/server-managed (no droppable markdown
      // command-file directory for agents-cli to sync into).
      commands: false,
      // No Claude marketplace / plugin manifest support.
      plugins: false,
      // Cloud agents are server-side; no installable subagent-definition
      // directory to sync into (keeps the table truthful).
      subagents: false,
      rules: { file: 'AGENTS.md' },
      workflows: false,
      memory: false,
      // No per-run permission flag beyond `--auto-approve`; the single `edit`
      // mode maps to no flags (mirrors hermes).
      modes: ['edit'],
      rulesImports: false,
      // Bare `warp` opens the interactive TUI (its only run form).
      interactiveRepl: true,
    },
  },
};

/** All current and legacy agent IDs derived from the AGENTS registry. */
export const ALL_AGENT_IDS: AgentId[] = Object.keys(AGENTS) as AgentId[];

/**
 * Agents the routine daemon can fire locally. Lives here (not runner.ts) so
 * routines.ts can import it for schedule-time validation without a circular
 * import (runner.ts already imports from routines.ts).
 *
 * This is a curated subset of AGENT_COMMANDS, not "every harness that can run
 * headlessly". Expanding it is a product change (gemini is hard-deprecated and
 * is deliberately absent). Argv itself is baked from AGENT_COMMANDS in
 * daemon/runner.ts bakeRoutineArgv — do not reintroduce a second token table.
 */
export const ROUTINE_AGENT_IDS: readonly string[] = Object.freeze([
  'claude',
  'codex',
  // gemini is hard-deprecated (Antigravity replaced it) — no routine target. A
  // legacy gemini routine now fails validateJob loud instead of firing a
  // retired backend; the id survives only for reading old sessions/config.
  'cursor',
  'kimi',
  'droid',
  'muse',
]);

/** Agents retained only for legacy reads, not install/import/sync targets. */
export const HARD_DEPRECATED_AGENT_IDS: AgentId[] = ALL_AGENT_IDS.filter((id) => AGENTS[id].deprecated?.hard);

/** Agents that can receive managed installs, imports, and resource sync writes. */
export const MANAGED_AGENT_IDS: AgentId[] = ALL_AGENT_IDS.filter((id) => !AGENTS[id].deprecated?.hard);

/**
 * A self-updating agent is a single global binary installed by an official
 * `curl … | sh` / `brew install` script that carries NO version token — the
 * installer can only ever fetch the *current* release, and the binary then keeps
 * itself up to date in place (droid, grok, antigravity, cursor, hermes,
 * goose). There is no semver to pin, so agents-cli must not model these as
 * having multiple installable version-homes the way it does for npm-packaged
 * agents (claude, codex, kimi, …).
 *
 * The predicate is `!npmPackage && installScript && !installScript.includes('VERSION')`:
 *   - `npmPackage` empty       → not installed from npm, so `agents add x@1.2.3`
 *                                can't resolve a registry version.
 *   - `installScript` present  → it IS installed by a script (not unmanaged).
 *   - no `VERSION` placeholder → the script has no slot for a pinned version
 *                                (contrast: an installer templated with `VERSION`
 *                                could pin, and is NOT self-updating).
 *
 * Route every "is this a pinnable, multi-version agent?" decision through here —
 * never a scattered `agent === 'droid'`.
 */
export function isSelfUpdatingAgent(agent: AgentId): boolean {
  const cfg = AGENTS[agent];
  return !cfg.npmPackage && !!cfg.installScript && !cfg.installScript.includes('VERSION');
}

export function isAgentHardDeprecated(agent: AgentId): boolean {
  // Tolerate ids outside the registry (legacy YAML, test fixtures): an unknown
  // agent is not hard-deprecated — its own validation rejects it elsewhere.
  return AGENTS[agent]?.deprecated?.hard === true;
}

// Capability-filtered agent lists used to live here as `*_CAPABLE_AGENTS`
// constants. They were a frequent source of silent-skip bugs (e.g. grok
// rules sync gated on `COMMANDS_CAPABLE_AGENTS`). Use `capableAgents(cap)`
// from `./capabilities.js` instead — it consults the AgentConfig matrix
// directly, so a single source of truth drives every gate.

/** Get the chalk color function for an agent. Works for any AgentId or SessionAgentId. */
export function colorAgent(agentId: string): (s: string) => string {
  const agent = AGENTS[agentId as AgentId];
  if (!agent) return chalk.white;
  return chalk[agent.color];
}

/** Return the agent's display name, colored. */
export function agentLabel(agentId: string): string {
  const agent = AGENTS[agentId as AgentId];
  if (!agent) return agentId;
  return chalk[agent.color](agent.name);
}

/** Check whether the given agent's CLI binary is present on PATH. */
export async function isCliInstalled(agentId: AgentId): Promise<boolean> {
  const agent = AGENTS[agentId];
  return findInPath(agent.cliCommand) !== null;
}

/** Return the installed CLI version for the given agent, or null if not found. */
export async function getCliVersion(agentId: AgentId): Promise<string | null> {
  const agent = AGENTS[agentId];
  const binaryPath = findInPath(agent.cliCommand);
  if (!binaryPath) return null;
  return getCachedVersionForBinary(agentId, binaryPath);
}

/** Return the absolute path to the agent's CLI binary on PATH, or null. */
export async function getCliPath(agentId: AgentId): Promise<string | null> {
  return findInPath(AGENTS[agentId].cliCommand);
}

/** Look up version from cache by (binary, mtime). On miss or stale, spawn `--version` and cache. */
async function getCachedVersionForBinary(agentId: AgentId, binaryPath: string): Promise<string | null> {
  let mtime = 0;
  try {
    mtime = fs.statSync(binaryPath).mtimeMs;
  } catch {
    /* binary vanished between findInPath and statSync */
    return null;
  }

  const cache = loadCliVersionCache();
  const cached = cache[agentId];
  if (cached && cached.binaryPath === binaryPath && cached.mtime === mtime) {
    return cached.version;
  }

  const agent = AGENTS[agentId];
  let version: string | null = null;
  try {
    // probeCapture, not bare execFileAsync: a probed harness can fork its own
    // children (copilot's platform-binary downloader), and a timeout kill of
    // the direct child would orphan them mid-write (RUSH-3028). The probe runs
    // in its own process group and the whole group is reaped on settle.
    const { stdout } = await probeCapture(agent.cliCommand, ['--version'], 3000);
    const versionRe = agent.versionStdoutMatch === 'openclaw'
      ? /openclaw\/(\d+\.\d+\.\d+)/
      : /(\d+\.\d+\.\d+)/;
    const match = stdout.match(versionRe);
    version = match ? match[1] : stdout.trim();
  } catch {
    /* version command failed */
    version = null;
  }

  // Skip persisting null results — the most common cause is a transient
  // `--version` failure (slow startup, stdout race, etc.). A sticky-null
  // entry kept users in a broken state where every subsequent
  // `getCachedVersionForBinary` short-circuited to null forever, even
  // after the binary started working. Re-probing on the next call costs
  // one execFile; persisting null costs the whole feature.
  if (version !== null) {
    cache[agentId] = { binaryPath, mtime, version };
    saveCliVersionCache();
  }
  return version;
}

/**
 * Resolve the full CLI state for an agent: whether it is installed, its version,
 * and the path to the binary. Checks version-managed installs first, then falls
 * back to a plain PATH lookup.
 */
export async function getCliState(agentId: AgentId): Promise<CliState> {
  // Fast path: if version-managed, derive state from filesystem (no subprocesses)
  const agent = AGENTS[agentId];
  const agentVersionsDir = path.join(getVersionsDir(), agentId);
  if (fs.existsSync(agentVersionsDir)) {
    // Use resolved version (project manifest -> global default)
    const resolvedVer = resolveVersion(agentId, process.cwd());
    if (resolvedVer) {
      const binaryPath = path.join(agentVersionsDir, resolvedVer, 'node_modules', '.bin', agent.cliCommand);
      if (fs.existsSync(binaryPath)) {
        const shimPath = path.join(getShimsDir(), agent.cliCommand);
        return {
          installed: true,
          version: resolvedVer,
          path: fs.existsSync(shimPath) ? shimPath : binaryPath,
        };
      }
    }

    // Fallback: if no default set or resolved version not installed, return first available
    const entries = fs.readdirSync(agentVersionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const binaryPath = path.join(agentVersionsDir, entry.name, 'node_modules', '.bin', agent.cliCommand);
        if (fs.existsSync(binaryPath)) {
          const shimPath = path.join(getShimsDir(), agent.cliCommand);
          return {
            installed: true,
            version: entry.name,
            path: fs.existsSync(shimPath) ? shimPath : binaryPath,
          };
        }
      }
    }
  }

  return getUnmanagedCliState(agentId);
}

/**
 * Resolve the agent's OWN install — the one agents-cli does not manage — by plain
 * PATH lookup, ignoring the version dirs entirely.
 *
 * Callers that specifically mean "the user's own globally-installed CLI" must use
 * this rather than `getCliState`, whose managed fast path reports an installed
 * version (any version dir, in readdir order) and would therefore hand back an
 * isolated copy — a copy that is deliberately unreachable from PATH — labelled as
 * the global install.
 */
export async function getUnmanagedCliState(agentId: AgentId): Promise<CliState> {
  const agent = AGENTS[agentId];
  // Grok (and any future harness with unmanagedBinary: 'grok-downloads')
  // keeps versioned binaries under ~/.grok/downloads/, not on PATH.
  if (agent.unmanagedBinary === 'grok-downloads') {
    const grokBin = resolveGrokBinary();
    if (!grokBin) {
      return { installed: false, version: null, path: null };
    }
    return {
      installed: true,
      version: await getCachedVersionForBinary(agentId, grokBin),
      path: grokBin,
    };
  }

  const binaryPath = findInPath(agent.cliCommand);
  if (!binaryPath) {
    return { installed: false, version: null, path: null };
  }
  return {
    installed: true,
    version: await getCachedVersionForBinary(agentId, binaryPath),
    path: binaryPath,
  };
}

/** Resolve CLI state for all registered agents in parallel. */
export async function getAllCliStates(): Promise<Partial<Record<AgentId, CliState>>> {
  const states: Partial<Record<AgentId, CliState>> = {};
  const results = await Promise.all(
    ALL_AGENT_IDS.map(async (agentId) => ({
      agentId,
      state: await getCliState(agentId),
    }))
  );
  for (const { agentId, state } of results) {
    states[agentId] = state;
  }
  return states;
}

/** Info about an existing unmanaged agent installation. */
export interface UnmanagedInstall {
  agentId: AgentId;
  configDir: string;
  version: string | null;
}

/**
 * Agents that `agents setup` probes for pre-existing native installations
 * (i.e., a config dir present before agents-cli took over). Derived from
 * `sessionDir` so a new harness cannot be walkable yet missing from setup.
 */
export const UNMANAGED_DETECTION_CANDIDATES: AgentId[] = ALL_AGENT_IDS.filter(
  (id) => AGENTS[id].sessionDir !== null,
);

/**
 * Detect existing agent installations that are NOT yet managed by agents-cli.
 * Returns agents whose config dir exists as a real directory (not a symlink).
 */
export async function getUnmanagedAgentInstalls(): Promise<UnmanagedInstall[]> {
  const unmanaged: UnmanagedInstall[] = [];

  for (const agentId of UNMANAGED_DETECTION_CANDIDATES) {
    const agent = AGENTS[agentId];
    try {
      const stat = fs.lstatSync(agent.configDir);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        const version = await getCliVersion(agentId);
        unmanaged.push({ agentId, configDir: agent.configDir, version });
      }
    } catch {
      // Config dir doesn't exist
    }
  }

  return unmanaged;
}

/** Create the agent's slash-commands directory if it does not exist. */
export function ensureCommandsDir(agentId: AgentId): void {
  const agent = AGENTS[agentId];
  if (!fs.existsSync(agent.commandsDir)) {
    fs.mkdirSync(agent.commandsDir, { recursive: true });
  }
}

/** Create the agent's skills directory if it does not exist. */
export function ensureSkillsDir(agentId: AgentId): void {
  const agent = AGENTS[agentId];
  if (!fs.existsSync(agent.skillsDir)) {
    fs.mkdirSync(agent.skillsDir, { recursive: true });
  }
}

/**
 * The agent's config-dir name relative to $HOME — e.g. '.claude',
 * '.gemini/antigravity-cli', '.config/amp', '.kimi-code'.
 *
 * Path segment to join onto a (version) home root when locating an agent's
 * commands/skills/plugins. Do NOT hardcode `.${agentId}`: it is wrong for
 * every agent whose config dir is nested or under ~/.config — antigravity
 * (~/.gemini/antigravity-cli), amp (~/.config/amp), goose (~/.config/goose),
 * kimi (~/.kimi-code). Mirrors the shim configDirName derivation in shims.ts.
 *
 * Relativized against the module-level HOME constant (the same value used to
 * build every `configDir`), NOT a fresh `os.homedir()` — so the result stays a
 * clean relative name even when HOME is overridden after module load (tests,
 * sandboxes). Using `os.homedir()` here would yield `../../real/home/.claude`.
 */
export function agentConfigDirName(agentId: AgentId): string {
  return path.relative(HOME, AGENTS[agentId].configDir);
}

/** Account identity and billing information extracted from an agent's auth config. */
export interface AccountInfo {
  accountKey: string | null;
  usageKey: string | null;
  accountId: string | null;
  organizationId: string | null;
  userId: string | null;
  email: string | null;
  plan: string | null;
  usageStatus: 'available' | 'rate_limited' | 'out_of_credits' | null;
  overageCredits: { amount: number; currency: string } | null;
  lastActive: Date | null;
  // Whether the agent has a usable local credential. For most agents this
  // tracks `email != null`, but some CLIs (Antigravity, Kimi) store an opaque
  // OAuth/JWT credential with no email claim — they are signed in even though
  // we can't surface an address. Callers that only want to know "logged in or
  // not" should read this, not `email`.
  signedIn: boolean;
  // Claude-only: raw organizationType/organizationName from .claude.json's
  // oauthAccount ("claude_max", "claude_team", ...). Two installs can share an
  // email yet belong to different orgs (a personal Max plan and a Team seat);
  // these fields are what let display layers tell them apart. Optional so the
  // other agents' return literals stay valid — absent means "not applicable".
  organizationType?: string | null;
  organizationName?: string | null;
}

/**
 * Human-readable label for a Claude account's organizationType as read from
 * .claude.json's oauthAccount ("claude_team" -> "Team"). Unrecognized values
 * (future tiers) are rendered by stripping the "claude_" prefix and
 * title-casing the rest — an unfamiliar-but-visible label beats silence.
 * Returns null for missing input.
 */
export function formatClaudeOrgLabel(orgType: string | null | undefined): string | null {
  if (!orgType) return null;
  const known: Record<string, string> = {
    claude_max: 'Max',
    claude_pro: 'Pro',
    claude_team: 'Team',
    claude_enterprise: 'Enterprise',
    claude_free: 'Free',
  };
  if (known[orgType]) return known[orgType];
  return orgType
    .replace(/^claude_/, '')
    .split('_')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Short badge identifying which ORG an account belongs to — "Turing Labs" for a
 * multi-seat Team/Enterprise org, whose name is real identity that disambiguates
 * a Team seat from a same-email personal plan. Returns null for personal plans
 * (Max/Pro/Free): the tier label now lives in the aligned plan column, so a badge
 * would only duplicate it, and a personal org's name is auto-generated boilerplate
 * ("<email>'s Organization"), not identity. Also null when the account carries no
 * organizationType (signed out, non-Claude agents, configs predating the field).
 */
export function accountOrgBadge(
  info?: Pick<AccountInfo, 'organizationType' | 'organizationName'> | null
): string | null {
  const isMultiSeat =
    info?.organizationType === 'claude_team' || info?.organizationType === 'claude_enterprise';
  if (isMultiSeat && info?.organizationName) return info.organizationName;
  return null;
}

/** Agents whose local credential formats expose enough state for account selection. */
export const ACCOUNT_INSPECTION_AGENT_IDS = [
  'claude',
  'codex',
  'gemini',
  'cursor',
  'grok',
  'antigravity',
  'kimi',
  'droid',
  'opencode',
  'muse',
] as const satisfies readonly AgentId[];

const ACCOUNT_INSPECTION_AGENTS = new Set<AgentId>(ACCOUNT_INSPECTION_AGENT_IDS);

/** Whether agents-cli can determine this agent's per-version sign-in state. */
export function supportsAccountInspection(agentId: AgentId): boolean {
  return ACCOUNT_INSPECTION_AGENTS.has(agentId);
}

/**
 * Human-readable account identity shared by every account-aware surface.
 * Prefer email, append a multi-seat Claude organization name when present,
 * then fall back to a non-secret account id or a generic signed-in label.
 */
export function accountDisplayLabel(
  info?: Pick<
    AccountInfo,
    'email' | 'accountId' | 'signedIn' | 'organizationType' | 'organizationName'
  > | null
): string {
  if (!info) return '';
  if (info.email) {
    const badge = accountOrgBadge(info);
    return badge ? `${info.email} (${badge})` : info.email;
  }
  if (info.signedIn) return info.accountId ? `id:${info.accountId}` : 'signed in';
  return '';
}

/** Return the email address associated with the agent's auth config, or null. */
export async function getAccountEmail(
  agentId: AgentId,
  home?: string
): Promise<string | null> {
  const info = await getAccountInfo(agentId, home);
  return info.email;
}

/**
 * Extract full account information (identity, plan, usage status, credits) from
 * the agent's local auth/config files. Supports Claude, Codex, and Gemini.
 */
/**
 * Resolve a file-auth agent's credential file. Sign-in is account-global, but
 * each installed version gets an isolated home; the credential physically lives
 * only in the home the user logged in under (the one the `~/.<config>` symlink
 * targets). Check the per-version `base` first, then fall back to the active
 * config location under the real HOME so every installed version reflects the
 * true account state (droid/antigravity/kimi all stored login per-version-home
 * and showed non-active versions as "not signed in"). Returns the first
 * existing path, or null.
 */
/** True when `dir` is under the per-account slot root (`~/.agents/.history/accounts/`). */
export function isAccountSlotDir(dir: string): boolean {
  const root = path.resolve(getHistoryDir(), 'accounts');
  const resolved = path.resolve(dir);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function resolveAccountCredentialPath(base: string, ...segments: string[]): string | null {
  const perVersion = path.join(base, ...segments);
  try { if (fs.existsSync(perVersion)) return perVersion; } catch { /* unreadable */ }
  // A slot is the account's own HOME (PHNX-3940 T5). Never inherit another
  // account's adopted ~/.<config> — that is the cross-account leak.
  if (isAccountSlotDir(base)) return null;
  const active = path.join(process.env.AGENTS_REAL_HOME || os.homedir(), ...segments);
  if (active !== perVersion) {
    try { if (fs.existsSync(active)) return active; } catch { /* unreadable */ }
  }
  return null;
}

/**
 * The on-disk credential file(s) each account-inspectable agent authenticates
 * from, expressed as path segments under a home. Mirrors the exact files
 * {@link getAccountInfo} reads, so a presence check here matches what a real
 * launch would find. Each entry is a list of alternatives — the FIRST that
 * exists counts as present (claude writes either `.claude/.claude.json` under
 * the shimmed config dir or a home-level `.claude.json`). Agents whose login is
 * stored only in the OS keychain on some platforms (antigravity, and claude's
 * token) still expose a credential FILE — the presence of that file is the
 * signal we key off; its absence on BOTH the per-version home and the active
 * home is what makes a logged-out claim provable.
 */
const CREDENTIAL_FILE_SEGMENTS: Partial<Record<AgentId, string[][]>> = {
  claude: [['.claude', '.claude.json'], ['.claude.json']],
  codex: [['.codex', 'auth.json']],
  gemini: [['.gemini', 'google_accounts.json']],
  grok: [['.grok', 'auth.json']],
  kimi: [['.kimi-code', 'credentials', 'kimi-code.json']],
  droid: [['.factory', 'auth.v2.file']],
  antigravity: [['.gemini', 'antigravity-cli', 'antigravity-oauth-token']],
  opencode: [['.local', 'share', 'opencode', 'auth.json']],
  // Muse Code stores OAuth / API credentials at ~/.config/muse/auth.json
  // (or META_API_KEY in the environment, which is not a file).
  muse: [['.config', 'muse', 'auth.json']],
  // With AGENT_CLI_CREDENTIAL_STORE=file, Cursor stores both OAuth tokens at
  // ~/.cursor/auth.json. cli-config.json holds account metadata only.
  cursor: [['.cursor', 'auth.json']],
};

/** Whether an agent's credential file exists under a given home. */
function credentialFileExistsUnder(agentId: AgentId, home: string): boolean {
  const alternatives = CREDENTIAL_FILE_SEGMENTS[agentId];
  if (!alternatives) return false;
  const hasSegment = alternatives.some((segments) => {
    const p = path.join(home, ...segments);
    try { return fs.existsSync(p); } catch { return false; }
  });
  if (!hasSegment) return false;
  // Claude's `.claude.json` is account METADATA Claude Code writes on any
  // launch, not the credential itself — a version can carry stale identity
  // there (e.g. install-time carry-forward) with no usable credential behind
  // it: a failed OAuth refresh blanks `.credentials.json`, and a Linux worker
  // can be missing BOTH `.credentials.json` and the `.oauth_token` setup-token
  // file entirely (PHNX-3502). `credentialPresence` promises to mirror what a
  // real launch would find, so it must fail whenever `isClaudeCredentialFileBlank`
  // — the SAME floor `getAccountInfo` applies — would. On macOS that floor is a
  // no-op (Keychain-only, always "not blank"), so this reduces to the identity
  // check above, unchanged.
  if (agentId === 'claude') return !isClaudeCredentialFileBlank(home);
  return true;
}

/** Where an agent's credential file lives, split into the per-version copy and
 *  the active/global copy under the real HOME. */
export interface CredentialPresence {
  /** The credential file exists inside the passed version home. */
  perVersion: boolean;
  /** The credential file exists under the active/global HOME (the one the login
   *  symlink actually targets), independent of the version home. */
  active: boolean;
  /** Whether agents-cli knows WHERE this agent's credential lives at all — i.e.
   *  the agent has an entry in {@link CREDENTIAL_FILE_SEGMENTS}. When false both
   *  probes are trivially false because there is nothing to look for, so absence
   *  is NOT evidence of a logout and no caller may treat it as provable.
   *
   *  This is deliberately separate from `supportsAccountInspection`: the two
   *  registries move independently, and an agent has already been added to the
   *  inspection set without a credential path (cursor), which without this flag
   *  produced a false "logged out" critical for every installed version. */
  knownLocation: boolean;
}

/**
 * File-presence probe for an agent's credential, split by location: whether it
 * exists in a SPECIFIC version home (`perVersion`) and whether it exists under
 * the active/global HOME (`active`). A logged-out claim is only *provable* when
 * BOTH are absent — a version that merely lacks its own copy but shares the
 * global login is signed in, not logged out. Pure file existence; no decrypt,
 * no network, no keychain prompt. Agents with no inspectable identity return
 * `{ perVersion: false, active: false }` and must NEVER yield a provable-logout
 * claim (the caller gates on {@link supportsAccountInspection}).
 */
export function credentialPresence(agentId: AgentId, versionHome: string): CredentialPresence {
  const realHome = process.env.AGENTS_REAL_HOME || os.homedir();
  const perVersion = credentialFileExistsUnder(agentId, versionHome);
  const active = credentialFileExistsUnder(agentId, realHome);
  const knownLocation = (CREDENTIAL_FILE_SEGMENTS[agentId]?.length ?? 0) > 0;
  return { perVersion, active, knownLocation };
}

/** Decrypted contents of Droid's auth.v2.file (subset we consume). */
export interface DroidAuthPayload {
  access_token?: string;
  active_organization_id?: string | null;
}

/**
 * Factory Droid stores its OAuth credential encrypted at ~/.factory/auth.v2.file
 * (AES-256-GCM, format `ivB64:tagB64:ctB64`) with the 32-byte key base64-stored
 * in ~/.factory/auth.v2.key. On the keyfile-v2 source there is no OS-keychain /
 * device binding — the key is on disk — so we can decrypt locally with no
 * network call. Every failure (missing key file — e.g. a keyring-v2/legacy
 * login with no on-disk key, a bad GCM tag, or malformed JSON) returns null.
 * Never throws. Shared by account identity below and the Droid usage fetcher
 * in usage.ts.
 */
export function decryptDroidAuthPayload(base: string): DroidAuthPayload | null {
  const filePath = resolveAccountCredentialPath(base, '.factory', 'auth.v2.file');
  const keyPath = resolveAccountCredentialPath(base, '.factory', 'auth.v2.key');
  if (!filePath || !keyPath) return null;
  return decryptDroidAuthFile(filePath, keyPath);
}

/**
 * Decrypt a Droid `auth.v2.file` (AES-256-GCM `ivB64:tagB64:ctB64`) using the
 * raw 32-byte key stored base64 in `auth.v2.key`, given the EXACT paths to both.
 * Same crypto as decryptDroidAuthPayload but without the account-global HOME
 * fallback, so the identity of a SPECIFIC version home resolves against only
 * that home's files (carryForwardAuthFiles needs per-dir identity). Returns null
 * on any failure (missing file/key, wrong key length, bad GCM tag, malformed
 * JSON). Never throws.
 */
export function decryptDroidAuthFile(filePath: string, keyPath: string): DroidAuthPayload | null {
  try {
    const blob = fs.readFileSync(filePath, 'utf-8').trim();
    const key = Buffer.from(fs.readFileSync(keyPath, 'utf-8').trim(), 'base64');
    if (key.length !== 32) return null;
    const [ivB64, tagB64, ctB64] = blob.split(':');
    if (!ivB64 || !tagB64 || !ctB64) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]).toString('utf-8');
    const cred = JSON.parse(plaintext);
    return cred && typeof cred === 'object' ? (cred as DroidAuthPayload) : null;
  } catch {
    return null;
  }
}

/**
 * Stable account identity for a *file-auth* agent's credential directory
 * (droid / kimi / antigravity), or null when the directory holds no decodable
 * account claim. Unlike a naive top-level JSON key-scan (which matched NO real
 * credential file), this decrypts / decodes each agent's REAL on-disk format so
 * the identity resolves against production credentials:
 *   - droid: AES-256-GCM auth.v2.file (+ auth.v2.key) -> WorkOS access-token JWT
 *     -> email / org_id / sub.
 *   - kimi: credentials/kimi-code.json -> access-token JWT -> user_id / sub.
 *   - antigravity: antigravity-oauth-token -> token.refresh_token -> JWT sub
 *     when the token is a JWT, else a SHA-256 hash of the raw refresh-token
 *     value (opaque Google consumer tokens are stable per login — hashed so
 *     the identity key, which is persisted as a usage-cache key, never carries
 *     a live credential).
 * Two directories for the SAME account compare equal; two DIFFERENT accounts
 * compare distinct. Used by carryForwardAuthFiles to refuse overwriting one
 * account's login with a credential that belongs to a DIFFERENT account
 * (RUSH-1764). Never throws.
 */
export function readAuthAccountIdentity(agent: AgentId, configDir: string): string | null {
  try {
    switch (agent) {
      case 'droid': {
        const payload = decryptDroidAuthFile(
          path.join(configDir, 'auth.v2.file'),
          path.join(configDir, 'auth.v2.key'),
        );
        const claims =
          typeof payload?.access_token === 'string' ? decodeJwtPayload(payload.access_token) : null;
        if (!claims) return null;
        return buildIdentityKey(agent, [
          ['email', normalizeIdentityPart(claims.email)],
          ['org', normalizeIdentityPart(claims.org_id ?? payload?.active_organization_id)],
          ['sub', normalizeIdentityPart(claims.sub)],
        ]);
      }
      case 'kimi': {
        const data = JSON.parse(
          fs.readFileSync(path.join(configDir, 'credentials', 'kimi-code.json'), 'utf-8'),
        );
        const accessToken = data?.access_token;
        const claims = typeof accessToken === 'string' ? decodeJwtPayload(accessToken) : null;
        return buildIdentityKey(agent, [
          ['user', normalizeIdentityPart(claims?.user_id ?? claims?.sub)],
        ]);
      }
      case 'antigravity': {
        const data = JSON.parse(
          fs.readFileSync(path.join(configDir, 'antigravity-oauth-token'), 'utf-8'),
        );
        const refreshToken = data?.token?.refresh_token;
        if (typeof refreshToken !== 'string' || !refreshToken) return null;
        const claims = decodeJwtPayload(refreshToken);
        const sub = normalizeIdentityPart(claims?.sub ?? claims?.user_id);
        // An opaque (non-JWT) Google refresh token IS the credential — hash it
        // so the identity key stays stable per login without embedding a live
        // secret (the key is persisted as a usage-cache filename key).
        const fallback = crypto.createHash('sha256').update(refreshToken).digest('hex').slice(0, 16);
        return buildIdentityKey(agent, [['sub', sub ?? fallback]]);
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Derive Droid account identity from the decrypted credential. The
 * `access_token` is a WorkOS JWT carrying an `email` claim (plus org_id /
 * role). We decode the claim WITHOUT verifying `exp`: the email is stable
 * identity for display, not an authorization decision, so an expired token
 * still yields the right address. Returns null when the credential can't be
 * decrypted or has no decodable claims, so the caller falls back to the
 * file-presence signed-in signal.
 */
function decryptDroidCredential(
  base: string
): { email: string | null; orgId: string | null; role: string | null } | null {
  const cred = decryptDroidAuthPayload(base);
  const claims = typeof cred?.access_token === 'string' ? decodeJwtPayload(cred.access_token) : null;
  if (!claims) return null;
  return {
    email: typeof claims.email === 'string' ? claims.email : null,
    orgId: normalizeIdentityPart(claims.org_id ?? cred?.active_organization_id),
    role: typeof claims.role === 'string' ? claims.role : null,
  };
}

let cachedAgyKeychainSignedIn: boolean | undefined;

/**
 * Antigravity (`agy`) stores its OAuth token via the Go keyring library
 * (zalando/go-keyring), which is platform-split:
 *
 *   - macOS: login keychain, service `gemini`, account `antigravity` — no file.
 *   - Linux with Secret Service (libsecret / gnome-keyring): attributes
 *     service=`gemini`, username=`antigravity` (go-keyring's Secret Service
 *     mapping of service+user). Prefer this over the file when a keyring
 *     daemon is running.
 *   - Linux without Secret Service: file fallback at
 *     `~/.gemini/antigravity-cli/antigravity-oauth-token`.
 *
 * Probe the OS keyring for existence after the file check. On macOS,
 * `security find-generic-password` without `-w` is metadata-only (never
 * prompts). On Linux, `secret-tool lookup` exit 0 means the item exists
 * (stdout is the secret — discarded, never logged). Cached per process —
 * the keyring is account-global, so one probe covers every installed version.
 * Returns false when the platform has no probe (Windows) or the tool is
 * missing. Guard with `AGENTS_NO_KEYCHAIN_PROBE=1` for hermetic tests.
 */
export function antigravityOsKeyringProbe(
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[] } | null {
  if (platform === 'darwin') {
    return {
      cmd: 'security',
      args: ['find-generic-password', '-s', 'gemini', '-a', 'antigravity'],
    };
  }
  if (platform === 'linux') {
    // go-keyring secret_service attributes: "service" + "username" (not
    // "account" — that flag is the macOS security(1) spelling of the same user).
    return {
      cmd: 'secret-tool',
      args: ['lookup', 'service', 'gemini', 'username', 'antigravity'],
    };
  }
  return null;
}

/** @internal test hook — clear the per-process keyring probe cache. */
export function __resetAntigravityKeychainCacheForTest(): void {
  cachedAgyKeychainSignedIn = undefined;
}

async function antigravityKeychainSignedIn(): Promise<boolean> {
  // Test isolation first (before cache): real OS keyrings can't be sandboxed
  // per-test. Same spirit as AGENTS_REAL_HOME. Not cached, so tests can toggle.
  if (process.env.AGENTS_NO_KEYCHAIN_PROBE === '1') return false;
  if (cachedAgyKeychainSignedIn !== undefined) return cachedAgyKeychainSignedIn;

  const probe = antigravityOsKeyringProbe();
  if (!probe) {
    cachedAgyKeychainSignedIn = false;
    return false;
  }
  try {
    // Discard stdout: Linux secret-tool lookup prints the secret value.
    await execFileAsync(probe.cmd, probe.args, {
      timeout: 3000,
      // encoding so stdout is a string we can drop without ever logging it
      encoding: 'utf8',
    });
    cachedAgyKeychainSignedIn = true;
  } catch {
    // Missing tool (ENOENT), missing item, locked collection, timeout → signed out.
    cachedAgyKeychainSignedIn = false;
  }
  return cachedAgyKeychainSignedIn;
}

/**
 * OpenCode (sst/opencode) stores provider credentials in a single JSON file at
 * `$XDG_DATA_HOME/opencode/auth.json`, defaulting to
 * `~/.local/share/opencode/auth.json` on EVERY platform — its `xdg-basedir`
 * dependency does not special-case macOS, so there is no
 * `~/Library/Application Support` variant. The path is account-global (not
 * per-version), matching how `session/discover.ts` already resolves
 * `~/.local/share/opencode/opencode.db`.
 *
 * Resolution order, first existing wins:
 *   1. `<base>/.local/share/opencode/auth.json` — the passed per-version home.
 *      This is primarily a test hook (suites write a hermetic auth file under a
 *      temp home) but also covers any relocated install.
 *   2. `$XDG_DATA_HOME/opencode/auth.json` — an explicit XDG override, exactly
 *      what OpenCode itself honours.
 *   3. `<realHome>/.local/share/opencode/auth.json` — the active default, under
 *      `AGENTS_REAL_HOME` or `os.homedir()`, so every installed version reflects
 *      the one account-global login (same fallback shape as
 *      resolveAccountCredentialPath).
 * Returns the first existing path, or null. Never throws.
 */
function resolveOpenCodeAuthPath(base: string): string | null {
  const candidates = [path.join(base, '.local', 'share', 'opencode', 'auth.json')];
  const xdgData = process.env.XDG_DATA_HOME;
  if (xdgData) candidates.push(path.join(xdgData, 'opencode', 'auth.json'));
  const realHome = process.env.AGENTS_REAL_HOME || os.homedir();
  candidates.push(path.join(realHome, '.local', 'share', 'opencode', 'auth.json'));
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* unreadable */ }
  }
  return null;
}

/**
 * Validate one OpenCode auth.json entry against its discriminated union
 * (`type: 'oauth' | 'api' | 'wellknown'`) and confirm the credential actually
 * carries its required secret field(s) non-empty. This guards against a
 * corrupt/half-written entry reading as signed-in — the same "must have a real
 * credential" floor grok/antigravity apply. We only INSPECT the shape here; the
 * secret values (`access`/`refresh`/`key`/`token`) are never read out or
 * surfaced anywhere.
 */
function isValidOpenCodeCredential(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const cred = value as Record<string, unknown>;
  const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  switch (cred.type) {
    case 'oauth': return nonEmpty(cred.access) || nonEmpty(cred.refresh);
    case 'api': return nonEmpty(cred.key);
    case 'wellknown': return nonEmpty(cred.key) && nonEmpty(cred.token);
    default: return false;
  }
}

/**
 * OpenCode's account identity: the sorted, "+"-joined list of provider ids
 * that hold a valid credential in `auth.json` (e.g. `"anthropic+muse-spark"`).
 * `auth.json` carries no email/identity claim (see `isValidOpenCodeCredential`),
 * so this join is the closest thing to "which account is this" available — the
 * same value `agents view`/`agents doctor` show for OpenCode's signed-in state.
 *
 * This is the ONLY correct source for an OpenCode "account". OpenCode's SQLite
 * `opencode.db` also carries `account`/`account_state`/`control_account` tables,
 * but on a real, actively-used install (yosemite-s1, 1.16.0, 35 applied
 * migrations) all three are permanently empty — no migration ever populates
 * them, and no session has ever written a row. Reading from them instead of
 * `auth.json` always yields `undefined`, credential or not; `session/discover.ts`
 * uses this function rather than duplicating a sqlite lookup against those
 * dead tables.
 *
 * Sync (`fs.readFileSync`), no network. Returns undefined when `auth.json` is
 * missing, unreadable, or carries no valid credential.
 */
export function resolveOpenCodeAccountId(base: string): string | undefined {
  const authPath = resolveOpenCodeAuthPath(base);
  if (!authPath) return undefined;
  try {
    const data = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    if (!data || typeof data !== 'object') return undefined;
    const providers = Object.entries(data as Record<string, unknown>)
      .filter(([, cred]) => isValidOpenCodeCredential(cred))
      .map(([id]) => id)
      .sort();
    return providers.length ? providers.join('+') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a Muse Code `~/.config/muse/auth.json` document holds any usable
 * access token. Live shape from `muse login` (device OAuth, Muse Code 0.1.0):
 *   { schema_version: 1, providers: { meta: { access_token, api_key, user_email, … } } }
 * Also accept top-level or one-level-nested tokens for older/alternate writers.
 * Recurses into objects so `providers.meta.access_token` is found — a flat
 * one-level walk only saw `providers` and reported signed-out after a successful
 * login (balanced then excluded the account). Never returns the secret itself.
 */
function museAuthHasToken(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const root = value as Record<string, unknown>;
  if (typeof root.access_token === 'string' && root.access_token.length > 0) return true;
  if (typeof root.api_key === 'string' && root.api_key.length > 0) return true;
  for (const slot of Object.values(root)) {
    if (museAuthHasToken(slot, depth + 1)) return true;
  }
  return false;
}

/** Best-effort email from a Muse auth.json (providers.meta.user_email, etc.). */
function museAuthEmail(value: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (typeof root.user_email === 'string' && root.user_email.includes('@')) {
    return root.user_email;
  }
  if (typeof root.email === 'string' && root.email.includes('@')) {
    return root.email;
  }
  for (const slot of Object.values(root)) {
    const found = museAuthEmail(slot, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Whether a Claude version home's credential file is present but carries no
 * token — the "must have a real credential" floor (see
 * `isValidOpenCodeCredential`) applied to claude.
 *
 * A FAILED OAuth refresh leaves exactly this state behind: Claude Code rewrites
 * `.claude/.credentials.json` with `accessToken: ""`, `refreshToken: ""` and
 * `expiresAt: 0`, keeping only the descriptive fields (`subscriptionType`,
 * `rateLimitTier`, `refreshTokenExpiresAt`). Everything we derive from
 * `.claude.json` — email, plan — still looks healthy, so the install reported
 * `signedIn: true`, `agents view` drew usage bars for it, and balanced rotation
 * (whose `authValid` is just "email present") kept picking it — every pick dying
 * at spawn on "OAuth session expired and could not be refreshed".
 *
 * Only decidable off macOS: there the login Keychain is the canonical store and
 * this file is not authoritative, and probing the Keychain would raise an
 * authorization sheet per installed version on every `agents run` — the reason
 * rotation stopped calling `isClaudeAuthValid` at all. Off macOS the file IS the
 * only store, so a missing or token-less file is proof of signed-out — unless a
 * Linux setup-token (`.claude/.oauth_token`) is present, which the shim exports
 * as `CLAUDE_CODE_OAUTH_TOKEN` and can authenticate the run without
 * `.credentials.json`. `platform` is a parameter so both branches are testable
 * on any host.
 *
 * Sync, no Keychain, no network — safe on the `agents run` hot path.
 */
export function isClaudeCredentialFileBlank(
  base: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform === 'darwin') return false;
  // A per-version setup-token is a real credential on Linux even when
  // `.credentials.json` was never written (the shim's `$CLAUDE_CONFIG_DIR/.oauth_token`
  // fallback). Treat it as signed-in so rotation does not skip a worker that
  // authenticates from an attached setup-token.
  try {
    const token = fs.readFileSync(path.join(base, '.claude', '.oauth_token'), 'utf-8').trim();
    if (token.length > 0) return false;
  } catch {
    /* absent — fall through to the credentials.json floor */
  }
  try {
    const raw = fs.readFileSync(path.join(base, '.claude', '.credentials.json'), 'utf-8');
    const oauth = (JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: unknown; refreshToken?: unknown };
    }).claudeAiOauth;
    if (!oauth) return false;
    const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
    return !nonEmpty(oauth.accessToken) && !nonEmpty(oauth.refreshToken);
  } catch (err) {
    // Off macOS the file IS the store. Missing it means this home cannot
    // authenticate (a newly installed default with leftover `.claude.json`
    // oauthAccount is the PHNX-2685 false-healthy case). A corrupt file is
    // not positive evidence of a blank credential — leave the existing
    // signal alone rather than declaring a working install signed out.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }
}

/**
 * Identity of the Claude account a version home is (or was) logged into, read
 * straight from `.claude.json`'s `oauthAccount`.
 *
 * Deliberately independent of whether the credential still works. `getAccountInfo`
 * applies a credential floor so `agents view` and rotation route around an install
 * that would die at spawn; attribution of *history* must not. A transcript written
 * under an org is still that org's work after the token is revoked or the home is
 * trashed, and on Linux/Windows the floor would otherwise erase the identity of
 * every retired home (`isClaudeCredentialFileBlank` short-circuits only on darwin).
 */
export interface ClaudeHomeIdentity {
  email: string | null;
  accountId: string | null;
  organizationId: string | null;
  organizationName: string | null;
  organizationType: string | null;
  /**
   * Org-scoped identity — the rate-limit bucket, and the correct key to group by.
   * Two orgs under one email (a Team seat and a personal Max plan) are separate
   * buckets and MUST stay distinct; see `candidateIdentity` in lib/rotate.ts.
   */
  usageKey: string | null;
  /** Account+org identity, narrower than `usageKey`. */
  accountKey: string | null;
}

/** A version home's `.claude.json` plus the identity derived from it. */
export interface ClaudeHomeConfig {
  /** The config file actually read. */
  path: string;
  config: Record<string, any>;
  identity: ClaudeHomeIdentity;
}

/**
 * Read a Claude home's config and account identity. Returns null when the home has
 * no readable `.claude.json`, or has one with no `oauthAccount` (never signed in).
 *
 * Sync because the session scanner calls it once per home on a hot path, and the
 * file is a few KB of local JSON. No Keychain access — see `getAccountInfo`.
 */
export function readClaudeHomeConfig(base: string): ClaudeHomeConfig | null {
  // Claude reads/writes config at $CLAUDE_CONFIG_DIR/.claude.json when set, falling
  // back to $HOME/.claude.json. Our shim sets CLAUDE_CONFIG_DIR to the per-version
  // .claude dir, so prefer that file; fall back to home-level for versions ever
  // launched without the shim (IDE extension, direct binary).
  const configDirFile = path.join(base, '.claude', '.claude.json');
  const homeLevelFile = path.join(base, '.claude.json');
  const activeFile = fs.existsSync(configDirFile) ? configDirFile : homeLevelFile;

  let config: Record<string, any>;
  try {
    config = JSON.parse(fs.readFileSync(activeFile, 'utf-8'));
  } catch {
    return null;
  }

  const oa = config.oauthAccount;
  if (!oa) return null;

  const email = normalizeIdentityPart(oa.emailAddress);
  let accountId = normalizeIdentityPart(oa.accountUuid);
  let organizationId = normalizeIdentityPart(oa.organizationUuid);

  // Worker slot provisioned from a durable setup-token: only the email was
  // seeded on disk (seedClaudeWorkerHomeIdentity), so accountUuid/organizationUuid
  // are absent and both accountKey and usageKey would be null — the row reads
  // "not connected here" (PHNX-3940, sibling worker-identity diagnosis). Complete
  // the identity from the fleet-synced registry row for this email, keyed exactly
  // as a headed login's home carries it. Guarded on email-only so a headed home
  // (uuids on disk) never pays the readMeta() read, and fails CLOSED to email-only
  // when zero or several rows match (registeredNativeAccountForEmail never guesses).
  if (email && !accountId && !organizationId) {
    const registered = registeredNativeAccountForEmail(readMeta(), 'claude', email);
    const parts = registered ? parseNativeIdentityKey('claude', registered.identityKey) : null;
    if (parts) {
      accountId = normalizeIdentityPart(parts.account);
      organizationId = normalizeIdentityPart(parts.org);
    }
  }

  return {
    path: activeFile,
    config,
    identity: {
      email: email ?? (oa.emailAddress || null),
      accountId,
      organizationId,
      organizationName: oa.organizationName ?? null,
      organizationType: oa.organizationType ?? null,
      usageKey: buildIdentityKey('claude', [['org', organizationId]]),
      accountKey: buildIdentityKey('claude', [
        ['account', accountId],
        ['org', organizationId],
      ]),
    },
  };
}

export async function getAccountInfo(
  agentId: AgentId,
  home?: string
): Promise<AccountInfo> {
  const base = home || os.homedir();
  const empty: AccountInfo = {
    accountKey: null,
    usageKey: null,
    accountId: null,
    organizationId: null,
    userId: null,
    email: null,
    plan: null,
    usageStatus: null,
    overageCredits: null,
    lastActive: null,
    signedIn: false,
  };

  const configFiles: Partial<Record<AgentId, string>> = {
    claude: path.join(base, '.claude.json'),
    codex: path.join(base, '.codex', 'auth.json'),
    gemini: path.join(base, '.gemini', 'google_accounts.json'),
  };
  const lastActive = resolveLastActive(agentId, base, configFiles[agentId]);

  try {
    switch (agentId) {
      case 'claude': {
        // Identity extraction is shared with the session scanner's account
        // attribution — see readClaudeHomeConfig. A home with no readable config or
        // no oauthAccount is signed out, which is what the pre-refactor code
        // produced when JSON.parse threw or oauthAccount was absent.
        const claudeHome = readClaudeHomeConfig(base);
        if (!claudeHome) return { ...empty, lastActive };
        const { config: data, identity } = claudeHome;
        const oa = data.oauthAccount;
        const { accountId, organizationId, email, accountKey, usageKey } = identity;

        // Credential floor: a blanked credential file means this home cannot
        // authenticate, whatever `.claude.json` still says. Report it signed out
        // so `agents view` prompts a re-login and rotation routes around it,
        // instead of handing runs to an install that dies at spawn.
        if (email && isClaudeCredentialFileBlank(base)) {
          return { ...empty, lastActive };
        }

        // Plan tier is derived from .claude.json's organizationType, which carries
        // the TRUE tier (claude_max → "Max", claude_pro → "Pro", claude_team →
        // "Team") and is already in-hand from the config we just read — no Keychain
        // prompt. billingType only distinguishes "has a Stripe subscription" and so
        // mislabels every Max account as "Pro"; keep it as a fallback for older
        // configs predating organizationType. (Reading subscriptionType from the
        // keychain item would force a macOS Keychain ACL prompt on every `agents
        // run`, so we deliberately avoid it — organizationType gives us the tier
        // without that cost.)
        let plan: string | null = formatClaudeOrgLabel(oa?.organizationType);
        if (!plan) {
          if (oa?.billingType === 'stripe_subscription') {
            plan = 'Pro';
          } else if (oa?.billingType) {
            plan = oa.billingType;
          }
        }

        // usageStatus is NOT derived from cachedExtraUsageDisabledReason. That
        // field reports why pay-as-you-go overage is off (out_of_credits = no
        // overage credits purchased; org_level_disabled = admin turned overage
        // off), which says nothing about whether the account is throttled — a
        // Pro account at 5% weekly usage with overage disabled is fully usable.
        // Real throttle state comes from the live usage windows; callers derive
        // it via deriveUsageStatusFromSnapshot(). Here we only report whether
        // the account is signed in at all. Overage state stays visible through
        // overageCredits below.
        const usageStatus: AccountInfo['usageStatus'] = email ? 'available' : null;

        let overageCredits: AccountInfo['overageCredits'] = null;
        const orgId = oa?.organizationUuid;
        const creditCache = orgId && data.overageCreditGrantCache?.[orgId];
        if (creditCache?.info?.available && creditCache.info.amount_minor_units) {
          overageCredits = {
            amount: creditCache.info.amount_minor_units / 100,
            currency: creditCache.info.currency || 'USD',
          };
        }

        return {
          accountKey,
          usageKey,
          accountId,
          organizationId,
          userId: null,
          email,
          plan,
          usageStatus,
          overageCredits,
          lastActive,
          signedIn: !!email,
          organizationType: oa?.organizationType ?? null,
          organizationName: oa?.organizationName ?? null,
        };
      }
      case 'codex': {
        const data = JSON.parse(await fs.promises.readFile(path.join(base, '.codex', 'auth.json'), 'utf-8'));
        const token = data.tokens?.id_token || data.tokens?.access_token;
        if (!token) return { ...empty, lastActive };
        const decoded = decodeJwtPayload(token);
        if (!decoded) return { ...empty, lastActive };
        const email = decoded.email || null;

        // Plan and subscription from OpenAI auth claim
        const authClaim = decoded['https://api.openai.com/auth'] || {};
        const accountId = normalizeIdentityPart(authClaim.chatgpt_account_id);
        const userId = normalizeIdentityPart(authClaim.chatgpt_user_id || authClaim.user_id);
        const organizationId = normalizeIdentityPart(getCodexDefaultOrgId(authClaim));
        const accountKey = buildIdentityKey(agentId, [
          ['account', accountId],
          ['user', userId],
          ['org', organizationId],
        ]);
        const rawPlan = authClaim.chatgpt_plan_type;
        const plan = rawPlan ? rawPlan.charAt(0).toUpperCase() + rawPlan.slice(1) : null;

        // Subscription status: expired = out_of_credits
        let usageStatus: AccountInfo['usageStatus'] = null;
        const activeUntil = authClaim.chatgpt_subscription_active_until;
        if (activeUntil) {
          const expired = new Date(activeUntil).getTime() < Date.now();
          usageStatus = expired ? 'out_of_credits' : 'available';
        }

        return {
          accountKey,
          usageKey: accountKey,
          accountId,
          organizationId,
          userId,
          email,
          plan,
          usageStatus,
          overageCredits: null,
          lastActive,
          signedIn: !!email,
        };
      }
      case 'gemini': {
        const data = JSON.parse(await fs.promises.readFile(path.join(base, '.gemini', 'google_accounts.json'), 'utf-8'));
        const email = data.active || null;
        return { ...empty, email, signedIn: !!email, lastActive };
      }
      case 'cursor': {
        // Cursor CLI keeps account metadata in ~/.cursor/cli-config.json
        // (authInfo: { email, userId, authId }) and its OAuth tokens SEPARATELY
        // in ~/.cursor/auth.json ({ accessToken, refreshToken }). Presence
        // of an access token is the signed-in signal; email/ids come from
        // cli-config. authId is the OAuth subject (e.g. "google-oauth2|<n>") — the
        // same value the usage endpoint keys on (see getCursorUsageInfo).
        const cfgPath = resolveAccountCredentialPath(base, '.cursor', 'cli-config.json');
        if (!cfgPath) return { ...empty, lastActive };
        try {
          const cfg = JSON.parse(await fs.promises.readFile(cfgPath, 'utf-8'));
          const authInfo = cfg?.authInfo;
          const email = typeof authInfo?.email === 'string' ? authInfo.email : null;
          const accountId = normalizeIdentityPart(authInfo?.authId ?? authInfo?.userId);
          if (!email && !accountId) return { ...empty, lastActive };
          const authPath = resolveAccountCredentialPath(base, '.cursor', 'auth.json');
          let hasToken = false;
          if (authPath) {
            try {
              const tok = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
              hasToken = typeof tok?.accessToken === 'string' && tok.accessToken.length > 0;
            } catch { /* unreadable token file */ }
          }
          // cli-config survives logout and may describe a different keychain
          // account. Without this version's file token, its identity is stale
          // metadata rather than a usable managed login.
          if (!hasToken) return { ...empty, lastActive };
          const accountKey = buildIdentityKey(agentId, [['user', accountId]]);
          return { ...empty, email, accountId, accountKey, signedIn: true, lastActive };
        } catch {}
        return { ...empty, lastActive };
      }
      case 'grok': {
        // Grok stores auth in ~/.grok/auth.json as a map keyed by
        // "<oidc_issuer>::<client_id>" -> { email, user_id, refresh_token,
        // create_time, expires_at, team_id, ... }. (Older builds wrote a flat
        // object with a top-level email.) The old code only read a TOP-LEVEL
        // `email`, so the current nested format always looked signed-out even
        // when logged in. Read the newest account record: a refresh token means
        // signed in, and we surface the email/ids like claude/codex.
        const authPath = resolveAccountCredentialPath(base, '.grok', 'auth.json');
        if (!authPath) return { ...empty, lastActive };
        try {
          const data = JSON.parse(await fs.promises.readFile(authPath, 'utf-8'));
          const records = (data && typeof data === 'object' ? [data, ...Object.values(data)] : [])
            .filter((r): r is Record<string, any> => !!r && typeof r === 'object');
          const account = records
            .filter(r => typeof r.refresh_token === 'string' || typeof r.email === 'string')
            .sort((a, b) => String(b.create_time || '').localeCompare(String(a.create_time || '')))[0];
          if (account) {
            const email = typeof account.email === 'string' ? account.email : null;
            const accountId = normalizeIdentityPart(account.user_id ?? account.principal_id);
            const organizationId = normalizeIdentityPart(account.team_id);
            const accountKey = buildIdentityKey(agentId, [['user', accountId], ['org', organizationId]]);
            return { ...empty, email, accountId, organizationId, accountKey, signedIn: true, lastActive };
          }
        } catch {}
        return { ...empty, lastActive };
      }
      case 'antigravity': {
        // Antigravity (`agy`) stores a consumer Google OAuth grant (access +
        // refresh token, no id_token) — presence of a refresh token is the only
        // signed-in signal we can derive without a network call. Storage is
        // platform-split via go-keyring:
        //   - file ~/.gemini/antigravity-cli/antigravity-oauth-token (Linux
        //     fallback when no Secret Service is available)
        //   - macOS keychain / Linux libsecret (service gemini + user
        //     antigravity) when a keyring daemon is present
        // Check the file first, then the OS keyring probe.
        const tokenPath = resolveAccountCredentialPath(base, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
        if (tokenPath) {
          const data = JSON.parse(await fs.promises.readFile(tokenPath, 'utf-8'));
          if (typeof data?.token?.refresh_token === 'string' && data.token.refresh_token) {
            // A stable account/usage key (derived from the refresh token — see
            // readAuthAccountIdentity) lets `agents view` dedupe and cache the
            // per-model quota bars for this login.
            const identity = readAuthAccountIdentity('antigravity', path.dirname(tokenPath));
            return { ...empty, signedIn: true, lastActive, accountKey: identity, usageKey: identity };
          }
        }
        if (await antigravityKeychainSignedIn()) {
          // Keyring-only login (the macOS case): the OS keyring holds exactly
          // ONE antigravity credential, so a stable singleton key identifies it
          // for usage-cache dedup without reading the secret value here.
          const identity = buildIdentityKey('antigravity', [['sub', 'keychain']]);
          return { ...empty, signedIn: true, lastActive, accountKey: identity, usageKey: identity };
        }
        return { ...empty, lastActive };
      }
      case 'kimi': {
        // Kimi Code stores OAuth credentials at
        // ~/.kimi-code/credentials/kimi-code.json. The access token is a JWT
        // whose payload carries an opaque user_id (no email), so we report
        // signed-in state plus a stable account key for usage dedup.
        const credPath = resolveAccountCredentialPath(base, '.kimi-code', 'credentials', 'kimi-code.json');
        if (!credPath) return { ...empty, lastActive };
        const data = JSON.parse(await fs.promises.readFile(credPath, 'utf-8'));
        const accessToken = data?.access_token;
        if (typeof accessToken !== 'string' || !accessToken) return { ...empty, lastActive };
        const decoded = decodeJwtPayload(accessToken);
        const userId = normalizeIdentityPart(decoded?.user_id ?? decoded?.sub);
        const accountKey = buildIdentityKey(agentId, [['user', userId]]);
        return { ...empty, signedIn: true, accountId: userId, accountKey, lastActive };
      }
      case 'droid': {
        // Factory Droid stores auth at ~/.factory/auth.v2.file (AES-256-GCM,
        // decrypted with the on-disk ~/.factory/auth.v2.key). We decrypt locally
        // — no network — and surface the email/org/role from the WorkOS
        // access-token JWT, same as claude/codex/grok. If the credential can't be
        // decrypted (a keyring-v2/legacy login with no on-disk key, or a decrypt
        // failure) we fall back to the file-presence signed-in signal so the row
        // still reads as logged in — the conservative floor antigravity/kimi use.
        // `.factory` is the config dir on every platform (macOS/Linux
        // ~/.factory, Windows %USERPROFILE%\.factory).
        const decoded = decryptDroidCredential(base);
        if (decoded?.email) {
          const organizationId = decoded.orgId;
          const accountKey = buildIdentityKey(agentId, [['org', organizationId]]);
          return {
            ...empty,
            email: decoded.email,
            organizationId,
            accountId: organizationId,
            accountKey,
            signedIn: true,
            lastActive,
          };
        }
        const authPath = resolveAccountCredentialPath(base, '.factory', 'auth.v2.file');
        if (!authPath) return { ...empty, lastActive };
        return { ...empty, signedIn: true, lastActive };
      }
      case 'opencode': {
        // OpenCode's auth.json is a record keyed by provider id ->
        // { type: 'oauth'|'api'|'wellknown', ...secret fields }. There is no
        // email/identity claim to surface, so — like antigravity/kimi — we
        // report signed-in state plus the NON-SECRET provider metadata (which
        // provider ids hold a valid credential) and never read the tokens/keys
        // themselves. The user's complaint was the row read "not signed in"
        // despite a live login; a valid provider entry now shows e.g.
        // "id:muse-spark" so they can see exactly which provider is configured.
        // resolveOpenCodeAccountId is the single source of truth for this join —
        // session/discover.ts reuses it for the indexed `account` field.
        const accountId = resolveOpenCodeAccountId(base);
        if (!accountId) return { ...empty, lastActive };
        const accountKey = buildIdentityKey(agentId, [['providers', accountId]]);
        return { ...empty, signedIn: true, accountId, accountKey, lastActive };
      }
      case 'muse': {
        // Muse Code authenticates with META_API_KEY (env, highest priority) or
        // a stored OAuth/API credential at ~/.config/muse/auth.json. Live file
        // shape nests under providers.meta (access_token + optional user_email).
        if (process.env.META_API_KEY?.trim() || process.env.MODEL_API_KEY?.trim()) {
          const accountKey = buildIdentityKey(agentId, [['auth', 'env']]);
          return { ...empty, signedIn: true, accountId: 'env', accountKey, lastActive };
        }
        const authPath = resolveAccountCredentialPath(base, '.config', 'muse', 'auth.json');
        if (!authPath) return { ...empty, lastActive };
        const data = JSON.parse(await fs.promises.readFile(authPath, 'utf-8'));
        if (!data || typeof data !== 'object') return { ...empty, lastActive };
        if (!museAuthHasToken(data)) return { ...empty, lastActive };
        const email = museAuthEmail(data);
        const accountKey = buildIdentityKey(
          agentId,
          email ? [['email', email]] : [['auth', 'file']],
        );
        return {
          ...empty,
          signedIn: true,
          email,
          accountId: email ?? 'file',
          accountKey,
          lastActive,
        };
      }
      default:
        return { ...empty, lastActive };
    }
  } catch {
    /* auth/config file missing or unreadable */
    return { ...empty, lastActive };
  }
}

// Fresh window for the cached session walk. Matches USAGE_CACHE_FRESH_MS in
// usage.ts (5 minutes) so a launch storm reuses both probes for the same period.
const LAST_ACTIVE_CACHE_FRESH_MS = 5 * 60 * 1000;

const getLastActiveCachePath = () => path.join(getCacheDir(), 'last-active.json');

interface LastActiveCacheEntry {
  /** Newest session-file mtime (ms), or null when the home had no sessions. */
  mtimeMs: number | null;
  /** When the walk that produced this entry ran (ms since epoch). */
  computedAt: number;
}

/**
 * Determine when the agent was last used by checking session file mtimes,
 * falling back to config mtime.
 *
 * The session walk stats every transcript under the home's session dir —
 * thousands of files on long-lived installs — and `agents run` rotation calls
 * this once per installed version on every launch. The walk result is cached
 * on disk for a short window so back-to-back launches skip it entirely.
 * Cache read/write is best-effort: any failure falls back to walking.
 */
export function resolveLastActive(
  agentId: AgentId,
  base: string,
  configPath?: string,
  cachePath = getLastActiveCachePath(),
  now = new Date()
): Date | null {
  const sessionDir = getSessionDir(agentId, base);
  const sessionExt = getSessionExtension(agentId);
  if (sessionDir && sessionExt) {
    const key = `${agentId}:${base}`;
    const cache = readLastActiveCacheFile(cachePath);
    const entry = cache[key];
    const fresh =
      entry &&
      typeof entry.computedAt === 'number' &&
      now.getTime() - entry.computedAt >= 0 &&
      now.getTime() - entry.computedAt < LAST_ACTIVE_CACHE_FRESH_MS;

    if (fresh) {
      if (entry.mtimeMs !== null) return new Date(entry.mtimeMs);
      // Fresh entry with no sessions: fall through to the config mtime below.
    } else {
      const mtimeMs = latestFileMtimeMs(sessionDir, sessionExt);
      cache[key] = { mtimeMs, computedAt: now.getTime() };
      // Stale entries are never served, so drop them on write — keeps homes
      // that no longer exist (removed versions, test temp dirs) from
      // accumulating in the file.
      for (const [k, v] of Object.entries(cache)) {
        if (k !== key && !(typeof v?.computedAt === 'number' && now.getTime() - v.computedAt < LAST_ACTIVE_CACHE_FRESH_MS)) {
          delete cache[k];
        }
      }
      writeLastActiveCacheFile(cache, cachePath);
      if (mtimeMs !== null) return new Date(mtimeMs);
    }
  }

  if (!configPath) return null;
  try {
    return fs.statSync(configPath).mtime;
  } catch {
    return null;
  }
}

/** Read the entire last-active cache file. Missing or corrupt file reads as empty. */
function readLastActiveCacheFile(cachePath: string): Record<string, LastActiveCacheEntry> {
  if (!fs.existsSync(cachePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as Record<string, LastActiveCacheEntry>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Write the entire last-active cache. Best-effort; a failed write just means the next call walks again. */
function writeLastActiveCacheFile(cache: Record<string, LastActiveCacheEntry>, cachePath: string): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf-8');
  } catch {
    /* best-effort */
  }
}

/** Return the root directory where the agent stores session files, or null if unknown. */
function getSessionDir(agentId: AgentId, base: string): string | null {
  const rel = AGENTS[agentId].sessionDir;
  return rel ? path.join(base, ...rel) : null;
}

/** Return the file extension used for session files by the given agent. */
function getSessionExtension(agentId: AgentId): string | null {
  return AGENTS[agentId].sessionFileExt;
}

/**
 * Quick count of session files for an agent (without full DB scan).
 * Used during init to show approximate session count to user.
 */
export function countSessionFiles(agentId: AgentId): number {
  const sessionDir = getSessionDir(agentId, HOME);
  const ext = getSessionExtension(agentId);
  if (!sessionDir || !ext || !fs.existsSync(sessionDir)) return 0;

  let count = 0;
  const walk = (dir: string): void => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name));
        } else if (entry.isFile() && entry.name.endsWith(ext)) {
          count++;
        }
      }
    } catch {
      // Permission denied or other error
    }
  };
  walk(sessionDir);
  return count;
}

/** Decode the payload section of a JWT token without verifying its signature. */
export function decodeJwtPayload(token: string): Record<string, any> | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }
}

/** Extract the default organization ID from a Codex/OpenAI auth claim. */
function getCodexDefaultOrgId(authClaim: any): string | null {
  const organizations = authClaim?.organizations;
  if (!Array.isArray(organizations)) return null;
  const first = organizations[0];
  return typeof first?.id === 'string' ? first.id : null;
}

/** Trim and normalize an identity string, returning null for empty or non-string values. */
function normalizeIdentityPart(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** Build a composite identity key like "claude:account=abc:org=xyz" from labeled parts. */
function buildIdentityKey(
  agentId: AgentId,
  parts: Array<[label: string, value: string | null]>
): string | null {
  const encoded = parts
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}=${value}`);
  if (encoded.length === 0) return null;
  return `${agentId}:${encoded.join(':')}`;
}

/** Register an MCP server with an agent's CLI via `mcp add`. */
export async function registerMcp(
  agentId: AgentId,
  name: string,
  command: string,
  scope: 'user' | 'project' = 'user',
  transport: string = 'stdio',
  options?: { home?: string; binary?: string; headers?: Record<string, string> }
): Promise<{ success: boolean; error?: string }> {
  const agent = AGENTS[agentId];
  if (!supports(agentId, 'mcp').ok) {
    return { success: false, error: 'Agent does not support MCP' };
  }
  if (transport === 'http' && !supports(agentId, 'mcpHttp').ok) {
    return { success: false, error: 'skipped: agent does not support HTTP MCP registration' };
  }
  if (transport === 'http' && options?.headers && Object.keys(options.headers).length > 0 && !supports(agentId, 'mcpHeaders').ok) {
    return { success: false, error: 'skipped: HTTP MCP headers are only supported for Claude registration' };
  }
  if (agent.mcpRegister === 'config') {
    try {
      writeMcpToConfig(agentId, name, command, scope, transport, options?.home);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
  if (!options?.binary && !(await isCliInstalled(agentId))) {
    return { success: false, error: 'CLI not installed' };
  }

  try {
    // Use explicit binary path when provided (bypasses shim for version-managed agents)
    const bin = options?.binary || agent.cliCommand;
    let args: string[];
    if (transport === 'http') {
      if (agent.mcpAddHttp === 'url') {
        args = ['mcp', 'add', name, '--url', command];
      } else {
        const headerArgs = Object.entries(options?.headers || {}).flatMap(([key, value]) => ['--header', `${key}: ${value}`]);
        args = ['mcp', 'add', '--transport', 'http', '--scope', scope, name, command, ...headerArgs];
      }
    } else if (agent.mcpAddStdio === 'scope') {
      const commandArgs = splitCommandLine(command);
      args = ['mcp', 'add', '--transport', transport, '--scope', scope, name, '--', ...commandArgs];
    } else {
      const commandArgs = splitCommandLine(command);
      args = ['mcp', 'add', name, '--', ...commandArgs];
    }
    // When home is specified, override HOME so MCP config writes to the version's config dir
    const env = options?.home ? { ...process.env, HOME: options.home } : undefined;
    // On Windows a bare command name / `.cmd` wrapper (the npm-installed agent
    // CLI) can't be exec'd directly — it needs shell:true for PATHEXT/cmd. Off
    // Windows this is always false, so the no-shell argv path is unchanged.
    // RUSH-1752: when shell is needed, compose a fully-quoted command line and
    // pass EMPTY argv so user-controlled MCP command/args never reach cmd.exe unescaped.
    const spec = execFileShellSpec(bin, args);
    await execFileAsync(spec.command, spec.args, { ...(env ? { env } : {}), shell: spec.shell });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** Unregister (remove) a named MCP server from an agent's CLI config. */
export async function unregisterMcp(
  agentId: AgentId,
  name: string,
  options?: { home?: string; binary?: string }
): Promise<{ success: boolean; error?: string }> {
  const agent = AGENTS[agentId];
  if (!supports(agentId, 'mcp').ok) {
    return { success: false, error: 'Agent does not support MCP' };
  }
  if (agent.mcpRegister === 'config') {
    try {
      removeMcpFromConfig(agentId, name, options?.home);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
  if (!options?.binary && !(await isCliInstalled(agentId))) {
    return { success: false, error: 'CLI not installed' };
  }

  try {
    const bin = options?.binary || agent.cliCommand;
    const env = options?.home ? { ...process.env, HOME: options.home } : undefined;
    // RUSH-1752: same shell-safe path as registerMcp — attacker-controlled MCP
    // `name` must not reach cmd.exe unescaped when shell:true is required.
    const spec = execFileShellSpec(bin, ['mcp', 'remove', name]);
    await execFileAsync(spec.command, spec.args, { ...(env ? { env } : {}), shell: spec.shell });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** Result of an MCP registration or removal operation targeting a specific agent and optional version. */
export interface McpTargetOperationResult {
  agentId: AgentId;
  version?: string;
  success: boolean;
  error?: string;
}

/**
 * Register an MCP server across multiple agent targets, including both direct
 * (non-version-managed) agents and specific version-managed installs.
 */
export async function registerMcpToTargets(
  targets: { directAgents: AgentId[]; versionSelections: Map<AgentId, string[]> },
  name: string,
  command: string,
  scope: 'user' | 'project' = 'user',
  transport: string = 'stdio',
  options: { headers?: Record<string, string> } = {}
): Promise<McpTargetOperationResult[]> {
  const results: McpTargetOperationResult[] = [];

  for (const agentId of targets.directAgents) {
    const result = await registerMcp(agentId, name, command, scope, transport, options);
    results.push({ agentId, success: result.success, error: result.error });
  }

  for (const [agentId, versions] of targets.versionSelections) {
    for (const version of versions) {
      const result = await registerMcp(agentId, name, command, scope, transport, {
        ...options,
        home: getVersionHomePath(agentId, version),
        binary: getBinaryPath(agentId, version),
      });
      results.push({ agentId, version, success: result.success, error: result.error });
    }
  }

  return results;
}

/**
 * Unregister an MCP server from multiple agent targets, including both direct
 * agents and specific version-managed installs.
 */
export async function unregisterMcpFromTargets(
  targets: { directAgents: AgentId[]; versionSelections: Map<AgentId, string[]> },
  name: string
): Promise<McpTargetOperationResult[]> {
  const results: McpTargetOperationResult[] = [];

  for (const agentId of targets.directAgents) {
    const result = await unregisterMcp(agentId, name);
    results.push({ agentId, success: result.success, error: result.error });
  }

  for (const [agentId, versions] of targets.versionSelections) {
    for (const version of versions) {
      const result = await unregisterMcp(agentId, name, {
        home: getVersionHomePath(agentId, version),
        binary: getBinaryPath(agentId, version),
      });
      results.push({ agentId, version, success: result.success, error: result.error });
    }
  }

  return results;
}

/** Scope at which an MCP server is registered: user-global or per-project. */
export type McpScope = 'user' | 'project';

/** Describes an MCP server discovered in an agent's config, with its scope and command. */
export interface InstalledMcp {
  name: string;
  scope: McpScope;
  command?: string;
  version?: string;
}

interface McpConfigEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  url?: string;
}

function userMcpConfigPath(agentId: AgentId, home?: string): string {
  if (home) return getMcpConfigPathForHome(agentId, home);
  return getUserMcpConfigPath(agentId);
}

function scopedMcpConfigPath(agentId: AgentId, scope: 'user' | 'project', home?: string): string {
  if (scope === 'project') return getProjectMcpConfigPath(agentId);
  return userMcpConfigPath(agentId, home);
}

function mcpEntryFromCommand(command: string, transport: string): McpConfigEntry {
  if (transport === 'http') {
    return { url: command };
  }
  const commandArgs = splitCommandLine(command);
  return {
    command: commandArgs[0],
    args: commandArgs.slice(1),
  };
}

function readYamlConfig(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {};
  const parsed = yaml.parse(fs.readFileSync(configPath, 'utf-8'));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function readJsonConfig(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {};
  const content = configPath.endsWith('.jsonc')
    ? stripJsonComments(fs.readFileSync(configPath, 'utf-8'))
    : fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(content);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function writeMcpToConfig(
  agentId: AgentId,
  name: string,
  command: string,
  scope: 'user' | 'project',
  transport: string,
  home?: string
): void {
  const configPath = scopedMcpConfigPath(agentId, scope, home);
  const entry = mcpEntryFromCommand(command, transport);

  if (AGENTS[agentId].mcpConfigWrite === 'yaml-mcp_servers') {
    const config = readYamlConfig(configPath);
    if (!config.mcp_servers || typeof config.mcp_servers !== 'object' || Array.isArray(config.mcp_servers)) {
      config.mcp_servers = {};
    }
    (config.mcp_servers as Record<string, unknown>)[name] = entry;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, yaml.stringify(config), 'utf-8');
    return;
  }

  const config = readJsonConfig(configPath);
  if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) {
    config.mcpServers = {};
  }
  (config.mcpServers as Record<string, unknown>)[name] = entry;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

function removeMcpFromConfig(agentId: AgentId, name: string, home?: string): void {
  const configPath = userMcpConfigPath(agentId, home);
  if (!fs.existsSync(configPath)) return;

  if (AGENTS[agentId].mcpConfigWrite === 'yaml-mcp_servers') {
    const config = readYamlConfig(configPath);
    const servers = config.mcp_servers;
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
      delete (servers as Record<string, unknown>)[name];
      fs.writeFileSync(configPath, yaml.stringify(config), 'utf-8');
    }
    return;
  }

  const config = readJsonConfig(configPath);
  const servers = config.mcpServers;
  if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
    delete (servers as Record<string, unknown>)[name];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  }
}

/**
 * Extract version from npm package specification.
 * Examples: @scope/package@latest -> latest
 *           @scope/package@1.2.3 -> 1.2.3
 *           some-package -> undefined
 */
function extractNpmVersion(args: string[]): string | undefined {
  // Find npm package argument (looks like @scope/package@version or package@version)
  for (const arg of args) {
    // Match @scope/package@version or package@version
    const match = arg.match(/@([^@]+)$|^([^@]+)@(.+)$/);
    if (match) {
      // @scope/package@version pattern
      const versionMatch = arg.match(/@([^@/]+)$/);
      if (versionMatch) {
        return versionMatch[1];
      }
    }
  }
  return undefined;
}

/**
 * Strip JSON comments for JSONC parsing.
 * Only removes comments outside of strings.
 *
 * Exported because the MCP writer needs the SAME parser the reader uses: a
 * naive `//`-to-end-of-line regex eats the `//` inside
 * `"$schema": "https://opencode.ai/config.json"`, which every opencode-generated
 * config carries.
 */
export function stripJsonComments(content: string): string {
  let result = '';
  let inString = false;
  let escape = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];
    const next = content[i + 1];

    if (escape) {
      result += char;
      escape = false;
      i++;
      continue;
    }

    if (char === '\\' && inString) {
      result += char;
      escape = true;
      i++;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      result += char;
      i++;
      continue;
    }

    if (!inString) {
      // Check for single-line comment
      if (char === '/' && next === '/') {
        // Skip until end of line
        while (i < content.length && content[i] !== '\n') {
          i++;
        }
        continue;
      }
      // Check for multi-line comment
      if (char === '/' && next === '*') {
        i += 2;
        while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) {
          i++;
        }
        i += 2; // Skip */
        continue;
      }
    }

    result += char;
    i++;
  }

  return result;
}

/**
 * Parse MCP servers from a JSON/JSONC config file.
 */
function parseMcpFromJsonConfig(configPath: string): Record<string, McpConfigEntry> {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    let content = fs.readFileSync(configPath, 'utf-8');
    // Handle JSONC (JSON with comments)
    if (configPath.endsWith('.jsonc')) {
      content = stripJsonComments(content);
    }
    const config = JSON.parse(content);

    // Claude uses mcpServers, others may use mcp_servers or mcp
    return config.mcpServers || config.mcp_servers || config.mcp || {};
  } catch {
    /* JSON config corrupt or unreadable */
    return {};
  }
}

/**
 * Parse MCP servers from a TOML config file (Codex).
 * Codex stores MCPs as [mcp_servers.ServerName] sections.
 */
function parseMcpFromTomlConfig(configPath: string): Record<string, McpConfigEntry> {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = TOML.parse(content) as Record<string, unknown>;

    // Codex uses mcp_servers as a table with server names as keys
    const mcpServers = config.mcp_servers as Record<string, McpConfigEntry> | undefined;
    return mcpServers || {};
  } catch {
    /* TOML config corrupt or unreadable */
    return {};
  }
}

function parseMcpFromYamlConfig(configPath: string): Record<string, McpConfigEntry> {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const config = readYamlConfig(configPath);
    const mcpServers = config.mcp_servers as Record<string, McpConfigEntry> | undefined;
    return mcpServers || {};
  } catch {
    /* YAML config corrupt or unreadable */
    return {};
  }
}

/**
 * Parse MCP servers from OpenCode's JSONC config.
 * OpenCode stores MCPs in the "mcp" object with different structure.
 */
function parseMcpFromOpenCodeConfig(configPath: string): Record<string, McpConfigEntry> {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const content = stripJsonComments(fs.readFileSync(configPath, 'utf-8'));
    const config = JSON.parse(content);
    const mcpConfig = config.mcp as Record<string, {
      type?: string;
      command?: string[];
      url?: string;
      enabled?: boolean;
    }> | undefined;

    if (!mcpConfig) return {};

    // Convert OpenCode format to our McpConfigEntry format
    const result: Record<string, McpConfigEntry> = {};
    for (const [name, entry] of Object.entries(mcpConfig)) {
      if (entry.type === 'local' && entry.command) {
        // Local MCP: command is an array like ["npx", "-y", "@pkg@version"]
        result[name] = {
          command: entry.command[0],
          args: entry.command.slice(1),
        };
      } else if (entry.type === 'remote' && entry.url) {
        // Remote MCP: HTTP URL
        result[name] = {
          url: entry.url,
        };
      }
    }
    return result;
  } catch {
    /* OpenCode JSONC config corrupt or unreadable */
    return {};
  }
}

/**
 * Get user-scoped MCP config path for an agent.
 *
 * All three MCP path resolvers read `MCP_TARGETS`, so the file the writer
 * targets, the file the parser reads, and the file the staleness detector
 * watches cannot drift apart. An agent with no MCP target (the hard-deprecated
 * `gemini`) keeps the historical settings.json default so old configs still
 * parse.
 */
export function getUserMcpConfigPath(agentId: AgentId): string {
  return getMcpConfigPathForHome(agentId, HOME);
}

/**
 * Get MCP config path for a specific HOME directory (used for version-managed agents).
 */
export function getMcpConfigPathForHome(agentId: AgentId, home: string): string {
  const target = MCP_TARGETS[agentId];
  if (target) return target.home(home);
  return path.join(home, agentConfigDirName(agentId), 'settings.json');
}

/**
 * Get project-scoped MCP config path for an agent.
 */
export function getProjectMcpConfigPath(agentId: AgentId, cwd: string = process.cwd()): string {
  const target = MCP_TARGETS[agentId];
  if (target) return target.project(cwd);
  return path.join(cwd, `.${agentId}`, 'settings.json');
}

/**
 * Parse MCP servers from OpenClaw's JSON config.
 * OpenClaw stores MCPs under mcp.servers with a similar structure to other agents.
 */
function parseMcpFromOpenClawConfig(configPath: string): Record<string, McpConfigEntry> {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);

    // OpenClaw uses mcp.servers for MCP configuration
    const mcpServers = config.mcp?.servers as Record<string, {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      transport?: string;
    }> | undefined;

    if (!mcpServers) return {};

    const result: Record<string, McpConfigEntry> = {};
    for (const [name, entry] of Object.entries(mcpServers)) {
      if (entry.command) {
        result[name] = {
          command: entry.command,
          args: entry.args,
          env: entry.env,
        };
      } else if (entry.url) {
        result[name] = {
          url: entry.url,
          type: entry.transport || 'sse',
        };
      }
    }
    return result;
  } catch {
    /* OpenClaw JSON config corrupt or unreadable */
    return {};
  }
}

/**
 * Parse MCP config based on agent type.
 */
export function parseMcpConfig(agentId: AgentId, configPath: string): Record<string, McpConfigEntry> {
  // Dispatch on the registry's declared format, not the agent id, so the parser
  // can never disagree with the writer about a file's serialization -- grok's
  // TOML config was previously read as JSON and always came back empty.
  switch (MCP_TARGETS[agentId]?.format) {
    case 'toml':
      return parseMcpFromTomlConfig(configPath);
    case 'opencode-jsonc':
      return parseMcpFromOpenCodeConfig(configPath);
    case 'openclaw-json':
      return parseMcpFromOpenClawConfig(configPath);
    case 'yaml':
      return parseMcpFromYamlConfig(configPath);
    default:
      // claude-json / antigravity-json / muse-json all live in a JSON object;
      // parseMcpFromJsonConfig accepts mcpServers | mcp_servers | mcp. Agents
      // with no declared format fall here too, matching prior behavior.
      return parseMcpFromJsonConfig(configPath);
  }
}

/**
 * List installed MCP servers with scope information.
 * Pass options.home to read from a version-managed agent's home directory.
 */
export function listInstalledMcpsWithScope(
  agentId: AgentId,
  cwd: string = process.cwd(),
  options?: { home?: string }
): InstalledMcp[] {
  const results: InstalledMcp[] = [];

  // Helper to build full command string
  const buildCommand = (config: McpConfigEntry): string | undefined => {
    if (config.command && config.args?.length) {
      return `${config.command} ${config.args.join(' ')}`;
    }
    return config.command || (config.args ? config.args.join(' ') : undefined);
  };

  // User-scoped MCPs (version-aware when home is provided)
  const userConfigPath = options?.home
    ? getMcpConfigPathForHome(agentId, options.home)
    : getUserMcpConfigPath(agentId);
  const userMcps = parseMcpConfig(agentId, userConfigPath);
  for (const [name, config] of Object.entries(userMcps)) {
    results.push({
      name,
      scope: 'user',
      command: buildCommand(config),
      version: config.args ? extractNpmVersion(config.args) : undefined,
    });
  }

  // Project-scoped MCPs
  const projectConfigPath = getProjectMcpConfigPath(agentId, cwd);
  const projectMcps = parseMcpConfig(agentId, projectConfigPath);
  for (const [name, config] of Object.entries(projectMcps)) {
    // Skip if already in user scope (project can override, but we show both)
    results.push({
      name,
      scope: 'project',
      command: buildCommand(config),
      version: config.args ? extractNpmVersion(config.args) : undefined,
    });
  }

  return results;
}

/** Map of agent name aliases and shorthand identifiers to canonical AgentId values. */
export const AGENT_NAME_ALIASES: Record<string, AgentId> = {
  claude: 'claude',
  'claude-code': 'claude',
  cc: 'claude',
  codex: 'codex',
  'openai-codex': 'codex',
  cx: 'codex',
  gemini: 'gemini',
  'gemini-cli': 'gemini',
  gx: 'gemini',
  cursor: 'cursor',
  'cursor-agent': 'cursor',
  cr: 'cursor',
  opencode: 'opencode',
  oc: 'opencode',
  openclaw: 'openclaw',
  claw: 'openclaw',
  ocl: 'openclaw',
  copilot: 'copilot',
  'copilot-cli': 'copilot',
  'github-copilot': 'copilot',
  gh: 'copilot',
  amp: 'amp',
  sourcegraph: 'amp',
  goose: 'goose',
  'block-goose': 'goose',
  antigravity: 'antigravity',
  'google-antigravity': 'antigravity',
  agy: 'antigravity',
  ag: 'antigravity',
  grok: 'grok',
  'grok-build': 'grok',
  'xai-grok': 'grok',
  gk: 'grok',
  kimi: 'kimi',
  'kimi-code': 'kimi',
  factory: 'droid',
  'factory-ai': 'droid',
  droid: 'droid',
  hermes: 'hermes',
  'hermes-agent': 'hermes',
  muse: 'muse',
  'muse-code': 'muse',
  'muse-spark': 'muse',
  'meta-muse': 'muse',
  warp: 'warp',
  oz: 'warp',
  'warp-agent': 'warp',
  'warp-cli': 'warp',
};

/**
 * Resolve a user-provided agent name (alias, shorthand, or canonical) to its AgentId.
 * Tolerates a single typo (insertion/deletion/substitution/transposition) against
 * canonical ids and aliases — `cladue` -> claude, `kim` -> kimi, `codx` -> codex —
 * but only when the correction is unambiguous (all distance-1 candidates agree on
 * one agent). Two-letter shorthands are excluded as fuzzy candidates.
 */
export function resolveAgentName(input: string): AgentId | null {
  const lower = input.toLowerCase();
  const exact = AGENT_NAME_ALIASES[lower] ?? (AGENTS[lower as AgentId] ? (lower as AgentId) : null);
  if (exact || lower.length < 3) return exact;

  const hits = new Set<AgentId>();
  for (const id of ALL_AGENT_IDS) {
    if (damerauLevenshtein(lower, id) === 1) hits.add(id);
  }
  for (const [key, id] of Object.entries(AGENT_NAME_ALIASES)) {
    if (key.length >= 3 && damerauLevenshtein(lower, key) === 1) hits.add(id);
  }
  return hits.size === 1 ? hits.values().next().value! : null;
}

/** Check whether the input string matches any known agent name or alias. */
export function isAgentName(input: string): boolean {
  return resolveAgentName(input) !== null;
}

/**
 * Split a CLI-provided `<agent>[@<version>][#<label>]` spec into its bare agent
 * id, optional exact version token, and optional account label, the same way
 * `agents run` does — NOT the
 * agent-spec qualifier engine (`@latest`/`@all`), which enumerates installed
 * versions for read/diagnostic commands, not a single launch target. Returns an
 * error message rather than throwing so callers decide exit-vs-continue.
 */
export function parseAgentVersionSpec(
  raw: string,
): { agent: AgentId; version?: string; label?: string } | { error: string } {
  const labelParts = raw.split('#');
  if (labelParts.length > 2) {
    return { error: `Invalid agent spec '${raw}': at most one '#label' is allowed` };
  }
  const [versionSpec, rawLabel] = labelParts;
  if (rawLabel !== undefined && (rawLabel === '' || !/^[a-zA-Z0-9][a-zA-Z0-9@._+-]*$/.test(rawLabel))) {
    return { error: `Invalid account label '${rawLabel}' in '${raw}'` };
  }
  const parts = versionSpec.split('@');
  if (parts.length > 2) {
    return { error: `Invalid agent spec '${raw}': at most one '@version' is allowed` };
  }
  const [rawAgent, rawVersion] = parts;
  const agent = resolveAgentName(rawAgent);
  if (!agent) {
    return { error: `Unknown agent, profile, or workflow: ${rawAgent}. See \`agents view\` for the installed harnesses.` };
  }
  if (rawVersion !== undefined && (rawVersion === '' || !VERSION_RE.test(rawVersion))) {
    return { error: `Invalid version '${rawVersion}' in '${raw}'` };
  }
  return { agent, ...(rawVersion ? { version: rawVersion } : {}), ...(rawLabel ? { label: rawLabel } : {}) };
}

/**
 * Build the deprecation notice lines for an agent, or null if it isn't
 * deprecated. Split from the printer so tests can assert the content without
 * capturing stdout. Lines are plain (uncolored) text.
 */
export function deprecationNotice(agent: AgentId): string[] | null {
  const dep = AGENTS[agent].deprecated;
  if (!dep) return null;
  const name = AGENTS[agent].name;
  const lines = [
    `Warning: ${name} was deprecated by ${dep.by} (${dep.date}).`,
    `  ${dep.reason}`,
  ];
  if (dep.replacement) {
    const rep = AGENTS[dep.replacement];
    lines.push(`  Consider using ${rep.name} instead:  agents add ${rep.id}`);
  }
  if (dep.url) lines.push(`  ${dep.url}`);
  return lines;
}

export function hardDeprecationNotice(agent: AgentId): string[] | null {
  const dep = AGENTS[agent].deprecated;
  if (!dep?.hard) return null;
  const name = AGENTS[agent].name;
  const lines = [
    `${name} is no longer supported by agents-cli because ${dep.by} retired it (${dep.date}).`,
    `  ${dep.reason}`,
  ];
  if (dep.replacement) {
    const rep = AGENTS[dep.replacement];
    lines.push(`  Use ${rep.name} instead:  agents add ${rep.id}`);
  }
  if (dep.url) lines.push(`  ${dep.url}`);
  return lines;
}

export function hardDeprecationError(agent: AgentId): string {
  return hardDeprecationNotice(agent)?.join('\n') ?? `${AGENTS[agent].name} is no longer supported.`;
}

/**
 * Print a deprecation warning (yellow) if the agent's registry entry carries a
 * `deprecated` marker; no-op otherwise. Call from any user entry point that
 * acts on a chosen agent — install (`agents add`) and `agents teams add`.
 */
export function warnAgentDeprecated(agent: AgentId): void {
  const lines = deprecationNotice(agent);
  if (!lines) return;
  for (const line of lines) console.log(chalk.yellow(line));
}

/** Format an error message for an unrecognized agent name, listing valid options. */
export function formatAgentError(agentName: string, validAgents: AgentId[] = ALL_AGENT_IDS): string {
  return `Unknown agent '${agentName}'. Valid agents: ${validAgents.join(', ')}`;
}
