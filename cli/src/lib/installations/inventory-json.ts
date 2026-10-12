import { accountListJson, loadAccountCatalog, secretsUnavailableNote } from '../account-catalog.js';
import { collectRunCandidates, isLaunchableSignedIn, readinessFromCandidate } from '../accounting/rotate.js';
import { deriveUsageStatusFromSnapshot, getUsageInfoByIdentity, getUsageLookupKey, usageErrorForDisplay } from '../accounting/usage.js';
import { ALL_AGENT_IDS, type AccountInfo, credentialPresence, getAccountInfo, getAllCliStates } from '../agents.js';
import { authCacheKey, readAuthHealthCache } from '../auth-health.js';
import { getGitSyncStatus, isGitRepo } from '../git.js';
import { machineId } from '../machine-id.js';
import { resolveConfiguredModel } from '../models.js';
import { discoverPlugins, pluginSupportsAgent } from '../plugins/plugins.js';
import { type ProfileSummary, listProfiles, profileSummary } from '../profiles.js';
import { getAgentResources } from '../resources.js';
import { getCentralRulesFileName } from '../rules/rules.js';
import { compareVersionLabels } from './duplicate-prune.js';
import { getUserAgentsDir } from '../state.js';
import type { AgentId } from '../types.js';
import type { ResourceItemJson, ResourceSection, SyncState, VersionResourcesJson, ViewJsonAgent, ViewJsonRunReady, ViewJsonVersion } from '../view-types.js';
import { readInstallation } from './store.js';
import { getGlobalDefault, getIsolatedDefault, getLiveVersion, getVersionDir, getVersionHomePath, isGlobalBinaryAgent, isVersionIsolated, listInstalledVersions } from './versions.js';
import chalk from 'chalk';

export function getHarnesses(): ProfileSummary[] {
  return listProfiles().map(profileSummary);
}

export type ResourceSyncType = 'commands' | 'skills' | 'hooks' | 'memory';

interface ResourceSyncData {
  hasGitRepo: boolean;
  commands: Awaited<ReturnType<typeof getGitSyncStatus>>;
  skills: Awaited<ReturnType<typeof getGitSyncStatus>>;
  hooks: Awaited<ReturnType<typeof getGitSyncStatus>>;
  memory: Awaited<ReturnType<typeof getGitSyncStatus>>;
}

export async function loadResourceSyncData(): Promise<ResourceSyncData> {
  const userAgentsDir = getUserAgentsDir();
  const hasGitRepo = isGitRepo(userAgentsDir);
  return {
    hasGitRepo,
    commands: hasGitRepo ? await getGitSyncStatus(userAgentsDir, 'commands') : null,
    skills: hasGitRepo ? await getGitSyncStatus(userAgentsDir, 'skills') : null,
    hooks: hasGitRepo ? await getGitSyncStatus(userAgentsDir, 'hooks') : null,
    memory: hasGitRepo ? await getGitSyncStatus(userAgentsDir, 'rules') : null,
  };
}

export function resolveResourceSyncState(
  agentId: AgentId,
  resourceName: string,
  resourceType: ResourceSyncType,
  syncStatus: Awaited<ReturnType<typeof getGitSyncStatus>>,
): SyncState | undefined {
  if (!syncStatus) return undefined;

  let relativePath: string;
  if (resourceType === 'commands') {
    relativePath = `commands/${resourceName}.md`;
  } else if (resourceType === 'skills') {
    relativePath = `skills/${resourceName}`;
  } else if (resourceType === 'hooks') {
    relativePath = `hooks/${resourceName}`;
  } else {
    const centralName = getCentralRulesFileName(agentId);
    relativePath = `rules/${centralName}`;
  }

  const matchesPath = (f: string) => f === relativePath || f.startsWith(relativePath + '/');

  if (syncStatus.new.some(matchesPath) || syncStatus.staged.some(matchesPath)) return 'new';
  if (syncStatus.modified.some(matchesPath)) return 'modified';
  if (syncStatus.deleted.some(matchesPath)) return 'deleted';
  if (syncStatus.synced.some(matchesPath)) return 'synced';
  return 'new';
}

function collectVersionResources(
  agentId: AgentId,
  home: string,
  cwd: string,
  cliInstalled: boolean,
  sections: Set<ResourceSection>,
  sync: ResourceSyncData,
): VersionResourcesJson {
  const res = getAgentResources(agentId, { cwd, scope: 'all', cliInstalled, home });
  const out: VersionResourcesJson = {};

  const withSync = (
    r: { name: string; scope: 'user' | 'project'; description?: string },
    type: ResourceSyncType,
    syncStatus: Awaited<ReturnType<typeof getGitSyncStatus>>,
  ): ResourceItemJson => {
    const item: ResourceItemJson = { name: r.name, scope: r.scope };
    if (r.scope !== 'project') {
      const s = resolveResourceSyncState(agentId, r.name, type, syncStatus);
      if (s) item.syncState = s;
    }
    if (r.description) item.description = r.description;
    return item;
  };

  if (sections.has('commands')) out.commands = res.commands.map((r) => withSync(r, 'commands', sync.commands));
  if (sections.has('skills')) {
    out.skills = res.skills.map((r) => {
      const item = withSync(r, 'skills', sync.skills);
      if (r.ruleCount && r.ruleCount > 0) item.ruleCount = r.ruleCount;
      return item;
    });
  }
  if (sections.has('mcp')) {
    out.mcp = res.mcp.map((r) => {
      const item: ResourceItemJson = { name: r.name, scope: r.scope };
      if (r.scope !== 'project') item.syncState = 'synced';
      return item;
    });
  }
  if (sections.has('memory')) out.memory = res.memory.map((r) => withSync(r, 'memory', sync.memory));
  if (sections.has('hooks')) out.hooks = res.hooks.map((r) => withSync(r, 'hooks', sync.hooks));
  if (sections.has('workflows')) out.workflows = res.workflows.map((r) => ({ name: r.name, scope: r.scope }));
  if (sections.has('plugins')) {
    out.plugins = discoverPlugins()
      .filter((p) => pluginSupportsAgent(p, agentId))
      .map((p) => ({ name: p.name }));
  }
  return out;
}

export async function computeAgentRunReady(agentId: AgentId): Promise<ViewJsonRunReady | undefined> {
  const candidates = await collectRunCandidates(agentId);
  if (candidates.length === 0) return undefined;
  const accounts = candidates.map((c) => {
    const readiness = readinessFromCandidate(c);
    const name = c.nativeAccount || c.accountLabel || c.email || c.version;
    return { name, ready: readiness.ready, reason: readiness.ready ? 'ready' : readiness.reason };
  });
  const readyAccount = accounts.find((a) => a.ready);
  let reason: string;
  if (readyAccount) {
    reason = `ready (${readyAccount.name})`;
  } else {
    const reasons = [...new Set(accounts.map((a) => a.reason))];
    reason = reasons.length === 1 ? `all ${reasons[0]}` : reasons.join(', ');
  }
  return { ready: !!readyAccount, reason, accounts };
}

export async function collectAgentsJson(
  filterAgentId?: AgentId,
  resourceSections?: Set<ResourceSection>,
  opts?: { forceRefresh?: boolean },
): Promise<ViewJsonAgent[]> {
  const agentsToShow = filterAgentId ? [filterAgentId] : ALL_AGENT_IDS;
  const authCache = readAuthHealthCache();
  const host = machineId();
  const wantResources = !!resourceSections && resourceSections.size > 0;
  const resourceSync = wantResources ? await loadResourceSyncData() : null;
  const cliStates = wantResources ? await getAllCliStates() : null;
  const infoFetches: Promise<{ agentId: AgentId; version: string; home: string; info: AccountInfo }>[] = [];
  for (const agentId of agentsToShow) {
    for (const ver of listInstalledVersions(agentId)) {
      const home = getVersionHomePath(agentId, ver);
      infoFetches.push(
        getAccountInfo(agentId, home).then((info) => ({ agentId, version: ver, home, info }))
      );
    }
  }
  const infoResults = await Promise.all(infoFetches);

  const globalReleases = new Map<AgentId, string>();
  await Promise.all(agentsToShow.filter(isGlobalBinaryAgent).map(async (agent) => {
    if (!infoResults.some((row) => row.agentId === agent)) return;
    const release = await getLiveVersion(agent);
    if (release) globalReleases.set(agent, release);
  }));
  const actualRelease = (agent: AgentId, label: string): string =>
    globalReleases.get(agent) ?? readInstallation(agent, label)?.releaseVersion ?? label;

  const { canonicalByUsageKey, usageByKey } = await getUsageInfoByIdentity(
    infoResults.map(({ agentId, home, version, info }) => ({
      agentId,
      home,
      cliVersion: version,
      info,
    })),
    { forceRefresh: opts?.forceRefresh === true },
  );

  const mergeCanonical = (info: AccountInfo): AccountInfo => {
    const key = getUsageLookupKey(info);
    if (!key) return info;
    const canon = canonicalByUsageKey.get(key);
    if (!canon) return info;
    return {
      ...info,
      plan: usageByKey.get(key)?.snapshot?.plan ?? canon.plan,
      usageStatus: deriveUsageStatusFromSnapshot(usageByKey.get(key)?.snapshot),
      overageCredits: canon.overageCredits,
    };
  };

  const byAgent = new Map<AgentId, ViewJsonVersion[]>();
  for (const { agentId, version, home, info: rawInfo } of infoResults) {
    const info = mergeCanonical(rawInfo);
    const globalDefault = getGlobalDefault(agentId);
    const usageKey = getUsageLookupKey(info);
    const usageInfo = usageKey ? usageByKey.get(usageKey) : undefined;
    const snapshot = usageInfo?.snapshot ?? null;

    const authHealth = authCache[authCacheKey(host, agentId, version)];
    const entry: ViewJsonVersion = {
      version,
      releaseVersion: actualRelease(agentId, version),
      isDefault: version === globalDefault,
      isolated: isVersionIsolated(agentId, version),
      isIsolatedDefault: getIsolatedDefault(agentId) === version,
      signedIn: info.signedIn,
      launchable: isLaunchableSignedIn(info.signedIn, credentialPresence(agentId, home)),
      authVerdict: authHealth?.verdict ?? null,
      authCheckedAt: authHealth?.checkedAt ?? null,
      email: info.email,
      accountId: info.accountId,
      organizationType: info.organizationType ?? null,
      organizationName: info.organizationName ?? null,
      plan: info.plan,
      usageStatus: info.usageStatus,
      usageCapturedAt: snapshot?.capturedAt?.toISOString() ?? null,
      overageCredits: info.overageCredits,
      usageError: usageErrorForDisplay(usageInfo?.error),
      windows: snapshot
        ? snapshot.windows.map((w) => ({
            key: w.key,
            label: w.label,
            usedPercent: w.usedPercent,
            resetsAt: w.resetsAt ? w.resetsAt.toISOString() : null,
          }))
        : [],
      unavailable: snapshot?.unavailable
        ? {
            reason: snapshot.unavailable.reason,
            resetsAt: snapshot.unavailable.resetsAt?.toISOString(),
          }
        : undefined,
      lastActive: info.lastActive ? info.lastActive.toISOString() : null,
      path: getVersionDir(agentId, version),
      configuredModel: resolveConfiguredModel(agentId, version),
    };

    if (wantResources && resourceSync) {
      entry.resources = collectVersionResources(
        agentId,
        home,
        process.cwd(),
        cliStates?.[agentId]?.installed ?? false,
        resourceSections!,
        resourceSync,
      );
    }

    const existing = byAgent.get(agentId);
    if (existing) existing.push(entry);
    else byAgent.set(agentId, [entry]);
  }

  const harnesses = filterAgentId ? [] : getHarnesses();
  const catalog = await loadAccountCatalog();
  const note = secretsUnavailableNote(catalog);
  if (note) console.error(chalk.yellow(note));
  const runReadyByAgent = new Map<AgentId, ViewJsonRunReady>();
  await Promise.all(
    agentsToShow.map(async (agentId) => {
      const runReady = await computeAgentRunReady(agentId);
      if (runReady) runReadyByAgent.set(agentId, runReady);
    }),
  );

  const out: ViewJsonAgent[] = [];
  for (const agentId of agentsToShow) {
    const versions = byAgent.get(agentId) ?? [];
    versions.sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return compareVersionLabels(b.version, a.version);
    });
    const accounts = accountListJson(
      catalog.native.filter((row) => row.agent === agentId),
      catalog.provider.filter((row) => row.harnesses.includes(agentId)),
      agentId,
    ).accounts;
    out.push({
      agent: agentId,
      versions,
      accounts,
      runReady: runReadyByAgent.get(agentId),
      harnesses: harnesses.filter((h) => h.agent === agentId),
    });
  }
  return out;
}
