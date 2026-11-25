import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { diffVersionResources } from './doctor-diff.js';
import { getVersionHomePath, reopenDeclinedOptIn } from './installations/versions.js';
import { getUserAgentsDir, setVersionResourcePatterns } from './state.js';

describe('diffVersionResources honours a declined opt-in', () => {
  it('reports a declined hook as neither missing nor drifted, so heal installs nothing', () => {
    const hookDir = path.join(getUserAgentsDir(), 'hooks', 'pre-tool-use');
    fs.mkdirSync(hookDir, { recursive: true });
    const hookName = `declined-guard-${Date.now()}`;
    const hookFile = path.join(hookDir, `${hookName}.sh`);
    fs.writeFileSync(hookFile, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const version = `0.0.0-heal-${Date.now()}`;
    fs.mkdirSync(path.join(getVersionHomePath('claude', version), '.claude'), { recursive: true });
    const missingHooks = () => diffVersionResources('claude', version, { kinds: ['hooks'] })
      .kinds.hooks.filter((row) => row.status === 'missing').map((row) => row.name);
    try {
      expect(missingHooks().some((name) => name.includes(hookName))).toBe(true);

      setVersionResourcePatterns('claude', version, { hooks: ['!system:*', '!user:*'] });
      expect(missingHooks().some((name) => name.includes(hookName))).toBe(false);

      reopenDeclinedOptIn('claude', version, 'hooks', [hookName]);
      expect(missingHooks().some((name) => name.includes(hookName))).toBe(true);
    } finally {
      fs.rmSync(hookFile, { force: true });
    }
  });

  it('reports a declined permission group as not missing until it is added back', () => {
    const groupDir = path.join(getUserAgentsDir(), 'permissions', 'groups');
    fs.mkdirSync(groupDir, { recursive: true });
    const group = `declined-net-${Date.now()}`;
    const groupFile = path.join(groupDir, `${group}.yaml`);
    fs.writeFileSync(groupFile, 'allow:\n  - "Bash(curl:*)"\n');
    const version = `0.0.0-perm-${Date.now()}`;
    fs.mkdirSync(path.join(getVersionHomePath('claude', version), '.claude'), { recursive: true });
    const missing = () => diffVersionResources('claude', version, { kinds: ['permissions'] })
      .kinds.permissions.filter((row) => row.status === 'missing').map((row) => row.name);
    try {
      expect(missing()).toContain(group);
      setVersionResourcePatterns('claude', version, { permissions: ['system:*', `!user:${group}`] });
      expect(missing()).not.toContain(group);
      reopenDeclinedOptIn('claude', version, 'permissions', [group]);
      expect(missing()).toContain(group);
    } finally {
      fs.rmSync(groupFile, { force: true });
    }
  });
});
