import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addNativeAccount, readSlots, removeAccount } from '../account-registry.js';
import { getGlobalDefault, getVersionHomePath, listInstalledVersions } from '../installations/store.js';
import { getHistoryDir, readMeta, updateMeta } from '../state.js';
import { ensureSlot, projectAccountSlots, recordSlot, slotDir } from './slots.js';

beforeAll(() => {
  const tracker = path.resolve(__dirname, '../../../../packages/session-tracker');
  execFileSync('bun', ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: tracker, stdio: 'pipe' });
  execFileSync('bun', ['run', 'build'], { cwd: tracker, stdio: 'pipe' });
  fs.copyFileSync(path.join(tracker, 'src/hook.sh'), path.join(tracker, 'dist/hook.sh'));
  fs.chmodSync(path.join(tracker, 'dist/hook.sh'), 0o755);
}, 60_000);

describe('slotDir', () => {
  it('is ~/.agents/.history/accounts/<harness>/<accountId>/', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    expect(slotDir('claude', id)).toBe(path.join(getHistoryDir(), 'accounts', 'claude', id));
  });

  it('refuses a path-shaped account id', () => {
    expect(() => slotDir('claude', '../escape')).toThrow(/Invalid account id/);
    expect(() => slotDir('claude', 'a/b')).toThrow(/Invalid account id/);
  });
});

describe('ensureSlot', () => {
  const id = `slot-test-${Date.now()}`;
  afterEach(() => {
    fs.rmSync(slotDir('claude', id), { recursive: true, force: true });
  });

  it('creates a HOME-shaped dir and does not copy credentials', () => {
    const slot = ensureSlot('claude', id);
    expect(slot.accountId).toBe(id);
    expect(slot.slotDir).toBe(slotDir('claude', id));
    expect(slot.authMode).toBe('native');
    expect(slot.verdict).toBe('unconfigured');
    expect(fs.existsSync(path.join(slot.slotDir, '.claude'))).toBe(true);

    const cred = path.join(slot.slotDir, '.claude', '.credentials.json');
    const oauth = path.join(slot.slotDir, '.claude.json');
    expect(fs.existsSync(cred)).toBe(false);
    if (fs.existsSync(oauth)) {
      const parsed = JSON.parse(fs.readFileSync(oauth, 'utf8')) as { oauthAccount?: unknown };
      expect(parsed.oauthAccount).toBeUndefined();
    }

    const version = getGlobalDefault('claude') ?? listInstalledVersions('claude')[0];
    if (version) {
      const fromHome = getVersionHomePath('claude', version);
      const srcSettings = path.join(fromHome, '.claude', 'settings.json');
      const destSettings = path.join(slot.slotDir, '.claude', 'settings.json');
      if (fs.existsSync(srcSettings)) {
        expect(fs.existsSync(destSettings)).toBe(true);
      }
      const srcCred = path.join(fromHome, '.claude', '.credentials.json');
      if (fs.existsSync(srcCred)) {
        expect(fs.existsSync(cred)).toBe(false);
      }
    }
  });

  it('is idempotent: a second call does not throw', () => {
    ensureSlot('claude', id);
    expect(() => ensureSlot('claude', id)).not.toThrow();
  });
});

describe('recordSlot / readSlots device-doc round-trip', () => {
  const prevMid = process.env.AGENTS_SYNC_MACHINE_ID;
  const clear = () => updateMeta((m) => ({
    ...m,
    accounts: { ...m.accounts, native: {} },
    deviceAccounts: undefined,
  }));
  beforeEach(() => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'slotbox';
    clear();
  });
  afterEach(() => {
    clear();
    if (prevMid === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = prevMid;
  });

  it('persists slots in the device doc, never central, and round-trips', () => {
    const created = addNativeAccount('work', 'claude', 'claude:user=slot-1', 'work@example.com', 'version');
    const slot = ensureSlot('claude', created.id);
    recordSlot(created.id, slot);

    const read = readSlots(readMeta());
    expect(read[created.id]).toMatchObject({
      accountId: created.id,
      slotDir: slot.slotDir,
      authMode: 'native',
      verdict: 'unconfigured',
    });

    expect(readMeta().accounts).not.toHaveProperty('slots');
    expect(JSON.stringify(readMeta().accounts?.native?.[created.id] ?? {})).not.toContain('slotDir');

    removeAccount('work');
    expect(readSlots(readMeta())[created.id]).toBeUndefined();
    fs.rmSync(slot.slotDir, { recursive: true, force: true });
  });

  it('refuses a recordSlot key that does not match the slot', () => {
    expect(() => recordSlot('aaa', {
      accountId: 'bbb',
      slotDir: '/tmp/no',
      authMode: 'native',
      verdict: 'unconfigured',
    })).toThrow(/mismatch/);
  });
});

describe('projectAccountSlots (PHNX-3940: slots follow the version home)', () => {
  const prevMid = process.env.AGENTS_SYNC_MACHINE_ID;
  const VERSION = '9.9.9';
  const versionHome = () => getVersionHomePath('claude', VERSION);
  const clear = () => updateMeta((m) => ({
    ...m,
    accounts: { ...m.accounts, native: {} },
    deviceAccounts: undefined,
    agents: { ...m.agents, claude: undefined },
  }));
  // A managed Claude install the sandboxed HOME can call its default: the
  // package.json + bin file listInstalledVersions checks, and a version home
  // carrying one skill (`alpha`) as the projection source.
  const seedManagedClaude = () => {
    const versionDir = path.dirname(versionHome());
    const pkgDir = path.join(versionDir, 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: VERSION, bin: { claude: 'bin/claude' } }));
    fs.writeFileSync(path.join(pkgDir, 'bin', 'claude'), '#!/bin/sh\n');
    fs.chmodSync(path.join(pkgDir, 'bin', 'claude'), 0o755);
    // The rules writer composes the `default` preset from the active layers;
    // the sandboxed HOME has no system layer, so the user layer declares it.
    const rulesDir = path.join(os.homedir(), '.agents', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'rules.yaml'), 'presets:\n  default:\n    subrules: []\n');
    fs.mkdirSync(path.join(versionHome(), '.claude', 'skills', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(versionHome(), '.claude', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\n');
    updateMeta((m) => ({ ...m, agents: { ...m.agents, claude: VERSION } }));
  };
  beforeEach(() => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'slotbox';
    clear();
    seedManagedClaude();
  });
  afterEach(() => {
    clear();
    fs.rmSync(path.dirname(versionHome()), { recursive: true, force: true });
    if (prevMid === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = prevMid;
  });

  it('re-projects every claude slot from the default version home and prunes a skill the source no longer has', () => {
    expect(getGlobalDefault('claude')).toBe(VERSION);
    const created = addNativeAccount('work', 'claude', 'claude:user=slot-2', 'work@example.com', 'version');
    // Deliberately NOT recorded: a slot dir with no device-doc record (an add
    // that stopped before recordSlot, or an older build) is still projected.
    const slot = ensureSlot('claude', created.id);
    expect(readSlots(readMeta())[created.id]).toBeUndefined();
    try {
      const skillsDir = path.join(slot.slotDir, '.claude', 'skills');
      fs.mkdirSync(path.join(skillsDir, 'zz-stale-skill'), { recursive: true });
      fs.writeFileSync(path.join(skillsDir, 'zz-stale-skill', 'SKILL.md'), '---\nname: zz-stale-skill\n---\n');

      const projected = projectAccountSlots('claude');
      const mine = projected.find((p) => p.accountId === created.id);
      expect(mine).toBeDefined();
      expect(mine!.name).toBe('work');
      expect(mine!.slotDir).toBe(slot.slotDir);
      expect(mine!.from).toBe(VERSION);
      expect(mine!.pruned).toEqual(['skills/zz-stale-skill']);
      expect(fs.existsSync(path.join(skillsDir, 'zz-stale-skill'))).toBe(false);
      expect(fs.existsSync(path.join(slot.slotDir, '.claude', '.credentials.json'))).toBe(false);

      // Idempotent: a second pass has nothing left to prune.
      expect(projectAccountSlots('claude').find((p) => p.accountId === created.id)?.pruned).toEqual([]);
    } finally {
      removeAccount('work');
      fs.rmSync(slot.slotDir, { recursive: true, force: true });
    }
  });

  it('skips a slot whose directory is gone, and never touches a slot through another harness', () => {
    const created = addNativeAccount('gone', 'claude', 'claude:user=slot-3', 'gone@example.com', 'version');
    const slot = ensureSlot('claude', created.id);
    recordSlot(created.id, slot);
    try {
      expect(projectAccountSlots('codex').some((p) => p.accountId === created.id)).toBe(false);
      fs.rmSync(slot.slotDir, { recursive: true, force: true });
      expect(projectAccountSlots('claude').some((p) => p.accountId === created.id)).toBe(false);
    } finally {
      removeAccount('gone');
    }
  });

  it('registers the tracker in new Codex slots and replaces stale registrations during sync', () => {
    const fromHome = getVersionHomePath('codex', VERSION);
    const previousDefault = readMeta().agents?.codex;
    fs.mkdirSync(path.join(fromHome, '.codex'), { recursive: true });
    updateMeta((m) => ({ ...m, agents: { ...m.agents, codex: VERSION } }));
    const created = addNativeAccount('tracker', 'codex', 'codex:account=slot-tracker', 'tracker@example.com', VERSION);
    const slot = ensureSlot('codex', created.id);
    recordSlot(created.id, slot);
    const hooksFile = path.join(slot.slotDir, '.codex', 'hooks.json');
    const sessionId = randomUUID();
    const sidecar = path.join(getHistoryDir(), 'by-session', `${sessionId}.json`);
    const commands = (): string[] => JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks.SessionStart
      .flatMap((group: { hooks: { command: string }[] }) => group.hooks.map((hook) => hook.command));
    try {
      expect(commands().filter((command) => command.includes('session-tracker'))).toHaveLength(1);
      const old = '/obsolete/session-tracker/dist/hook.sh codex';
      const unrelated = 'echo unrelated-user-hook';
      fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { SessionStart: [{ matcher: '', hooks: [
        { type: 'command', command: old }, { type: 'command', command: unrelated },
      ] }] } }));
      const credentials = path.join(slot.slotDir, '.codex', 'auth.json');
      const credentialBytes = '{"fixture":"account-local credential sentinel"}\n';
      fs.writeFileSync(credentials, credentialBytes);
      for (let pass = 0; pass < 2; pass++) {
        projectAccountSlots('codex');
        const registered = commands();
        expect(registered).not.toContain(old);
        expect(registered).toContain(unrelated);
        expect(registered.filter((command) => command.includes('session-tracker'))).toHaveLength(1);
        expect(fs.readFileSync(credentials, 'utf8')).toBe(credentialBytes);
      }
      const command = commands().find((value) => value.includes('session-tracker'))!;
      execFileSync('sh', ['-c', command], {
        cwd: slot.slotDir,
        input: JSON.stringify({ session_id: sessionId, cwd: slot.slotDir }),
        env: { ...process.env, HOME: slot.slotDir, AGENTS_HISTORY_DIR: getHistoryDir(), AGENTS_RUN_ACCOUNT_ID: created.id },
      });
      expect(JSON.parse(fs.readFileSync(sidecar, 'utf8')).accountId).toBe(created.id);
    } finally {
      fs.rmSync(sidecar, { force: true });
      removeAccount('tracker');
      fs.rmSync(slot.slotDir, { recursive: true, force: true });
      fs.rmSync(fromHome, { recursive: true, force: true });
      updateMeta((m) => ({ ...m, agents: { ...m.agents, codex: previousDefault } }));
    }
  });
});
