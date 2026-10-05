import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';


let testHome: string;
let userDir: string;
let cmdsHome: string;
let srcCmds: string;

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-sync-test-'));
  userDir = path.join(testHome, '.agents');
  const versionDir = path.join(userDir, '.history', 'versions', 'claude', '2.0.0');
  cmdsHome = path.join(versionDir, 'home', '.claude', 'commands');
  srcCmds = path.join(userDir, 'commands');
  fs.mkdirSync(cmdsHome, { recursive: true });
  fs.mkdirSync(srcCmds, { recursive: true });
  fs.mkdirSync(path.join(userDir, '.system'), { recursive: true });
  const binDir = path.join(versionDir, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'agents:\n  claude: "2.0.0"\n');
});

afterEach(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

function runYesApply(): { result: string; drifted: string; missingPresent: boolean; missing: string } {
  const modulePath = path.resolve(process.cwd(), 'src/lib/drift-sync.ts');
  const script = `
    import { promptDriftSync } from ${JSON.stringify(modulePath)};
    const r = await promptDriftSync({ cwd: ${JSON.stringify(userDir)}, yes: true, quiet: true });
    console.error(JSON.stringify({ healedVersions: r.healed.length }));
  `;
  execFileSync('bun', ['-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: testHome },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return {
    result: '',
    drifted: fs.readFileSync(path.join(cmdsHome, 'drifted.md'), 'utf-8'),
    missingPresent: fs.existsSync(path.join(cmdsHome, 'missing.md')),
    missing: fs.existsSync(path.join(cmdsHome, 'missing.md'))
      ? fs.readFileSync(path.join(cmdsHome, 'missing.md'), 'utf-8')
      : '',
  };
}

describe('promptDriftSync --yes — apply path', () => {
  it('overwrites a drifted resource with its source and installs a missing one', () => {
    fs.writeFileSync(path.join(srcCmds, 'drifted.md'), 'ALPHA v2 (source of truth)\n');
    fs.writeFileSync(path.join(srcCmds, 'missing.md'), 'GAMMA (new)\n');
    fs.writeFileSync(path.join(cmdsHome, 'drifted.md'), 'ALPHA v1 (stale)\n');

    const after = runYesApply();

    expect(after.drifted.trim()).toBe('ALPHA v2 (source of truth)');
    expect(after.missingPresent).toBe(true);
    expect(after.missing.trim()).toBe('GAMMA (new)');
  });
});

describe('promptDriftSync --yes — routes through the shared repair pass (BLOCKER 1)', () => {
  it('repairs a broken managed hook runtime shim while reconciling a drifted version', () => {
    fs.writeFileSync(path.join(srcCmds, 'drifted.md'), 'ALPHA v2 (source of truth)\n');
    fs.writeFileSync(path.join(cmdsHome, 'drifted.md'), 'ALPHA v1 (stale)\n');
    const systemDir = path.join(userDir, '.system');
    fs.writeFileSync(
      path.join(systemDir, 'agents.yaml'),
      'hooks:\n  runtime-guard:\n    script: runtime-guard.sh\n    events: [PreToolUse]\n    matcher: Bash\n',
    );
    const hooksDir = path.join(cmdsHome, '..', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'runtime-guard.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const modulePath = path.resolve(process.cwd(), 'src/lib/drift-sync.ts');
    const hooksPath = path.resolve(process.cwd(), 'src/lib/hooks/install.ts');
    const probe = path.join(testHome, 'probe.json');
    const script = `
      const fs = await import('node:fs');
      const { promptDriftSync } = await import(${JSON.stringify(modulePath)});
      const hooks = await import(${JSON.stringify(hooksPath)});
      const before = hooks.inspectBrokenManagedHookRuntimeArtifacts({ agent: 'claude', version: '2.0.0' });
      const r = await promptDriftSync({ cwd: ${JSON.stringify(userDir)}, yes: true, quiet: true });
      const after = hooks.inspectBrokenManagedHookRuntimeArtifacts({ agent: 'claude', version: '2.0.0' });
      fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({
        healed: r.healed.length,
        beforeReasons: before.map((b) => b.reason),
        afterBrokenCount: after.length,
      }));
    `;
    execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: testHome,
        AGENTS_HOOK_SHIMS_DIR: path.join(testHome, 'hook-shims'),
        AGENTS_HOOK_CACHE_DIR: path.join(testHome, 'hook-cache'),
        AGENTS_LOGS_DIR: path.join(testHome, 'logs'),
        AGENTS_PERF_DIR: path.join(testHome, 'perf'),
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const out = JSON.parse(fs.readFileSync(probe, 'utf-8')) as {
      healed: number; beforeReasons: string[]; afterBrokenCount: number;
    };

    expect(fs.readFileSync(path.join(cmdsHome, 'drifted.md'), 'utf-8').trim())
      .toBe('ALPHA v2 (source of truth)');
    expect(out.beforeReasons).toContain('missing');
    expect(out.afterBrokenCount).toBe(0);
  });
});
