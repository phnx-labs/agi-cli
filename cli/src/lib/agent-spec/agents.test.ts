import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENTS,
  ACCOUNT_INSPECTION_AGENT_IDS,
  ALL_AGENT_IDS,
  UNMANAGED_DETECTION_CANDIDATES,
  __resetAntigravityKeychainCacheForTest,
  accountOrgBadge,
  antigravityOsKeyringProbe,
  credentialPresence,
  deprecationNotice,
  formatClaudeOrgLabel,
  getAccountInfo,
  hardDeprecationNotice,
  isClaudeCredentialFileBlank,
  resolveAgentName,
  parseAgentVersionSpec,
  resolveNativeBinaryPath,
  resolveLastActive,
  supportsAccountInspection,
  warnAgentDeprecated,
} from './agents.js';
import { IS_WINDOWS, execFileShellSpec } from '../platform/index.js';
import type { CapabilityName } from '../types.js';

const tempDirs: string[] = [];

describe('account inspection support', () => {
  it('matches the credential formats getAccountInfo can inspect safely', () => {
    expect(ACCOUNT_INSPECTION_AGENT_IDS).toEqual([
      'claude',
      'codex',
      'cursor',
      'grok',
      'antigravity',
      'kimi',
      'droid',
      'opencode',
      'muse',
    ]);
    for (const agent of ACCOUNT_INSPECTION_AGENT_IDS) {
      expect(supportsAccountInspection(agent)).toBe(true);
    }
    expect(supportsAccountInspection('amp')).toBe(false);
  });
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-agents-'));
  tempDirs.push(dir);
  return dir;
}

describe('credentialPresence (RUSH-2069 provable-logout signal)', () => {
  let prevRealHome: string | undefined;
  let activeHome: string;
  beforeEach(() => {
    prevRealHome = process.env.AGENTS_REAL_HOME;
    activeHome = makeTempDir();
    process.env.AGENTS_REAL_HOME = activeHome;
  });
  afterEach(() => {
    if (prevRealHome === undefined) delete process.env.AGENTS_REAL_HOME;
    else process.env.AGENTS_REAL_HOME = prevRealHome;
  });

  function writeCodexAuth(home: string): void {
    const dir = path.join(home, '.codex');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.json'), '{}', 'utf-8');
  }

  it('reports perVersion=true when the version home holds the credential', () => {
    const versionHome = makeTempDir();
    writeCodexAuth(versionHome);
    const p = credentialPresence('codex', versionHome);
    expect(p.perVersion).toBe(true);
    expect(p.active).toBe(false);
  });

  it('reports active=true (not provable) when only the global HOME holds it', () => {
    writeCodexAuth(activeHome);
    const p = credentialPresence('codex', makeTempDir());
    expect(p.perVersion).toBe(false);
    expect(p.active).toBe(true);
    expect(p.perVersion && p.active).toBe(false);
    expect(!p.perVersion && !p.active).toBe(false);
  });

  it('reports neither present (provable logout) when the credential is absent everywhere', () => {
    const p = credentialPresence('codex', makeTempDir());
    expect(p.perVersion).toBe(false);
    expect(p.active).toBe(false);
    expect(!p.perVersion && !p.active).toBe(true);
  });

  it('honors the claude alternative credential paths (.claude/.claude.json OR .claude.json)', () => {
    const versionHome = makeTempDir();
    fs.writeFileSync(path.join(versionHome, '.claude.json'), '{}', 'utf-8');
    fs.mkdirSync(path.join(versionHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(versionHome, '.claude', '.oauth_token'), 'sk-ant-oat01-test', 'utf-8');
    expect(credentialPresence('claude', versionHome).perVersion).toBe(true);
  });

  it('reports perVersion=false for claude when .claude.json exists but the real credential is blank (PHNX-3502)', () => {
    const versionHome = makeTempDir();
    fs.writeFileSync(path.join(versionHome, '.claude.json'), '{}', 'utf-8');
    const p = credentialPresence('claude', versionHome);
    if (process.platform === 'darwin') {
      expect(p.perVersion).toBe(true);
    } else {
      expect(p.perVersion).toBe(false);
    }
  });

  it('reports knownLocation=false for an agent with no credential path', () => {
    const p = credentialPresence('amp' as any, makeTempDir());
    expect(p).toEqual({ perVersion: false, active: false, knownLocation: false });
  });

  it('every inspectable agent WITHOUT a credential path is unprovable, never a false critical', () => {
    const dir = makeTempDir();
    for (const agent of ALL_AGENT_IDS.filter(supportsAccountInspection)) {
      const p = credentialPresence(agent, dir);
      if (!p.knownLocation) {
        expect(p.knownLocation && !p.perVersion && !p.active).toBe(false);
      }
    }
  });
});

function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function writeArgLogger(dir: string): { binary: string; logPath: string } {
  const binary = path.join(dir, 'fake-agent');
  const logPath = path.join(dir, 'argv.log');
  fs.writeFileSync(
    binary,
    [
      '#!/bin/sh',
      `LOG_FILE=${shSingleQuote(logPath)}`,
      'printf "HOME:%s\\n" "$HOME" >> "$LOG_FILE"',
      'for arg do',
      '  printf "ARG:%s\\n" "$arg" >> "$LOG_FILE"',
      'done',
      '',
    ].join('\n'),
    'utf-8'
  );
  fs.chmodSync(binary, 0o755);
  return { binary, logPath };
}

function runAgentsModule(expression: string): unknown {
  const moduleUrl = pathToFileURL(path.resolve('dist/lib/agents.js')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { registerMcp, unregisterMcp } from ${JSON.stringify(moduleUrl)};
    const result = await ${expression};
    console.log(JSON.stringify(result));
  `], {
    env: { ...process.env },
    encoding: 'utf-8',
  });

  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim());
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(IS_WINDOWS)('MCP CLI execution', () => {
  it('registers MCP servers with argv, not a shell command string', async () => {
    const dir = makeTempDir();
    const { binary, logPath } = writeArgLogger(dir);
    const pwnedPath = path.join(dir, 'pwned');

    const result = runAgentsModule(
      `registerMcp('codex', ${JSON.stringify(`demo; touch ${pwnedPath}`)}, ${JSON.stringify(`/bin/echo; touch ${pwnedPath}`)}, 'user', 'stdio', { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)} })`
    ) as { success: boolean };

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(result.success).toBe(true);
    expect(fs.existsSync(pwnedPath)).toBe(false);
    expect(log).toContain(`HOME:${dir}`);
    expect(log).toContain('ARG:mcp\nARG:add');
    expect(log).toContain(`ARG:demo; touch ${pwnedPath}`);
    expect(log).toContain('ARG:/bin/echo;');
    expect(log).toContain('ARG:touch');
    expect(log).toContain(`ARG:${pwnedPath}`);
  });

  it('removes MCP servers with argv, not a shell command string', async () => {
    const dir = makeTempDir();
    const { binary, logPath } = writeArgLogger(dir);
    const pwnedPath = path.join(dir, 'pwned');
    const evilName = `demo"; touch ${pwnedPath}`;

    const result = runAgentsModule(
      `unregisterMcp('codex', ${JSON.stringify(evilName)}, { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)} })`
    ) as { success: boolean };

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(result.success).toBe(true);
    expect(fs.existsSync(pwnedPath)).toBe(false);
    expect(log).toContain('ARG:mcp\nARG:remove');
    expect(log).toContain(`ARG:${evilName}`);

    const metaName = 'demo&evil|more>out';
    const winSpec = execFileShellSpec('codex.cmd', ['mcp', 'remove', metaName], 'win32');
    expect(winSpec.shell).toBe(true);
    expect(winSpec.args).toEqual([]);
    expect(winSpec.command).toBe('codex.cmd mcp remove "demo&evil|more>out"');
  });

  it('preserves quoted MCP command arguments without invoking a shell', async () => {
    const dir = makeTempDir();
    const { binary, logPath } = writeArgLogger(dir);

    const result = runAgentsModule(
      `registerMcp('claude', 'demo', 'node -e "console.log(1)"', 'project', 'stdio', { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)} })`
    ) as { success: boolean };

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(result.success).toBe(true);
    expect(log).toContain('ARG:--transport\nARG:stdio\nARG:--scope\nARG:project');
    expect(log).toContain('ARG:node');
    expect(log).toContain('ARG:-e');
    expect(log).toContain('ARG:console.log(1)');
  });

  it('registers Claude HTTP MCP servers with native transport args and headers', async () => {
    const dir = makeTempDir();
    const { binary, logPath } = writeArgLogger(dir);

    const result = runAgentsModule(
      `registerMcp('claude', 'docs', 'https://developers.openai.com/mcp', 'user', 'http', { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)}, headers: { Authorization: 'Bearer token' } })`
    ) as { success: boolean };

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(result.success).toBe(true);
    expect(log).toContain('ARG:--transport\nARG:http\nARG:--scope\nARG:user');
    expect(log).toContain('ARG:docs\nARG:https://developers.openai.com/mcp');
    expect(log).toContain('ARG:--header\nARG:Authorization: Bearer token');
    expect(log).not.toContain('ARG:--\n');
  });

  it('registers Codex HTTP MCP servers with --url', async () => {
    const dir = makeTempDir();
    const { binary, logPath } = writeArgLogger(dir);

    const result = runAgentsModule(
      `registerMcp('codex', 'docs', 'https://developers.openai.com/mcp', 'user', 'http', { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)} })`
    ) as { success: boolean };

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(result.success).toBe(true);
    expect(log).toContain('ARG:mcp\nARG:add\nARG:docs\nARG:--url\nARG:https://developers.openai.com/mcp');
    expect(log).not.toContain('ARG:--\n');
  });

  it('skips HTTP MCP registration for agents without native HTTP support', async () => {
    const dir = makeTempDir();
    const { binary } = writeArgLogger(dir);

    const result = runAgentsModule(
      `registerMcp('cursor', 'docs', 'https://developers.openai.com/mcp', 'user', 'http', { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)} })`
    ) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe('skipped: agent does not support HTTP MCP registration');
  });

  it('skips HTTP MCP headers for agents that accept HTTP but not headers (codex)', async () => {
    const dir = makeTempDir();
    const { binary } = writeArgLogger(dir);

    const result = runAgentsModule(
      `registerMcp('codex', 'docs', 'https://developers.openai.com/mcp', 'user', 'http', { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)}, headers: { Authorization: 'Bearer token' } })`
    ) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe('skipped: HTTP MCP headers are only supported for Claude registration');
  });

});

describe('AGENTS capability matrix', () => {
  it('declares every gateable resource capability for every agent', () => {
    const requiredCapabilities: CapabilityName[] = [
      'hooks',
      'mcp',
      'mcpHttp',
      'mcpHeaders',
      'allowlist',
      'skills',
      'commands',
      'plugins',
      'subagents',
      'rules',
      'workflows',
      'interactiveRepl',
    ];

    for (const [agentId, config] of Object.entries(AGENTS)) {
      for (const capability of requiredCapabilities) {
        expect(config.capabilities, `${agentId} missing ${capability}`).toHaveProperty(capability);
      }
    }
  });

  it('declares every dispatch field for every AgentId', () => {
    const requiredDispatchFields = [
      'sessionDir',
      'sessionFileExt',
      'versionStdoutMatch',
      'unmanagedBinary',
      'mcpRegister',
      'mcpAddHttp',
      'mcpAddStdio',
      'mcpConfigWrite',
    ] as const;

    for (const id of ALL_AGENT_IDS) {
      const config = AGENTS[id];
      for (const field of requiredDispatchFields) {
        expect(config, `${id} missing ${field}`).toHaveProperty(field);
        expect(config[field], `${id}.${field} must not be undefined`).not.toBeUndefined();
      }
    }
  });

  it('pins the specialized dispatch rows so a copied default cannot hide drift', () => {
    expect(AGENTS.openclaw.versionStdoutMatch).toBe('openclaw');
    expect(AGENTS.grok.unmanagedBinary).toBe('grok-downloads');
    expect(AGENTS.hermes.mcpRegister).toBe('config');
    expect(AGENTS.hermes.mcpConfigWrite).toBe('yaml-mcp_servers');
    expect(AGENTS.codex.mcpAddHttp).toBe('url');
    expect(AGENTS.claude.mcpAddStdio).toBe('scope');
    expect(AGENTS.claude.sessionDir).toEqual(['.claude', 'projects']);
    expect(AGENTS.claude.sessionFileExt).toBe('.jsonl');
    expect(AGENTS.codex.sessionDir).toEqual(['.codex', 'sessions']);
    expect(AGENTS.grok.sessionDir).toEqual(['.grok', 'sessions']);
    expect(AGENTS.grok.sessionFileExt).toBe('.json');
    expect(AGENTS.copilot.sessionDir).toEqual(['.copilot', 'session-state']);
    expect(AGENTS.droid.sessionDir).toEqual(['.factory', 'sessions']);
    expect(AGENTS.muse.sessionDir).toEqual(['.local', 'share', 'muse', 'sessions']);
    expect(AGENTS.muse.sessionFileExt).toBe('.jsonl');
  });

  it('derives unmanaged-detection candidates from sessionDir, not a shadow list', () => {
    expect(UNMANAGED_DETECTION_CANDIDATES).toEqual(
      ALL_AGENT_IDS.filter((id) => AGENTS[id].sessionDir !== null),
    );
    expect(new Set(UNMANAGED_DETECTION_CANDIDATES)).toEqual(
      new Set(['claude', 'codex', 'grok', 'copilot', 'droid', 'muse']),
    );
  });

  it('allows current Cursor builds to open their prompt-less interactive TUI', () => {
    expect(AGENTS.cursor.capabilities.interactiveRepl).toBe(true);
  });
});

describe('resolveNativeBinaryPath', () => {
  it('accepts a native executable before the agents shims directory exists', () => {
    const root = makeTempDir();
    expect(resolveNativeBinaryPath('node', process.execPath, {
      shimsDir: path.join(root, 'missing-shims'),
      historyDir: path.join(root, 'missing-history'),
    })).toBe(fs.realpathSync(process.execPath));
  });
});

describe('resolveLastActive', () => {
  function makeClaudeHome(sessionMtimeSec?: number): string {
    const home = makeTempDir();
    const projects = path.join(home, '.claude', 'projects', 'some-project');
    fs.mkdirSync(projects, { recursive: true });
    if (sessionMtimeSec !== undefined) {
      const session = path.join(projects, 'session.jsonl');
      fs.writeFileSync(session, '{}', 'utf-8');
      fs.utimesSync(session, sessionMtimeSec, sessionMtimeSec);
    }
    return home;
  }

  function cacheFile(): string {
    return path.join(makeTempDir(), 'last-active.json');
  }

  it('returns the newest session mtime and persists it to the cache', () => {
    const home = makeClaudeHome(5_000);
    const cachePath = cacheFile();

    const result = resolveLastActive('claude', home, undefined, cachePath);
    expect(result?.getTime()).toBe(5_000_000);

    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    expect(cache[`claude:${home}`]).toEqual({ mtimeMs: 5_000_000, computedAt: expect.any(Number) });
  });

  it('serves from cache within the fresh window instead of re-walking', () => {
    const home = makeClaudeHome(5_000);
    const cachePath = cacheFile();
    const t0 = new Date('2026-06-11T00:00:00Z');

    expect(resolveLastActive('claude', home, undefined, cachePath, t0)?.getTime()).toBe(5_000_000);

    const newer = path.join(home, '.claude', 'projects', 'some-project', 'newer.jsonl');
    fs.writeFileSync(newer, '{}', 'utf-8');
    fs.utimesSync(newer, 9_000, 9_000);

    const within = new Date(t0.getTime() + 60_000);
    expect(resolveLastActive('claude', home, undefined, cachePath, within)?.getTime()).toBe(5_000_000);

    const beyond = new Date(t0.getTime() + 6 * 60_000);
    expect(resolveLastActive('claude', home, undefined, cachePath, beyond)?.getTime()).toBe(9_000_000);
  });

  it('falls back to config mtime when the home has no sessions, including via a fresh null entry', () => {
    const home = makeClaudeHome();
    const cachePath = cacheFile();
    const config = path.join(home, '.claude.json');
    fs.writeFileSync(config, '{}', 'utf-8');
    fs.utimesSync(config, 7_000, 7_000);
    const t0 = new Date('2026-06-11T00:00:00Z');

    expect(resolveLastActive('claude', home, config, cachePath, t0)?.getTime()).toBe(7_000_000);
    const within = new Date(t0.getTime() + 60_000);
    expect(resolveLastActive('claude', home, config, cachePath, within)?.getTime()).toBe(7_000_000);
  });

  it('treats a corrupt cache file as empty and recomputes', () => {
    const home = makeClaudeHome(5_000);
    const cachePath = cacheFile();
    fs.writeFileSync(cachePath, 'not json', 'utf-8');

    expect(resolveLastActive('claude', home, undefined, cachePath)?.getTime()).toBe(5_000_000);
  });
});

describe('resolveLastActive cache pruning', () => {
  it('drops stale entries for other homes on write', () => {
    const home = path.join(makeTempDir(), 'live-home');
    const projects = path.join(home, '.claude', 'projects', 'p');
    fs.mkdirSync(projects, { recursive: true });
    const session = path.join(projects, 's.jsonl');
    fs.writeFileSync(session, '{}', 'utf-8');
    fs.utimesSync(session, 5_000, 5_000);

    const cachePath = path.join(makeTempDir(), 'last-active.json');
    const t0 = new Date('2026-06-11T00:00:00Z');
    fs.writeFileSync(cachePath, JSON.stringify({
      'claude:/gone/stale-home': { mtimeMs: 1_000, computedAt: t0.getTime() - 10 * 60_000 },
      'claude:/gone/fresh-home': { mtimeMs: 2_000, computedAt: t0.getTime() - 30_000 },
    }), 'utf-8');

    resolveLastActive('claude', home, undefined, cachePath, t0);

    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    expect(Object.keys(cache).sort()).toEqual([`claude:${home}`, 'claude:/gone/fresh-home'].sort());
  });
});

describe('resolveAgentName', () => {
  it('resolves every canonical id, including ones missing from the alias map', () => {
    for (const id of ALL_AGENT_IDS) {
      expect(resolveAgentName(id), `canonical id ${id}`).toBe(id);
    }
  });

  it('resolves aliases and shorthands case-insensitively', () => {
    expect(resolveAgentName('claude-code')).toBe('claude');
    expect(resolveAgentName('cc')).toBe('claude');
    expect(resolveAgentName('CLAUDE')).toBe('claude');
    expect(resolveAgentName('kimi-code')).toBe('kimi');
  });

  it('corrects a single typo against canonical ids', () => {
    expect(resolveAgentName('cladue')).toBe('claude');
    expect(resolveAgentName('claud')).toBe('claude');
    expect(resolveAgentName('clude')).toBe('claude');
    expect(resolveAgentName('codx')).toBe('codex');
    expect(resolveAgentName('kim')).toBe('kimi');
    expect(resolveAgentName('grook')).toBe('grok');
  });

  it('corrects a single typo against multi-letter aliases', () => {
    expect(resolveAgentName('clw')).toBe('openclaw');
  });

  it('returns null when the correction is ambiguous', () => {
    expect(resolveAgentName('arp')).toBeNull();
  });

  it('returns null for short or unrecognizable input', () => {
    expect(resolveAgentName('cl')).toBeNull();
    expect(resolveAgentName('gpt')).toBeNull();
    expect(resolveAgentName('')).toBeNull();
    expect(resolveAgentName('definitely-not-an-agent')).toBeNull();
  });
});

function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

function writeDroidCredential(dir: string, claims: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const credential = JSON.stringify({
    access_token: makeJwt(claims),
    refresh_token: 'rt',
    active_organization_id: 'org_local',
  });
  const ct = Buffer.concat([cipher.update(credential, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = [iv, tag, ct].map((b) => b.toString('base64')).join(':');
  fs.writeFileSync(path.join(dir, 'auth.v2.file'), blob, 'utf-8');
  fs.writeFileSync(path.join(dir, 'auth.v2.key'), key.toString('base64'), 'utf-8');
}

describe('getAccountInfo — token-only agents (no local email)', () => {
  let prevRealHome: string | undefined;
  let prevNoKeychain: string | undefined;
  beforeEach(() => {
    prevRealHome = process.env.AGENTS_REAL_HOME;
    process.env.AGENTS_REAL_HOME = makeTempDir();
    prevNoKeychain = process.env.AGENTS_NO_KEYCHAIN_PROBE;
    process.env.AGENTS_NO_KEYCHAIN_PROBE = '1';
  });
  afterEach(() => {
    if (prevRealHome === undefined) delete process.env.AGENTS_REAL_HOME;
    else process.env.AGENTS_REAL_HOME = prevRealHome;
    if (prevNoKeychain === undefined) delete process.env.AGENTS_NO_KEYCHAIN_PROBE;
    else process.env.AGENTS_NO_KEYCHAIN_PROBE = prevNoKeychain;
  });

  it('marks Antigravity signed in when a refresh token is present', async () => {
    const home = makeTempDir();
    const dir = path.join(home, '.gemini', 'antigravity-cli');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'antigravity-oauth-token'),
      JSON.stringify({
        token: { access_token: 'ya29.expired', refresh_token: '1//refresh', token_type: 'Bearer' },
        auth_method: 'consumer',
      }),
      'utf-8'
    );

    const info = await getAccountInfo('antigravity', home);
    expect(info.signedIn).toBe(true);
    expect(info.email).toBeNull();
    expect(info.accountKey).toMatch(/^antigravity:sub=[0-9a-f]{16}$/);
    expect(info.accountKey).not.toContain('1//refresh');
    expect(info.usageKey).toBe(info.accountKey);
  });

  it('treats Antigravity as signed out when the token file is missing', async () => {
    const info = await getAccountInfo('antigravity', makeTempDir());
    expect(info.signedIn).toBe(false);
    expect(info.email).toBeNull();
  });

  it('treats Antigravity as signed out when the token carries no refresh token', async () => {
    const home = makeTempDir();
    const dir = path.join(home, '.gemini', 'antigravity-cli');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'antigravity-oauth-token'),
      JSON.stringify({ token: { access_token: 'ya29.x' } }),
      'utf-8'
    );
    const info = await getAccountInfo('antigravity', home);
    expect(info.signedIn).toBe(false);
  });

  it('selects the macOS security probe and the Linux secret-tool probe (RUSH-1329)', () => {
    expect(antigravityOsKeyringProbe('darwin')).toEqual({
      cmd: 'security',
      args: ['find-generic-password', '-s', 'gemini', '-a', 'antigravity'],
    });
    expect(antigravityOsKeyringProbe('linux')).toEqual({
      cmd: 'secret-tool',
      args: ['lookup', 'service', 'gemini', 'username', 'antigravity'],
    });
    expect(antigravityOsKeyringProbe('win32')).toBeNull();
  });

  it('marks Antigravity signed in via Linux secret-tool when no token file exists (RUSH-1329)', async () => {
    if (process.platform !== 'linux') return;

    const binDir = makeTempDir();
    const fake = path.join(binDir, 'secret-tool');
    fs.writeFileSync(
      fake,
      [
        '#!/bin/sh',
        '# Fake Secret Service probe for RUSH-1329.',
        'if [ "$1" = "lookup" ] && [ "$2" = "service" ] && [ "$3" = "gemini" ] \\',
        '   && [ "$4" = "username" ] && [ "$5" = "antigravity" ]; then',
        '  printf "%s" "fake-refresh-token"',
        '  exit 0',
        'fi',
        'exit 1',
        '',
      ].join('\n'),
      'utf-8'
    );
    fs.chmodSync(fake, 0o755);

    const prevPath = process.env.PATH;
    const prevNoKeychain = process.env.AGENTS_NO_KEYCHAIN_PROBE;
    process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ''}`;
    delete process.env.AGENTS_NO_KEYCHAIN_PROBE;
    __resetAntigravityKeychainCacheForTest();

    try {
      const info = await getAccountInfo('antigravity', makeTempDir());
      expect(info.signedIn).toBe(true);
      expect(info.email).toBeNull();
    } finally {
      process.env.PATH = prevPath;
      if (prevNoKeychain === undefined) delete process.env.AGENTS_NO_KEYCHAIN_PROBE;
      else process.env.AGENTS_NO_KEYCHAIN_PROBE = prevNoKeychain;
      __resetAntigravityKeychainCacheForTest();
    }
  });

  it('treats Antigravity as signed out when secret-tool has no matching grant (RUSH-1329)', async () => {
    if (process.platform !== 'linux') return;

    const binDir = makeTempDir();
    const fake = path.join(binDir, 'secret-tool');
    fs.writeFileSync(fake, '#!/bin/sh\nexit 1\n', 'utf-8');
    fs.chmodSync(fake, 0o755);

    const prevPath = process.env.PATH;
    const prevNoKeychain = process.env.AGENTS_NO_KEYCHAIN_PROBE;
    process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ''}`;
    delete process.env.AGENTS_NO_KEYCHAIN_PROBE;
    __resetAntigravityKeychainCacheForTest();

    try {
      const info = await getAccountInfo('antigravity', makeTempDir());
      expect(info.signedIn).toBe(false);
    } finally {
      process.env.PATH = prevPath;
      if (prevNoKeychain === undefined) delete process.env.AGENTS_NO_KEYCHAIN_PROBE;
      else process.env.AGENTS_NO_KEYCHAIN_PROBE = prevNoKeychain;
      __resetAntigravityKeychainCacheForTest();
    }
  });

  it('marks Kimi signed in and derives a stable account key from the JWT user_id', async () => {
    const home = makeTempDir();
    const dir = path.join(home, '.kimi-code', 'credentials');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'kimi-code.json'),
      JSON.stringify({
        access_token: makeJwt({ user_id: 'd483kfq783mkn8of1gtg', sub: 'd483kfq783mkn8of1gtg', scope: 'kimi-code' }),
        refresh_token: makeJwt({ type: 'refresh' }),
        token_type: 'Bearer',
      }),
      'utf-8'
    );

    const info = await getAccountInfo('kimi', home);
    expect(info.signedIn).toBe(true);
    expect(info.email).toBeNull();
    expect(info.accountId).toBe('d483kfq783mkn8of1gtg');
    expect(info.accountKey).toBe('kimi:user=d483kfq783mkn8of1gtg');
  });

  it('treats Kimi as signed out when the credentials file is missing', async () => {
    const info = await getAccountInfo('kimi', makeTempDir());
    expect(info.signedIn).toBe(false);
  });

  it('detects Muse signed-in from providers.meta.access_token (live muse login shape)', async () => {
    const home = makeTempDir();
    const dir = path.join(home, '.config', 'muse');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'auth.json'),
      JSON.stringify({
        schema_version: 1,
        providers: {
          meta: {
            access_token: 'dca:test-token-not-real',
            obtained_via: 'device_code',
            mechanism: 'oauth',
            api_key: 'LLM|test',
            user_email: 'muqsit@example.com',
            user_full_name: 'Muqsit',
          },
        },
      }),
      'utf-8',
    );
    const info = await getAccountInfo('muse', home);
    expect(info.signedIn).toBe(true);
    expect(info.email).toBe('muqsit@example.com');
    expect(info.accountId).toBe('muqsit@example.com');
  });

  it('treats Muse as signed out when auth.json has no nested token', async () => {
    const home = makeTempDir();
    const dir = path.join(home, '.config', 'muse');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'auth.json'),
      JSON.stringify({ schema_version: 1, providers: { meta: {} } }),
      'utf-8',
    );
    const info = await getAccountInfo('muse', home);
    expect(info.signedIn).toBe(false);
  });

  it('decrypts auth.v2.file and surfaces the email + org from the WorkOS JWT', async () => {
    const home = makeTempDir();
    writeDroidCredential(path.join(home, '.factory'), {
      email: 'muqsit@getrush.ai',
      org_id: 'org_abc',
      role: 'owner',
      first_name: 'Muqsit',
    });

    const info = await getAccountInfo('droid', home);
    expect(info.signedIn).toBe(true);
    expect(info.email).toBe('muqsit@getrush.ai');
    expect(info.organizationId).toBe('org_abc');
    expect(info.accountKey).toBe('droid:org=org_abc');
  });

  it('falls back to signed-in with no email when the blob cannot be decrypted', async () => {
    const home = makeTempDir();
    const dir = path.join(home, '.factory');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.v2.file'), 'opaque-encrypted-blob', 'utf-8');

    const info = await getAccountInfo('droid', home);
    expect(info.signedIn).toBe(true);
    expect(info.email).toBeNull();
  });

  it('treats Droid as signed out when the auth file is missing', async () => {
    const info = await getAccountInfo('droid', makeTempDir());
    expect(info.signedIn).toBe(false);
    expect(info.email).toBeNull();
  });
});

describe('getAccountInfo — OpenCode provider credentials', () => {
  let prevXdg: string | undefined;
  let prevRealHome: string | undefined;
  beforeEach(() => {
    prevXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = makeTempDir();
    prevRealHome = process.env.AGENTS_REAL_HOME;
    process.env.AGENTS_REAL_HOME = makeTempDir();
  });
  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    if (prevRealHome === undefined) delete process.env.AGENTS_REAL_HOME;
    else process.env.AGENTS_REAL_HOME = prevRealHome;
  });

  function writeOpenCodeAuth(home: string, auth: Record<string, unknown>): void {
    const dir = path.join(home, '.local', 'share', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(auth), 'utf-8');
  }

  it('marks OpenCode signed in and surfaces the provider id for an api credential', async () => {
    const home = makeTempDir();
    writeOpenCodeAuth(home, { 'muse-spark': { type: 'api', key: 'sk-secret-value' } });

    const info = await getAccountInfo('opencode', home);
    expect(info.signedIn).toBe(true);
    expect(info.accountId).toBe('muse-spark');
    expect(info.accountKey).toBe('opencode:providers=muse-spark');
    expect(info.email).toBeNull();
    expect(JSON.stringify(info)).not.toContain('sk-secret-value');
  });

  it('detects oauth credentials and joins multiple providers into a stable sorted key', async () => {
    const home = makeTempDir();
    writeOpenCodeAuth(home, {
      openai: { type: 'oauth', access: 'at', refresh: 'rt', expires: 0 },
      anthropic: { type: 'api', key: 'sk-ant' },
    });

    const info = await getAccountInfo('opencode', home);
    expect(info.signedIn).toBe(true);
    expect(info.accountId).toBe('anthropic+openai');
    expect(info.accountKey).toBe('opencode:providers=anthropic+openai');
  });

  it('detects a wellknown credential requiring both key and token', async () => {
    const home = makeTempDir();
    writeOpenCodeAuth(home, { github: { type: 'wellknown', key: 'k', token: 't' } });

    const info = await getAccountInfo('opencode', home);
    expect(info.signedIn).toBe(true);
    expect(info.accountId).toBe('github');
  });

  it('resolves auth.json under $XDG_DATA_HOME when the per-version home has none', async () => {
    const xdg = process.env.XDG_DATA_HOME!;
    fs.mkdirSync(path.join(xdg, 'opencode'), { recursive: true });
    fs.writeFileSync(
      path.join(xdg, 'opencode', 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api', key: 'sk-xdg' } }),
      'utf-8'
    );

    const info = await getAccountInfo('opencode', makeTempDir());
    expect(info.signedIn).toBe(true);
    expect(info.accountId).toBe('anthropic');
  });

  it('treats OpenCode as signed out when auth.json is missing', async () => {
    const info = await getAccountInfo('opencode', makeTempDir());
    expect(info.signedIn).toBe(false);
    expect(info.accountId).toBeNull();
  });

  it('treats OpenCode as signed out when auth.json holds an empty object', async () => {
    const home = makeTempDir();
    writeOpenCodeAuth(home, {});
    const info = await getAccountInfo('opencode', home);
    expect(info.signedIn).toBe(false);
  });

  it('ignores corrupt/incomplete entries that carry no real credential', async () => {
    const home = makeTempDir();
    writeOpenCodeAuth(home, {
      broken: { type: 'api' },
      blank: { type: 'oauth', access: '', refresh: '' },
      weird: { type: 'mystery', key: 'x' },
    });
    const info = await getAccountInfo('opencode', home);
    expect(info.signedIn).toBe(false);
  });

  it('does not throw and reads signed out when auth.json is malformed JSON', async () => {
    const home = makeTempDir();
    const dir = path.join(home, '.local', 'share', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.json'), '{ not valid json', 'utf-8');
    const info = await getAccountInfo('opencode', home);
    expect(info.signedIn).toBe(false);
  });

  function jwt(claims: Record<string, unknown>): string {
    const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.signature`;
  }

  it('surfaces email and plan from an OAuth access token that carries the claims', async () => {
    const home = makeTempDir();
    writeOpenCodeAuth(home, {
      openai: {
        type: 'oauth',
        access: jwt({
          'https://api.openai.com/profile': { email: 'dev@example.com' },
          'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' },
        }),
        refresh: 'rt-secret-value',
      },
    });

    const info = await getAccountInfo('opencode', home);
    expect(info.signedIn).toBe(true);
    expect(info.email).toBe('dev@example.com');
    expect(info.plan).toBe('Pro');
    expect(info.accountId).toBe('openai');
    expect(info.accountKey).toBe('opencode:providers=openai');
    expect(JSON.stringify(info)).not.toContain('rt-secret-value');
  });

  it('accepts a plain OIDC email claim and reports no plan when none is claimed', async () => {
    const home = makeTempDir();
    writeOpenCodeAuth(home, { someidp: { type: 'oauth', access: jwt({ email: 'x@y.dev' }) } });

    const info = await getAccountInfo('opencode', home);
    expect(info.email).toBe('x@y.dev');
    expect(info.plan).toBeNull();
  });

  it('takes the email from the first provider in sorted order, not file order', async () => {
    const home = makeTempDir();
    writeOpenCodeAuth(home, {
      zeta: { type: 'oauth', access: jwt({ email: 'later@example.com' }) },
      alpha: { type: 'oauth', access: jwt({ email: 'first@example.com' }) },
    });

    const info = await getAccountInfo('opencode', home);
    expect(info.accountId).toBe('alpha+zeta');
    expect(info.email).toBe('first@example.com');
  });

  it('reports no email for an opaque (non-JWT) oauth token, still signed in', async () => {
    const home = makeTempDir();
    writeOpenCodeAuth(home, { anthropic: { type: 'oauth', access: 'sk-ant-oat01-opaque' } });

    const info = await getAccountInfo('opencode', home);
    expect(info.signedIn).toBe(true);
    expect(info.email).toBeNull();
    expect(info.plan).toBeNull();
  });

  it('ignores a non-email value in the email claim', async () => {
    const home = makeTempDir();
    writeOpenCodeAuth(home, { p: { type: 'oauth', access: jwt({ email: 'not-an-email' }) } });

    const info = await getAccountInfo('opencode', home);
    expect(info.signedIn).toBe(true);
    expect(info.email).toBeNull();
  });

  it('dates lastActive from opencode.db, which the per-file session walk cannot see', async () => {
    const home = makeTempDir();
    writeOpenCodeAuth(home, { anthropic: { type: 'api', key: 'sk-ant' } });
    const db = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
    fs.writeFileSync(db, 'SQLite format 3\0');
    const written = new Date('2026-08-01T12:00:00Z');
    fs.utimesSync(db, written, written);

    const info = await getAccountInfo('opencode', home);
    expect(info.lastActive?.getTime()).toBe(written.getTime());
  });

  it('leaves lastActive null when no opencode.db exists anywhere', async () => {
    const home = makeTempDir();
    writeOpenCodeAuth(home, { anthropic: { type: 'api', key: 'sk-ant' } });
    const info = await getAccountInfo('opencode', home);
    expect(info.lastActive).toBeNull();
  });
});

describe('getAccountInfo — claude credential floor (blanked .credentials.json)', () => {
  function writeClaudeHome(
    home: string,
    oauth: Record<string, unknown> | null,
  ): void {
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        oauthAccount: {
          emailAddress: 'dev@example.com',
          accountUuid: 'acct-1',
          organizationUuid: 'org-1',
          organizationType: 'claude_max',
        },
      }),
      'utf-8',
    );
    if (!oauth) return;
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: oauth }),
      'utf-8',
    );
  }

  const blanked = {
    accessToken: '',
    refreshToken: '',
    expiresAt: 0,
    scopes: ['user:inference'],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    refreshTokenExpiresAt: 1787558041028,
  };

  it('treats an emptied token pair as signed out off macOS', () => {
    const home = makeTempDir();
    writeClaudeHome(home, blanked);
    expect(isClaudeCredentialFileBlank(home, 'linux')).toBe(true);
  });

  it('keeps a home with real tokens usable', () => {
    const home = makeTempDir();
    writeClaudeHome(home, { ...blanked, accessToken: 'at-real', refreshToken: 'rt-real', expiresAt: 1 });
    expect(isClaudeCredentialFileBlank(home, 'linux')).toBe(false);
  });

  it('keeps a home usable when only the refresh token survives, so a refresh can still recover it', () => {
    const home = makeTempDir();
    writeClaudeHome(home, { ...blanked, refreshToken: 'rt-real' });
    expect(isClaudeCredentialFileBlank(home, 'linux')).toBe(false);
  });

  it('treats a missing credential file as signed out off macOS (PHNX-2685)', () => {
    const home = makeTempDir();
    writeClaudeHome(home, null);
    expect(isClaudeCredentialFileBlank(home, 'linux')).toBe(true);
    expect(isClaudeCredentialFileBlank(home, 'darwin')).toBe(false);
  });

  it('keeps a Linux home with a setup-token usable even without .credentials.json', () => {
    const home = makeTempDir();
    writeClaudeHome(home, null);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', '.oauth_token'), 'sk-ant-oat01-testtoken', 'utf-8');
    expect(isClaudeCredentialFileBlank(home, 'linux')).toBe(false);
  });

  it('never judges from the file on macOS, where the login Keychain is canonical', () => {
    const home = makeTempDir();
    writeClaudeHome(home, blanked);
    expect(isClaudeCredentialFileBlank(home, 'darwin')).toBe(false);
  });

  it('does not mistake a corrupt credential file for a blank one', () => {
    const home = makeTempDir();
    writeClaudeHome(home, blanked);
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{not json', 'utf-8');
    expect(isClaudeCredentialFileBlank(home, 'linux')).toBe(false);
  });

  it('surfaces the account for a home whose tokens are intact', async () => {
    const home = makeTempDir();
    writeClaudeHome(home, { ...blanked, accessToken: 'at-real', refreshToken: 'rt-real', expiresAt: 1 });

    const info = await getAccountInfo('claude', home);
    expect(info.signedIn).toBe(true);
    expect(info.email).toBe('dev@example.com');
  });

  it.skipIf(process.platform === 'darwin')(
    'reports a blanked home as signed out, so rotation cannot pick it',
    async () => {
      const home = makeTempDir();
      writeClaudeHome(home, blanked);

      const info = await getAccountInfo('claude', home);
      expect(info.signedIn).toBe(false);
      expect(info.email).toBeNull();
      expect(info.plan).toBeNull();
      expect(info.usageStatus).toBeNull();
    },
  );

  it.skipIf(process.platform === 'darwin')(
    'reports a home with oauthAccount but no credentials.json as signed out (PHNX-2685)',
    async () => {
      const home = makeTempDir();
      writeClaudeHome(home, null);

      const info = await getAccountInfo('claude', home);
      expect(info.signedIn).toBe(false);
      expect(info.email).toBeNull();
    },
  );
});

describe('agent deprecation warnings', () => {
  it('no agent currently carries a deprecation marker', () => {
    for (const id of ALL_AGENT_IDS) {
      expect(deprecationNotice(id)).toBeNull();
      expect(warnAgentDeprecated(id)).toBeUndefined();
      expect(hardDeprecationNotice(id)).toBeNull();
    }
    const deprecated = ALL_AGENT_IDS.filter((id) => AGENTS[id].deprecated);
    expect(deprecated).toEqual([]);
  });
});

describe('getAccountInfo — grok (nested auth.json)', () => {
  let prevRealHome: string | undefined;
  beforeEach(() => { prevRealHome = process.env.AGENTS_REAL_HOME; process.env.AGENTS_REAL_HOME = makeTempDir(); });
  afterEach(() => {
    if (prevRealHome === undefined) delete process.env.AGENTS_REAL_HOME;
    else process.env.AGENTS_REAL_HOME = prevRealHome;
  });

  it('reads the nested "<issuer>::<client_id>" record — signed in with email + ids', async () => {
    const home = makeTempDir();
    const dir = path.join(home, '.grok');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
      'https://auth.x.ai::abc-123': {
        email: 'muqsitnawaz@icloud.com',
        user_id: '5b5643da',
        team_id: '4af61418',
        refresh_token: 'rt_xxx',
        create_time: '2026-07-01T03:11:20Z',
        auth_mode: 'oidc',
      },
    }));

    const info = await getAccountInfo('grok', home);
    expect(info.signedIn).toBe(true);
    expect(info.email).toBe('muqsitnawaz@icloud.com');
    expect(info.accountId).toBe('5b5643da');
  });

  it('picks the newest record when multiple providers are present', async () => {
    const home = makeTempDir();
    const dir = path.join(home, '.grok');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
      old: { email: 'old@x.ai', refresh_token: 'a', create_time: '2026-01-01T00:00:00Z' },
      new: { email: 'new@x.ai', refresh_token: 'b', create_time: '2026-07-01T00:00:00Z' },
    }));
    const info = await getAccountInfo('grok', home);
    expect(info.email).toBe('new@x.ai');
  });

  it('treats grok as signed out when auth.json is absent', async () => {
    const info = await getAccountInfo('grok', makeTempDir());
    expect(info.signedIn).toBe(false);
  });
});

describe('getAccountInfo — cursor (cli-config authInfo + separate auth.json)', () => {
  let prevRealHome: string | undefined;
  beforeEach(() => { prevRealHome = process.env.AGENTS_REAL_HOME; process.env.AGENTS_REAL_HOME = makeTempDir(); });
  afterEach(() => {
    if (prevRealHome === undefined) delete process.env.AGENTS_REAL_HOME;
    else process.env.AGENTS_REAL_HOME = prevRealHome;
  });

  it('reads email/authId from cli-config and treats a present access token as signed in', async () => {
    const home = makeTempDir();
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.mkdirSync(path.join(home, '.config', 'cursor'), { recursive: true });
    fs.writeFileSync(path.join(home, '.cursor', 'cli-config.json'), JSON.stringify({
      authInfo: { email: 'muqsitnawaz@gmail.com', userId: 27457401, authId: 'google-oauth2|106748008124572295566' },
    }));
    fs.writeFileSync(path.join(home, '.cursor', 'auth.json'), JSON.stringify({
      accessToken: 'eyJ.abc.def', refreshToken: 'eyJ.ghi.jkl',
    }));

    const info = await getAccountInfo('cursor', home);
    expect(info.signedIn).toBe(true);
    expect(info.email).toBe('muqsitnawaz@gmail.com');
    expect(info.accountId).toBe('google-oauth2|106748008124572295566');
    expect(info.accountKey).toBeTruthy();
  });

  it('treats cursor as signed out when cli-config is absent', async () => {
    const info = await getAccountInfo('cursor', makeTempDir());
    expect(info.signedIn).toBe(false);
  });

  it('does not surface stale cli-config identity when the version token is absent', async () => {
    const home = makeTempDir();
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(home, '.cursor', 'cli-config.json'), JSON.stringify({
      authInfo: { email: 'stale@example.com', authId: 'google-oauth2|stale' },
    }));

    const info = await getAccountInfo('cursor', home);
    expect(info).toEqual(expect.objectContaining({ signedIn: false, email: null, accountId: null, accountKey: null }));
  });
});

describe('getAccountInfo — Claude organization identity', () => {
  function writeClaudeConfig(oauthAccount: Record<string, unknown>): string {
    const home = makeTempDir();
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount }), 'utf-8');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'at-real', refreshToken: 'rt-real', expiresAt: 1 } }),
      'utf-8',
    );
    return home;
  }

  it('extracts organizationType and organizationName from a Team seat', async () => {
    const home = writeClaudeConfig({
      accountUuid: 'acc-1',
      organizationUuid: 'org-team',
      emailAddress: 'taylor@example.com',
      billingType: 'stripe_subscription',
      organizationType: 'claude_team',
      organizationName: 'Turing Labs',
      organizationRole: 'user',
      seatTier: 'team_tier_1',
    });
    const info = await getAccountInfo('claude', home);
    expect(info.organizationType).toBe('claude_team');
    expect(info.organizationName).toBe('Turing Labs');
    expect(info.plan).toBe('Team');
  });

  it('extracts organizationType from a personal Max plan, keeping the raw boilerplate name', async () => {
    const home = writeClaudeConfig({
      accountUuid: 'acc-1',
      organizationUuid: 'org-personal',
      emailAddress: 'taylor@example.com',
      billingType: 'stripe_subscription',
      organizationType: 'claude_max',
      organizationName: "taylor@example.com's Organization",
      organizationRole: 'admin',
    });
    const info = await getAccountInfo('claude', home);
    expect(info.organizationType).toBe('claude_max');
    expect(info.plan).toBe('Max');
    expect(info.organizationName).toBe("taylor@example.com's Organization");
  });

  it('returns nulls when the config predates the organization fields', async () => {
    const home = writeClaudeConfig({
      accountUuid: 'acc-1',
      organizationUuid: 'org-old',
      emailAddress: 'taylor@example.com',
      billingType: 'stripe_subscription',
    });
    const info = await getAccountInfo('claude', home);
    expect(info.organizationType).toBeNull();
    expect(info.organizationName).toBeNull();
    expect(info.plan).toBe('Pro');
  });

  it('keeps same-email accounts in different orgs distinguishable via accountKey', async () => {
    const max = await getAccountInfo('claude', writeClaudeConfig({
      accountUuid: 'acc-1',
      organizationUuid: 'org-personal',
      emailAddress: 'taylor@example.com',
      organizationType: 'claude_max',
    }));
    const team = await getAccountInfo('claude', writeClaudeConfig({
      accountUuid: 'acc-1',
      organizationUuid: 'org-team',
      emailAddress: 'taylor@example.com',
      organizationType: 'claude_team',
      organizationName: 'Turing Labs',
    }));
    expect(max.email).toBe(team.email);
    expect(max.accountKey).not.toBe(team.accountKey);
  });
});

describe('formatClaudeOrgLabel', () => {
  it('maps the known organization types to human labels', () => {
    expect(formatClaudeOrgLabel('claude_max')).toBe('Max');
    expect(formatClaudeOrgLabel('claude_pro')).toBe('Pro');
    expect(formatClaudeOrgLabel('claude_team')).toBe('Team');
    expect(formatClaudeOrgLabel('claude_enterprise')).toBe('Enterprise');
    expect(formatClaudeOrgLabel('claude_free')).toBe('Free');
  });

  it('title-cases unknown future types instead of hiding them', () => {
    expect(formatClaudeOrgLabel('claude_startup_tier_9')).toBe('Startup Tier 9');
    expect(formatClaudeOrgLabel('gov')).toBe('Gov');
  });

  it('returns null for missing input', () => {
    expect(formatClaudeOrgLabel(null)).toBeNull();
    expect(formatClaudeOrgLabel(undefined)).toBeNull();
    expect(formatClaudeOrgLabel('')).toBeNull();
  });
});

describe('accountOrgBadge', () => {
  it('shows just the org NAME for multi-seat org types', () => {
    expect(accountOrgBadge({ organizationType: 'claude_team', organizationName: 'Turing Labs' }))
      .toBe('Turing Labs');
    expect(accountOrgBadge({ organizationType: 'claude_enterprise', organizationName: 'BigCo' }))
      .toBe('BigCo');
  });

  it('returns null for personal plans — the tier shows in the plan column instead', () => {
    expect(accountOrgBadge({
      organizationType: 'claude_max',
      organizationName: "taylor@example.com's Organization",
    })).toBeNull();
    expect(accountOrgBadge({ organizationType: 'claude_pro', organizationName: 'x' })).toBeNull();
    expect(accountOrgBadge({ organizationType: 'claude_free', organizationName: 'x' })).toBeNull();
  });

  it('returns null when a multi-seat org has no name to show', () => {
    expect(accountOrgBadge({ organizationType: 'claude_team', organizationName: null })).toBeNull();
  });

  it('returns null when there is no organization type', () => {
    expect(accountOrgBadge({ organizationType: null, organizationName: 'Ghost' })).toBeNull();
    expect(accountOrgBadge(null)).toBeNull();
    expect(accountOrgBadge(undefined)).toBeNull();
  });
});

describe('parseAgentVersionSpec — the agents run launch-target split at the routines boundary (RUSH-2719)', () => {
  it('splits agent@version into bare agent + exact version', () => {
    expect(parseAgentVersionSpec('claude@2.1.207')).toEqual({ agent: 'claude', version: '2.1.207' });
  });

  it('splits account labels without pinning a version', () => {
    expect(parseAgentVersionSpec('codex#work')).toEqual({ agent: 'codex', label: 'work' });
    expect(parseAgentVersionSpec('codex@1.2.3#work')).toEqual({ agent: 'codex', version: '1.2.3', label: 'work' });
    expect(parseAgentVersionSpec('codex#user@example.com')).toEqual({ agent: 'codex', label: 'user@example.com' });
  });

  it('rejects an empty or malformed account label cleanly', () => {
    expect(parseAgentVersionSpec('codex#')).toMatchObject({ error: expect.stringContaining('Invalid account label') });
    expect(parseAgentVersionSpec('codex#bad label')).toMatchObject({ error: expect.stringContaining('Invalid account label') });
  });

  it('a bare agent id yields no version field', () => {
    expect(parseAgentVersionSpec('claude')).toEqual({ agent: 'claude' });
  });

  it('resolves aliases and single-typo names like resolveAgentName', () => {
    expect(parseAgentVersionSpec('cladue@2.1.207')).toEqual({ agent: 'claude', version: '2.1.207' });
  });

  it('an unknown agent returns the agents-run-style error, not an enum dump', () => {
    const r = parseAgentVersionSpec('gremlin');
    expect('error' in r && r.error).toMatch(/Unknown agent, profile, or workflow: gremlin/);
  });

  it('rejects a second @ segment', () => {
    const r = parseAgentVersionSpec('claude@2.1.207@extra');
    expect('error' in r && r.error).toMatch(/at most one '@version'/);
  });

  it('rejects an empty or malformed version token', () => {
    const empty = parseAgentVersionSpec('claude@');
    expect('error' in empty && empty.error).toMatch(/Invalid version ''/);
    const bad = parseAgentVersionSpec('claude@..');
    expect('error' in bad && bad.error).toMatch(/Invalid version/);
  });
});
