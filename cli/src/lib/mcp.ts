
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

export interface McpYamlConfig {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
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


export function getMcpTrustStorePath(): string {
  return path.join(getUserAgentsDir(), 'mcp-trust.yaml');
}

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

export function isProjectMcpTrusted(projectAgentsDir: string): boolean {
  return readTrustedProjects().has(normalizeProjectKey(projectAgentsDir));
}

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

export function untrustProjectMcp(cwd: string = process.cwd()): boolean {
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (!projectAgentsDir) return false;
  const key = normalizeProjectKey(projectAgentsDir);
  const trusted = readTrustedProjects();
  if (!trusted.delete(key)) return false;
  writeTrustedProjects(trusted);
  return true;
}

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

export function parseMcpConfigForScan(filePath: string): McpYamlConfig | null {
  try {
    return parseMcpServerConfig(filePath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`agents-cli: skipping ${filePath} — ${reason}`);
    return null;
  }
}

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

export function getMcpServersByName(
  names?: string[],
  options: { cwd?: string; enforceProjectTrust?: boolean } = {}
): InstalledMcpServer[] {
  const enforceProjectTrust = options.enforceProjectTrust ?? true;
  const allServers = listMcpServerConfigs(options.cwd, { enforceProjectTrust });
  if (!names || names.length === 0) {
    return allServers;
  }
  return allServers.filter((server) => names.includes(server.name));
}

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

function installMcpViaClaude(binaryPath: string, server: InstalledMcpServer, versionHome: string): void {
  const execEnv = { ...process.env, HOME: versionHome };

  if (server.config.transport === 'stdio') {
    const envArgs: string[] = [];
    if (server.config.env) {
      for (const [key, value] of Object.entries(server.config.env)) {
        envArgs.push('--env', `${key}=${value}`);
      }
    }

    const args = [
      'mcp', 'add', '--scope', 'user', '--transport', 'stdio',
      ...envArgs,
      '--',
      server.name,
      server.config.command!,
      ...(server.config.args || [])
    ];

    const spec = execFileShellSpec(binaryPath, args);
    execFileSync(spec.command, spec.args, {
      stdio: 'pipe',
      timeout: 30000,
      env: execEnv,
      shell: spec.shell,
    });
  } else {
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

function installMcpViaCodex(binaryPath: string, server: InstalledMcpServer, versionHome: string): void {
  let args: string[];
  if (server.config.transport === 'http') {
    if (!server.config.url) throw new Error(`HTTP MCP '${server.name}' has no url`);
    args = ['mcp', 'add', server.name, '--url', server.config.url];
  } else {
    args = [
      'mcp', 'add',
      '--',
      server.name,
      server.config.command!,
      ...(server.config.args || [])
    ];
  }

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
    const spec = execFileShellSpec(bin, args);
    execFileSync(spec.command, spec.args, { stdio: 'pipe', timeout: 30000, env, shell: spec.shell });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export interface WritableMcpServer {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

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

function readExistingConfig(
  configPath: string,
  parse: (raw: string) => unknown,
): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, 'utf-8');
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

function parseJsonc(raw: string): unknown {
  return JSON.parse(stripJsonComments(raw));
}

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

  const target = MCP_TARGETS[agentId];
  if (!target || target.format === null) {
    throw new Error(`cannot write MCP config: ${mcpWriteUnsupportedReason(agentId)}`);
  }

  const format = target.format;
  switch (format) {
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
      const unhandled: never = format;
      throw new Error(`unhandled MCP config format: ${String(unhandled)}`);
    }
  }
}

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
        writeMcpConfig(agentId, getMcpConfigPathForHome(agentId, versionHome), [toWritableServer(server)], 'merge');
        handled = true;
      }

      if (server.scope === 'project' && options.cwd) {
        writeMcpConfig(agentId, getProjectMcpConfigPath(agentId, options.cwd), [toWritableServer(server)], 'merge');
        handled = true;
      }

      if (handled) {
        applied.push(server.name);
      }
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('already exists') || message.includes('already configured')) {
        applied.push(server.name);
      } else {
        errors.push(`${server.name}: ${message}`);
      }
    }
  }

  return { success: errors.length === 0, applied, errors };
}

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

interface McpComparable {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

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

export function removeMcpServerConfig(name: string): boolean {
  const servers = listMcpServerConfigs();
  const server = servers.find((s) => s.name === name);
  if (!server) {
    return false;
  }

  fs.unlinkSync(server.path);
  return true;
}
