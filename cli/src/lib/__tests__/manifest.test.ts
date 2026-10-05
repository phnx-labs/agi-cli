import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const manifestPath = path.resolve(process.cwd(), 'src/lib/manifest.ts');

describe('writeManifest concurrent safety', () => {
  let testDir: string;

  function runManifestScript(home: string, script: string): string {
    return execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home },
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  }

  function spawnWriteManifest(repoPath: string, agentKey: string, version: string): Promise<void> {
    const script = `
      const { readManifest, writeManifest } = await import(${JSON.stringify(manifestPath)});
      const existing = readManifest(${JSON.stringify(repoPath)}) ?? {};
      const block = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(block, 0, 0, 200);
      writeManifest(${JSON.stringify(repoPath)}, {
        ...existing,
        agents: { ...(existing.agents ?? {}), ${JSON.stringify(agentKey)}: ${JSON.stringify(version)} },
      });
    `;
    return new Promise((resolve, reject) => {
      const child = spawn('bun', ['-e', script], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: testDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`writeManifest script exited ${code}\nstderr:\n${stderr}`));
      });
    });
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
    fs.writeFileSync(path.join(testDir, 'agents.yaml'), 'agents: {}\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('leaves a valid YAML file under concurrent writes (no corruption)', async () => {
    await Promise.all([
      spawnWriteManifest(testDir, 'claude', '1.0.0'),
      spawnWriteManifest(testDir, 'codex', '2.0.0'),
    ]);

    runManifestScript(testDir, `
      const { readManifest } = await import(${JSON.stringify(manifestPath)});
      const m = readManifest(${JSON.stringify(testDir)});
      if (!m || typeof m !== 'object') throw new Error('not an object: ' + JSON.stringify(m));
    `);

    expect(fs.readdirSync(testDir).filter((e) => e.includes('.tmp-'))).toEqual([]);
  });

  it('leaves no temp files when write succeeds', () => {
    runManifestScript(testDir, `
      const { writeManifest } = await import(${JSON.stringify(manifestPath)});
      writeManifest(${JSON.stringify(testDir)}, { agents: { claude: '1.0.0' } });
    `);
    expect(fs.readdirSync(testDir).filter((e) => e.includes('.tmp-'))).toEqual([]);
    const raw = fs.readFileSync(path.join(testDir, 'agents.yaml'), 'utf-8');
    expect(raw).toContain('claude');
  });
});

describe('writeManifest comment preservation (RUSH-2090)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-comments-'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function run(script: string): string {
    return execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: testDir },
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  }

  it('keeps document + inline comments when mcp add mutates the manifest', () => {
    const yamlPath = path.join(testDir, 'agents.yaml');
    fs.writeFileSync(
      yamlPath,
      [
        '# keep this hand-written comment',
        'agents:',
        '  claude: 2.1.0  # pin note',
        'mcp: {}',
        'defaults:',
        '  method: symlink  # prefer symlinks',
        '',
      ].join('\n'),
      'utf-8',
    );

    const out = run(`
      import * as fs from 'fs';
      const { readManifest, writeManifest } = await import(${JSON.stringify(manifestPath)});
      const dir = ${JSON.stringify(testDir)};
      const manifest = readManifest(dir) || {};
      manifest.mcp = manifest.mcp || {};
      manifest.mcp.demo = {
        command: 'demo-server',
        transport: 'stdio',
        scope: 'user',
        agents: ['claude'],
      };
      writeManifest(dir, manifest);
      const after = fs.readFileSync(dir + '/agents.yaml', 'utf8');
      console.log(JSON.stringify({
        headerComment: after.includes('keep this hand-written comment'),
        inlinePinComment: after.includes('# pin note'),
        defaultsComment: after.includes('# prefer symlinks'),
        demoAdded: after.includes('demo') && after.includes('demo-server'),
        claudePin: after.includes('claude: 2.1.0'),
      }));
    `);

    const r = JSON.parse(out);
    expect(r.headerComment).toBe(true);
    expect(r.inlinePinComment).toBe(true);
    expect(r.defaultsComment).toBe(true);
    expect(r.demoAdded).toBe(true);
    expect(r.claudePin).toBe(true);
  });

  it('returns byte-identical content when nothing in the manifest changed', () => {
    const yamlPath = path.join(testDir, 'agents.yaml');
    const before = [
      '# do not clobber me',
      'agents:',
      '  claude: 2.1.0  # pin',
      'mcp: {}',
      '',
    ].join('\n');
    fs.writeFileSync(yamlPath, before, 'utf-8');

    const out = run(`
      import * as fs from 'fs';
      const { readManifest, writeManifest } = await import(${JSON.stringify(manifestPath)});
      const dir = ${JSON.stringify(testDir)};
      const before = fs.readFileSync(dir + '/agents.yaml', 'utf8');
      writeManifest(dir, readManifest(dir));
      const after = fs.readFileSync(dir + '/agents.yaml', 'utf8');
      console.log(JSON.stringify({ byteIdentical: before === after }));
    `);

    expect(JSON.parse(out).byteIdentical).toBe(true);
  });

  it('falls back to plain stringify for a brand-new manifest file', () => {
    const out = run(`
      import * as fs from 'fs';
      const { writeManifest, readManifest } = await import(${JSON.stringify(manifestPath)});
      const dir = ${JSON.stringify(testDir)};
      writeManifest(dir, { agents: { claude: '1.0.0' }, mcp: {} });
      const raw = fs.readFileSync(dir + '/agents.yaml', 'utf8');
      const parsed = readManifest(dir);
      console.log(JSON.stringify({
        hasClaude: raw.includes('claude'),
        parsedClaude: parsed?.agents?.claude ?? null,
      }));
    `);

    const r = JSON.parse(out);
    expect(r.hasClaude).toBe(true);
    expect(r.parsedClaude).toBe('1.0.0');
  });
});
