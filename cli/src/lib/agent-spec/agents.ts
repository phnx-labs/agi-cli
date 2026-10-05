/** Core agent registry and detection: the canonical registry of supported agents with CLI commands,
 * config paths, capability flags and MCP points, plus detection of installed CLIs, version-managed
 * binaries, account/auth info, and MCP registration. */
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

export interface CliState {
  installed: boolean;
  version: string | null;
  path: string | null;
}

const execFileAsync = promisify(execFile);

const HOME = os.homedir();

/** Minimum Codex CLI version that supports hooks. Mirrors `AGENTS.codex.capabilities.hooks.since`,
 * exported for legacy import sites not yet on `supports()`. */
export const CODEX_HOOKS_MIN_VERSION = '0.116.0';

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
  }
}

/** Synchronous PATH search, no subprocess; returns the first matching binary. Skips our shims dir
 * (`~/.agents/.cache/shims/`): counting dispatch shims as installs falsely listed never-installed
 * agents under `agents view`'s "Not Managed by Agents CLI". */
interface NativeBinaryResolutionOptions {
  accept?: (candidate: string) => boolean;
  shimsDir?: string;
  historyDir?: string;
}

function pathIsWithin(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Resolve a PATH candidate to the immutable native executable agents-cli may register. An adopted
 * launcher outside the shims dir can resolve back into it; then its adoption record is the source
 * of truth. */
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
  }

  if (!pathIsWithin(canonicalCandidate, canonicalShimsDir)) return canonicalCandidate;

  // A shim resolves only to its recorded original; never recurse into the shim tree.
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
        // A shell only runs an executable file, and `which` skips a mode-644 namesake, so must
        // this, or a stray non-executable `secrets`/`claude` earlier on PATH would shadow the real
        // binary. POSIX-only (win32 uses PATHEXT).
        if (process.platform !== 'win32') fs.accessSync(full, fs.constants.X_OK);
        const native = resolveNativeBinaryPath(command, full, options);
        if (native && (!options.accept || options.accept(native))) return native;
      } catch {
      }
    }
  }
  return null;
}

/** Grok-specific binary resolution. Grok isn't in node_modules/.bin; its versioned binaries live in
 * each managed version home under `.grok/downloads/`, so detection must not follow the host
 * ~/.grok symlink. */
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

/** Per-harness dispatch data that used to be `if (agentId === ...)` arms. Stable harness
 * properties, so a new AgentId must declare every field (pinned by the completeness test in
 * agents.test.ts). `getAccountInfo` and `readAuthAccountIdentity` stay call-site parsers. */
type VersionStdoutMatch = 'semver' | 'openclaw';
type UnmanagedBinaryResolver = 'path' | 'grok-downloads';
type McpRegisterPath = 'cli' | 'config';
type McpAddHttpStyle = 'transport' | 'url';
type McpAddStdioStyle = 'scope' | 'simple';
type McpConfigWriteStyle = 'json-mcpServers' | 'yaml-mcp_servers';

interface AgentRegistryConfig extends AgentConfig {
  /** Session-transcript directory as path segments under a HOME root, or null when the harness has
   * no local session tree `agents` can walk. */
  sessionDir: string[] | null;
  sessionFileExt: '.jsonl' | '.json' | null;
  versionStdoutMatch: VersionStdoutMatch;
  unmanagedBinary: UnmanagedBinaryResolver;
  /** How `registerMcp`/`unregisterMcp` talk to the harness: `config` writes the file directly (no
   * `mcp add` CLI); `cli` shells out. */
  mcpRegister: McpRegisterPath;
  mcpAddHttp: McpAddHttpStyle;
  mcpAddStdio: McpAddStdioStyle;
  mcpConfigWrite: McpConfigWriteStyle;
}

/** Master registry of all supported agents by AgentId: CLI command, npm package, config layout,
 * instructions file, slash-command format and capability flags. The single source of truth for
 * agent metadata. */
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
    nativePluginSkills: true,
    // Harness-owned skill directories survive orphan cleanup.
    ownedSkillDirs: ['synced'],
    // Claude Code has a native `claude --cloud` (Anthropic-managed, needs claude.ai auth), but
    // routing stays on Rush Cloud deliberately, keeping cloud tasks in one tracked fleet (agents
    // cloud list/status/logs).
    cloudProvider: 'rush',
    capabilities: { hooks: true, mcp: true, mcpHttp: true, mcpHeaders: true, allowlist: true, skills: true, commands: true, plugins: true, subagents: true, rules: { file: 'CLAUDE.md' }, workflows: true, memory: true, modes: ['plan', 'edit', 'auto', 'skip'], rulesImports: true, interactiveRepl: true },
  },
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
    capabilities: { hooks: { since: '0.116.0' }, mcp: true, mcpHttp: true, mcpHeaders: false, allowlist: { since: '0.138.0' }, skills: true, commands: { until: '0.117.0' }, plugins: { since: '0.128.0' }, subagents: { since: '0.117.0' }, rules: { file: 'AGENTS.md' }, workflows: false, memory: true, modes: ['plan', 'edit', 'auto', 'skip'], interactiveRepl: true },
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
    hooksDir: 'hooks',
    // Plugins: `.cursor-plugin/plugin.json` (re-enabled in CLI 2026-05). Mirror the Claude
    // marketplace layout into ~/.cursor/plugins/ and copy the manifest into pluginManifestDir
    // (same as droid/codex).
    pluginManifestDir: '.cursor-plugin',
    instructionsFile: '.cursorrules',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: true,
    // Subagents: `.cursor/agents/<name>.md` or `~/.cursor/agents/` (YAML frontmatter, no `color`),
    // shipped in cursor-agent CalVer `>= 2026.1.22` (Cursor 2.4). `agents sync` enforces it
    // (versions.ts); direct `subagents add --agents cursor` does not.
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
    // Plugins: TS/JS modules auto-loaded from ~/.config/opencode/plugins/ and .opencode/plugins/,
    // not the Claude marketplace format (see installOpenCodePlugin). Lifecycle hooks come via
    // plugin modules, not a native opencode.json shell-command hooks block (v1.18.4).
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
    commandsDir: '',
    commandsSubdir: '',
    skillsDir: path.join(HOME, '.openclaw', 'skills'),
    // Gateway owns commands; converting them to skills would create a second runtime.
    nativeCommandRuntime: true,

    hooksDir: 'hooks',
    instructionsFile: 'workspace/AGENTS.md',
    format: 'markdown',
    variableSyntax: '{{ARGUMENTS}}',
    // hooks: NOT supported. OpenClaw has only fixed internal hooks (e.g. `boot-md`), no general
    // event-to-shell registration, and registerHooksToSettings silently no-ops for it (RUSH-2122).
    // Flip to `true` only with a real registerHooksForOpenClaw.
    supportsHooks: false,
    // allowlist: blanket tool rules map to ~/.openclaw/openclaw.json
    // `tools.alsoAllow`/`tools.deny`; OpenClaw gates per tool only, so finer patterns are skipped.
    // Self-updating, so no pinned since. Workflows sync as Lobster `.lobster` files.
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
    hooksDir: 'hooks',
    // Copilot reads a plugin's manifest from the plugin root (plugin.json), not
    // `.claude-plugin/plugin.json`; mirror it there. Verified against GitHub Copilot CLI 1.0.56.
    pluginManifestDir: '.',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: true,
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
    skillsDir: path.join(HOME, '.agents', 'skills'),
    nativeAgentsSkillsDir: true,
    hooksDir: 'hooks',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: true,
    // Plugins: Open Plugins under ~/.agents/plugins/<name>/, copied per version home. Workflows
    // sync as recipe YAML; permissions are unsupported (permission.yaml gates whole tools).
    // Commands are recipe YAML under `slash_commands`; subagents are recipes in agents/.
    capabilities: { hooks: { since: '1.34.0' }, mcp: true, mcpHttp: false, mcpHeaders: false, allowlist: false, skills: { since: '1.25.0' }, commands: true, plugins: true, subagents: true, rules: { file: 'AGENTS.md' }, workflows: true, memory: false, modes: ['edit'], interactiveRepl: true },
  },
  // Google Antigravity CLI (`agy`), the Gemini CLI's replacement as of IO 2026. configDir nests in
  // `~/.gemini/` (`antigravity-cli/`), so per-version HOME isolation works via the shim's
  // configDirName. Auth: Google OAuth or ANTIGRAVITY_API_KEY.
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
    capabilities: { hooks: true, mcp: true, mcpHttp: false, mcpHeaders: false, allowlist: true, skills: true, commands: true, plugins: true, subagents: { since: '1.0.16' }, rules: { file: 'AGENTS.md' }, workflows: { since: '1.0.6' }, memory: false, modes: ['edit', 'skip'], rulesImports: false, interactiveRepl: true },
  },
  // xAI Grok Build CLI (`grok`), early beta. Auth: OAuth or XAI_API_KEY. MCP inline under
  // [mcp_servers] in ~/.grok/config.toml; hooks auto-discovered from ~/.grok/hooks/; permissions
  // via --allow/--deny or [permission]. Workflows (Rhai) go to ~/.grok/workflows/.
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
    // Grok discovers slash commands from ~/.agents/commands/ (the cross-agent dir) and the legacy
    // ~/.claude/commands/ symlink. We write there directly so the per-agent path and central user
    // repo stay in sync.
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
      allowlist: true,
      skills: true,
      commands: true,
      plugins: true,
      subagents: true,
      rules: { file: 'AGENTS.md' },
      workflows: { since: '0.2.111' },
      memory: true,
      modes: ['plan', 'edit', 'skip'],
      // Headless plan stalls at Grok's approval gate; interactive plan still works.
      headlessPlan: false,
      rulesImports: true,
      interactiveRepl: true,
    },
  },
  // Kimi Code CLI (`kimi`), Moonshot AI. Install: `curl -fsSL
  // https://code.kimi.com/kimi-code/install.sh | bash` or `npm install -g @moonshot-ai/kimi-code`.
  // Config under `~/.kimi-code/` (config.toml, mcp.json, skills/, hooks/).
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
      // Claude-shaped agent markdown under ~/.kimi-code/agents/, discovered via `USER_BRAND_DIRS`
      // since 0.29.0. 0.28.x and older compile four agent profiles into the bundle with no loader,
      // so a synced file is never read.
      subagents: { since: '0.29.0' },
      rules: { file: 'AGENTS.md' },
      workflows: true,
      memory: false,
      modes: ['plan', 'edit', 'auto', 'skip'],
      // Kimi rejects combining its headless prompt and plan flags.
      headlessPlan: false,
      rulesImports: false,
      interactiveRepl: true,
    },
  },
  // Factory AI Droid CLI (`droid`): no npm package, binary at ~/.local/bin/droid (see shims.ts),
  // config in ~/.factory/. Hooks are Claude-shaped, so the Claude registrar is reused. Workflows
  // stay false: Missions (RUSH-1864) are session state with no discovery dir.
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
      // Factory Missions are invoke-only; Droid exposes no installable workflow directory.
      workflows: false,
      memory: false,
      modes: ['plan', 'edit', 'auto', 'skip'],
      rulesImports: false,
      interactiveRepl: true,
    },
  },
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
    // Plugins: Hermes loads flat `~/.hermes/plugins/<name>/` with `plugin.yaml`, and only once the
    // name is in the `plugins.enabled` allowlist in config.yaml (`plugins.disabled` wins). Not the
    // Claude layout, so install is a flat copy plus a YAML allowlist toggle.
    capabilities: {
      // Hooks share config.yaml since 0.11.0; permissions persist command globs/deny only.
      hooks: { since: '0.11.0' },
      mcp: true,
      mcpHttp: true,
      mcpHeaders: false,
      // Permissions: ~/.hermes/config.yaml has `command_allowlist` (always-approved globs) and
      // `approvals.deny` (unconditional blocks). Command-glob only; session `/tools` toggles are
      // intentionally not persisted.
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
  // Meta Muse Code (`muse`), built on Muse Spark; native self-updating binary via curl installer.
  // Config `~/.config/muse/settings.json` (needs `"schema_version": 1`). Headless: `muse exec`.
  // Auth: META_API_KEY or OAuth at `~/.config/muse/auth.json`.
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
    // Muse hooks use the Claude-shaped settings.json hooks block (plus project `.muse/hooks.json`);
    // registerHooksForClaude is reused with Muse's config dir and schema_version: 1.
    supportsHooks: true,
    pluginManifestDir: '.muse-plugin',
    capabilities: {
      hooks: true,
      mcp: true,
      mcpHttp: true,
      mcpHeaders: true,
      // Safety has no tool-name writer; skills replace droppable commands/workflows.
      allowlist: false,
      skills: true,
      commands: false,
      plugins: true,
      // Runtime subagents are not an installable definition directory.
      subagents: false,
      rules: { file: 'AGENTS.md' },
      workflows: false,
      memory: true,
      modes: ['plan', 'edit', 'auto', 'skip'],
      rulesImports: false,
      interactiveRepl: true,
    },
  },
  // Warp Agent CLI (`warp`): standalone interactive TUI agent installed to ~/.local/bin/warp (not
  // the older `oz` runner). Interactive only: no headless one-shot, `-p` or `--model`.
  // Conversations sync server-side, so no local transcript and warp is absent from SESSION_AGENTS.
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
    // No general hooks or one-shot prompt; conversations and command surfaces are server-owned.
    supportsHooks: false,
    capabilities: {
      hooks: false,
      mcp: true,
      mcpHttp: true,
      mcpHeaders: true,
      allowlist: false,
      skills: true,
      commands: false,
      plugins: false,
      subagents: false,
      rules: { file: 'AGENTS.md' },
      workflows: false,
      memory: false,
      modes: ['edit'],
      rulesImports: false,
      // Bare Warp opens its only run form; there is no local transcript to index.
      interactiveRepl: true,
    },
  },
};

export const ALL_AGENT_IDS: AgentId[] = Object.keys(AGENTS) as AgentId[];

/** Agents the routine daemon can fire locally. Lives here, not runner.ts, so routines.ts can
 * validate without a circular import. A curated subset of AGENT_COMMANDS; expanding it is a
 * product change. Argv is baked in daemon/runner.ts bakeRoutineArgv: no second token table. */
export const ROUTINE_AGENT_IDS: readonly string[] = Object.freeze([
  'claude',
  'codex',
  'cursor',
  'kimi',
  'droid',
  'muse',
]);

export const MANAGED_AGENT_IDS: AgentId[] = ALL_AGENT_IDS.filter((id) => !AGENTS[id].deprecated?.hard);

/** A self-updating agent is a single global binary from an official `curl | sh`/`brew` script with
 * no version token, so no semver to pin and no version-homes. Predicate: `!npmPackage &&
 * installScript && !installScript.includes('VERSION')`. Route every pinnable check here. */
export function isSelfUpdatingAgent(agent: AgentId): boolean {
  const cfg = AGENTS[agent];
  return !cfg.npmPackage && !!cfg.installScript && !cfg.installScript.includes('VERSION');
}

export function isAgentHardDeprecated(agent: AgentId): boolean {
  // Legacy YAML may carry unknown ids; validation rejects them at the owning boundary.
  return AGENTS[agent]?.deprecated?.hard === true;
}

// Capability-filtered `*_CAPABLE_AGENTS` constants caused silent-skip bugs (grok rules sync gated
// on `COMMANDS_CAPABLE_AGENTS`). Use `capableAgents(cap)` from `./capabilities.js`, which reads
// the AgentConfig matrix directly.

export function colorAgent(agentId: string): (s: string) => string {
  const agent = AGENTS[agentId as AgentId];
  if (!agent) return chalk.white;
  return chalk[agent.color];
}

export function agentLabel(agentId: string): string {
  const agent = AGENTS[agentId as AgentId];
  if (!agent) return agentId;
  return chalk[agent.color](agent.name);
}

export async function isCliInstalled(agentId: AgentId): Promise<boolean> {
  const agent = AGENTS[agentId];
  return findInPath(agent.cliCommand) !== null;
}

export async function getCliVersion(agentId: AgentId): Promise<string | null> {
  const agent = AGENTS[agentId];
  const binaryPath = findInPath(agent.cliCommand);
  if (!binaryPath) return null;
  return getCachedVersionForBinary(agentId, binaryPath);
}

export async function getCliPath(agentId: AgentId): Promise<string | null> {
  return findInPath(AGENTS[agentId].cliCommand);
}

async function getCachedVersionForBinary(agentId: AgentId, binaryPath: string): Promise<string | null> {
  let mtime = 0;
  try {
    mtime = fs.statSync(binaryPath).mtimeMs;
  } catch {
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
    // probeCapture, not bare execFileAsync: a probed harness can fork children (copilot's binary
    // downloader) that a timeout kill would orphan mid-write (RUSH-3028). The probe runs in its own
    // process group, reaped on settle.
    const { stdout } = await probeCapture(agent.cliCommand, ['--version'], 3000);
    const versionRe = agent.versionStdoutMatch === 'openclaw'
      ? /openclaw\/(\d+\.\d+\.\d+)/
      : /(\d+\.\d+\.\d+)/;
    const match = stdout.match(versionRe);
    version = match ? match[1] : stdout.trim();
  } catch {
    version = null;
  }

  // Skip persisting null: a transient `--version` failure left a sticky-null entry so
  // `getCachedVersionForBinary` returned null forever even after the binary worked. Re-probing
  // costs one execFile.
  if (version !== null) {
    cache[agentId] = { binaryPath, mtime, version };
    saveCliVersionCache();
  }
  return version;
}

/** Resolve the full CLI state for an agent: installed, version, and binary path. Checks
 * version-managed installs first, then a plain PATH lookup. */
export async function getCliState(agentId: AgentId): Promise<CliState> {
  const agent = AGENTS[agentId];
  const agentVersionsDir = path.join(getVersionsDir(), agentId);
  if (fs.existsSync(agentVersionsDir)) {
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

/** Resolve the agent's own, unmanaged install by plain PATH lookup, ignoring version dirs. Callers
 * meaning the user's global CLI must use this, since `getCliState`'s managed fast path would
 * return an isolated copy labelled as the global install. */
export async function getUnmanagedCliState(agentId: AgentId): Promise<CliState> {
  // This path must never relabel an isolated managed version as the user's global install.
  const agent = AGENTS[agentId];
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

interface UnmanagedInstall {
  agentId: AgentId;
  configDir: string;
  version: string | null;
}

/** Agents `agents setup` probes for pre-existing native installs (config dir present before
 * agents-cli took over). Derived from `sessionDir` so a walkable harness can't be missing from
 * setup. */
export const UNMANAGED_DETECTION_CANDIDATES: AgentId[] = ALL_AGENT_IDS.filter(
  (id) => AGENTS[id].sessionDir !== null,
);

/** Detect existing installs not yet managed by agents-cli: agents whose config dir is a real
 * directory, not a symlink. */
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
    }
  }

  return unmanaged;
}

export function ensureCommandsDir(agentId: AgentId): void {
  const agent = AGENTS[agentId];
  if (!fs.existsSync(agent.commandsDir)) {
    fs.mkdirSync(agent.commandsDir, { recursive: true });
  }
}

export function ensureSkillsDir(agentId: AgentId): void {
  const agent = AGENTS[agentId];
  if (!fs.existsSync(agent.skillsDir)) {
    fs.mkdirSync(agent.skillsDir, { recursive: true });
  }
}

/** The agent's config-dir name relative to $HOME (e.g. '.claude', '.gemini/antigravity-cli',
 * '.config/amp'). Don't hardcode `.${agentId}`: wrong for nested or ~/.config dirs. Relative to
 * the module HOME constant, not `os.homedir()`, so it survives HOME overrides. */
export function agentConfigDirName(agentId: AgentId): string {
  // Use import-time HOME: nested config dirs and later HOME overrides must stay relative.
  return path.relative(HOME, AGENTS[agentId].configDir);
}

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
  // Whether the agent has a usable local credential. Usually `email != null`, but Antigravity and
  // Kimi store an opaque credential with no email claim. Callers wanting logged-in or not should
  // read this, not `email`.
  signedIn: boolean;
  // Claude-only: raw organizationType/organizationName from .claude.json's oauthAccount. Two
  // installs can share an email across a personal Max plan and a Team seat; these fields tell them
  // apart. Absent means not applicable.
  organizationType?: string | null;
  organizationName?: string | null;
}

/** Human-readable label for a Claude organizationType ("claude_team" -> "Team"). Unrecognized
 * values strip "claude_" and title-case; unfamiliar-but-visible beats silence. Null for missing
 * input. */
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

/** Short badge naming the org for a multi-seat Team/Enterprise account, disambiguating a seat from
 * a same-email personal plan. Null for personal plans (the tier is in the plan column; their org
 * name is boilerplate) and when no organizationType exists. */
export function accountOrgBadge(
  info?: Pick<AccountInfo, 'organizationType' | 'organizationName'> | null
): string | null {
  // Personal org names are boilerplate; only named multi-seat orgs disambiguate identity.
  const isMultiSeat =
    info?.organizationType === 'claude_team' || info?.organizationType === 'claude_enterprise';
  if (isMultiSeat && info?.organizationName) return info.organizationName;
  return null;
}

export const ACCOUNT_INSPECTION_AGENT_IDS = [
  'claude',
  'codex',
  'cursor',
  'grok',
  'antigravity',
  'kimi',
  'droid',
  'opencode',
  'muse',
] as const satisfies readonly AgentId[];

const ACCOUNT_INSPECTION_AGENTS = new Set<AgentId>(ACCOUNT_INSPECTION_AGENT_IDS);

export function supportsAccountInspection(agentId: AgentId): boolean {
  return ACCOUNT_INSPECTION_AGENTS.has(agentId);
}

/** Human-readable account identity shared by every account-aware surface: email, plus a multi-seat
 * Claude org name if present, else a non-secret account id or a generic signed-in label. */
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

export async function getAccountEmail(
  agentId: AgentId,
  home?: string
): Promise<string | null> {
  const info = await getAccountInfo(agentId, home);
  return info.email;
}

/** Extract full account information (identity, plan, usage status, credits) from the agent's local
 * auth/config files. Supports Claude, Codex, and Gemini. */
/** Resolve a file-auth agent's credential file. Sign-in is account-global but versions have
 * isolated homes, so check the per-version `base`, then the active config under the real HOME
 * (non-active versions showed as "not signed in"). First existing path or null. */
/** True when `dir` is under the per-account slot root (`~/.agents/.history/accounts/`). */
export function isAccountSlotDir(dir: string): boolean {
  const root = path.resolve(getHistoryDir(), 'accounts');
  const resolved = path.resolve(dir);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function resolveAccountCredentialPath(base: string, ...segments: string[]): string | null {
  const perVersion = path.join(base, ...segments);
  try { if (fs.existsSync(perVersion)) return perVersion; } catch {  }
  // An account slot is its own HOME and must not inherit another active account's config.
  if (isAccountSlotDir(base)) return null;
  const active = path.join(process.env.AGENTS_REAL_HOME || os.homedir(), ...segments);
  if (active !== perVersion) {
    try { if (fs.existsSync(active)) return active; } catch {  }
  }
  return null;
}

/** The on-disk credential files each account-inspectable agent authenticates from, as path segments
 * under a home, mirroring what getAccountInfo reads. Entries are alternatives (first existing
 * wins). Absence in both the version home and the active home makes a logged-out claim provable. */
const CREDENTIAL_FILE_SEGMENTS: Partial<Record<AgentId, string[][]>> = {
  claude: [['.claude', '.claude.json'], ['.claude.json']],
  codex: [['.codex', 'auth.json']],
  grok: [['.grok', 'auth.json']],
  kimi: [['.kimi-code', 'credentials', 'kimi-code.json']],
  droid: [['.factory', 'auth.v2.file']],
  antigravity: [['.gemini', 'antigravity-cli', 'antigravity-oauth-token']],
  opencode: [['.local', 'share', 'opencode', 'auth.json']],
  muse: [['.config', 'muse', 'auth.json']],
  cursor: [['.cursor', 'auth.json']],
};

function credentialFileExistsUnder(agentId: AgentId, home: string): boolean {
  const alternatives = CREDENTIAL_FILE_SEGMENTS[agentId];
  if (!alternatives) return false;
  const hasSegment = alternatives.some((segments) => {
    const p = path.join(home, ...segments);
    try { return fs.existsSync(p); } catch { return false; }
  });
  if (!hasSegment) return false;
  // Claude's `.claude.json` is account metadata written on any launch, not the credential: a
  // failed refresh blanks `.credentials.json`, and a Linux worker may lack both it and
  // `.oauth_token` (PHNX-3502). credentialPresence must fail when the file is blank.
  if (agentId === 'claude') return !isClaudeCredentialFileBlank(home);
  return true;
}

export interface CredentialPresence {
  perVersion: boolean;
  active: boolean;
  /** Whether we know where this agent's credential lives (an entry in CREDENTIAL_FILE_SEGMENTS).
   * When false both probes are false, so absence is not evidence of a logout. Separate from
   * `supportsAccountInspection`: cursor lacked a path and showed a false "logged out". */
  knownLocation: boolean;
}

/** File-presence probe for an agent's credential in a specific version home (`perVersion`) and the
 * active HOME (`active`). A logout is provable only when both are absent. Pure existence: no
 * decrypt, network or keychain prompt. Agents with no inspectable identity return both false. */
export function credentialPresence(agentId: AgentId, versionHome: string): CredentialPresence {
  // Logout is provable only for a known location when both isolated and active copies are absent.
  const realHome = process.env.AGENTS_REAL_HOME || os.homedir();
  const perVersion = credentialFileExistsUnder(agentId, versionHome);
  const active = credentialFileExistsUnder(agentId, realHome);
  const knownLocation = (CREDENTIAL_FILE_SEGMENTS[agentId]?.length ?? 0) > 0;
  return { perVersion, active, knownLocation };
}

interface DroidAuthPayload {
  access_token?: string;
  active_organization_id?: string | null;
}

/** Factory Droid's OAuth credential is AES-256-GCM at ~/.factory/auth.v2.file with the key base64
 * in auth.v2.key. On keyfile-v2 the key is on disk, so decrypt locally. Any failure (no key file,
 * bad tag, bad JSON) returns null; never throws. Shared by account identity and the usage fetcher. */
export function decryptDroidAuthPayload(base: string): DroidAuthPayload | null {
  const filePath = resolveAccountCredentialPath(base, '.factory', 'auth.v2.file');
  const keyPath = resolveAccountCredentialPath(base, '.factory', 'auth.v2.key');
  if (!filePath || !keyPath) return null;
  return decryptDroidAuthFile(filePath, keyPath);
}

/** Decrypt a Droid `auth.v2.file` given the exact file and key paths. Same crypto as
 * decryptDroidAuthPayload without the account-global HOME fallback, so a specific version home
 * resolves against only its own files (carryForwardAuthFiles). Null on any failure; never throws. */
function decryptDroidAuthFile(filePath: string, keyPath: string): DroidAuthPayload | null {
  // Exact paths deliberately bypass active-HOME fallback for per-directory carry-forward identity.
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

/** Account identity for a file-auth agent's credential dir (droid/kimi/antigravity), or null.
 * Decodes each on-disk format (JWT `sub`, or a SHA-256 of an opaque token so no live credential is
 * persisted). Lets carryForwardAuthFiles refuse overwriting another login (RUSH-1764). */
export function readAuthAccountIdentity(agent: AgentId, configDir: string): string | null {
  // Identity claims outlive JWT authorization; credential usability is decided elsewhere.
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
        // Opaque tokens are hashed because this identity key is persisted; never persist the secret.
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

/** Derive Droid identity from the decrypted credential: the WorkOS `access_token` JWT's `email`
 * claim, decoded without verifying `exp` (display identity, not authorization). Null when it can't
 * be decrypted, so the caller falls back to the file-presence signal. */
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

/** Antigravity (`agy`) stores its token via go-keyring: macOS keychain, Linux Secret Service
 * (preferred over the file), else `~/.gemini/antigravity-cli/antigravity-oauth-token`. Existence
 * probe only, cached per process; false on Windows; AGENTS_NO_KEYCHAIN_PROBE=1 skips it. */
export function antigravityOsKeyringProbe(
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[] } | null {
  if (platform === 'darwin') {
    return {
      cmd: 'security',
      // Omitting -w makes this a metadata-only probe that never reads the secret.
      args: ['find-generic-password', '-s', 'gemini', '-a', 'antigravity'],
    };
  }
  if (platform === 'linux') {
    return {
      cmd: 'secret-tool',
      // go-keyring maps the user to username, not the macOS account spelling.
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
  // Test isolation precedes the account-global cache; Linux secret stdout is discarded.
  if (process.env.AGENTS_NO_KEYCHAIN_PROBE === '1') return false;
  if (cachedAgyKeychainSignedIn !== undefined) return cachedAgyKeychainSignedIn;

  const probe = antigravityOsKeyringProbe();
  if (!probe) {
    cachedAgyKeychainSignedIn = false;
    return false;
  }
  try {
    await execFileAsync(probe.cmd, probe.args, {
      timeout: 3000,
      encoding: 'utf8',
    });
    cachedAgyKeychainSignedIn = true;
  } catch {
    cachedAgyKeychainSignedIn = false;
  }
  return cachedAgyKeychainSignedIn;
}

const OPENCODE_XDG_DIRS = {
  data: { env: 'XDG_DATA_HOME', fallback: ['.local', 'share'] },
  state: { env: 'XDG_STATE_HOME', fallback: ['.local', 'state'] },
} as const;

/** Resolve one of OpenCode's XDG-rooted files (credentials under $XDG_DATA_HOME, TUI state under
 * $XDG_STATE_HOME), defaulting to ~/.local/share and ~/.local/state on every platform. First
 * existing wins: the passed home (test hook), the XDG override, then the real home. Never throws. */
export function resolveOpenCodeXdgPath(
  base: string,
  kind: keyof typeof OPENCODE_XDG_DIRS,
  file: string,
): string | null {
  const { env, fallback } = OPENCODE_XDG_DIRS[kind];
  const candidates = [path.join(base, ...fallback, 'opencode', file)];
  const override = process.env[env];
  if (override) candidates.push(path.join(override, 'opencode', file));
  const realHome = process.env.AGENTS_REAL_HOME || os.homedir();
  candidates.push(path.join(realHome, ...fallback, 'opencode', file));
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch {  }
  }
  return null;
}

function resolveOpenCodeAuthPath(base: string): string | null {
  return resolveOpenCodeXdgPath(base, 'data', 'auth.json');
}

/** Validate one OpenCode auth.json entry against its union (`oauth`|`api`|`wellknown`) and confirm
 * its required secret fields are non-empty, so a half-written entry doesn't read as signed in.
 * Only the shape is inspected; secret values are never read out. */
function isValidOpenCodeCredential(value: unknown): boolean {
  // Only complete auth.json discriminated-union credentials establish a login.
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

/** The identity an OpenCode `oauth` credential's access token carries, when it is a JWT. OpenAI's
 * token has the same namespaced claims as Codex's auth.json, so extraction is shared with `case
 * 'codex'`; a plain `email` claim also works. Opaque tokens and `api` keys yield nothing. */
function openCodeOauthIdentity(cred: unknown): { email: string | null; plan: string | null } {
  const access = (cred as { type?: unknown; access?: unknown } | null)?.access;
  if (typeof access !== 'string' || access.length === 0) return { email: null, plan: null };
  const claims = decodeJwtPayload(access);
  if (!claims) return { email: null, plan: null };

  const profile = claims['https://api.openai.com/profile'] || {};
  const auth = claims['https://api.openai.com/auth'] || {};
  const rawEmail = profile.email ?? claims.email;
  const email = typeof rawEmail === 'string' && rawEmail.includes('@') ? rawEmail : null;
  const rawPlan = auth.chatgpt_plan_type;
  const plan = typeof rawPlan === 'string' && rawPlan
    ? rawPlan.charAt(0).toUpperCase() + rawPlan.slice(1)
    : null;
  return { email, plan };
}

export interface OpenCodeIdentity {
  providers: string;
  email: string | null;
  plan: string | null;
}

/** OpenCode's account identity from `auth.json`. The provider join (`"meta+openai+opencode-go"`) is
 * the stable key session/discover.ts indexes by; OAuth providers add email and plan, in sorted
 * order. The only correct source: opencode.db's account tables are empty on real installs. */
export function resolveOpenCodeIdentity(base: string): OpenCodeIdentity | undefined {
  // auth.json, not empty SQLite account tables, is authoritative; sorted providers form the stable key.
  const authPath = resolveOpenCodeAuthPath(base);
  if (!authPath) return undefined;
  try {
    const data = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    if (!data || typeof data !== 'object') return undefined;
    const valid = Object.entries(data as Record<string, unknown>)
      .filter(([, cred]) => isValidOpenCodeCredential(cred))
      .sort(([a], [b]) => a.localeCompare(b));
    if (valid.length === 0) return undefined;

    let email: string | null = null;
    let plan: string | null = null;
    for (const [, cred] of valid) {
      const claimed = openCodeOauthIdentity(cred);
      email ??= claimed.email;
      plan ??= claimed.plan;
      if (email && plan) break;
    }
    return { providers: valid.map(([id]) => id).join('+'), email, plan };
  } catch {
    return undefined;
  }
}

/** The provider join alone, the key `session/discover.ts` indexes sessions by, for callers that
 * don't need the OAuth claim walk. */
export function resolveOpenCodeAccountId(base: string): string | undefined {
  return resolveOpenCodeIdentity(base)?.providers;
}

/** Whether a Muse Code `~/.config/muse/auth.json` holds a usable access token. Live shape from
 * `muse login`: `{ schema_version: 1, providers: { meta: { access_token, ... } } }`. Recurse: a
 * one-level walk reported signed-out after a successful login. Never returns the secret. */
function museAuthHasToken(value: unknown, depth = 0): boolean {
  // Live auth nests under providers.meta; bounded recursion also accepts older nested writers.
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

/** Whether a Claude home's credential file is present but token-less, the "real credential" floor:
 * a failed refresh blanks `.credentials.json` while `.claude.json` looks healthy, so balanced kept
 * picking it. Off macOS only (Keychain prompts); a `.oauth_token` setup-token counts. No network. */
export function isClaudeCredentialFileBlank(
  base: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  // macOS uses Keychain; on Linux absence means logged out while corrupt data fails open.
  if (platform === 'darwin') return false;
  // A per-version setup-token is a real credential on Linux even without `.credentials.json` (the
  // shim's `$CLAUDE_CONFIG_DIR/.oauth_token`), so treat it as signed in or rotation skips such
  // workers.
  try {
    const token = fs.readFileSync(path.join(base, '.claude', '.oauth_token'), 'utf-8').trim();
    if (token.length > 0) return false;
  } catch {
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
    // Off macOS the file is the store: missing means the home can't authenticate (PHNX-2685
    // false-healthy case). A corrupt file isn't evidence of a blank credential, so leave the
    // existing signal alone.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }
}

/** Identity of the Claude account a home is or was logged into, from `.claude.json`'s
 * `oauthAccount`, deliberately independent of whether the credential works. Attribution of history
 * must survive revocation or trashing, which the getAccountInfo floor would erase. */
export interface ClaudeHomeIdentity {
  email: string | null;
  accountId: string | null;
  organizationId: string | null;
  organizationName: string | null;
  organizationType: string | null;
  /** Org-scoped identity: the rate-limit bucket and the right grouping key. A Team seat and a
   * personal Max plan under one email are separate buckets and must stay distinct (see
   * `candidateIdentity` in lib/rotate.ts). */
  usageKey: string | null;
  accountKey: string | null;
}

interface ClaudeHomeConfig {
  path: string;
  config: Record<string, any>;
  identity: ClaudeHomeIdentity;
}

/** Read a Claude home's config and account identity; null with no readable `.claude.json` or no
 * `oauthAccount`. Sync because the session scanner calls it per home on a hot path; no Keychain
 * (see getAccountInfo). */
export function readClaudeHomeConfig(base: string): ClaudeHomeConfig | null {
  // Claude reads config at $CLAUDE_CONFIG_DIR/.claude.json, else $HOME/.claude.json. Our shim sets
  // it to the per-version .claude dir, so prefer that file; fall back to home-level for versions
  // launched without the shim.
  const configDirFile = path.join(base, '.claude', '.claude.json');
  const homeLevelFile = path.join(base, '.claude.json');
  // Version-home config takes precedence over the legacy home-level file.
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

  // A worker slot from a durable setup-token has only the email on disk
  // (seedClaudeWorkerHomeIdentity), so the row reads "not connected here" (PHNX-3940). Complete
  // the identity from the fleet-synced registry row, for email-only homes; else fail closed.
  if (email && !accountId && !organizationId) {
    // Email-only worker homes accept one exact registry match; ambiguity fails closed.
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
      // Usage is org-scoped; account routing is account+org scoped.
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
  // Group accounts by stable provider/org identity, never display text or stale metadata.
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
    // OpenCode keeps every session in one sqlite file, so the per-session file walk finds nothing;
    // the mtime fallback is right since opencode.db is written every turn.
    opencode: resolveOpenCodeXdgPath(base, 'data', 'opencode.db') ?? undefined,
  };
  const lastActive = resolveLastActive(agentId, base, configFiles[agentId]);

  try {
    switch (agentId) {
      case 'claude': {
        // Identity extraction is shared with the session scanner (see readClaudeHomeConfig). No
        // readable config or no `oauthAccount` means signed out, as before the refactor.
        const claudeHome = readClaudeHomeConfig(base);
        if (!claudeHome) return { ...empty, lastActive };
        const { config: data, identity } = claudeHome;
        const oa = data.oauthAccount;
        const { accountId, organizationId, email, accountKey, usageKey } = identity;

        // Credential floor: a blanked credential file means this home can't authenticate whatever
        // `.claude.json` says. Report signed out so `agents view` prompts re-login and rotation
        // routes around it.
        if (email && isClaudeCredentialFileBlank(base)) {
          return { ...empty, lastActive };
        }

        // Plan tier comes from `.claude.json` organizationType (claude_max -> "Max"), already in
        // hand with no Keychain prompt. billingType mislabels Max as "Pro", so it is only an
        // older-config fallback; the keychain's subscriptionType would prompt every run.
        let plan: string | null = formatClaudeOrgLabel(oa?.organizationType);
        if (!plan) {
          if (oa?.billingType === 'stripe_subscription') {
            plan = 'Pro';
          } else if (oa?.billingType) {
            plan = oa.billingType;
          }
        }

        // usageStatus is not derived from cachedExtraUsageDisabledReason, which says why overage
        // is off, not whether the account is throttled. Real throttle state comes from usage
        // windows (deriveUsageStatusFromSnapshot); here only signed-in is reported.
        const usageStatus: AccountInfo['usageStatus'] = email ? 'available' : null;

        // Overage credit display is independent of the subscription throttle status.
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
      case 'cursor': {
        // Cursor CLI keeps account metadata in ~/.cursor/cli-config.json (authInfo: email, userId,
        // authId) and OAuth tokens separately in ~/.cursor/auth.json. An access token means signed
        // in; authId is the OAuth subject the usage endpoint keys on (see getCursorUsageInfo).
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
            } catch {  }
          }
          if (!hasToken) return { ...empty, lastActive };
          const accountKey = buildIdentityKey(agentId, [['user', accountId]]);
          return { ...empty, email, accountId, accountKey, signedIn: true, lastActive };
        } catch {}
        return { ...empty, lastActive };
      }
      case 'grok': {
        // Grok stores auth in ~/.grok/auth.json as a map keyed `<oidc_issuer>::<client_id>` (older
        // builds were flat). Reading only a top-level `email` made the nested format look
        // signed-out. Read the newest record: a refresh token means signed in.
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
        // Antigravity (`agy`) stores a consumer Google OAuth grant with no id_token; a refresh
        // token is the only network-free signed-in signal. Storage is go-keyring platform-split:
        // the Linux fallback file, or macOS keychain / Linux libsecret. Check the file first.
        const tokenPath = resolveAccountCredentialPath(base, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
        if (tokenPath) {
          const data = JSON.parse(await fs.promises.readFile(tokenPath, 'utf-8'));
          if (typeof data?.token?.refresh_token === 'string' && data.token.refresh_token) {
            const identity = readAuthAccountIdentity('antigravity', path.dirname(tokenPath));
            return { ...empty, signedIn: true, lastActive, accountKey: identity, usageKey: identity };
          }
        }
        if (await antigravityKeychainSignedIn()) {
          const identity = buildIdentityKey('antigravity', [['sub', 'keychain']]);
          return { ...empty, signedIn: true, lastActive, accountKey: identity, usageKey: identity };
        }
        return { ...empty, lastActive };
      }
      case 'kimi': {
        // Kimi Code stores OAuth at ~/.kimi-code/credentials/kimi-code.json. Its JWT carries an
        // opaque user_id and no email, so report signed-in plus a stable account key for usage
        // dedup.
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
        // Factory Droid auth is AES-256-GCM at ~/.factory/auth.v2.file with the on-disk
        // auth.v2.key. Decrypt locally and surface email/org/role from the WorkOS JWT. If it can't
        // be decrypted (keyring-v2/legacy login), fall back to file presence.
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
        // An unreadable encrypted payload still counts conservatively when its auth file exists.
        const authPath = resolveAccountCredentialPath(base, '.factory', 'auth.v2.file');
        if (!authPath) return { ...empty, lastActive };
        return { ...empty, signedIn: true, lastActive };
      }
      case 'opencode': {
        // OpenCode's auth.json maps provider id to `{ type, ...secrets }`. The provider join is
        // the identity key (see resolveOpenCodeIdentity); an OAuth provider's token adds email and
        // plan. Only JWT claims are read.
        const identity = resolveOpenCodeIdentity(base);
        if (!identity) return { ...empty, lastActive };
        const accountKey = buildIdentityKey(agentId, [['providers', identity.providers]]);
        return {
          ...empty,
          signedIn: true,
          accountId: identity.providers,
          accountKey,
          email: identity.email,
          plan: identity.plan,
          lastActive,
        };
      }
      case 'muse': {
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
    return { ...empty, lastActive };
  }
}

// Short-lived launch-path cache: never serve stale entries; no-session falls back to config mtime.
const LAST_ACTIVE_CACHE_FRESH_MS = 5 * 60 * 1000;

const getLastActiveCachePath = () => path.join(getCacheDir(), 'last-active.json');

interface LastActiveCacheEntry {
  mtimeMs: number | null;
  computedAt: number;
}

/** Determine when the agent was last used from session file mtimes, falling back to config mtime.
 * The walk stats thousands of files and rotation calls it per version on every launch, so the
 * result is cached on disk briefly. Cache failures fall back to walking. */
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
    } else {
      const mtimeMs = latestFileMtimeMs(sessionDir, sessionExt);
      cache[key] = { mtimeMs, computedAt: now.getTime() };
      // Prune obsolete homes on each best-effort cache write.
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

function readLastActiveCacheFile(cachePath: string): Record<string, LastActiveCacheEntry> {
  if (!fs.existsSync(cachePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as Record<string, LastActiveCacheEntry>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeLastActiveCacheFile(cache: Record<string, LastActiveCacheEntry>, cachePath: string): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf-8');
  } catch {
  }
}

function getSessionDir(agentId: AgentId, base: string): string | null {
  const rel = AGENTS[agentId].sessionDir;
  return rel ? path.join(base, ...rel) : null;
}

function getSessionExtension(agentId: AgentId): string | null {
  return AGENTS[agentId].sessionFileExt;
}

/** Quick count of session files for an agent without a full DB scan, to show an approximate count
 * during init. */
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
    }
  };
  walk(sessionDir);
  return count;
}

export function decodeJwtPayload(token: string): Record<string, any> | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }
}

function getCodexDefaultOrgId(authClaim: any): string | null {
  const organizations = authClaim?.organizations;
  if (!Array.isArray(organizations)) return null;
  const first = organizations[0];
  return typeof first?.id === 'string' ? first.id : null;
}

function normalizeIdentityPart(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

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
    // HOME selects the version-owned MCP config for CLI-backed registration.
    const env = options?.home ? { ...process.env, HOME: options.home } : undefined;
    // On Windows a bare command or `.cmd` wrapper needs shell:true; off Windows this is false and
    // the argv path is unchanged. RUSH-1752: when a shell is needed, compose a fully-quoted line
    // with empty argv so user-controlled MCP command/args never reach cmd.exe unescaped.
    const spec = execFileShellSpec(bin, args);
    await execFileAsync(spec.command, spec.args, { ...(env ? { env } : {}), shell: spec.shell });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

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
    // HOME selects the version-owned MCP config for CLI-backed removal.
    const env = options?.home ? { ...process.env, HOME: options.home } : undefined;
    // Keep attacker-controlled names on the same quoted Windows wrapper path.
    const spec = execFileShellSpec(bin, ['mcp', 'remove', name]);
    await execFileAsync(spec.command, spec.args, { ...(env ? { env } : {}), shell: spec.shell });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export interface McpTargetOperationResult {
  agentId: AgentId;
  version?: string;
  success: boolean;
  error?: string;
}

/** Register an MCP server across multiple targets, both direct (non-version-managed) agents and
 * specific version-managed installs. */
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

/** Unregister an MCP server from multiple targets, both direct agents and specific version-managed
 * installs. */
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

type McpScope = 'user' | 'project';

interface InstalledMcp {
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

/** Extract the version from an npm package spec (`@scope/package@1.2.3` -> 1.2.3, `@latest` ->
 * latest, `some-package` -> undefined). */
function extractNpmVersion(args: string[]): string | undefined {
  for (const arg of args) {
    const match = arg.match(/@([^@]+)$|^([^@]+)@(.+)$/);
    if (match) {
      const versionMatch = arg.match(/@([^@/]+)$/);
      if (versionMatch) {
        return versionMatch[1];
      }
    }
  }
  return undefined;
}

/** Strip JSON comments for JSONC parsing, only outside strings. Exported because the MCP writer
 * needs the same parser as the reader: a naive `//` regex eats the `//` in `"$schema":
 * "https://opencode.ai/config.json"`. */
export function stripJsonComments(content: string): string {
  // Strip comments only outside strings so schema and MCP URLs survive JSONC parsing.
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
      if (char === '/' && next === '/') {
        while (i < content.length && content[i] !== '\n') {
          i++;
        }
        continue;
      }
      if (char === '/' && next === '*') {
        i += 2;
        while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) {
          i++;
        }
        i += 2;
        continue;
      }
    }

    result += char;
    i++;
  }

  return result;
}

function parseMcpFromJsonConfig(configPath: string): Record<string, McpConfigEntry> {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    let content = fs.readFileSync(configPath, 'utf-8');
    if (configPath.endsWith('.jsonc')) {
      content = stripJsonComments(content);
    }
    const config = JSON.parse(content);

    return config.mcpServers || config.mcp_servers || config.mcp || {};
  } catch {
    return {};
  }
}

/** Parse MCP servers from a Codex TOML config, which stores them as [mcp_servers.ServerName]
 * sections. */
function parseMcpFromTomlConfig(configPath: string): Record<string, McpConfigEntry> {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = TOML.parse(content) as Record<string, unknown>;

    const mcpServers = config.mcp_servers as Record<string, McpConfigEntry> | undefined;
    return mcpServers || {};
  } catch {
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
    return {};
  }
}

/** Parse MCP servers from OpenCode's JSONC config, which keeps them in the "mcp" object with a
 * different shape. */
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

    const result: Record<string, McpConfigEntry> = {};
    for (const [name, entry] of Object.entries(mcpConfig)) {
      if (entry.type === 'local' && entry.command) {
        result[name] = {
          command: entry.command[0],
          args: entry.command.slice(1),
        };
      } else if (entry.type === 'remote' && entry.url) {
        result[name] = {
          url: entry.url,
        };
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** User-scoped MCP config path for an agent. All three MCP path resolvers read `MCP_TARGETS`, so
 * the writer, parser and staleness detector can't drift. An agent with no target keeps the
 * settings.json default. */
export function getUserMcpConfigPath(agentId: AgentId): string {
  return getMcpConfigPathForHome(agentId, HOME);
}

export function getMcpConfigPathForHome(agentId: AgentId, home: string): string {
  const target = MCP_TARGETS[agentId];
  if (target) return target.home(home);
  return path.join(home, agentConfigDirName(agentId), 'settings.json');
}

export function getProjectMcpConfigPath(agentId: AgentId, cwd: string = process.cwd()): string {
  const target = MCP_TARGETS[agentId];
  if (target) return target.project(cwd);
  return path.join(cwd, `.${agentId}`, 'settings.json');
}

/** Parse MCP servers from OpenClaw's JSON config (under mcp.servers, similar to other agents). */
function parseMcpFromOpenClawConfig(configPath: string): Record<string, McpConfigEntry> {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);

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
    return {};
  }
}

export function parseMcpConfig(agentId: AgentId, configPath: string): Record<string, McpConfigEntry> {
  // Path, writer, parser, and staleness dispatch share MCP_TARGETS' format declaration.
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
      // JSON owns declared Claude/Antigravity/Muse formats and legacy undeclared agents.
      return parseMcpFromJsonConfig(configPath);
  }
}

/** List installed MCP servers with scope information; pass options.home for a version-managed
 * agent's home. */
export function listInstalledMcpsWithScope(
  agentId: AgentId,
  cwd: string = process.cwd(),
  options?: { home?: string }
): InstalledMcp[] {
  const results: InstalledMcp[] = [];

  const buildCommand = (config: McpConfigEntry): string | undefined => {
    if (config.command && config.args?.length) {
      return `${config.command} ${config.args.join(' ')}`;
    }
    return config.command || (config.args ? config.args.join(' ') : undefined);
  };

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

  const projectConfigPath = getProjectMcpConfigPath(agentId, cwd);
  const projectMcps = parseMcpConfig(agentId, projectConfigPath);
  for (const [name, config] of Object.entries(projectMcps)) {
    results.push({
      name,
      scope: 'project',
      command: buildCommand(config),
      version: config.args ? extractNpmVersion(config.args) : undefined,
    });
  }

  return results;
}

const AGENT_NAME_ALIASES: Record<string, AgentId> = {
  claude: 'claude',
  'claude-code': 'claude',
  cc: 'claude',
  codex: 'codex',
  'openai-codex': 'codex',
  cx: 'codex',
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

/** Resolve a user-provided agent name (alias, shorthand, or canonical) to its AgentId. Tolerates
 * one typo (`cladue` -> claude) only when all distance-1 candidates agree on one agent; two-letter
 * shorthands are excluded as fuzzy candidates. */
export function resolveAgentName(input: string): AgentId | null {
  // Resolve exact names first; fuzzy 3+ character matches must be one edit and one target.
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

export function isAgentName(input: string): boolean {
  return resolveAgentName(input) !== null;
}

/** Split a CLI `<agent>[@<version>][#<label>]` spec into agent id, exact version token and account
 * label, as `agents run` does, not the `@latest`/`@all` qualifier engine. Returns an error message
 * rather than throwing so callers choose exit or continue. */
export function parseAgentVersionSpec(
  raw: string,
): { agent: AgentId; version?: string; label?: string } | { error: string } {
  // This parses one run target, not the diagnostic selector grammar with @all/@latest.
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

/** Build the deprecation notice lines for an agent, or null if not deprecated. Split from the
 * printer so tests can assert content without capturing stdout; plain uncolored text. */
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

/** Print a yellow deprecation warning if the agent's registry entry has a `deprecated` marker;
 * no-op otherwise. Call from user entry points that act on a chosen agent (`agents add`, `agents
 * teams add`). */
export function warnAgentDeprecated(agent: AgentId): void {
  const lines = deprecationNotice(agent);
  if (!lines) return;
  for (const line of lines) console.log(chalk.yellow(line));
}

export function formatAgentError(agentName: string, validAgents: AgentId[] = ALL_AGENT_IDS): string {
  return `Unknown agent '${agentName}'. Valid agents: ${validAgents.join(', ')}`;
}
