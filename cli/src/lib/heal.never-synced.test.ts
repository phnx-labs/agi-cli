import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { heal } from './heal.js';
import { getVersionHomePath, syncResourcesToVersion } from './installations/versions.js';
import { getUserAgentsDir } from './state.js';

describe('heal leaves a never-synced version to its first sync', () => {
  it('heals nothing before the first sync and the missing hook after it', async () => {
    const hookDir = path.join(getUserAgentsDir(), 'hooks', 'pre-tool-use');
    fs.mkdirSync(hookDir, { recursive: true });
    const hookName = `first-sync-${Date.now()}`;
    const hookFile = path.join(hookDir, `${hookName}.sh`);
    fs.writeFileSync(hookFile, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const version = `0.0.0-first-sync-${Date.now()}`;
    fs.mkdirSync(path.join(getVersionHomePath('claude', version), '.claude'), { recursive: true });
    const healedHooks = async () => (await heal({ mode: 'safe', agent: 'claude', versions: [version], dryRun: true }))
      .versions.flatMap((v) => v.healed).filter((h) => h.kind === 'hooks').map((h) => h.name);
    try {
      expect(await healedHooks()).toEqual([]);

      syncResourcesToVersion('claude', version, { skills: [] });
      expect((await healedHooks()).some((name) => name.includes(hookName))).toBe(true);
    } finally {
      fs.rmSync(hookFile, { force: true });
    }
  });
});
