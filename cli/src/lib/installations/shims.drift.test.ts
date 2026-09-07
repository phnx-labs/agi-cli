import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// AGENTS_BIN drift + orphan-prune helpers read from getShimsDir() (resolved from
// process.env.HOME at module-eval), so they run in a subprocess against a planted
// temp HOME — the established doctor-diff.test.ts pattern. Real fs, no mocks.

// POSIX-only: the fixtures are `#!/bin/sh` shims with `AGENTS_BIN='...'`. On Windows
// shims are `.cmd` files with different naming + AGENTS_BIN syntax, so these bash-shaped
// fixtures don't apply (the helpers there are effectively no-ops on Windows .cmd shims).
describe.skipIf(process.platform === 'win32')('shim AGENTS_BIN drift + orphan prune', () => {
  let home: string;
  let shimsDir: string;
  let liveBin: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-drift-'));
    shimsDir = path.join(home, '.agents', '.cache', 'shims');
    fs.mkdirSync(shimsDir, { recursive: true });
    // A real file to serve as a "live" AGENTS_BIN target.
    liveBin = path.join(home, 'live-index.js');
    fs.writeFileSync(liveBin, '// live install\n');

    const deadBin = '/nonexistent/removed-install/dist/index.js';
    // Legacy command shim, dead target -> should prune.
    write('browser', `#!/bin/sh\nAGENTS_BIN='${deadBin}'\nexec "$AGENTS_BIN" browser "$@"\n`);
    // Legacy command shim, LIVE target -> should NOT prune.
    write('sessions', `#!/bin/sh\nAGENTS_BIN='${liveBin}'\nexec "$AGENTS_BIN" sessions "$@"\n`);
    // Legacy `secrets` shim, LIVE target -> pruned anyway: `agents secrets` is a
    // passthrough to the standalone binary since PHNX-3989, so this shim can only
    // recurse into itself, and it shadows the real `secrets` on PATH.
    write('secrets', `#!/bin/sh\nAGENTS_BIN='${liveBin}'\nexec "$AGENTS_BIN" secrets "$@"\n`);
    // A user alias shim, dead-ish -> protected, should NOT prune.
    write('myalias', `#!/bin/sh\n# Alias shim: myalias\nexec agents whatever "$@"\n`);
    // An AGENT shim (claude), dead target -> not pruned (agent command), but drift-detected.
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
    expect(r.prunedBrowser).toBe(true);    // dead target -> removed
    expect(r.prunedSessions).toBe(false);  // live target -> spared
    expect(r.prunedSecrets).toBe(true);    // live target, but re-enters `agents secrets` -> removed (PHNX-3989)
    expect(r.prunedAlias).toBe(false);     // user alias -> spared
    expect(r.prunedClaude).toBe(false);    // agent command -> never pruned here
    expect(r.claudePointsLive).toBe(false); // agent shim baked at a different, removed install -> drift

    // browser + secrets actually gone from disk; the spared ones remain.
    expect(fs.existsSync(path.join(shimsDir, 'browser'))).toBe(false);
    expect(fs.existsSync(path.join(shimsDir, 'secrets'))).toBe(false);
    expect(fs.existsSync(path.join(shimsDir, 'sessions'))).toBe(true);
    expect(fs.existsSync(path.join(shimsDir, 'myalias'))).toBe(true);
    expect(fs.existsSync(path.join(shimsDir, 'claude'))).toBe(true);
  });
});
