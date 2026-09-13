import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { parseMcpServerConfig, buildWorkflowMcpConfig, validateMcpServerName, registerMcpCommandToTargets, type InstalledMcpServer } from './mcp.js';
import { IS_WINDOWS } from './platform/index.js';
import * as TOML from 'smol-toml';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-mcp-'));
  tempDirs.push(dir);
  return dir;
}

function writeVersionBinary(home: string, agent: string, version: string, command: string): string {
  const binary = path.join(home, '.agents', '.history', 'versions', agent, version, 'node_modules', '.bin', command);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(
    binary,
    [
      '#!/bin/sh',
      'for arg do',
      '  printf "ARG:%s\\n" "$arg" >> "$LOG_PATH"',
      'done',
      '',
    ].join('\n'),
    'utf-8'
  );
  fs.chmodSync(binary, 0o755);
  return binary;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('MCP sync execution', () => {
  it('rejects YAML configs whose args are not string arrays', () => {
    const home = makeTempHome();
    const configPath = path.join(home, 'bad.yaml');
    fs.writeFileSync(
      configPath,
      [
        'name: bad',
        'transport: stdio',
        'command: npx',
        'args: "-y bad"',
        '',
      ].join('\n'),
      'utf-8'
    );

    expect(() => parseMcpServerConfig(configPath)).toThrow('args must be a string array');
  });

  it('rejects YAML configs whose name starts with a dash', () => {
    const home = makeTempHome();
    const configPath = path.join(home, 'evil.yaml');
    fs.writeFileSync(
      configPath,
      [
        'name: --dangerous-flag',
        'transport: stdio',
        'command: node',
        '',
      ].join('\n'),
      'utf-8'
    );

    expect(() => parseMcpServerConfig(configPath)).toThrow("names cannot start with '-'");
  });

  it('rejects YAML configs whose name contains whitespace', () => {
    const home = makeTempHome();
    const configPath = path.join(home, 'evil.yaml');
    fs.writeFileSync(
      configPath,
      [
        'name: bad name',
        'transport: stdio',
        'command: node',
        '',
      ].join('\n'),
      'utf-8'
    );

    expect(() => parseMcpServerConfig(configPath)).toThrow('whitespace or control characters');
  });

  // Proves installMcpServers spawns the CLI with an argv array (no shell), so a
  // `command: "/bin/echo; touch"` payload can't execute. The proof uses a
  // `#!/bin/sh` argv-logger fake binary, which is POSIX-only — on Windows the
  // managed binary is a `.cmd` reached via cmd.exe. installMcpServers' Windows
  // spawn path (.cmd resolution + shell) is hardened in mcp.ts.
  it.skipIf(IS_WINDOWS)('installs Codex MCP servers with argv, not a shell command string', async () => {
    const home = makeTempHome();
    const version = '0.1.0';
    const logPath = path.join(home, 'argv.log');
    const pwnedPath = path.join(home, 'pwned');
    writeVersionBinary(home, 'codex', version, 'codex');

    const mcpDir = path.join(home, '.agents', 'mcp');
    fs.mkdirSync(mcpDir, { recursive: true });
    fs.writeFileSync(
      path.join(mcpDir, 'demo.yaml'),
      [
        'name: demo',
        'transport: stdio',
        'command: "/bin/echo; touch"',
        `args: ["${pwnedPath}"]`,
        '',
      ].join('\n'),
      'utf-8'
    );

    const moduleUrl = pathToFileURL(path.resolve('dist/lib/mcp.js')).href;
    const versionHome = path.join(home, '.agents', '.history', 'versions', 'codex', version, 'home');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { installMcpServers } from ${JSON.stringify(moduleUrl)};
      const result = installMcpServers('codex', ${JSON.stringify(version)}, ${JSON.stringify(versionHome)});
      console.log(JSON.stringify(result));
    `], {
      env: { ...process.env, HOME: home, LOG_PATH: logPath },
      encoding: 'utf-8',
    });

    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim());

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(result.success).toBe(true);
    expect(fs.existsSync(pwnedPath)).toBe(false);
    expect(log).toContain('ARG:mcp\nARG:add\nARG:--\nARG:demo');
    expect(log).toContain('ARG:--\nARG:demo\nARG:/bin/echo; touch');
    expect(log).toContain(`ARG:${pwnedPath}`);
  });
});

describe('buildWorkflowMcpConfig', () => {
  const stdio = (name: string, extra: Partial<InstalledMcpServer['config']> = {}): InstalledMcpServer => ({
    name,
    path: `/x/${name}.yaml`,
    config: { name, transport: 'stdio', command: 'node', ...extra },
  });

  it('emits the { mcpServers: { name: { command, args, env } } } shape Claude expects', () => {
    const json = buildWorkflowMcpConfig([
      stdio('github', { args: ['server.js'], env: { TOKEN: 'x' } }),
    ]);
    expect(JSON.parse(json)).toEqual({
      mcpServers: { github: { command: 'node', args: ['server.js'], env: { TOKEN: 'x' } } },
    });
  });

  it('omits empty args/env and maps http transport to { url }', () => {
    const json = buildWorkflowMcpConfig([
      stdio('bare'),
      { name: 'remote', path: '/x/remote.yaml', config: { name: 'remote', transport: 'http', url: 'https://e.x/mcp' } },
    ]);
    expect(JSON.parse(json)).toEqual({
      mcpServers: {
        bare: { command: 'node' },
        remote: { url: 'https://e.x/mcp' },
      },
    });
  });

  it('returns an empty mcpServers map for no servers', () => {
    expect(JSON.parse(buildWorkflowMcpConfig([]))).toEqual({ mcpServers: {} });
  });
});

describe('project MCP trust gate (RUSH-1776)', () => {
  // Run an ESM snippet against the built module with an isolated HOME, so the
  // trust store (~/.agents/mcp-trust.yaml) and the user MCP dir never touch the
  // real home. Returns the JSON the snippet prints.
  function probe(home: string, body: string): any {
    const moduleUrl = pathToFileURL(path.resolve('dist/lib/mcp.js')).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import * as mcp from ${JSON.stringify(moduleUrl)};
      ${body}
    `], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });
    if (child.status !== 0) throw new Error(child.stderr || 'probe failed');
    return JSON.parse(child.stdout.trim());
  }

  // A temp HOME holding a trusted user-scoped MCP and a hostile project-scoped
  // MCP (as if from a freshly cloned repo). Returns absolute paths.
  function fixture(): { home: string; proj: string } {
    const home = makeTempHome();
    const userMcp = path.join(home, '.agents', 'mcp');
    fs.mkdirSync(userMcp, { recursive: true });
    fs.writeFileSync(
      path.join(userMcp, 'user-good.yaml'),
      ['name: user-good', 'transport: stdio', 'command: user-cmd', 'args: ["--safe"]', ''].join('\n'),
      'utf-8'
    );
    const proj = path.join(home, 'proj');
    const projMcp = path.join(proj, '.agents', 'mcp');
    fs.mkdirSync(projMcp, { recursive: true });
    fs.writeFileSync(
      path.join(projMcp, 'evil.yaml'),
      ['name: evil', 'transport: stdio', 'command: /bin/echo', 'args: ["pwned"]', ''].join('\n'),
      'utf-8'
    );
    return { home, proj };
  }

  it('(a) does NOT register/apply an untrusted project-scoped MCP', () => {
    const { home, proj } = fixture();
    const out = probe(home, `
      const enforced = mcp.getMcpServersByName(['evil'], { cwd: ${JSON.stringify(proj)} }).map(s => s.name);
      const listed = mcp.listMcpServerConfigs(${JSON.stringify(proj)}, { enforceProjectTrust: true }).map(s => s.name);
      console.log(JSON.stringify({ enforced, listed, trusted: mcp.isProjectMcpTrusted(${JSON.stringify(path.join(proj, '.agents'))}) }));
    `);
    expect(out.trusted).toBe(false);
    expect(out.enforced).toEqual([]); // spawn path never sees the hostile server
    expect(out.listed).not.toContain('evil');
    expect(out.listed).toContain('user-good'); // user server still resolves
  });

  it('(b) DOES register the project-scoped MCP after explicit opt-in', () => {
    const { home, proj } = fixture();
    const out = probe(home, `
      const before = mcp.getMcpServersByName(['evil'], { cwd: ${JSON.stringify(proj)} }).map(s => s.name);
      const trustedPath = mcp.trustProjectMcp(${JSON.stringify(proj)});
      const after = mcp.getMcpServersByName(['evil'], { cwd: ${JSON.stringify(proj)} }).map(s => s.name);
      console.log(JSON.stringify({ before, after, trustedPath, trusted: mcp.isProjectMcpTrusted(${JSON.stringify(path.join(proj, '.agents'))}) }));
    `);
    expect(out.before).toEqual([]);
    expect(out.trusted).toBe(true);
    expect(out.after).toEqual(['evil']); // opt-in lets it through the spawn path
    expect(fs.existsSync(path.join(home, '.agents', 'mcp-trust.yaml'))).toBe(true);
  });

  it('(c) leaves user-scoped MCPs unaffected regardless of project trust', () => {
    const { home, proj } = fixture();
    const out = probe(home, `
      const untrusted = mcp.getMcpServersByName(['user-good'], { cwd: ${JSON.stringify(proj)} }).map(s => s.name);
      mcp.trustProjectMcp(${JSON.stringify(proj)});
      const trusted = mcp.getMcpServersByName(['user-good'], { cwd: ${JSON.stringify(proj)} }).map(s => s.name);
      console.log(JSON.stringify({ untrusted, trusted }));
    `);
    expect(out.untrusted).toEqual(['user-good']);
    expect(out.trusted).toEqual(['user-good']);
  });

  it('(d) surfaces the command+args when listing an untrusted project MCP', () => {
    const { home, proj } = fixture();
    const out = probe(home, `
      const display = mcp.listMcpServerConfigs(${JSON.stringify(proj)}); // display path, no trust enforcement
      const evil = display.find(s => s.name === 'evil');
      const enforced = mcp.getMcpServersByName(['evil'], { cwd: ${JSON.stringify(proj)} }).map(s => s.name);
      console.log(JSON.stringify({ scope: evil && evil.scope, command: evil && evil.config.command, args: evil && evil.config.args, enforced }));
    `);
    expect(out.scope).toBe('project');
    expect(out.command).toBe('/bin/echo'); // user sees exactly what would run
    expect(out.args).toEqual(['pwned']);
    expect(out.enforced).toEqual([]); // ...but it still does not auto-apply
  });

  it('untrust revokes a previously granted trust', () => {
    const { home, proj } = fixture();
    const out = probe(home, `
      mcp.trustProjectMcp(${JSON.stringify(proj)});
      const afterTrust = mcp.getMcpServersByName(['evil'], { cwd: ${JSON.stringify(proj)} }).map(s => s.name);
      const revoked = mcp.untrustProjectMcp(${JSON.stringify(proj)});
      const afterUntrust = mcp.getMcpServersByName(['evil'], { cwd: ${JSON.stringify(proj)} }).map(s => s.name);
      console.log(JSON.stringify({ afterTrust, revoked, afterUntrust }));
    `);
    expect(out.afterTrust).toEqual(['evil']);
    expect(out.revoked).toBe(true);
    expect(out.afterUntrust).toEqual([]);
  });
});

describe('validateMcpServerName', () => {
  it('accepts common safe names', () => {
    expect(() => validateMcpServerName('demo')).not.toThrow();
    expect(() => validateMcpServerName('my_server')).not.toThrow();
    expect(() => validateMcpServerName('server-123')).not.toThrow();
    expect(() => validateMcpServerName('a.b')).not.toThrow();
  });

  it('rejects names starting with -', () => {
    expect(() => validateMcpServerName('--dangerous-flag')).toThrow("names cannot start with '-'");
    expect(() => validateMcpServerName('-rf')).toThrow("names cannot start with '-'");
  });

  it('rejects names containing whitespace or control characters', () => {
    expect(() => validateMcpServerName('bad name')).toThrow('whitespace or control characters');
    expect(() => validateMcpServerName('bad\tname')).toThrow('whitespace or control characters');
    expect(() => validateMcpServerName('bad\nname')).toThrow('whitespace or control characters');
    expect(() => validateMcpServerName('bad\x00name')).toThrow('whitespace or control characters');
  });
});

describe('MCP argv construction', () => {
  function makeServerYaml(home: string, fileName: string, lines: string[]): void {
    const mcpDir = path.join(home, '.agents', 'mcp');
    fs.mkdirSync(mcpDir, { recursive: true });
    fs.writeFileSync(path.join(mcpDir, fileName), lines.join('\n') + '\n', 'utf-8');
  }

  function runInstall(agent: string, version: string, versionHome: string, home: string, logPath: string): ReturnType<typeof spawnSync> {
    const moduleUrl = pathToFileURL(path.resolve('dist/lib/mcp.js')).href;
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { installMcpServers } from ${JSON.stringify(moduleUrl)};
      const result = installMcpServers(${JSON.stringify(agent)}, ${JSON.stringify(version)}, ${JSON.stringify(versionHome)});
      console.log(JSON.stringify(result));
    `], {
      env: { ...process.env, HOME: home, LOG_PATH: logPath },
      encoding: 'utf-8',
    });
  }

  it.skipIf(IS_WINDOWS)('puts Claude stdio name and command after --', async () => {
    const home = makeTempHome();
    const version = '0.1.0';
    const logPath = path.join(home, 'argv.log');
    writeVersionBinary(home, 'claude', version, 'claude');
    makeServerYaml(home, 'demo.yaml', [
      'name: demo',
      'transport: stdio',
      'command: node',
      'args: ["server.js"]',
      'env:',
      '  TOKEN: x',
    ]);
    const versionHome = path.join(home, '.agents', '.history', 'versions', 'claude', version, 'home');
    const child = runInstall('claude', version, versionHome, home, logPath);
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim());
    expect(result.success).toBe(true);
    const log = fs.readFileSync(logPath, 'utf-8');
    expect(log).toMatch(/ARG:--\nARG:demo\nARG:node\nARG:server\.js/);
  });

  it.skipIf(IS_WINDOWS)('puts Claude http name and url after --', async () => {
    const home = makeTempHome();
    const version = '0.1.0';
    const logPath = path.join(home, 'argv.log');
    writeVersionBinary(home, 'claude', version, 'claude');
    makeServerYaml(home, 'remote.yaml', [
      'name: remote',
      'transport: http',
      'url: https://e.x/mcp',
    ]);
    const versionHome = path.join(home, '.agents', '.history', 'versions', 'claude', version, 'home');
    const child = runInstall('claude', version, versionHome, home, logPath);
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim());
    expect(result.success).toBe(true);
    const log = fs.readFileSync(logPath, 'utf-8');
    expect(log).toMatch(/ARG:--\nARG:remote\nARG:https:\/\/e\.x\/mcp/);
  });

  it.skipIf(IS_WINDOWS)('puts Codex http name and --url flag', async () => {
    const home = makeTempHome();
    const version = '0.1.0';
    const logPath = path.join(home, 'argv.log');
    writeVersionBinary(home, 'codex', version, 'codex');
    makeServerYaml(home, 'remote.yaml', [
      'name: remote',
      'transport: http',
      'url: https://e.x/mcp',
    ]);
    const versionHome = path.join(home, '.agents', '.history', 'versions', 'codex', version, 'home');
    const child = runInstall('codex', version, versionHome, home, logPath);
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim());
    expect(result.success).toBe(true);
    const log = fs.readFileSync(logPath, 'utf-8');
    expect(log).toMatch(/ARG:mcp\nARG:add\nARG:remote\nARG:--url\nARG:https:\/\/e\.x\/mcp/);
  });

  it('rejects option-like names from registerMcpCommand before spawning', async () => {
    const result = await registerMcpCommandToTargets(
      { directAgents: ['codex'], versionSelections: new Map() },
      '--dangerous-flag',
      { command: 'node', args: [] }
    );
    expect(result[0].success).toBe(false);
    expect(result[0].error).toContain("names cannot start with '-'");
  });

  it.skipIf(IS_WINDOWS)('puts registerMcpCommand args after --', async () => {
    const home = makeTempHome();
    const version = '0.1.0';
    const logPath = path.join(home, 'argv.log');
    writeVersionBinary(home, 'claude', version, 'claude');
    const moduleUrl = pathToFileURL(path.resolve('dist/lib/mcp.js')).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { registerMcpCommandToTargets } from ${JSON.stringify(moduleUrl)};
      const result = await registerMcpCommandToTargets(
        { directAgents: [], versionSelections: new Map([['claude', ['${version}']]]) },
        'demo',
        { command: 'node', args: ['server.js'] },
        'user',
        'stdio'
      );
      console.log(JSON.stringify(result));
    `], {
      env: { ...process.env, HOME: home, LOG_PATH: logPath },
      encoding: 'utf-8',
    });
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim());
    expect(result[0].success).toBe(true);
    const log = fs.readFileSync(logPath, 'utf-8');
    expect(log).toMatch(/ARG:--\nARG:demo\nARG:node\nARG:server\.js/);
  });
});

describe('installMcpServers project-level config', () => {
  it.skipIf(IS_WINDOWS)('writes project-layer MCPs to the agent project config path', async () => {
    const home = makeTempHome();
    const version = '0.1.0';
    const projectRoot = path.join(home, 'project');
    const projectMcpDir = path.join(projectRoot, '.agents', 'mcp');
    const userMcpDir = path.join(home, '.agents', 'mcp');
    fs.mkdirSync(projectMcpDir, { recursive: true });
    fs.mkdirSync(userMcpDir, { recursive: true });

    fs.writeFileSync(
      path.join(projectMcpDir, 'project-server.yaml'),
      ['name: project-server', 'transport: stdio', 'command: node', 'args: ["project.js"]', ''].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(userMcpDir, 'user-server.yaml'),
      ['name: user-server', 'transport: stdio', 'command: node', 'args: ["user.js"]', ''].join('\n'),
      'utf-8'
    );

    const moduleUrl = pathToFileURL(path.resolve('dist/lib/mcp.js')).href;
    const versionHome = path.join(home, '.agents', '.history', 'versions', 'cursor', version, 'home');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { installMcpServers, trustProjectMcp } from ${JSON.stringify(moduleUrl)};
      trustProjectMcp(${JSON.stringify(projectRoot)});
      const result = installMcpServers('cursor', ${JSON.stringify(version)}, ${JSON.stringify(versionHome)}, undefined, { cwd: ${JSON.stringify(projectRoot)} });
      console.log(JSON.stringify(result));
    `], {
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });

    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim());
    expect(result.success).toBe(true);

    const userConfig = JSON.parse(fs.readFileSync(path.join(versionHome, '.cursor', 'mcp.json'), 'utf-8'));
    expect(userConfig.mcpServers).toHaveProperty('project-server');
    expect(userConfig.mcpServers).toHaveProperty('user-server');

    const projectConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, '.cursor', 'mcp.json'), 'utf-8'));
    expect(projectConfig.mcpServers).toHaveProperty('project-server');
    expect(projectConfig.mcpServers).not.toHaveProperty('user-server');
  });

  it.skipIf(IS_WINDOWS)('merges project config without clobbering manual entries', async () => {
    const home = makeTempHome();
    const version = '0.1.0';
    const projectRoot = path.join(home, 'project');
    const projectMcpDir = path.join(projectRoot, '.agents', 'mcp');
    fs.mkdirSync(projectMcpDir, { recursive: true });

    fs.writeFileSync(
      path.join(projectMcpDir, 'project-server.yaml'),
      ['name: project-server', 'transport: stdio', 'command: node', 'args: ["project.js"]', ''].join('\n'),
      'utf-8'
    );

    const projectConfigDir = path.join(projectRoot, '.cursor');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { 'manual-server': { command: 'manual' } } }, null, 2),
      'utf-8'
    );

    const moduleUrl = pathToFileURL(path.resolve('dist/lib/mcp.js')).href;
    const versionHome = path.join(home, '.agents', '.history', 'versions', 'cursor', version, 'home');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { installMcpServers, trustProjectMcp } from ${JSON.stringify(moduleUrl)};
      trustProjectMcp(${JSON.stringify(projectRoot)});
      const result = installMcpServers('cursor', ${JSON.stringify(version)}, ${JSON.stringify(versionHome)}, undefined, { cwd: ${JSON.stringify(projectRoot)} });
      console.log(JSON.stringify(result));
    `], {
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });

    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim());
    expect(result.success).toBe(true);

    const projectConfig = JSON.parse(fs.readFileSync(path.join(projectConfigDir, 'mcp.json'), 'utf-8'));
    expect(projectConfig.mcpServers).toHaveProperty('project-server');
    expect(projectConfig.mcpServers).toHaveProperty('manual-server');
    expect(projectConfig.mcpServers['manual-server']).toEqual({ command: 'manual' });
  });
});

describe('writeMcpConfig OpenClaw format', () => {
  it('writes stdio servers under config.mcp.servers', () => {
    const home = makeTempHome();
    const configPath = path.join(home, '.openclaw', 'openclaw.json');
    const moduleUrl = pathToFileURL(path.resolve('dist/lib/mcp.js')).href;

    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { writeMcpConfig } from ${JSON.stringify(moduleUrl)};
      writeMcpConfig('openclaw', ${JSON.stringify(configPath)}, [{
        name: 'claw-server',
        transport: 'stdio',
        command: 'node',
        args: ['mcp.js'],
        env: { API_KEY: 'secret' },
      }], 'overwrite');
      console.log('ok');
    `], {
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });

    expect(child.status, child.stderr).toBe(0);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.mcp?.servers?.['claw-server']).toEqual({
      command: 'node',
      args: ['mcp.js'],
      env: { API_KEY: 'secret' },
    });
  });

  it('merges without clobbering existing mcp.servers entries', () => {
    const home = makeTempHome();
    const configPath = path.join(home, '.openclaw', 'openclaw.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcp: { servers: { existing: { command: 'existing' } } } }, null, 2),
      'utf-8'
    );
    const moduleUrl = pathToFileURL(path.resolve('dist/lib/mcp.js')).href;

    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { writeMcpConfig } from ${JSON.stringify(moduleUrl)};
      writeMcpConfig('openclaw', ${JSON.stringify(configPath)}, [{
        name: 'new-server',
        transport: 'sse',
        url: 'https://example.com/sse',
      }], 'merge');
      console.log('ok');
    `], {
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });

    expect(child.status, child.stderr).toBe(0);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.mcp?.servers?.existing).toEqual({ command: 'existing' });
    expect(config.mcp?.servers?.['new-server']).toEqual({
      url: 'https://example.com/sse',
      transport: 'sse',
    });
  });
});

describe('installMcpServers grok user-level config', () => {
  it.skipIf(IS_WINDOWS)('writes multiple user-scoped servers without clobbering', () => {
    const home = makeTempHome();
    const version = '0.1.0';
    const userMcpDir = path.join(home, '.agents', 'mcp');
    fs.mkdirSync(userMcpDir, { recursive: true });

    fs.writeFileSync(
      path.join(userMcpDir, 'server-a.yaml'),
      ['name: server-a', 'transport: stdio', 'command: node', 'args: ["a.js"]', ''].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(userMcpDir, 'server-b.yaml'),
      ['name: server-b', 'transport: stdio', 'command: node', 'args: ["b.js"]', ''].join('\n'),
      'utf-8'
    );

    const moduleUrl = pathToFileURL(path.resolve('dist/lib/mcp.js')).href;
    const versionHome = path.join(home, '.agents', '.history', 'versions', 'grok', version, 'home');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { installMcpServers } from ${JSON.stringify(moduleUrl)};
      const result = installMcpServers('grok', ${JSON.stringify(version)}, ${JSON.stringify(versionHome)});
      console.log(JSON.stringify(result));
    `], {
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });

    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim());
    expect(result.success).toBe(true);
    expect(result.applied).toContain('server-a');
    expect(result.applied).toContain('server-b');

    const config = TOML.parse(fs.readFileSync(path.join(versionHome, '.grok', 'config.toml'), 'utf-8'));
    expect(config.mcp_servers).toHaveProperty('server-a');
    expect(config.mcp_servers).toHaveProperty('server-b');
    expect(config.mcp_servers['server-a']).toEqual({ command: 'node', args: ['a.js'] });
    expect(config.mcp_servers['server-b']).toEqual({ command: 'node', args: ['b.js'] });
  });
});

describe('installMcpServers handled-agent tracking', () => {
  it.skipIf(IS_WINDOWS)('writes multiple OpenClaw user-scoped servers without clobbering', () => {
    const home = makeTempHome();
    const version = '0.1.0';
    const userMcpDir = path.join(home, '.agents', 'mcp');
    fs.mkdirSync(userMcpDir, { recursive: true });

    fs.writeFileSync(
      path.join(userMcpDir, 'server-a.yaml'),
      ['name: server-a', 'transport: stdio', 'command: node', 'args: ["a.js"]', ''].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(userMcpDir, 'server-b.yaml'),
      ['name: server-b', 'transport: stdio', 'command: node', 'args: ["b.js"]', ''].join('\n'),
      'utf-8'
    );

    const moduleUrl = pathToFileURL(path.resolve('dist/lib/mcp.js')).href;
    const versionHome = path.join(home, '.agents', '.history', 'versions', 'openclaw', version, 'home');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { installMcpServers } from ${JSON.stringify(moduleUrl)};
      const result = installMcpServers('openclaw', ${JSON.stringify(version)}, ${JSON.stringify(versionHome)});
      console.log(JSON.stringify(result));
    `], {
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });

    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim());
    expect(result.success).toBe(true);
    expect(result.applied).toContain('server-a');
    expect(result.applied).toContain('server-b');

    const config = JSON.parse(fs.readFileSync(path.join(versionHome, '.openclaw', 'openclaw.json'), 'utf-8'));
    expect(config.mcp?.servers?.['server-a']).toEqual({ command: 'node', args: ['a.js'], env: {} });
    expect(config.mcp?.servers?.['server-b']).toEqual({ command: 'node', args: ['b.js'], env: {} });
  });

  it.skipIf(IS_WINDOWS)('fails loud for an agent whose config format is not implemented', () => {
    // RUSH-2677: copilot is mcp-capable but agents-cli has no verified schema for
    // its mcp-config.json. It used to return `success: true` with an empty
    // `applied` -- a silent no-op the sync surface could not distinguish from a
    // real write. It must now say why it wrote nothing.
    const home = makeTempHome();
    const version = '0.1.0';
    const userMcpDir = path.join(home, '.agents', 'mcp');
    fs.mkdirSync(userMcpDir, { recursive: true });

    fs.writeFileSync(
      path.join(userMcpDir, 'user-server.yaml'),
      ['name: user-server', 'transport: stdio', 'command: node', 'args: ["user.js"]', ''].join('\n'),
      'utf-8'
    );

    const moduleUrl = pathToFileURL(path.resolve('dist/lib/mcp.js')).href;
    const versionHome = path.join(home, '.agents', '.history', 'versions', 'copilot', version, 'home');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { installMcpServers } from ${JSON.stringify(moduleUrl)};
      const result = installMcpServers('copilot', ${JSON.stringify(version)}, ${JSON.stringify(versionHome)});
      console.log(JSON.stringify(result));
    `], {
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });

    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim());
    expect(result.success).toBe(false);
    expect(result.applied).not.toContain('user-server');
    expect(result.errors.join('\n')).toContain('copilot');
    expect(result.errors.join('\n')).toContain('cannot write MCP config');
  });

  it.skipIf(IS_WINDOWS)('writes antigravity MCP into the shared ~/.gemini/config it actually reads', () => {
    // RUSH-2677: antigravity resolved a config path and then fell through the
    // writer switch entirely -- no file, no error, reported as success. It also
    // resolved the per-version .gemini/antigravity-cli/ state dir rather than the
    // shared .gemini/config/ agy reads MCP from.
    const home = makeTempHome();
    const version = '1.0.16';
    const userMcpDir = path.join(home, '.agents', 'mcp');
    fs.mkdirSync(userMcpDir, { recursive: true });

    fs.writeFileSync(
      path.join(userMcpDir, 'local-server.yaml'),
      ['name: local-server', 'transport: stdio', 'command: node', 'args: ["srv.js"]', ''].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(userMcpDir, 'remote-server.yaml'),
      ['name: remote-server', 'transport: http', 'url: https://mcp.example.com/sse', ''].join('\n'),
      'utf-8'
    );

    const moduleUrl = pathToFileURL(path.resolve('dist/lib/mcp.js')).href;
    const versionHome = path.join(home, '.agents', '.history', 'versions', 'antigravity', version, 'home');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { installMcpServers } from ${JSON.stringify(moduleUrl)};
      const result = installMcpServers('antigravity', ${JSON.stringify(version)}, ${JSON.stringify(versionHome)});
      console.log(JSON.stringify(result));
    `], {
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });

    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim());
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.applied).toEqual(expect.arrayContaining(['local-server', 'remote-server']));

    // agy reads ~/.gemini/config/mcp_config.json from the REAL home — only
    // ~/.gemini/antigravity-cli is symlinked into a version home — so the write
    // must land there, NOT under the version home (the child ran with HOME=home).
    const configPath = path.join(home, '.gemini', 'config', 'mcp_config.json');
    expect(fs.existsSync(configPath), `expected agy MCP config at ${configPath}`).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers['local-server']).toEqual({ command: 'node', args: ['srv.js'], env: {} });
    // agy keys a remote server `serverUrl` (SSE), not `url`.
    expect(config.mcpServers['remote-server']).toEqual({ serverUrl: 'https://mcp.example.com/sse' });

    // Neither the per-version state dir nor a version-home copy of the shared
    // config dir may be where MCP landed — agy opens neither.
    expect(fs.existsSync(path.join(versionHome, '.gemini', 'antigravity-cli', 'mcp_config.json'))).toBe(false);
    expect(fs.existsSync(path.join(versionHome, '.gemini', 'config', 'mcp_config.json'))).toBe(false);
  });

  it.skipIf(IS_WINDOWS)('writes kimi MCP where the staleness detector reads it back', () => {
    // The installer wrote .kimi-code/mcp.json while the path resolver answered
    // .kimi-code/settings.json, so a synced server was reported as missing forever.
    const home = makeTempHome();
    const version = '0.29.0';
    const userMcpDir = path.join(home, '.agents', 'mcp');
    fs.mkdirSync(userMcpDir, { recursive: true });
    fs.writeFileSync(
      path.join(userMcpDir, 'kimi-server.yaml'),
      ['name: kimi-server', 'transport: stdio', 'command: node', 'args: ["k.js"]', ''].join('\n'),
      'utf-8'
    );

    const mcpUrl = pathToFileURL(path.resolve('dist/lib/mcp.js')).href;
    const agentsUrl = pathToFileURL(path.resolve('dist/lib/agents.js')).href;
    const versionHome = path.join(home, '.agents', '.history', 'versions', 'kimi', version, 'home');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { installMcpServers } from ${JSON.stringify(mcpUrl)};
      import { getMcpConfigPathForHome, parseMcpConfig } from ${JSON.stringify(agentsUrl)};
      const result = installMcpServers('kimi', ${JSON.stringify(version)}, ${JSON.stringify(versionHome)});
      const detected = Object.keys(parseMcpConfig('kimi', getMcpConfigPathForHome('kimi', ${JSON.stringify(versionHome)})));
      console.log(JSON.stringify({ result, detected }));
    `], {
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });

    expect(child.status, child.stderr).toBe(0);
    const { result, detected } = JSON.parse(child.stdout.trim());
    expect(result.applied).toContain('kimi-server');
    // The write and the read-back must agree on the file.
    expect(detected).toContain('kimi-server');
  });
  it.skipIf(IS_WINDOWS)('refuses a malformed existing config instead of rewriting it from scratch', () => {
    // The five per-agent installers this replaced parsed unguarded, so a corrupt
    // config threw and the file survived. writeMcpConfig's catch-and-reset would
    // have rebuilt hermes' whole config.yaml — which holds far more than MCP —
    // from `{}`.
    const home = makeTempHome();
    const version = '0.1.0';
    const userMcpDir = path.join(home, '.agents', 'mcp');
    fs.mkdirSync(userMcpDir, { recursive: true });
    fs.writeFileSync(
      path.join(userMcpDir, 'srv.yaml'),
      ['name: srv', 'transport: stdio', 'command: node', 'args: ["s.js"]', ''].join('\n'),
      'utf-8'
    );

    const versionHome = path.join(home, '.agents', '.history', 'versions', 'droid', version, 'home');
    const configPath = path.join(versionHome, '.factory', 'mcp.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const corrupt = '{ "mcpServers": { "keep-me": { "command": "node" } ';  // truncated on purpose
    fs.writeFileSync(configPath, corrupt, 'utf-8');

    const moduleUrl = pathToFileURL(path.resolve('dist/lib/mcp.js')).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { installMcpServers } from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify(installMcpServers('droid', ${JSON.stringify(version)}, ${JSON.stringify(versionHome)})));
    `], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });

    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim());
    expect(result.success).toBe(false);
    expect(result.errors.join('\n')).toContain('is not valid');
    // The user's file is byte-identical — nothing was clobbered.
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(corrupt);
  });
  it.skipIf(IS_WINDOWS)('treats an empty config file as nothing recorded, not corruption', () => {
    // JSON.parse('') throws, so a bare `touch`ed or half-written config would
    // have failed the whole sync once malformed configs stopped resetting to {}.
    const home = makeTempHome();
    const version = '0.1.0';
    const userMcpDir = path.join(home, '.agents', 'mcp');
    fs.mkdirSync(userMcpDir, { recursive: true });
    fs.writeFileSync(
      path.join(userMcpDir, 'srv.yaml'),
      ['name: srv', 'transport: stdio', 'command: node', 'args: ["s.js"]', ''].join('\n'),
      'utf-8'
    );

    const versionHome = path.join(home, '.agents', '.history', 'versions', 'droid', version, 'home');
    const configPath = path.join(versionHome, '.factory', 'mcp.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '   \n', 'utf-8');

    const moduleUrl = pathToFileURL(path.resolve('dist/lib/mcp.js')).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { installMcpServers } from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify(installMcpServers('droid', ${JSON.stringify(version)}, ${JSON.stringify(versionHome)})));
    `], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });

    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim());
    expect(result.errors).toEqual([]);
    expect(result.applied).toContain('srv');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).mcpServers.srv).toBeTruthy();
  });
  it.skipIf(IS_WINDOWS)('keeps a URL inside a JSONC string intact when merging opencode MCP', () => {
    // A `//`-to-end-of-line regex eats the `//` in
    // "$schema": "https://opencode.ai/config.json" — which every
    // opencode-generated config carries — so the writer would refuse a config
    // the reader parses fine. Both must use the string-literal-aware stripper.
    const home = makeTempHome();
    const version = '0.1.0';
    const userMcpDir = path.join(home, '.agents', 'mcp');
    fs.mkdirSync(userMcpDir, { recursive: true });
    fs.writeFileSync(
      path.join(userMcpDir, 'srv.yaml'),
      ['name: srv', 'transport: stdio', 'command: node', 'args: ["s.js"]', ''].join('\n'),
      'utf-8'
    );

    const versionHome = path.join(home, '.agents', '.history', 'versions', 'opencode', version, 'home');
    const configPath = path.join(versionHome, '.config', 'opencode', 'opencode.jsonc');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, [
      '{',
      '  // a real comment, which must go',
      '  "$schema": "https://opencode.ai/config.json",',
      '  "theme": "tokyonight"',
      '}',
      '',
    ].join('\n'), 'utf-8');

    const moduleUrl = pathToFileURL(path.resolve('dist/lib/mcp.js')).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { installMcpServers } from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify(installMcpServers('opencode', ${JSON.stringify(version)}, ${JSON.stringify(versionHome)})));
    `], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });

    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim());
    expect(result.errors).toEqual([]);
    expect(result.applied).toContain('srv');

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    // The schema URL survived, the neighbouring keys survived, and MCP landed.
    expect(config.$schema).toBe('https://opencode.ai/config.json');
    expect(config.theme).toBe('tokyonight');
    expect(config.mcp.srv).toBeTruthy();
  });
});
