import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';


describe.skipIf(process.platform === 'win32')('shim AGENTS_BIN drift + orphan prune', () => {
  let home: string;
  let shimsDir: string;
  let liveBin: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-drift-'));
    shimsDir = path.join(home, '.agents', '.cache', 'shims');
    fs.mkdirSync(shimsDir, { recursive: true });
    liveBin = path.join(home, 'live-index.js');
    fs.writeFileSync(liveBin, '// live install\n');

    const deadBin = '/nonexistent/removed-install/dist/index.js';
    write('browser', `#!/bin/sh\nAGENTS_BIN='${deadBin}'\nexec "$AGENTS_BIN" browser "$@"\n`);
    write('sessions', `#!/bin/sh\nAGENTS_BIN='${liveBin}'\nexec "$AGENTS_BIN" sessions "$@"\n`);
    write('secrets', `#!/bin/sh\nAGENTS_BIN='${liveBin}'\nexec "$AGENTS_BIN" secrets "$@"\n`);
    write('myalias', `#!/bin/sh\n# Alias shim: myalias\nexec agents whatever "$@"\n`);
    write('claude', `#!/bin/bash\n# agents-shim-version: 25\nAGENTS_BIN='${deadBin}'\nexec "$AGENTS_BIN"\n`);
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  function write(name: string, body: string) {
    const p = path.join(shimsDir, name);
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
  }

  function run(): Record<string, unknown> {
    const modulePath = path.resolve(process.cwd(), 'src/lib/installations/shims.ts');
    const script = `
      import { pruneOrphanedCommandShim, shimPointsAtLiveInstall, listShimFileNames } from ${JSON.stringify(modulePath)};
      console.log(JSON.stringify({
        files: listShimFileNames().sort(),
        prunedBrowser: pruneOrphanedCommandShim('browser'),
        prunedSessions: pruneOrphanedCommandShim('sessions'),
        prunedSecrets: pruneOrphanedCommandShim('secrets'),
        prunedAlias: pruneOrphanedCommandShim('myalias'),
        prunedClaude: pruneOrphanedCommandShim('claude'),
        claudePointsLive: shimPointsAtLiveInstall('claude'),
      }));
    `;
    const out = execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString('utf-8');
    return JSON.parse(out);
  }

  it('prunes dead-target orphan command shims and the always-recursive secrets shim; spares live, alias, and agent shims', () => {
    const r = run() as {
      files: string[]; prunedBrowser: boolean; prunedSessions: boolean; prunedSecrets: boolean;
      prunedAlias: boolean; prunedClaude: boolean; claudePointsLive: boolean;
    };

    expect(r.files).toEqual(['browser', 'claude', 'myalias', 'secrets', 'sessions']);
    expect(r.prunedBrowser).toBe(true);
    expect(r.prunedSessions).toBe(true);
    expect(r.prunedSecrets).toBe(true);
    expect(r.prunedAlias).toBe(false);
    expect(r.prunedClaude).toBe(false);
    expect(r.claudePointsLive).toBe(false);

    expect(fs.existsSync(path.join(shimsDir, 'browser'))).toBe(false);
    expect(fs.existsSync(path.join(shimsDir, 'secrets'))).toBe(false);
    expect(fs.existsSync(path.join(shimsDir, 'sessions'))).toBe(false);
    expect(fs.existsSync(path.join(shimsDir, 'myalias'))).toBe(true);
    expect(fs.existsSync(path.join(shimsDir, 'claude'))).toBe(true);
  });
});
