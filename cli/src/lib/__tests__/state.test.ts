import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

import {
  getBackupsDir,
  getCommandsDir,
  getHooksDir,
  getPackagesDir,
  getPluginsDir,
  getRoutinesDir,
  getRunsDir,
  getShimsDir,
  getSkillsDir,
  getTrashDir,
  getTrashVersionsDir,
  getVersionsDir,
} from '../state.js';

describe('state paths', () => {
  it('keeps system resource directories under ~/.agents/.system', () => {
    const systemRoot = path.join(os.homedir(), '.agents', '.system');

    expect(getCommandsDir()).toBe(path.join(systemRoot, 'commands'));
    expect(getHooksDir()).toBe(path.join(systemRoot, 'hooks'));
    expect(getSkillsDir()).toBe(path.join(systemRoot, 'skills'));
  });

  it('stores durable runtime state under ~/.agents/.history', () => {
    const userRoot = path.join(os.homedir(), '.agents');
    const history = path.join(userRoot, '.history');

    expect(getVersionsDir()).toBe(path.join(history, 'versions'));
    expect(getRunsDir()).toBe(path.join(history, 'runs'));
    expect(getBackupsDir()).toBe(path.join(history, 'backups'));
    expect(getTrashDir()).toBe(path.join(history, 'trash'));
    expect(getTrashVersionsDir()).toBe(path.join(history, 'trash', 'versions'));
  });

  it('stores regenerable runtime state under ~/.agents/.cache', () => {
    const userRoot = path.join(os.homedir(), '.agents');
    const cache = path.join(userRoot, '.cache');

    expect(getPackagesDir()).toBe(path.join(cache, 'packages'));
    expect(getShimsDir()).toBe(path.join(cache, 'shims'));
  });

  it('keeps definitions/configs at the top of ~/.agents', () => {
    const userRoot = path.join(os.homedir(), '.agents');
    expect(getRoutinesDir()).toBe(path.join(userRoot, 'routines'));
    expect(getPluginsDir()).toBe(path.join(userRoot, 'plugins'));
  });
});

describe('readMeta merges agents.yaml from both repos', () => {
  let testDir: string;
  let userDir: string;
  let systemDir: string;
  const modulePath = path.resolve(process.cwd(), 'src/lib/state.ts');
  const MACHINE = 'state-testbox';
  function hermeticEnv(home: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: home,
      AGENTS_SYNC_MACHINE_ID: MACHINE,
      AGENTS_DEVICES_DIR: path.join(home, '.agents', '.history', 'devices'),
    };
  }

  function runReadMeta(home: string): Record<string, unknown> {
    const result = execFileSync(
      'bun',
      [
        '-e',
        `import { readMeta } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(readMeta()));`,
      ],
      {
        cwd: process.cwd(),
        env: hermeticEnv(home),
        stdio: 'pipe',
        encoding: 'utf8',
      },
    ).trim();
    return JSON.parse(result);
  }

  function runStateScript(home: string, script: string): string {
    return execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: hermeticEnv(home),
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  }

  function runStateScriptWithNode(home: string, script: string): string {
    return execFileSync('node', ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: hermeticEnv(home),
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  }

  function spawnStateScript(home: string, script: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('bun', ['-e', script], {
        cwd: process.cwd(),
        env: hermeticEnv(home),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`state script exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      });
    });
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
    userDir = path.join(testDir, '.agents');
    systemDir = path.join(userDir, '.system');
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(systemDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('merges agents from both system and user repos, user wins on conflict', () => {
    fs.writeFileSync(
      path.join(systemDir, 'agents.yaml'),
      'agents:\n  claude: "1.0.0"\n  codex: "2.0.0"\n'
    );
    fs.writeFileSync(
      path.join(userDir, 'agents.yaml'),
      'agents:\n  claude: "3.0.0"\n  gemini: "1.0.0"\n'
    );

    const meta = runReadMeta(testDir);
    const agents = meta.agents as Record<string, string>;

    expect(agents.claude).toBe('3.0.0');
    expect(agents.codex).toBe('2.0.0');
    expect(agents.gemini).toBe('1.0.0');
  });

  it('reads from system repo when user repo has no agents.yaml', () => {
    fs.writeFileSync(
      path.join(systemDir, 'agents.yaml'),
      'agents:\n  claude: "1.0.0"\n'
    );

    const meta = runReadMeta(testDir);
    const agents = meta.agents as Record<string, string>;

    expect(agents.claude).toBe('1.0.0');
  });

  it('reads from user repo when system repo has no agents.yaml', () => {
    fs.writeFileSync(
      path.join(userDir, 'agents.yaml'),
      'agents:\n  claude: "2.0.0"\n'
    );

    const meta = runReadMeta(testDir);
    const agents = meta.agents as Record<string, string>;

    expect(agents.claude).toBe('2.0.0');
  });

  it('preserves an unknown top-level key on write, but still deletes a cleared known key', () => {
    fs.writeFileSync(
      path.join(userDir, 'agents.yaml'),
      'futureUnknownKey: keep-me\nprojectRoot: ~/old\n',
    );

    runStateScript(testDir, `
      const { updateMeta } = await import(${JSON.stringify(modulePath)});
      updateMeta((meta) => {
        const { futureUnknownKey, projectRoot, ...rest } = meta;
        return { ...rest, source: 'set-by-write' };
      });
    `);

    const out = fs.readFileSync(path.join(userDir, 'agents.yaml'), 'utf8');
    expect(out).toContain('futureUnknownKey: keep-me');
    expect(out).not.toContain('projectRoot');
    expect(out).toContain('source: set-by-write');
  });

  it('does not drop share: when a partial writeMeta omits it (RUSH-2837)', () => {
    fs.writeFileSync(
      path.join(userDir, 'agents.yaml'),
      [
        'share:',
        '  baseUrl: https://share.agents-cli.sh',
        '  accountId: cba808419c971547b1634aec0a7bf795',
        '  workerName: agents-share',
        '  bucketName: agents-share',
        '',
      ].join('\n'),
    );
    runStateScript(testDir, `
      const { writeMeta } = await import(${JSON.stringify(modulePath)});
      writeMeta({ run: { claude: { strategy: 'balanced' } } });
    `);
    const out = fs.readFileSync(path.join(userDir, 'agents.yaml'), 'utf8');
    expect(out).toContain('baseUrl: https://share.agents-cli.sh');
    expect(out).toContain('accountId: cba808419c971547b1634aec0a7bf795');
    expect(out).toContain('strategy: balanced');
  });

  it('does not lose concurrent updateMeta callback writes', async () => {
    const HOLD_MS = 1_000;
    const makeUpdate = (agent: string, version: string) => `
      const { updateMeta } = await import(${JSON.stringify(modulePath)});
      updateMeta((meta) => {
        const block = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(block, 0, 0, ${HOLD_MS});
        return {
          ...meta,
          agents: {
            ...(meta.agents ?? {}),
            ${JSON.stringify(agent)}: ${JSON.stringify(version)},
          },
        };
      });
    `;

    await Promise.all([
      spawnStateScript(testDir, makeUpdate('claude', '1.0.0')),
      spawnStateScript(testDir, makeUpdate('codex', '2.0.0')),
    ]);

    const meta = runReadMeta(testDir);
    expect(meta.agents).toMatchObject({
      claude: '1.0.0',
      codex: '2.0.0',
    });
  });

  it('keeps the original agents.yaml when rename fails after writing the temp file', () => {
    const moduleUrl = pathToFileURL(modulePath).href;
    fs.writeFileSync(
      path.join(userDir, 'agents.yaml'),
      'agents:\n  claude: "1.0.0"\n',
      'utf-8',
    );

    const output = runStateScriptWithNode(testDir, `
      import fs from 'fs';
      import path from 'path';
      import { syncBuiltinESMExports } from 'module';

      const target = path.join(process.env.HOME, '.agents', 'agents.yaml');
      const originalRename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (to === target) throw new Error('simulated rename failure');
        return originalRename(from, to);
      };
      syncBuiltinESMExports();

      const { writeMeta } = await import(${JSON.stringify(moduleUrl)});
      try {
        writeMeta({ agents: { claude: '9.9.9' } });
      } catch (err) {
        console.log(String(err.message));
      }
      console.log(fs.readFileSync(target, 'utf-8'));
    `);

    expect(output).toContain('simulated rename failure');
    expect(output).toContain('claude: "1.0.0"');
    expect(output).not.toContain('9.9.9');
    expect(fs.readdirSync(userDir).filter((entry) => entry.includes('.tmp-'))).toEqual([]);
  });

  it('breaks a stale agents.yaml lock older than five seconds', () => {
    fs.writeFileSync(
      path.join(userDir, 'agents.yaml'),
      'agents:\n  claude: "1.0.0"\n',
      'utf-8',
    );
    fs.mkdirSync(path.join(userDir, 'agents.yaml.lock'));
    const staleTime = new Date(Date.now() - 10_000);
    fs.utimesSync(path.join(userDir, 'agents.yaml.lock'), staleTime, staleTime);

    runStateScript(testDir, `
      const { updateMeta } = await import(${JSON.stringify(modulePath)});
      updateMeta((meta) => ({
        ...meta,
        agents: { ...(meta.agents ?? {}), codex: '2.0.0' },
      }));
    `);

    const meta = runReadMeta(testDir);
    expect(meta.agents).toMatchObject({
      claude: '1.0.0',
      codex: '2.0.0',
    });
  });

  it('caches parsed agents.yaml across repeated reads (no re-parse when mtime unchanged)', () => {
    const moduleUrl = pathToFileURL(modulePath).href;
    fs.writeFileSync(
      path.join(userDir, 'agents.yaml'),
      'agents:\n  claude: "1.0.0"\n',
      'utf-8',
    );

    const output = runStateScriptWithNode(testDir, `
      import fs from 'fs';
      import path from 'path';
      import { syncBuiltinESMExports } from 'module';

      const targetUser = path.join(process.env.HOME, '.agents', 'agents.yaml');
      const targetSystem = path.join(process.env.HOME, '.agents', '.system', 'agents.yaml');
      const originalRead = fs.readFileSync;
      let reads = 0;
      fs.readFileSync = (file, opts) => {
        if (file === targetUser || file === targetSystem) reads++;
        return originalRead(file, opts);
      };
      syncBuiltinESMExports();

      const { readMeta } = await import(${JSON.stringify(moduleUrl)});
      readMeta();
      const readsAfterFirst = reads;
      readMeta();
      readMeta();
      console.log(JSON.stringify({ readsAfterFirst, readsTotal: reads }));
    `);
    const counts = JSON.parse(output) as { readsAfterFirst: number; readsTotal: number };

    expect(counts.readsTotal).toBe(counts.readsAfterFirst);
    expect(counts.readsAfterFirst).toBeGreaterThan(0);
  });

  it('invalidates the cache when writeMeta runs', () => {
    const moduleUrl = pathToFileURL(modulePath).href;
    fs.writeFileSync(
      path.join(userDir, 'agents.yaml'),
      'agents:\n  claude: "1.0.0"\n',
      'utf-8',
    );

    const output = runStateScriptWithNode(testDir, `
      import { readMeta, writeMeta } from ${JSON.stringify(moduleUrl)};
      const before = readMeta();
      writeMeta({ ...before, agents: { ...before.agents, claude: '9.9.9' } });
      const after = readMeta();
      console.log(JSON.stringify({ before: before.agents?.claude, after: after.agents?.claude }));
    `);
    const result = JSON.parse(output) as { before: string; after: string };

    expect(result.before).toBe('1.0.0');
    expect(result.after).toBe('9.9.9');
  });

  it('refreshes the cache when the device pin file is modified out-of-band', () => {
    const moduleUrl = pathToFileURL(modulePath).href;
    fs.writeFileSync(
      path.join(userDir, 'agents.yaml'),
      'agents:\n  claude: "1.0.0"\n',
      'utf-8',
    );

    const output = runStateScriptWithNode(testDir, `
      import fs from 'fs';
      import path from 'path';
      import { readMeta, getDevicePinsPath } from ${JSON.stringify(moduleUrl)};

      const before = readMeta(); // central pin overlays while no pins file exists
      const pinsPath = getDevicePinsPath();

      // Wait long enough for the mtime to definitely advance (HFS+ mtime is per-second).
      await new Promise((r) => setTimeout(r, 1100));
      fs.mkdirSync(path.dirname(pinsPath), { recursive: true });
      fs.writeFileSync(pinsPath, JSON.stringify({ agents: { claude: '2.0.0' } }, null, 2) + '\\n');

      const after = readMeta();
      console.log(JSON.stringify({ before: before.agents?.claude, after: after.agents?.claude }));
    `);
    const result = JSON.parse(output) as { before: string; after: string };

    expect(result.before).toBe('1.0.0');
    expect(result.after).toBe('2.0.0');
  });
});

describe('agents.yaml device-local split (routing + read overlay)', () => {
  let home: string;
  const MACHINE = 'testbox';
  const modulePath = path.resolve(process.cwd(), 'src/lib/state.ts');
  const moduleUrl = pathToFileURL(modulePath).href;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-split-'));
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function run(script: string): string {
    return execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        AGENTS_SYNC_MACHINE_ID: MACHINE,
        AGENTS_DEVICES_DIR: path.join(home, '.agents', '.history', 'devices'),
      },
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  }

  it('routes agents: -> pins JSON, versions: -> history json, rest -> central', () => {
    const out = run(`
      import * as fs from 'fs';
      import * as yaml from 'yaml';
      import { writeMeta, getDevicePinsPath, getVersionResourcesPath } from ${JSON.stringify(moduleUrl)};
      writeMeta({
        agents: { claude: '2.1.0' },
        versions: { claude: { '2.1.0': { rulesPreset: 'default' } } },
        run: { claude: { strategy: 'balanced' } },
      });
      const central = yaml.parse(fs.readFileSync(process.env.HOME + '/.agents/agents.yaml', 'utf8')) || {};
      const pins = JSON.parse(fs.readFileSync(getDevicePinsPath(), 'utf8'));
      const history = JSON.parse(fs.readFileSync(getVersionResourcesPath(), 'utf8'));
      console.log(JSON.stringify({
        centralHasAgents: 'agents' in central,
        centralHasVersions: 'versions' in central,
        centralRun: central.run && central.run.claude && central.run.claude.strategy,
        pinAgents: pins.agents,
        history,
        pinsPath: getDevicePinsPath(),
      }));
    `);
    const r = JSON.parse(out);
    expect(r.centralHasAgents).toBe(false);
    expect(r.centralHasVersions).toBe(false);
    expect(r.centralRun).toBe('balanced');
    expect(r.pinAgents).toEqual({ claude: '2.1.0' });
    expect(r.history).toEqual({ claude: { '2.1.0': { rulesPreset: 'default' } } });
    expect(r.pinsPath).toContain(path.join('.history', 'devices', `pins-${MACHINE}.json`));
  });

  it('readMeta re-assembles agents: and versions: from the split files', () => {
    const out = run(`
      import { writeMeta, readMeta } from ${JSON.stringify(moduleUrl)};
      writeMeta({
        agents: { claude: '2.1.0', codex: '0.1.0' },
        versions: { claude: { '2.1.0': { rulesPreset: 'x' } } },
        hosts: { box: { source: 'inline', address: 'h' } },
      });
      console.log(JSON.stringify(readMeta()));
    `);
    const meta = JSON.parse(out);
    expect(meta.agents).toEqual({ claude: '2.1.0', codex: '0.1.0' });
    expect(meta.versions).toEqual({ claude: { '2.1.0': { rulesPreset: 'x' } } });
    expect(meta.hosts).toBeDefined();
  });

  it('preserves comments + hosts in central agents.yaml; a device-only write does not touch it (no churn)', () => {
    const out = run(`
      import * as fs from 'fs';
      import { writeMeta, readMeta } from ${JSON.stringify(moduleUrl)};
      const p = process.env.HOME + '/.agents/agents.yaml';
      fs.writeFileSync(p, [
        '# hand-written note: do not clobber me',
        'defaultAgent: claude',
        'hosts:',
        '  box:',
        '    source: inline',
        '    address: 10.0.0.1  # tailnet IP',
        ''
      ].join('\\n'));
      const before = fs.readFileSync(p, 'utf8');
      // Unrelated write: a device pin (agents:) routes to the device file, not central.
      writeMeta({ ...readMeta(), agents: { claude: '2.1.0' } });
      const after = fs.readFileSync(p, 'utf8');
      console.log(JSON.stringify({
        commentSurvived: after.includes('do not clobber me'),
        inlineCommentSurvived: after.includes('# tailnet IP'),
        hostsSurvived: after.includes('address: 10.0.0.1'),
        byteIdentical: before === after,
      }));
    `);
    const r = JSON.parse(out);
    expect(r.commentSurvived).toBe(true);
    expect(r.inlineCommentSurvived).toBe(true);
    expect(r.hostsSurvived).toBe(true);
    expect(r.byteIdentical).toBe(true);
  });

  it('updates a changed central field while keeping surrounding comments', () => {
    const out = run(`
      import * as fs from 'fs';
      import { writeMeta, readMeta } from ${JSON.stringify(moduleUrl)};
      const p = process.env.HOME + '/.agents/agents.yaml';
      // Use a field that STAYS central. projectRoot moved to the per-machine doc
      // (it is an inferred local path), so updating it here would delete it from
      // this file along with the comment attached to it — testing the wrong thing.
      fs.writeFileSync(p, ['# keep this comment', 'source: /old/path', ''].join('\\n'));
      writeMeta({ ...readMeta(), source: '/new/path' });
      const after = fs.readFileSync(p, 'utf8');
      console.log(JSON.stringify({
        commentSurvived: after.includes('keep this comment'),
        valueUpdated: after.includes('/new/path'),
        oldGone: !after.includes('/old/path'),
      }));
    `);
    const r = JSON.parse(out);
    expect(r.commentSurvived).toBe(true);
    expect(r.valueUpdated).toBe(true);
    expect(r.oldGone).toBe(true);
  });

  it('does not create a device file when there are no pins', () => {
    const out = run(`
      import * as fs from 'fs';
      import { writeMeta, getDeviceMetaPath } from ${JSON.stringify(moduleUrl)};
      writeMeta({ run: { claude: { strategy: 'balanced' } } });
      console.log(JSON.stringify({ deviceExists: fs.existsSync(getDeviceMetaPath()) }));
    `);
    expect(JSON.parse(out).deviceExists).toBe(false);
  });

  it('invalidates the cache when the history version-resources file changes out-of-band', () => {
    const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '-e', `
      import fs from 'fs';
      import { readMeta, writeMeta, getVersionResourcesPath } from ${JSON.stringify(moduleUrl)};
      writeMeta({ versions: { claude: { '2.1.0': { rulesPreset: 'a' } } }, run: { claude: { strategy: 'balanced' } } });
      const before = readMeta().versions?.claude?.['2.1.0']?.rulesPreset;
      await new Promise((r) => setTimeout(r, 1100));
      fs.writeFileSync(getVersionResourcesPath(), JSON.stringify({ claude: { '2.1.0': { rulesPreset: 'b' } } }, null, 2));
      const after = readMeta().versions?.claude?.['2.1.0']?.rulesPreset;
      console.log(JSON.stringify({ before, after }));
    `], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        AGENTS_SYNC_MACHINE_ID: MACHINE,
        AGENTS_DEVICES_DIR: path.join(home, '.agents', '.history', 'devices'),
      },
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
    const r = JSON.parse(out);
    expect(r.before).toBe('a');
    expect(r.after).toBe('b');
  });
});
