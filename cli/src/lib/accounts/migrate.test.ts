/**
 * Real-filesystem tests for folding N per-account installations into 1 install
 * + N slots (PHNX-3940 T7). Uses the fork-private HOME from tests/setup.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  applyAccountMigration,
  formatMigrationPlan,
  planAccountMigration,
  type AccountMigrationPlan,
} from './migrate.js';
import {
  createInstallation,
  getGlobalDefault,
  getVersionDir,
  invalidateInstalledVersionsCache,
  listInstalledVersions,
  setGlobalDefault,
} from '../installations/versions.js';
import { getAccountInfo } from '../agents.js';
import { getDB } from '../session/db.js';
import { readSlots, slotDir } from './slots.js';
import { addNativeAccount, bindAccount, listNativeAccounts, removeAccount, unbindAccount } from '../account-registry.js';
import { getHistoryDir, getVersionsDir, readMeta, updateMeta } from '../state.js';
import { restoreVersion } from '../../commands/trash.js';

const suffix = `t7${Date.now().toString(36)}`;
const labels = {
  emptyDefault: `0.1.0-${suffix}`,
  empty2: `0.2.0-${suffix}`,
  empty3: `0.3.0-${suffix}`,
  gmailOld: `0.4.0-${suffix}`,
  icloud: `0.5.0-${suffix}`,
  gmailNew: `0.6.0-${suffix}`,
} as const;
const gmail = `gmail-${suffix}@example.com`;
const icloud = `icloud-${suffix}@example.com`;
const allLabels = Object.values(labels);
const plantedAccounts: string[] = [];
const extraCleanupLabels: string[] = [];
const sessionId = `t7-sess-${suffix}`;

function plantInstall(label: string, release: string, login?: { email: string }): string {
  const dir = getVersionDir('claude', label);
  const pkgRoot = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(path.join(pkgRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({
    name: '@anthropic-ai/claude-code',
    version: release,
    bin: { claude: 'bin/claude-launcher' },
  }));
  fs.writeFileSync(path.join(pkgRoot, 'bin', 'claude-launcher'), 'REAL BINARY');
  const homeDir = path.join(dir, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  if (login) {
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({
      oauthAccount: {
        emailAddress: login.email,
        accountUuid: `acct-${login.email}`,
        organizationUuid: `org-${login.email}`,
        organizationType: 'claude_pro',
      },
    }));
    fs.writeFileSync(
      path.join(homeDir, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 86_400_000 } }),
    );
  }
  createInstallation('claude', label, release);
  return dir;
}

function treeSnapshot(root: string): string {
  const rows: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        rows.push(`${rel}/`);
        walk(full);
      } else if (entry.name.endsWith('.db') || entry.name.endsWith('-wal') || entry.name.endsWith('-shm') || entry.name === 'last-active.json') {
        rows.push(`${rel}:present`);
      } else {
        const buf = fs.readFileSync(full);
        rows.push(`${rel}:${buf.length}:${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}`);
      }
    }
  };
  walk(root);
  return rows.join('\n');
}

function listTrashLabels(): string[] {
  const root = path.join(getHistoryDir(), 'trash', 'versions', 'claude');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((n) => allLabels.includes(n as typeof allLabels[number])).sort();
}

function fixtureFleet(): { sessionFile: string; prevDefault: string | null } {
  const prevDefault = getGlobalDefault('claude');
  plantInstall(labels.emptyDefault, '0.1.0');
  plantInstall(labels.empty2, '0.2.0');
  plantInstall(labels.empty3, '0.3.0');
  plantInstall(labels.gmailOld, '0.4.0', { email: gmail });
  plantInstall(labels.icloud, '0.5.0', { email: icloud });
  plantInstall(labels.gmailNew, '0.6.0', { email: gmail });
  invalidateInstalledVersionsCache('claude');
  setGlobalDefault('claude', labels.emptyDefault);

  const sessionFile = path.join(
    getVersionDir('claude', labels.icloud),
    'home',
    '.claude',
    'projects',
    '-Users-t7-proj',
    `${suffix}.jsonl`,
  );
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, `${JSON.stringify({ type: 'user', message: { content: 'hello from t7' } })}\n`);
  const db = getDB();
  db.prepare(`
    INSERT INTO sessions (id, short_id, agent, timestamp, last_activity, file_path, is_team_origin)
    VALUES (?, ?, 'claude', ?, ?, ?, 0)
  `).run(sessionId, sessionId.slice(0, 8), new Date().toISOString(), new Date().toISOString(), sessionFile);
  return { sessionFile, prevDefault };
}

function dropClaudeBindings(): void {
  const meta = readMeta();
  const bindings = { ...meta.accounts?.bindings, ...meta.deviceAccounts?.bindings };
  for (const [target, id] of Object.entries(bindings)) {
    if (target === 'claude' || target.startsWith('claude@')) {
      try { unbindAccount(id, target, 'claude'); } catch { /* already gone */ }
    }
  }
}

async function registerHomeAccount(label: string, name: string, email: string) {
  const info = await getAccountInfo('claude', path.join(getVersionDir('claude', label), 'home'));
  if (!info.accountKey) throw new Error(`expected accountKey for claude@${label}`);
  const existing = listNativeAccounts(readMeta()).find((a) => a.agent === 'claude' && a.identityKey === info.accountKey);
  if (existing) {
    plantedAccounts.push(existing.name);
    return existing;
  }
  const row = addNativeAccount(name, 'claude', info.accountKey, email, 'version');
  plantedAccounts.push(row.name);
  return row;
}

function cleanup(prevDefault: string | null): void {
  try {
    getDB().prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
  } catch { /* db may not exist */ }
  dropClaudeBindings();
  for (const name of plantedAccounts.splice(0)) {
    try { removeAccount(`claude#${name}`); } catch { /* already gone */ }
  }
  for (const row of listNativeAccounts(readMeta()).filter((a) => a.identityLabel === gmail || a.identityLabel === icloud)) {
    try { removeAccount(`claude#${row.name}`); } catch { /* already gone */ }
  }
  for (const label of [...allLabels, ...extraCleanupLabels.splice(0)]) {
    const dir = getVersionDir('claude', label);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    const trash = path.join(getHistoryDir(), 'trash', 'versions', 'claude', label);
    if (fs.existsSync(trash)) fs.rmSync(trash, { recursive: true, force: true });
  }
  const accountsDir = path.join(getHistoryDir(), 'accounts', 'claude');
  if (fs.existsSync(accountsDir)) {
    for (const id of fs.readdirSync(accountsDir)) {
      const p = path.join(accountsDir, id);
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  const manifests = path.join(getHistoryDir(), 'accounts');
  if (fs.existsSync(manifests)) {
    for (const f of fs.readdirSync(manifests)) {
      if (f.startsWith('migration-') && f.endsWith('.json')) fs.rmSync(path.join(manifests, f), { force: true });
    }
  }
  if (prevDefault) setGlobalDefault('claude', prevDefault);
  else setGlobalDefault('claude', undefined);
  invalidateInstalledVersionsCache('claude');
}

describe('accounts migrate (PHNX-3940 T7)', () => {
  let prevDefault: string | null = null;

  afterEach(() => {
    cleanup(prevDefault);
    prevDefault = null;
  });

  it('--dry-run leaves install bytes untouched and reports 1 install + 2 slots + 4 trash', async () => {
    prevDefault = fixtureFleet().prevDefault;
    const versionsRoot = path.join(getVersionsDir(), 'claude');
    const before = treeSnapshot(versionsRoot);
    const plan = await planAccountMigration(['claude'], { isActive: async () => false });
    const ours = plan.harnesses[0]!;
    expect(ours.inventory.filter((i) => allLabels.includes(i.label as typeof allLabels[number]))).toHaveLength(6);
    expect(ours.actions.filter((a) => a.kind === 'slot')).toHaveLength(2);
    expect(ours.actions.filter((a) => a.kind === 'trash')).toHaveLength(4);
    expect(ours.canonical).toBe(labels.gmailNew);
    expect(treeSnapshot(versionsRoot)).toBe(before);
    expect(getGlobalDefault('claude')).toBe(labels.emptyDefault);
    expect(fs.readdirSync(versionsRoot).filter((n) => allLabels.includes(n as typeof allLabels[number])).sort()).toEqual([...allLabels].sort());
  });

  it('apply folds 6 installs into 1 install + 2 slots + 4 trashed, repoints default, reindexes sessions, writes a manifest', async () => {
    const fx = fixtureFleet();
    prevDefault = fx.prevDefault;
    const result = await applyAccountMigration(['claude'], { isActive: async () => false });
    const ours = result.plan.harnesses[0]!;
    expect(ours.actions.filter((a) => a.kind === 'slot')).toHaveLength(2);
    expect(ours.actions.filter((a) => a.kind === 'trash')).toHaveLength(4);
    expect(ours.canonical).toBe(labels.gmailNew);
    expect(getGlobalDefault('claude')).toBe(labels.gmailNew);
    expect(listInstalledVersions('claude').filter((v) => allLabels.includes(v as typeof allLabels[number]))).toEqual([labels.gmailNew]);

    const slots = Object.values(readSlots(readMeta()));
    const oursSlots = slots.filter((s) => fs.existsSync(path.join(s.slotDir, '.claude.json')));
    expect(oursSlots.length).toBeGreaterThanOrEqual(2);
    for (const slot of oursSlots) {
      expect(fs.existsSync(path.join(slot.slotDir, '.claude', '.credentials.json'))).toBe(true);
      expect(fs.existsSync(path.join(slot.slotDir, 'node_modules'))).toBe(false);
    }

    const natives = listNativeAccounts(readMeta()).filter((a) => a.agent === 'claude' && (a.identityLabel === gmail || a.identityLabel === icloud));
    expect(natives).toHaveLength(2);
    plantedAccounts.push(...natives.map((a) => a.name));

    const liveHome = path.join(getVersionDir('claude', labels.gmailNew), 'home');
    expect(fs.existsSync(path.join(liveHome, '.claude.json'))).toBe(false);

    const row = getDB().prepare(`SELECT file_path FROM sessions WHERE id = ?`).get(sessionId) as { file_path: string };
    expect(row.file_path).not.toBe(fx.sessionFile);
    expect(row.file_path.includes(`${path.sep}accounts${path.sep}claude${path.sep}`)).toBe(true);
    expect(fs.existsSync(row.file_path)).toBe(true);
    expect(result.sessionsReindexed).toBeGreaterThanOrEqual(1);

    expect(fs.existsSync(result.manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8')) as {
      dryRun: boolean;
      schema: number;
      status: string;
      plan: { totals: { slots: number } };
    };
    expect(manifest.dryRun).toBe(false);
    expect(manifest.schema).toBe(1);
    expect(manifest.status).toBe('complete');
    expect(manifest.plan.totals.slots).toBe(2);
    expect(listTrashLabels()).toEqual(expect.arrayContaining([labels.emptyDefault, labels.empty2, labels.empty3, labels.gmailOld]));
  });

  it('counts a busy canonical as the kept install and says it is busy', async () => {
    prevDefault = fixtureFleet().prevDefault;
    const plan = await planAccountMigration(['claude'], {
      isActive: async (inst) => inst.label === labels.gmailNew,
    });
    const ours = plan.harnesses[0]!;
    expect(ours.canonical).toBe(labels.gmailNew);
    expect(ours.counts.keep).toBe(1);
    expect(ours.actions.some((a) => a.kind === 'defer' && a.label === labels.gmailNew)).toBe(true);
    const text = formatMigrationPlan(plan);
    expect(text).toContain('1 install');
    expect(text).not.toMatch(/→ 0 install/);
    expect(text).toContain(`canonical claude@${labels.gmailNew} busy`);
  });

  it('formatMigrationPlan names a deferred canonical as the kept busy install', () => {
    const plan: AccountMigrationPlan = {
      at: '2026-09-06T00:00:00.000Z',
      totals: { installations: 10, keep: 1, slots: 7, trash: 1, deferred: 2, skipped: 0 },
      harnesses: [{
        agent: 'claude',
        canonical: '2.1.260',
        defaultBefore: '2.1.260',
        inventory: [],
        counts: { installations: 10, keep: 1, slots: 7, trash: 1, deferred: 2, skipped: 0 },
        actions: [
          {
            kind: 'defer',
            label: '2.1.260',
            release: '2.1.260',
            reason: 'installation is busy (live process or launch lease)',
            sessionCount: 0,
            pathMoves: [],
          },
          {
            kind: 'defer',
            label: '2.1.219',
            release: '2.1.219',
            reason: 'installation is busy (live process or launch lease)',
            sessionCount: 0,
            pathMoves: [],
          },
        ],
      }],
    };
    const text = formatMigrationPlan(plan);
    expect(text).toBe(
      'claude: 10 installations → 1 install + 7 slots + 1 trashed + 2 deferred (canonical claude@2.1.260 busy)\n'
      + '  defer     claude@2.1.260  installation is busy (live process or launch lease)\n'
      + '  defer     claude@2.1.219  installation is busy (live process or launch lease)\n'
      + 'totals: 10 installations → 1 install + 7 slots + 1 trashed + 2 deferred',
    );
  });

  it('a busy home is deferred and never moved', async () => {
    prevDefault = fixtureFleet().prevDefault;
    const result = await applyAccountMigration(['claude'], {
      isActive: async (inst) => inst.label === labels.icloud,
    });
    const ours = result.plan.harnesses[0]!;
    expect(ours.actions.some((a) => a.kind === 'defer' && a.label === labels.icloud)).toBe(true);
    expect(fs.existsSync(getVersionDir('claude', labels.icloud))).toBe(true);
    expect(fs.existsSync(path.join(getVersionDir('claude', labels.icloud), 'home', '.claude.json'))).toBe(true);
    const live = listInstalledVersions('claude').filter((v) => allLabels.includes(v as typeof allLabels[number])).sort();
    expect(live).toEqual([labels.icloud, labels.gmailNew].sort());
  });

  it('agents trash restore reverses one trashed home', async () => {
    prevDefault = fixtureFleet().prevDefault;
    await applyAccountMigration(['claude'], { isActive: async () => false });
    expect(fs.existsSync(getVersionDir('claude', labels.emptyDefault))).toBe(false);
    expect(listTrashLabels()).toContain(labels.emptyDefault);
    restoreVersion(`claude@${labels.emptyDefault}`);
    expect(fs.existsSync(getVersionDir('claude', labels.emptyDefault))).toBe(true);
    expect(fs.existsSync(path.join(getVersionDir('claude', labels.emptyDefault), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude-launcher'))).toBe(true);
  });

  it('fails loud on an unreadable installation.json', async () => {
    const label = `0.9.0-${suffix}-bad`;
    plantInstall(label, '0.9.0');
    fs.writeFileSync(path.join(getVersionDir('claude', label), 'installation.json'), '{not-json');
    invalidateInstalledVersionsCache('claude');
    await expect(planAccountMigration(['claude'], { isActive: async () => false }))
      .rejects.toThrow(/Unreadable installation\.json for claude@0\.9\.0/);
    fs.rmSync(getVersionDir('claude', label), { recursive: true, force: true });
  });

  it('trashes a stale home whose account already holds a provisioned slot instead of aborting', async () => {
    prevDefault = fixtureFleet().prevDefault;
    await applyAccountMigration(['claude'], { isActive: async () => false });
    const natives = listNativeAccounts(readMeta()).filter((a) => a.identityLabel === gmail || a.identityLabel === icloud);
    plantedAccounts.push(...natives.map((a) => a.name));
    const gmailAcct = natives.find((a) => a.identityLabel === gmail)!;
    const slotBefore = fs.readdirSync(slotDir('claude', gmailAcct.id));
    expect(slotBefore.length).toBeGreaterThan(0);
    // Canonical is the newest signed-in install, so plant a newer icloud home
    // to hold that role: it also already has a slot, which exercises the
    // canonical branch (binary kept, home left in place) while the older gmail
    // home below takes the trash branch.
    const pinnedDefault = `9.9.9-${suffix}-def`;
    extraCleanupLabels.push(pinnedDefault);
    plantInstall(pinnedDefault, '9.9.9', { email: icloud });
    setGlobalDefault('claude', pinnedDefault);
    const extra = `0.7.0-${suffix}`;
    plantInstall(extra, '0.7.0', { email: gmail });
    invalidateInstalledVersionsCache('claude');
    bindAccount(gmailAcct.id, `claude@${extra}`, 'claude');

    const plan = await planAccountMigration(['claude'], { isActive: async () => false });
    const action = plan.harnesses.find((h) => h.agent === 'claude')?.actions.find((a) => a.label === extra);
    expect(action?.kind).toBe('trash');
    expect(action?.reason).toMatch(/already holds a provisioned slot/);
    expect(action?.accountId).toBe(gmailAcct.id);
    const canonicalAction = plan.harnesses.find((h) => h.agent === 'claude')?.actions.find((a) => a.label === pinnedDefault);
    expect(canonicalAction?.kind).toBe('canonical');
    expect(canonicalAction?.reason).toMatch(/already holds a slot/);

    const result = await applyAccountMigration(['claude'], { isActive: async () => false });
    expect(result.manifest.status).toBe('complete');
    expect(fs.existsSync(getVersionDir('claude', extra))).toBe(false);
    expect(fs.existsSync(path.join(getHistoryDir(), 'trash', 'versions', 'claude', extra))).toBe(true);
    expect(result.manifest.harnesses.claude?.trashed.find((t) => t.label === extra)?.reason).toMatch(/already holds a provisioned slot/);
    // The slot the account already owned is untouched, and the binding that
    // named the trashed version now names the account.
    expect(fs.readdirSync(slotDir('claude', gmailAcct.id))).toEqual(slotBefore);
    const bindings = { ...readMeta().accounts?.bindings, ...readMeta().deviceAccounts?.bindings };
    expect(bindings[`claude@${extra}`]).toBe(gmailAcct.id);
    // The canonical home stayed where it was.
    expect(fs.existsSync(path.join(getVersionDir('claude', pinnedDefault), 'home', '.claude.json'))).toBe(true);
    unbindAccount(gmailAcct.id, `claude@${extra}`, 'claude');
  });

  it('still fails loud when the slot path is occupied by something that is not a slot directory', async () => {
    prevDefault = fixtureFleet().prevDefault;
    await applyAccountMigration(['claude'], { isActive: async () => false });
    const natives = listNativeAccounts(readMeta()).filter((a) => a.identityLabel === gmail || a.identityLabel === icloud);
    plantedAccounts.push(...natives.map((a) => a.name));
    const gmailAcct = natives.find((a) => a.identityLabel === gmail)!;
    const dest = slotDir('claude', gmailAcct.id);
    const keep = path.join(path.dirname(dest), `${path.basename(dest)}.keep-${suffix}`);
    fs.renameSync(dest, keep);
    fs.writeFileSync(dest, 'not a directory');
    const extra = `0.7.0-${suffix}`;
    plantInstall(extra, '0.7.0', { email: gmail });
    invalidateInstalledVersionsCache('claude');
    try {
      await expect(applyAccountMigration(['claude'], { isActive: async () => false }))
        .rejects.toThrow(/Slot already exists/);
    } finally {
      fs.rmSync(dest, { force: true });
      fs.renameSync(keep, dest);
      fs.rmSync(getVersionDir('claude', extra), { recursive: true, force: true });
    }
  });

  it('writes the manifest before the first move and records only completed identities after a mid-loop failure', async () => {
    const labelA = `0.1.0-${suffix}-crash-a`;
    const labelB = `0.2.0-${suffix}-crash-b`;
    extraCleanupLabels.push(labelA, labelB);
    const emailA = `crash-a-${suffix}@example.com`;
    const emailB = `crash-b-${suffix}@example.com`;
    prevDefault = getGlobalDefault('claude');
    plantInstall(labelA, '0.1.0', { email: emailA });
    plantInstall(labelB, '0.2.0', { email: emailB });
    invalidateInstalledVersionsCache('claude');
    const acctA = await registerHomeAccount(labelA, `crash-a-${suffix}`, emailA);
    const acctB = await registerHomeAccount(labelB, `crash-b-${suffix}`, emailB);
    // A regular file at the slot path is not a provisioned slot, so the plan
    // still routes B to `slot` and the apply-time guard is what fails.
    const destB = slotDir('claude', acctB.id);
    fs.mkdirSync(path.dirname(destB), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destB, 'preexisting');

    await expect(applyAccountMigration(['claude'], { isActive: async () => false }))
      .rejects.toThrow(/Slot already exists/);

    const manifests = path.join(getHistoryDir(), 'accounts');
    const files = fs.readdirSync(manifests).filter((f) => f.startsWith('migration-') && f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const manifest = JSON.parse(fs.readFileSync(path.join(manifests, files[0]!), 'utf8')) as {
      status: string;
      plan: unknown;
      harnesses: { claude?: { slots: Array<{ oldLabel: string; accountId: string }>; trashed: Array<{ label: string }> } };
      map: Record<string, string>;
    };
    expect(manifest.status).toBe('planned');
    expect(manifest.plan).toBeTruthy();
    const oursSlots = (manifest.harnesses.claude?.slots ?? []).filter((s) => s.oldLabel === labelA || s.oldLabel === labelB);
    expect(oursSlots).toEqual([
      expect.objectContaining({ oldLabel: labelA, accountId: acctA.id }),
    ]);
    expect(oursSlots.some((s) => s.oldLabel === labelB || s.accountId === acctB.id)).toBe(false);
    expect(manifest.map[`claude@${labelA}`]).toBeTruthy();
    expect(manifest.map[`claude@${labelB}`]).toBeUndefined();
    expect(fs.existsSync(path.join(getVersionDir('claude', labelA), 'home', '.claude.json'))).toBe(false);
    expect(fs.existsSync(path.join(getVersionDir('claude', labelB), 'home', '.claude.json'))).toBe(true);
  });

  it('redirects a binding on a duplicate-trashed home to the kept identity account', async () => {
    prevDefault = fixtureFleet().prevDefault;
    const gmailAcct = await registerHomeAccount(labels.gmailNew, `t7-gmail-${suffix}`, gmail);
    bindAccount(gmailAcct.id, `claude@${labels.gmailOld}`, 'claude');
    await applyAccountMigration(['claude'], { isActive: async () => false });
    const bindings = { ...readMeta().accounts?.bindings, ...readMeta().deviceAccounts?.bindings };
    expect(bindings[`claude@${labels.gmailOld}`]).toBe(gmailAcct.id);
    expect(bindings.claude).toBeUndefined();
  });

  it('rewrites two agent@label bindings to their respective account ids, never one bare-agent binding', async () => {
    prevDefault = fixtureFleet().prevDefault;
    const gmailAcct = await registerHomeAccount(labels.gmailNew, `t7-gmail-${suffix}`, gmail);
    const icloudAcct = await registerHomeAccount(labels.icloud, `t7-icloud-${suffix}`, icloud);
    bindAccount(gmailAcct.id, `claude@${labels.gmailNew}`, 'claude');
    bindAccount(icloudAcct.id, `claude@${labels.icloud}`, 'claude');
    await applyAccountMigration(['claude'], { isActive: async () => false });
    const bindings = { ...readMeta().accounts?.bindings, ...readMeta().deviceAccounts?.bindings };
    expect(bindings[`claude@${labels.gmailNew}`]).toBe(gmailAcct.id);
    expect(bindings[`claude@${labels.icloud}`]).toBe(icloudAcct.id);
    expect(bindings.claude).toBeUndefined();
    expect(new Set([bindings[`claude@${labels.gmailNew}`], bindings[`claude@${labels.icloud}`]]).size).toBe(2);
  });

  it('fails loud when a binding target was trashed with no kept same-identity account', async () => {
    prevDefault = fixtureFleet().prevDefault;
    const gmailAcct = await registerHomeAccount(labels.gmailNew, `t7-gmail-${suffix}`, gmail);
    bindAccount(gmailAcct.id, `claude@${labels.emptyDefault}`, 'claude');
    await expect(applyAccountMigration(['claude'], { isActive: async () => false }))
      .rejects.toThrow(/Cannot rewrite binding 'claude@.*': .* was removed and has no kept account/);
  });

  it('fails loud when a home identity does not match the account row it is mapped to', async () => {
    const label = `0.8.0-${suffix}-mismatch`;
    extraCleanupLabels.push(label);
    prevDefault = getGlobalDefault('claude');
    plantInstall(label, '0.8.0', { email: gmail });
    invalidateInstalledVersionsCache('claude');
    const row = addNativeAccount(`mismatch-${suffix}`, 'claude', 'claude:account=other:org=other', 'other@example.com', 'version');
    plantedAccounts.push(row.name);
    updateMeta((current) => ({
      ...current,
      deviceAccounts: {
        ...current.deviceAccounts,
        homes: { ...current.deviceAccounts?.homes, [row.id]: label },
      },
    }));
    await expect(planAccountMigration(['claude'], { isActive: async () => false }))
      .rejects.toThrow(/Identity mismatch for claude@.*: home is '.*' but account row '.*' is 'claude:account=other:org=other'/);
    await expect(applyAccountMigration(['claude'], { isActive: async () => false }))
      .rejects.toThrow(/Identity mismatch/);
  });
});
