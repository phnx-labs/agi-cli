/**
 * MCP server management - reading from ~/.agents/mcp/ and applying to agent configs.
 *
 * MCP servers are stored as YAML files in ~/.agents/mcp/:
 *   ~/.agents/mcp/swarm.yaml
 *   ~/.agents/mcp/figma.yaml
 *
 * Each file defines a server that gets applied (merged) into agent configs during sync.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import * as TOML from 'smol-toml';
import { execFileSync } from 'child_process';
import * as os from 'os';
import type { AgentId } from './types.js';
import { getMcpDir, getUserMcpDir, getProjectAgentsDir, getVersionsDir, getUserAgentsDir } from './state.js';
import { getBinaryPath, getVersionHomePath } from './installations/versions.js';
import { IS_WINDOWS, execFileShellSpec } from './platform/index.js';
import { AGENTS, getMcpConfigPathForHome, getProjectMcpConfigPath, parseMcpConfig, stripJsonComments } from './agents.js';
import { MCP_TARGETS, mcpWriteUnsupportedReason } from './mcp-registry.js';
import { isCapable } from './capabilities.js';

/**
 * MCP server config as stored in ~/.agents/mcp/*.yaml
 */
export interface McpYamlConfig {
  name: string;
  transport: 'stdio' | 'http';
  // For stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // For http transport
  url?: string;
}

export interface InstalledMcpServer {
  name: string;
  path: string;
  config: McpYamlConfig;
  scope?: 'user' | 'project';
}

export interface McpCommandSpec {
  command: string;
  args: string[];
}

export interface McpTargetOperationResult {
  agentId: AgentId;
  version?: string;
  success: boolean;
  error?: string;
}

/**
 * Parse an MCP server config from a YAML file.
 */
export function parseMcpServerConfig(filePath: string): McpYamlConfig | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  let parsed: unknown;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    parsed = yaml.parse(content);
  } catch {
    return null;
  }

  return validateMcpYamlConfig(parsed);
}

/**
 * Validate an MCP server name. Rejects names that could be misinterpreted as
 * command-line options or that contain characters unsafe for argv/identifier use.
 */
export function validateMcpServerName(name: string): void {
  if (name.startsWith('-')) {
    throw new Error(`Invalid MCP server name '${name}': names cannot start with '-'`);
  }
  if (/[\s\0-\x1f\x7f]/.test(name)) {
    throw new Error(`Invalid MCP server name '${name}': names cannot contain whitespace or control characters`);
  }
}

function validateMcpYamlConfig(parsed: unknown): McpYamlConfig | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const config = parsed as Record<string, unknown>;
  if (typeof config.name !== 'string' || config.name.length === 0) return null;
  validateMcpServerName(config.name);
  if (config.transport !== 'stdio' && config.transport !== 'http') return null;

  const result: McpYamlConfig = {
    name: config.name,
    transport: config.transport,
  };

  if (config.transport === 'stdio') {
    if (config.command === undefined || config.command === '') return null;
    if (typeof config.command !== 'string') {
      throw new Error(`Invalid MCP config '${config.name}': command must be a string`);
    }
    result.command = config.command;
    if (config.args !== undefined) {
      if (!Array.isArray(config.args) || !config.args.every((arg) => typeof arg === 'string')) {
        throw new Error(`Invalid MCP config '${config.name}': args must be a string array`);
      }
      result.args = config.args;
    }
    if (config.env !== undefined) {
      if (!isStringRecord(config.env)) {
        throw new Error(`Invalid MCP config '${config.name}': env must be a string map`);
      }
      result.env = config.env;
    }
  } else {
    if (typeof config.url !== 'string' || config.url.length === 0) return null;
    result.url = config.url;
  }

  return result;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === 'string');
}

// ─── Project MCP trust (RUSH-1776) ───────────────────────────────────────────
// Project-scoped MCP configs (<repo>/.agents/mcp/*.yaml) are UNTRUSTED by
// default. An MCP server is an arbitrary command spawned under the agent's
// authority, so merely cloning a hostile repo must never auto-register or run
// it. A project's MCP servers enter the register/spawn path only after the user
// explicitly trusts that project (`agents mcp trust`), recorded in a user-owned
// store OUTSIDE any repo so a cloned repo can't grant itself trust. User- and
// system-scoped MCPs (~/.agents/mcp/*) are always trusted.

/** Path to the user-owned project-trust store (never inside a repo). */
export function getMcpTrustStorePath(): string {
  return path.join(getUserAgentsDir(), 'mcp-trust.yaml');
}

/**
 * Key a project by its ROOT (parent of `.agents/`), resolved through symlinks
 * so the key is stable no matter how the cwd was spelled.
 */
function normalizeProjectKey(projectAgentsDir: string): string {
  const root = path.dirname(projectAgentsDir);
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

function readTrustedProjects(): Set<string> {
  const storePath = getMcpTrustStorePath();
  if (!fs.existsSync(storePath)) return new Set();
  let parsed: unknown;
  try {
    parsed = yaml.parse(fs.readFileSync(storePath, 'utf-8'));
  } catch {
    return new Set();
  }
  const list = parsed && typeof parsed === 'object' && Array.isArray((parsed as { trustedProjects?: unknown }).trustedProjects)
    ? (parsed as { trustedProjects: unknown[] }).trustedProjects
    : [];
  const out = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    try {
      out.add(fs.realpathSync(entry));
    } catch {
      out.add(path.resolve(entry));
    }
  }
  return out;
}

function writeTrustedProjects(trusted: Set<string>): void {
  const storePath = getMcpTrustStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, yaml.stringify({ trustedProjects: Array.from(trusted).sort() }), 'utf-8');
}

/**
 * Whether the project that owns `projectAgentsDir` has been explicitly trusted
 * for MCP auto-apply. Untrusted by default (fail closed).
 */
export function isProjectMcpTrusted(projectAgentsDir: string): boolean {
  return readTrustedProjects().has(normalizeProjectKey(projectAgentsDir));
}

/**
 * Record explicit trust for the project containing `cwd` so its project-scoped
 * MCP servers may be registered/spawned. Returns the trusted project root, or
 * null when `cwd` is not inside a project (no `.agents/` to trust).
 */
export function trustProjectMcp(cwd: string = process.cwd()): string | null {
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (!projectAgentsDir) return null;
  const key = normalizeProjectKey(projectAgentsDir);
  const trusted = readTrustedProjects();
  if (!trusted.has(key)) {
    trusted.add(key);
    writeTrustedProjects(trusted);
  }
  return key;
}

/** Revoke MCP trust for the project containing `cwd`. Returns true if it was trusted. */
export function untrustProjectMcp(cwd: string = process.cwd()): boolean {
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (!projectAgentsDir) return false;
  const key = normalizeProjectKey(projectAgentsDir);
  const trusted = readTrustedProjects();
  if (!trusted.delete(key)) return false;
  writeTrustedProjects(trusted);
  return true;
}

/**
 * List all MCP server configs from ~/.agents/mcp/.
 *
 * When `enforceProjectTrust` is set, project-scoped configs are included only
 * for a project the user has explicitly trusted (see `isProjectMcpTrusted`) —
 * this is the choke point that keeps an untrusted cloned repo's MCP servers out
 * of the register/spawn path. It ALSO fixes name-collision shadowing: an
 * untrusted project entry is dropped before dedup, so it can never mask a
 * same-named user entry. Display callers omit the flag to surface project
 * entries (command+args and all) regardless of trust.
 */
export function listMcpServerConfigs(
  cwd: string = process.cwd(),
  options: { enforceProjectTrust?: boolean } = {}
): InstalledMcpServer[] {
  const dirs: Array<{ scope: 'project' | 'user'; dir: string }> = [];
  const projectAgentsDir = getProjectAgentsDir(cwd);
  const includeProject = projectAgentsDir !== null
    && (!options.enforceProjectTrust || isProjectMcpTrusted(projectAgentsDir));
  if (projectAgentsDir && includeProject) {
    dirs.push({ scope: 'project', dir: path.join(projectAgentsDir, 'mcp') });
  }
  // User dir first (wins on name collision), then system
  dirs.push({ scope: 'user', dir: getUserMcpDir() });
  dirs.push({ scope: 'user', dir: getMcpDir() });

  const results = new Map<string, InstalledMcpServer>();

  for (const { scope, dir } of dirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;

      const filePath = path.join(dir, entry.name);
      const config = parseMcpConfigForScan(filePath);
      if (config && !results.has(config.name)) {
        results.set(config.name, {
          name: config.name,
          path: filePath,
          config,
          scope,
        });
      }
    }
  }

  return Array.from(results.values());
}

/**
 * Parse one config during a directory SCAN. `validateMcpYamlConfig` returns null
 * for some malformed shapes but *throws* for others (`args` not a string array,
 * `command`/`env` of the wrong type), and a scan must not be all-or-nothing: a
 * single bad file under `<repo>/mcp/` took down the whole of
 * `agents inspect <repo>` with an unhandled stack trace. Skip the file and name
 * it, exactly as a null return is already skipped. Explicit single-file
 * operations call `parseMcpServerConfig` directly and still throw loudly.
 */
export function parseMcpConfigForScan(filePath: string): McpYamlConfig | null {
  try {
    return parseMcpServerConfig(filePath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`agents-cli: skipping ${filePath} — ${reason}`);
    return null;
  }
}

/**
 * Scan a repository for MCP server YAML configs.
 * Looks under <repoPath>/mcp/*.yaml — same on-disk layout as ~/.agents/mcp/.
 */
export function discoverMcpConfigsFromRepo(repoPath: string): InstalledMcpServer[] {
  const dir = path.join(repoPath, 'mcp');
  if (!fs.existsSync(dir)) return [];

  const results: InstalledMcpServer[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;

    const filePath = path.join(dir, entry.name);
    const config = parseMcpConfigForScan(filePath);
    if (config) {
      results.push({ name: config.name, path: filePath, config, scope: 'user' });
    }
  }
  return results;
}

/**
 * Install an MCP YAML config from a source file into ~/.agents/mcp/.
 * Re-serializes via writeMcpServerConfig so the on-disk filename is
 * deterministic (sanitized from the server name).
 */
export function installMcpConfigCentrally(
  sourcePath: string
): { success: boolean; error?: string; path?: string } {
  try {
    const config = parseMcpServerConfig(sourcePath);
    if (!config) {
      return { success: false, error: `Invalid MCP config at ${sourcePath}` };
    }
    const written = writeMcpServerConfig(config);
    return { success: true, path: written };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Get MCP servers by name.
 * If names is provided, returns only those servers.
 * Otherwise returns all servers.
 */
export function getMcpServersByName(
  names?: string[],
  options: { cwd?: string; enforceProjectTrust?: boolean } = {}
): InstalledMcpServer[] {
  // This feeds the register/spawn path (installMcpServers, workflow assembly),
  // so untrusted project-scoped servers are excluded by default (fail closed).
  const enforceProjectTrust = options.enforceProjectTrust ?? true;
  const allServers = listMcpServerConfigs(options.cwd, { enforceProjectTrust });
  if (!names || names.length === 0) {
    return allServers;
  }
  return allServers.filter((server) => names.includes(server.name));
}

/**
 * Assemble the JSON payload Claude's `--mcp-config` flag expects from a set of
 * installed MCP servers: `{ "mcpServers": { "<name>": { command, args, env } | { url } } }`.
 * Pure — takes servers, returns a JSON string. The caller writes it to an
 * ephemeral file and passes the path to buildExecCommand.
 */
export function buildWorkflowMcpConfig(servers: InstalledMcpServer[]): string {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const server of servers) {
    const cfg = server.config;
    if (cfg.transport === 'http') {
      mcpServers[server.name] = { url: cfg.url };
    } else {
      const entry: Record<string, unknown> = { command: cfg.command };
      if (cfg.args && cfg.args.length > 0) entry.args = cfg.args;
      if (cfg.env && Object.keys(cfg.env).length > 0) entry.env = cfg.env;
      mcpServers[server.name] = entry;
    }
  }
  return JSON.stringify({ mcpServers });
}

/**
 * Install MCP server using Claude CLI.
 * Uses: claude mcp add --scope user --transport <type> <name> [--env K=V]... -- <cmd> [args...]
 */
function installMcpViaClaude(binaryPath: string, server: InstalledMcpServer, versionHome: string): void {
  const execEnv = { ...process.env, HOME: versionHome };

  if (server.config.transport === 'stdio') {
    // Build env args
    const envArgs: string[] = [];
    if (server.config.env) {
      for (const [key, value] of Object.entries(server.config.env)) {
        envArgs.push('--env', `${key}=${value}`);
      }
    }

    // claude mcp add --scope user --transport stdio [--env K=V]... -- <name> <cmd> [args...]
    const args = [
      'mcp', 'add', '--scope', 'user', '--transport', 'stdio',
      ...envArgs,
      '--',
      server.name,
      server.config.command!,
      ...(server.config.args || [])
    ];

    // RUSH-1752: user-controlled MCP command/args must not reach cmd.exe unquoted.
    const spec = execFileShellSpec(binaryPath, args);
    execFileSync(spec.command, spec.args, {
      stdio: 'pipe',
      timeout: 30000,
      env: execEnv,
      shell: spec.shell,
    });
  } else {
    // claude mcp add --scope user --transport http -- <name> <url>
    const httpArgs = ['mcp', 'add', '--scope', 'user', '--transport', 'http', '--', server.name, server.config.url!];
    const spec = execFileShellSpec(binaryPath, httpArgs);
    execFileSync(spec.command, spec.args, {
      stdio: 'pipe',
      timeout: 30000,
      env: execEnv,
      shell: spec.shell,
    });
  }
}

/**
 * Install MCP server using Codex CLI.
 * Uses: codex mcp add <name> -- <cmd> [args...]
 */
function installMcpViaCodex(binaryPath: string, server: InstalledMcpServer, versionHome: string): void {
  let args: string[];
  if (server.config.transport === 'http') {
    if (!server.config.url) throw new Error(`HTTP MCP '${server.name}' has no url`);
    // codex mcp add <name> --url <url>
    args = ['mcp', 'add', server.name, '--url', server.config.url];
  } else {
    // codex mcp add -- <name> <cmd> [args...]
    args = [
      'mcp', 'add',
      '--',
      server.name,
      server.config.command!,
      ...(server.config.args || [])
    ];
  }

  // RUSH-1752: user-controlled MCP command/args must not reach cmd.exe unquoted.
  const spec = execFileShellSpec(binaryPath, args);
  execFileSync(spec.command, spec.args, {
    stdio: 'pipe',
    timeout: 30000,
    env: { ...process.env, HOME: versionHome },
    shell: spec.shell,
  });
}

export async function registerMcpCommandToTargets(
  targets: { directAgents: AgentId[]; versionSelections: Map<AgentId, string[]> },
  name: string,
  commandSpec: McpCommandSpec,
  scope: 'user' | 'project' = 'user',
  transport: string = 'stdio'
): Promise<McpTargetOperationResult[]> {
  const results: McpTargetOperationResult[] = [];

  for (const agentId of targets.directAgents) {
    const result = registerMcpCommand(agentId, name, commandSpec, scope, transport);
    results.push({ agentId, success: result.success, error: result.error });
  }

  for (const [agentId, versions] of targets.versionSelections) {
    for (const version of versions) {
      const result = registerMcpCommand(agentId, name, commandSpec, scope, transport, {
        home: getVersionHomePath(agentId, version),
        binary: getBinaryPath(agentId, version),
      });
      results.push({ agentId, version, success: result.success, error: result.error });
    }
  }

  return results;
}

function registerMcpCommand(
  agentId: AgentId,
  name: string,
  commandSpec: McpCommandSpec,
  scope: 'user' | 'project',
  transport: string,
  options: { home?: string; binary?: string } = {}
): { success: boolean; error?: string } {
  try {
    validateMcpServerName(name);
    if (agentId === 'hermes') {
      // Hermes has no `mcp add` CLI; write its YAML config directly.
      const home = options.home || os.homedir();
      writeMcpConfig(agentId, getMcpConfigPathForHome(agentId, home), [{
        name,
        transport: transport === 'http' ? 'http' : 'stdio',
        ...(transport === 'http'
          ? { url: commandSpec.command }
          : { command: commandSpec.command, args: commandSpec.args }),
      }], 'merge');
      return { success: true };
    }
    const bin = options.binary || AGENTS[agentId].cliCommand;
    const commandArgs = [commandSpec.command, ...commandSpec.args];
    const args = agentId === 'claude'
      ? ['mcp', 'add', '--transport', transport, '--scope', scope, '--', name, ...commandArgs]
      : ['mcp', 'add', '--', name, ...commandArgs];
    const env = options.home ? { ...process.env, HOME: options.home } : process.env;
    // RUSH-1752: user-controlled MCP command/args must not reach cmd.exe unquoted.
    const spec = execFileShellSpec(bin, args);
    execFileSync(spec.command, spec.args, { stdio: 'pipe', timeout: 30000, env, shell: spec.shell });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * MCP server shaped for direct config-file serialization.
 */
export interface WritableMcpServer {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** Project a discovered MCP server config into the writer's input shape. */
function toWritableServer(server: InstalledMcpServer): WritableMcpServer {
  return {
    name: server.config.name,
    transport: server.config.transport,
    command: server.config.command,
    args: server.config.args,
    env: server.config.env,
    url: server.config.url,
  };
}

/**
 * Read an existing agent config, or `{}` when it does not exist yet.
 *
 * A file that exists but does not parse **throws** rather than resetting to
 * `{}`: these configs hold far more than MCP (hermes' whole `config.yaml`,
 * openclaw's `openclaw.json`, opencode's `opencode.jsonc`), so silently
 * rewriting one from scratch destroys everything else in it. The five per-agent
 * installers this replaced parsed unguarded for exactly that reason -- the throw
 * surfaced as a reported error and left the file intact, which is the behavior
 * preserved here.
 */
function readExistingConfig(
  configPath: string,
  parse: (raw: string) => unknown,
): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, 'utf-8');
  // An empty (or whitespace-only) file is "nothing recorded yet", not corruption
  // -- a touched file or an interrupted write. `JSON.parse('')` throws, so
  // without this an empty ~/.factory/mcp.json would fail the whole sync.
  if (raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    throw new Error(`existing config at ${configPath} is not valid: ${(err as Error).message}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`existing config at ${configPath} is not an object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Parse a JSONC config.
 *
 * Uses the shared string-literal-aware `stripJsonComments` — the same one the
 * read path uses on this very file. A regex that blanks `//` to end-of-line
 * destroys `"$schema": "https://opencode.ai/config.json"`, which every
 * opencode-generated config carries, and would make the writer disagree with
 * the reader about the same bytes.
 */
function parseJsonc(raw: string): unknown {
  return JSON.parse(stripJsonComments(raw));
}

/**
 * Serialize MCP servers into an agent-specific config file.
 *
 * The format comes from `MCP_TARGETS` (lib/mcp-registry.ts), so a harness whose
 * schema is not implemented **throws** here rather than falling through the
 * switch and returning as if it had written something. `installMcpServers`
 * catches that and reports it as an error, never as a silent success.
 *
 * `mode: 'overwrite'` replaces the whole MCP section (used for tool-managed
 * version-home configs). `mode: 'merge'` updates/adds the provided server
 * entries while preserving existing entries (used for project-level configs
 * that users may hand-edit or populate via agent CLI commands).
 *
 * An empty `servers` list is a no-op by default — most callers pass a
 * resolved-but-possibly-empty selection and an empty one means "nothing to
 * apply," not "clear whatever is there," so this must never wipe an existing
 * config out from under an unrelated caller. `options.allowEmpty` is the
 * explicit opt-in for a caller that owns the ENTIRE mcp section by
 * construction (it always knows the complete current desired server set,
 * including the empty set) and needs `overwrite` to actually clear it —
 * still only the mcp section: `readExistingConfig` above preserves every
 * other top-level key already, in both modes.
 */
export function writeMcpConfig(
  agentId: AgentId,
  configPath: string,
  servers: WritableMcpServer[],
  mode: 'overwrite' | 'merge' = 'overwrite',
  options: { allowEmpty?: boolean } = {}
): void {
  if (servers.length === 0 && !options.allowEmpty) {
    return;
  }

  // Narrowed, not asserted: this is what lets the `never` guard on the default
  // arm below be a real compile-time check rather than a cosmetic one.
  const target = MCP_TARGETS[agentId];
  if (!target || target.format === null) {
    throw new Error(`cannot write MCP config: ${mcpWriteUnsupportedReason(agentId)}`);
  }

  const format = target.format;
  switch (format) {
    // Claude's `{ "mcpServers": {...} }` schema, shared by cursor, kimi, droid
    // and Oz (.warp/.mcp.json): stdio carries command/args/env,
    // remote carries url + optional headers.
    case 'claude-json': {
      const config = readExistingConfig(configPath, JSON.parse);

      const mcpServers: Record<string, unknown> =
        mode === 'merge' && config.mcpServers && typeof config.mcpServers === 'object'
          ? { ...(config.mcpServers as Record<string, unknown>) }
          : {};

      for (const server of servers) {
        if (server.transport === 'stdio') {
          mcpServers[server.name] = {
            command: server.command,
            args: server.args || [],
            env: server.env || {},
          };
        } else {
          mcpServers[server.name] = {
            url: server.url,
            ...(server.headers && { headers: server.headers }),
          };
        }
      }

      config.mcpServers = mcpServers;

      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      break;
    }
    case 'antigravity-json': {
      // agy reads ~/.gemini/config/mcp_config.json. Same `mcpServers` map as
      // Claude for stdio, but a remote server is keyed `serverUrl` (SSE) and
      // carries no headers — see agy's bundled docs/mcp_servers.md.
      const config = readExistingConfig(configPath, JSON.parse);

      const mcpServers: Record<string, unknown> =
        mode === 'merge' && config.mcpServers && typeof config.mcpServers === 'object'
          ? { ...(config.mcpServers as Record<string, unknown>) }
          : {};

      for (const server of servers) {
        if (server.transport === 'stdio') {
          mcpServers[server.name] = {
            command: server.command,
            args: server.args || [],
            env: server.env || {},
          };
        } else {
          mcpServers[server.name] = { serverUrl: server.url };
        }
      }

      config.mcpServers = mcpServers;

      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      break;
    }
    case 'openclaw-json': {
      const config = readExistingConfig(configPath, JSON.parse);

      if (!config.mcp || typeof config.mcp !== 'object') {
        config.mcp = {};
      }
      const mcp = config.mcp as Record<string, unknown>;

      const mcpServers: Record<string, unknown> =
        mode === 'merge' && mcp.servers && typeof mcp.servers === 'object'
          ? { ...(mcp.servers as Record<string, unknown>) }
          : {};

      for (const server of servers) {
        if (server.transport === 'stdio') {
          mcpServers[server.name] = {
            command: server.command,
            args: server.args || [],
            env: server.env || {},
          };
        } else {
          mcpServers[server.name] = {
            url: server.url,
            transport: server.transport,
            ...(server.headers && { headers: server.headers }),
          };
        }
      }

      mcp.servers = mcpServers;
      config.mcp = mcp;

      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      break;
    }
    case 'toml': {
      const config = readExistingConfig(configPath, (raw) => TOML.parse(raw));

      const mcpServers: Record<string, unknown> =
        mode === 'merge' && config.mcp_servers && typeof config.mcp_servers === 'object'
          ? { ...(config.mcp_servers as Record<string, unknown>) }
          : {};

      for (const server of servers) {
        if (server.transport === 'stdio') {
          mcpServers[server.name] = {
            command: server.command,
            args: server.args || [],
            ...(server.env && { env: server.env }),
          };
        } else {
          mcpServers[server.name] = {
            url: server.url,
            ...(server.headers && { headers: server.headers }),
          };
        }
      }

      config.mcp_servers = mcpServers;

      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, TOML.stringify(config), 'utf-8');
      break;
    }
    case 'opencode-jsonc': {
      const config = readExistingConfig(configPath, parseJsonc);

      const mcp: Record<string, unknown> =
        mode === 'merge' && config.mcp && typeof config.mcp === 'object'
          ? { ...(config.mcp as Record<string, unknown>) }
          : {};

      for (const server of servers) {
        if (server.transport === 'stdio') {
          const commandArray = [server.command, ...(server.args || [])];
          mcp[server.name] = {
            type: 'local',
            command: commandArray,
            ...(server.env && { env: server.env }),
          };
        } else {
          mcp[server.name] = {
            type: 'remote',
            url: server.url,
          };
        }
      }

      config.mcp = mcp;

      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      break;
    }
    case 'yaml': {
      const config = readExistingConfig(configPath, (raw) => yaml.parse(raw));

      const mcpServers: Record<string, unknown> =
        mode === 'merge' && config.mcp_servers && typeof config.mcp_servers === 'object' && !Array.isArray(config.mcp_servers)
          ? { ...(config.mcp_servers as Record<string, unknown>) }
          : {};

      for (const server of servers) {
        if (server.transport === 'stdio') {
          mcpServers[server.name] = {
            command: server.command,
            args: server.args || [],
            ...(server.env && { env: server.env }),
          };
        } else {
          mcpServers[server.name] = {
            url: server.url,
          };
        }
      }

      config.mcp_servers = mcpServers;

      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, yaml.stringify(config), 'utf-8');
      break;
    }
    case 'muse-json': {
      // Muse Code settings.json: requires schema_version: 1; MCP lives under
      // mcp_servers with an explicit transport (stdio | streamable_http).
      // See https://dev.meta.ai/docs/muse-code/extending#mcp
      const config = readExistingConfig(configPath, JSON.parse);
      if (config.schema_version === undefined) {
        config.schema_version = 1;
      }

      const mcpServers: Record<string, unknown> =
        mode === 'merge' && config.mcp_servers && typeof config.mcp_servers === 'object' && !Array.isArray(config.mcp_servers)
          ? { ...(config.mcp_servers as Record<string, unknown>) }
          : {};

      for (const server of servers) {
        if (server.transport === 'stdio') {
          mcpServers[server.name] = {
            transport: 'stdio',
            command: server.command,
            args: server.args || [],
            ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
            enabled: true,
          };
        } else {
          mcpServers[server.name] = {
            transport: 'streamable_http',
            url: server.url,
            ...(server.headers && Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
            enabled: true,
          };
        }
      }

      config.mcp_servers = mcpServers;

      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      break;
    }
    default: {
      // Unreachable: mcpWriteUnsupportedReason above rejects a null format and
      // every McpFormat has an arm. The assignment is deliberately NOT cast —
      // `as never` would make it unfailable and the guard cosmetic. Adding an
      // McpFormat without an arm above is a compile error here.
      const unhandled: never = format;
      throw new Error(`unhandled MCP config format: ${String(unhandled)}`);
    }
  }
}

/**
 * Install MCP servers to an agent.
 * For Claude/Codex: uses CLI commands (claude mcp add, codex mcp add)
 * For others: edits config files directly
 */
export function installMcpServers(
  agentId: AgentId,
  version: string,
  versionHome: string,
  mcpNames?: string[],
  options: { cwd?: string } = {}
): { success: boolean; applied: string[]; errors: string[] } {
  if (!isCapable(agentId, 'mcp')) {
    return { success: true, applied: [], errors: [] };
  }

  const servers = getMcpServersByName(mcpNames, { cwd: options.cwd });
  if (servers.length === 0) {
    return { success: true, applied: [], errors: [] };
  }

  const applied: string[] = [];
  const errors: string[] = [];

  // Get binary path for CLI-based agents. On Windows npm drops a `.cmd` launcher
  // next to the extensionless POSIX wrapper in node_modules/.bin; prefer it so
  // the CLI is actually executable (the bare wrapper is a shell script).
  const cliCommand = AGENTS[agentId].cliCommand;
  let binaryPath = path.join(getVersionsDir(), agentId, version, 'node_modules', '.bin', cliCommand);
  if (IS_WINDOWS && fs.existsSync(binaryPath + '.cmd')) {
    binaryPath += '.cmd';
  }

  for (const server of servers) {
    let handled = false;

    try {
      const target = MCP_TARGETS[agentId];
      if (target?.cli === 'claude') {
        installMcpViaClaude(binaryPath, server, versionHome);
        handled = true;
      } else if (target?.cli === 'codex') {
        installMcpViaCodex(binaryPath, server, versionHome);
        handled = true;
      } else {
        // No harness CLI for this agent (or none that works — `grok mcp add`
        // does not register into the version home), so write its config file
        // directly. `writeMcpConfig` throws for a harness whose format is not
        // implemented, which the catch below turns into a reported error rather
        // than a silent success. Merge, because this loop runs once per server.
        writeMcpConfig(agentId, getMcpConfigPathForHome(agentId, versionHome), [toWritableServer(server)], 'merge');
        handled = true;
      }

      // Project-layer servers also get merged into the agent's project-level
      // config (e.g., .mcp.json, .codex/config.toml) so the CLI discovers them
      // when run inside the repo.
      if (server.scope === 'project' && options.cwd) {
        writeMcpConfig(agentId, getProjectMcpConfigPath(agentId, options.cwd), [toWritableServer(server)], 'merge');
        handled = true;
      }

      if (handled) {
        applied.push(server.name);
      }
    } catch (err) {
      const message = (err as Error).message;
      // Check if it's an "already exists" error - that's not a real error
      if (message.includes('already exists') || message.includes('already configured')) {
        applied.push(server.name); // Count as applied since it's already there
      } else {
        errors.push(`${server.name}: ${message}`);
      }
    }
  }

  return { success: errors.length === 0, applied, errors };
}

/**
 * Write an MCP server config to ~/.agents/mcp/.
 */
export function writeMcpServerConfig(config: McpYamlConfig): string {
  validateMcpServerName(config.name);
  const mcpDir = getUserMcpDir();
  fs.mkdirSync(mcpDir, { recursive: true });

  const fileName = `${config.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}.yaml`;
  const filePath = path.join(mcpDir, fileName);

  const content = yaml.stringify(config);
  fs.writeFileSync(filePath, content, 'utf-8');

  return filePath;
}

/** The transport-agnostic fields that identify an MCP server across formats. */
interface McpComparable {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

/**
 * Canonical string form of an MCP server for a structural, format-agnostic
 * compare: http servers by url; stdio servers by command + args (order
 * significant) + env (key-sorted, so serialization order is not drift). Undefined
 * / empty fields are dropped so `{args: []}` and `{}` compare equal.
 */
function mcpCanonical(entry: McpComparable): string {
  if (entry.url) return JSON.stringify({ url: entry.url });
  const env = entry.env && Object.keys(entry.env).length > 0
    ? Object.fromEntries(Object.entries(entry.env).sort(([a], [b]) => a.localeCompare(b)))
    : undefined;
  return JSON.stringify({
    command: entry.command,
    args: entry.args && entry.args.length > 0 ? entry.args : undefined,
    env,
  });
}

/**
 * True when MCP server `name` materialized in `agent`'s version home byte-matches
 * the resolved SOURCE definition `source` — the content-drift predicate `agents
 * doctor` uses. Parses the home's canonical MCP config for the harness (no
 * `claude mcp add` shell-out — the on-disk file is parseable) and structurally
 * compares command/args/env/url. Returns false when the server is absent from
 * the home (surfaced as `missing`/`extra` at the name level, not here).
 */
export function mcpServerMatches(
  agent: AgentId,
  versionHome: string,
  name: string,
  source: McpYamlConfig,
): boolean {
  const homePath = getMcpConfigPathForHome(agent, versionHome);
  const home = parseMcpConfig(agent, homePath)[name];
  if (!home) return false;
  const sourceComparable: McpComparable = source.transport === 'http'
    ? { url: source.url }
    : { command: source.command, args: source.args, env: source.env };
  return mcpCanonical(sourceComparable) === mcpCanonical(home);
}

/**
 * Remove an MCP server config from ~/.agents/mcp/.
 */
export function removeMcpServerConfig(name: string): boolean {
  const servers = listMcpServerConfigs();
  const server = servers.find((s) => s.name === name);
  if (!server) {
    return false;
  }

  fs.unlinkSync(server.path);
  return true;
}
