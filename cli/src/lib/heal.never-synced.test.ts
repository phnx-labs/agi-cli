import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { heal } from './heal.js';
import { getVersionHomePath, syncResourcesToVersion } from './installations/versions.js';
import { getUserAgentsDir, setActiveRulesPreset } from './state.js';
import { buildManifest, saveManifest } from './staleness/index.js';

describe('heal leaves a never-synced version to its first sync', () => {
  let hookName = '';
  let hookFile = '';
  let version = '';

  beforeEach(() => {
    const hookDir = path.join(getUserAgentsDir(), 'hooks', 'pre-tool-use');
    fs.mkdirSync(hookDir, { recursive: true });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    hookName = `first-sync-${stamp}`;
    hookFile = path.join(hookDir, `${hookName}.sh`);
    fs.writeFileSync(hookFile, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    version = `0.0.0-first-sync-${stamp}`;
    fs.mkdirSync(path.join(getVersionHomePath('claude', version), '.claude'), { recursive: true });
  });
  afterEach(() => fs.rmSync(hookFile, { force: true }));

  const healOnce = async () => (await heal({ mode: 'safe', agent: 'claude', versions: [version], dryRun: true })).versions[0];
  const healsHook = async () => (await healOnce()).healed.some((h) => h.kind === 'hooks' && h.name.includes(hookName));

  it('reports a fresh version as pending and heals nothing, then heals the missing hook after the first sync', async () => {
    expect(await healOnce()).toMatchObject({ healed: [], firstSyncPending: true });

    syncResourcesToVersion('claude', version, { skills: [] });
    expect((await healOnce()).firstSyncPending).toBeUndefined();
    expect(await healsHook()).toBe(true);
  });

  it('does not count a rules preset alone as a first sync', async () => {
    setActiveRulesPreset('claude', version, 'default');
    expect(await healOnce()).toMatchObject({ healed: [], firstSyncPending: true });
  });

  it('heals a version synced before patterns were recorded, which has only a sync manifest', async () => {
    saveManifest('claude', version, buildManifest('claude', version, process.cwd()));
    expect(await healsHook()).toBe(true);
  });
});
