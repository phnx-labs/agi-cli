/** MCP server management: servers are YAML files in ~/.agents/mcp/ (e.g. swarm.yaml) merged into
 * agent configs during sync. */

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

/** Validates an MCP server name; rejects names that could be read as command-line options or
 * contain characters unsafe for argv/identifiers. */
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

// Project MCP trust (RUSH-1776): project-scoped configs (<repo>/.agents/mcp/*.yaml) are UNTRUSTED
// by default, since a server is an arbitrary command. Used only after `agents mcp trust`, stored
// outside any repo. User/system-scoped MCPs are always trusted.

/** Path to the user-owned project-trust store (never inside a repo). */
export function getMcpTrustStorePath(): string {
  return path.join(getUserAgentsDir(), 'mcp-trust.yaml');
}

/** Keys a project by its ROOT (parent of `.agents/`), resolved through symlinks so the key is
 * stable however the cwd was spelled. */
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

/** Whether the project owning `projectAgentsDir` was explicitly trusted for MCP auto-apply.
 * Untrusted by default (fail closed). */
export function isProjectMcpTrusted(projectAgentsDir: string): boolean {
  return readTrustedProjects().has(normalizeProjectKey(projectAgentsDir));
}

/** Records explicit trust for the project containing `cwd`. Returns the trusted root, or null when
 * `cwd` is not in a project (no `.agents/`). */
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

/** Lists MCP server configs. With `enforceProjectTrust`, project configs are included only for
 * trusted projects: the choke point keeping an untrusted repo's servers out of register/spawn;
 * they are dropped before dedup so they can't shadow a user entry. Display callers omit the flag. */
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

/** Parses one config during a directory SCAN. validateMcpYamlConfig throws for some malformed
 * shapes, and one bad file under `<repo>/mcp/` took down all of `agents inspect <repo>`; skip and
 * name the file instead. Explicit single-file operations still throw. */
export function parseMcpConfigForScan(filePath: string): McpYamlConfig | null {
  try {
    return parseMcpServerConfig(filePath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`agents-cli: skipping ${filePath} — ${reason}`);
    return null;
  }
}

/** Scans a repository for MCP server YAML under <repoPath>/mcp/*.yaml, the same layout as
 * ~/.agents/mcp/. */
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

/** Installs an MCP YAML config into ~/.agents/mcp/, re-serialized via writeMcpServerConfig so the
 * filename is deterministic (sanitized from the server name). */
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

/** Gets MCP servers by name; all servers when `names` is not provided. */
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

/** Assembles the JSON Claude's `--mcp-config` flag expects from installed servers: `{ "mcpServers":
 * { name: { command, args, env } | { url } } }`. Pure; the caller writes it to an ephemeral file. */
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

/** Installs an MCP server via `claude mcp add --scope user --transport <type> <name> [--env K=V]...
 * -- <cmd> [args...]`. */
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

/** Installs an MCP server via `codex mcp add <name> -- <cmd> [args...]`. */
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

/** Reads an existing agent config, or `{}` when absent. A file that exists but does not parse
 * THROWS instead of resetting, since these configs hold far more than MCP (hermes config.yaml,
 * openclaw.json, opencode.jsonc) and a rewrite from scratch destroys the rest. */
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

/** Parses JSONC with the shared string-literal-aware `stripJsonComments`, the same as the read
 * path. A regex blanking `//` destroys `"$schema": "https://opencode.ai/config.json"` and makes
 * writer and reader disagree. */
function parseJsonc(raw: string): unknown {
  return JSON.parse(stripJsonComments(raw));
}

/** Serializes MCP servers into an agent's config; format comes from `MCP_TARGETS`, an unimplemented
 * harness THROWS. `overwrite` replaces the MCP section, `merge` updates given entries. Empty
 * `servers` is a no-op unless `options.allowEmpty`; other top-level keys are always preserved. */
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
      // Unreachable: mcpWriteUnsupportedReason rejects a null format and every McpFormat has an
      // arm. The assignment is deliberately not cast (`as never` would make the guard cosmetic),
      // so a new McpFormat without an arm fails to compile.
      const unhandled: never = format;
      throw new Error(`unhandled MCP config format: ${String(unhandled)}`);
    }
  }
}

/** Installs MCP servers to an agent: via CLI commands (`claude mcp add`, `codex mcp add`) for
 * Claude/Codex, direct config edits for the rest. */
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
        // No working harness CLI for this agent (`grok mcp add` doesn't register into the version
        // home), so write the config directly. writeMcpConfig throws for an unimplemented format
        // and the catch reports it. Merge, since this loop runs once per server.
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

/** Canonical string form of an MCP server for a format-agnostic compare: http by url; stdio by
 * command + args (ordered) + env (key-sorted). Empty fields are dropped so `{args: []}` equals
 * `{}`. */
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

/** True when server `name` in `agent`'s version home matches the resolved SOURCE definition (the
 * `agents doctor` content-drift predicate). Parses the on-disk config and compares
 * command/args/env/url structurally; false when absent (reported as missing/extra elsewhere). */
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
