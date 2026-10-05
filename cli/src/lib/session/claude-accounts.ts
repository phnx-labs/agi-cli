import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { readClaudeHomeConfig } from '../agents.js';
import { getAgentsDir, getHistoryDir } from '../state.js';

const HOME = os.homedir();
const VERSIONS_ROOTS = [getHistoryDir(), getAgentsDir()];

export interface ClaudeAccountBucket {
  key: string;
  attributed: boolean;
  email: string | null;
  orgName: string | null;
  plan: string | null;
  label: string;
  evidence: 'version-home' | 'recorded-version' | 'symlink-target' | 'none';
}

interface HomeEntry {
  prefix: string;
  bucket: ClaudeAccountBucket;
}

export interface ClaudeAccountIndex {
  entries: HomeEntry[];
  darkHomes: Array<{ prefix: string; version: string | null }>;
  byVersion: Map<string, ClaudeAccountBucket | 'ambiguous'>;
  byAccountId: Map<string, ClaudeAccountBucket>;
  symlinkBucket: ClaudeAccountBucket | null;
  symlinkPrefix: string;
}

function planFromOrgType(orgType: string | null): string | null {
  if (!orgType) return null;
  const m = /^claude_(.+)$/.exec(orgType);
  if (!m) return orgType;
  return m[1].charAt(0).toUpperCase() + m[1].slice(1);
}

function bucketForHome(
  home: string,
  evidence: ClaudeAccountBucket['evidence'],
): ClaudeAccountBucket | null {
  const cfg = readClaudeHomeConfig(home);
  if (!cfg) return null;
  const { email, organizationName: orgName, usageKey, accountKey, organizationType } = cfg.identity;
  const key = usageKey ?? accountKey ?? (email ? `claude:email=${email}` : null);
  if (!key) return null;
  return {
    key,
    attributed: true,
    email,
    orgName,
    plan: planFromOrgType(organizationType),
    label: orgName && email ? `${orgName} <${email}>` : (orgName ?? email ?? key),
    evidence,
  };
}

function unattributed(reason: string): ClaudeAccountBucket {
  return {
    key: `unattributed:${reason}`,
    attributed: false,
    email: null,
    orgName: null,
    plan: null,
    label: `unattributed (${reason})`,
    evidence: 'none',
  };
}

function listDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function buildClaudeAccountIndex(): ClaudeAccountIndex {
  const entries: HomeEntry[] = [];
  const darkHomes: Array<{ prefix: string; version: string | null }> = [];
  const liveByVersion = new Map<string, ClaudeAccountBucket>();
  const trashByVersion = new Map<string, ClaudeAccountBucket[]>();
  const byAccountId = new Map<string, ClaudeAccountBucket>();

  const addHome = (home: string, version: string | null, retired: boolean): void => {
    const bucket = bucketForHome(home, 'version-home');
    if (!bucket) {
      if (fs.existsSync(path.join(home, '.claude'))) {
        darkHomes.push({ prefix: path.join(home, '.claude'), version });
      }
      return;
    }
    entries.push({ prefix: path.join(home, '.claude'), bucket });
    if (!version) return;
    if (retired) {
      const list = trashByVersion.get(version) ?? [];
      list.push(bucket);
      trashByVersion.set(version, list);
    } else {
      liveByVersion.set(version, bucket);
    }
  };

  for (const root of VERSIONS_ROOTS) {
    const versionsBase = path.join(root, 'versions', 'claude');
    for (const version of listDirs(versionsBase)) {
      addHome(path.join(versionsBase, version, 'home'), version, false);
    }
  }

  const trashBase = path.join(getHistoryDir(), 'trash', 'versions', 'claude');
  for (const version of listDirs(trashBase)) {
    for (const stamp of listDirs(path.join(trashBase, version))) {
      addHome(path.join(trashBase, version, stamp, 'home'), version, true);
    }
  }

  const accountsBase = path.join(getHistoryDir(), 'accounts', 'claude');
  for (const accountId of listDirs(accountsBase)) {
    const home = path.join(accountsBase, accountId);
    const bucket = bucketForHome(home, 'version-home');
    if (!bucket) continue;
    entries.push({ prefix: path.join(home, '.claude'), bucket });
    byAccountId.set(accountId, bucket);
  }

  const byVersion = new Map<string, ClaudeAccountBucket | 'ambiguous'>();
  for (const [version, list] of trashByVersion) {
    const keys = new Set(list.map((b) => b.key));
    byVersion.set(
      version,
      keys.size === 1 ? { ...list[0], evidence: 'recorded-version' } : 'ambiguous',
    );
  }
  for (const [version, bucket] of liveByVersion) {
    byVersion.set(version, { ...bucket, evidence: 'recorded-version' });
  }

  entries.sort((a, b) => b.prefix.length - a.prefix.length);

  darkHomes.sort((a, b) => b.prefix.length - a.prefix.length);

  return {
    entries,
    darkHomes,
    byVersion,
    byAccountId,
    symlinkBucket: bucketForHome(HOME, 'symlink-target'),
    symlinkPrefix: path.join(HOME, '.claude'),
  };
}

function versionFromPath(filePath: string): string | null {
  const m = /[/\\]versions[/\\]claude[/\\]([^/\\]+)[/\\]/.exec(filePath);
  return m ? m[1] : null;
}

export function resolveClaudeAccount(
  index: ClaudeAccountIndex,
  filePath: string,
  recordedVersion?: string | null,
  launchAccountId?: string | null,
): ClaudeAccountBucket {
  if (launchAccountId) {
    return index.byAccountId.get(launchAccountId) ?? unattributed(`recorded account ${launchAccountId}`);
  }

  for (const entry of index.entries) {
    if (filePath.startsWith(entry.prefix + path.sep)) return entry.bucket;
  }

  for (const dark of index.darkHomes) {
    if (filePath.startsWith(dark.prefix + path.sep)) {
      return unattributed(dark.version ? `signed-out home ${dark.version}` : 'signed-out home');
    }
  }


  if (recordedVersion) {
    const byVersion = index.byVersion.get(recordedVersion);
    if (byVersion === 'ambiguous') {
      return unattributed(`ambiguous history for version ${recordedVersion}`);
    }
    if (byVersion) return byVersion;
    return unattributed(`no home for version ${recordedVersion}`);
  }

  if (filePath.startsWith(index.symlinkPrefix + path.sep) && index.symlinkBucket) {
    return index.symlinkBucket;
  }

  const version = versionFromPath(filePath);
  if (version) return unattributed(`signed-out home ${version}`);
  if (filePath.includes(`${path.sep}backups${path.sep}claude${path.sep}`)) {
    return unattributed('backup mirror');
  }
  return unattributed('unknown home');
}
