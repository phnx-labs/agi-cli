/**
 * View command for inspecting installed agents, versions, accounts, and resources.
 *
 * Implements `agents view` -- shows installed agent CLIs with version info,
 * account emails, usage stats, and active status. When given an agent@version
 * argument, displays a detailed breakdown of commands, skills, MCP servers,
 * rules, hooks, and promptcuts synced to that version.
 */
import { Option } from 'commander';
import type { Command } from 'commander';
import { addHostOption } from '../lib/hosts/option.js';
import chalk from 'chalk';
import { termLink } from '../lib/format.js';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

import {
  AGENTS,
  ALL_AGENT_IDS,
  accountDisplayLabel,
  getAllCliStates,
  getUnmanagedCliState,
  getAccountInfo,
  credentialPresence,
  resolveAgentName,
  formatAgentError,
  agentLabel,
  colorAgent,
} from '../lib/agents.js';
import type { AccountInfo, CliState } from '../lib/agents.js';
import { ambientClaudeToken, loginHint } from '../lib/signin-badge.js';
import type { AgentId } from '../lib/types.js';
import { machineId } from '../lib/machine-id.js';
import { authCacheKey, readAuthHealthCache } from '../lib/auth-health.js';
import {
  deriveUsageStatusFromSnapshot,
  formatUsageSection,
  formatUsageSummary,
  formatUsageStatusBadge,
  getUsageInfoForIdentity,
  getUsageInfoByIdentity,
  getUsageLookupKey,
  usageErrorForDisplay,
  viewUsageSummaryOptions,
} from '../lib/accounting/usage.js';
import { OVERVIEW_MAX_USAGE_WINDOWS } from '../lib/account-catalog.js';
import { isHeadedDeviceRole, selfConfiguredDeviceRole, type ConfiguredDeviceRole } from '../lib/device-config.js';
import { readManifest } from '../lib/manifest.js';
import {
  listInstalledVersions,
  listInstalledVersionDirs,
  getGlobalDefault,
  setGlobalDefault,
  getVersionHomePath,
  getVersionDir,
  resolveVersion,
  removeVersion,
  printTrashFooter,
  reconcileStaleLatestForAgent,
  isGlobalBinaryAgent,
  getLiveVersion,
  isVersionIsolated,
  getIsolatedDefault,
} from '../lib/installations/versions.js';
import {
  getShimsDir,
  isShimsInPath,
  ensureVersionedAliasCurrent,
  removeShim,
} from '../lib/installations/shims.js';
import { getAgentResources, listResources } from '../lib/resources.js';
import { renderMergedResources } from '../lib/merged-resources.js';
import { resolveVersionFilter, AgentSpecError } from '../lib/agent-spec/index.js';
import { listCliStatus } from '../lib/cli-resources.js';
import { isCapable } from '../lib/capabilities.js';
import { discoverPlugins, pluginSupportsAgent } from '../lib/plugins/plugins.js';
import { getAgentsDir, getUserAgentsDir, getEffectivePromptcutsPath, readMergedPromptcuts, readMeta } from '../lib/state.js';
import { findNativeAccountByIdentity } from '../lib/account-registry.js';
import { accountListJson, loadAccountCatalog, renderAccountRows, secretsUnavailableNote, type NativeAccountCatalogRow } from '../lib/account-catalog.js';
import { addSupported } from '../lib/accounts/add.js';
import { readInstallation } from '../lib/installations/store.js';
import { isAutoUpdateEnabledForAgent } from '../lib/installations/update-policy.js';
import { selectUpdateStrategy } from '../lib/installations/strategies.js';
import { isGitRepo, getGitSyncStatus } from '../lib/git.js';
import { getCentralRulesFileName } from '../lib/rules/rules.js';
import { composeRulesFromState, type ComposedSubrule } from '../lib/rules/compose.js';
import { getConfiguredRunStrategy, isLaunchableSignedIn } from '../lib/accounting/rotate.js';
import { resolveRunDefaults } from '../lib/run-defaults.js';
import { resolveConfiguredModel, type ConfiguredModelSource } from '../lib/models.js';
import type { ResourceItemJson, ResourceSection, SyncState, VersionResourcesJson, ViewJsonAgent, ViewJsonVersion } from '../lib/view-types.js';
export type { ResourceItemJson, ResourceSection, SyncState, VersionResourcesJson, ViewJsonAgent, ViewJsonVersion } from '../lib/view-types.js';
import { listProfiles, profileExists, profileSummary, readProfile, type Profile, type ProfileSummary } from '../lib/profiles.js';
import { getByokUsageForHarness, hasByokProvider, renderByokBar, type ByokUsageResult } from '../lib/byok-usage.js';
import { renderHarnessDetail } from './harness.js';
import { confirm } from '@inquirer/prompts';
import { formatPath, isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { terminalWidth, truncateToWidth, stringWidth, padToWidth } from '../lib/session/width.js';

/** Shared account identity formatter, re-exported for the view-specific tests. */
export const accountColumnLabel = accountDisplayLabel;

/**
 * The account column with the durable native-account name folded in: when the
 * signed-in identity of `agentId` has been named via `agents accounts add`,
 * render `work · email` instead of the bare email. Falls back to the plain
 * display label when the identity is unnamed.
 */
export function namedAccountColumnLabel(agentId: AgentId, info: AccountInfo | undefined): string {
  const display = accountColumnLabel(info);
  const saved = findNativeAccountByIdentity(readMeta(), agentId, info);
  return saved ? `${saved.name} · ${display || saved.identityLabel || saved.identityKey}` : display;
}

/** Human account identity; release labels belong only in installation diagnostics. */
export function nativeAccountViewLabel(row: Pick<NativeAccountCatalogRow, 'name' | 'display'>): string {
  return row.name && row.name !== row.display ? `${row.name} · ${row.display}` : row.display;
}

export interface AccountOrderedVersion {
  version: string;
  email: string | null;
}

/**
 * Human `agents view` row order: selected default first, then email-bearing
 * accounts alphabetically, then installs whose account has no email. Version
 * descending is the deterministic tie-breaker and preserves the old order for
 * every non-email harness.
 */
export function compareAccountOrderedVersions(
  a: AccountOrderedVersion,
  b: AccountOrderedVersion,
  globalDefault: string | null,
): number {
  const aIsDefault = a.version === globalDefault;
  const bIsDefault = b.version === globalDefault;
  if (aIsDefault !== bIsDefault) return aIsDefault ? -1 : 1;

  const aEmail = a.email?.toLowerCase() ?? null;
  const bEmail = b.email?.toLowerCase() ?? null;
  if (aEmail !== null && bEmail === null) return -1;
  if (aEmail === null && bEmail !== null) return 1;
  if (aEmail !== null && bEmail !== null) {
    const emailOrder = aEmail.localeCompare(bEmail);
    if (emailOrder !== 0) return emailOrder;
  }

  return compareVersions(b.version, a.version);
}

/**
 * Join fixed view columns with a consistent two-space gutter. Empty trailing
 * columns are dropped so a row without an auth chip does not grow a dangling
 * gutter, but interior empties stay padded so later columns stay aligned.
 */
export function joinViewColumns(cols: string[]): string {
  // Trim only pure-trailing empty strings so auth/status can be absent without
  // shifting earlier columns for rows that do carry them.
  let end = cols.length;
  while (end > 0 && cols[end - 1] === '') end--;
  return cols.slice(0, end).join('  ');
}

/**
 * Custom harnesses (the `~/.agents/profiles/*.yml` bundles), sorted by name.
 * YAMLs that fail validation are silently skipped by `listProfiles`, so this
 * never throws on a malformed file.
 */
function getHarnesses(): ProfileSummary[] {
  return listProfiles().map(profileSummary);
}

/** Version-first label: "<version> (forked from <host>[, tracks default])" */
function harnessVersionLabel(harness: ProfileSummary, globalDefault: string | null): string {
  const version = harness.hostVersion ?? globalDefault;
  if (version) {
    const trailer = harness.hostVersion
      ? chalk.gray(` (forked from ${harness.agent})`)
      : chalk.gray(` (forked from ${harness.agent}, `) +
        chalk.green(`tracks default`) +
        chalk.gray(`)`);
    return `${version}${trailer}`;
  }
  return chalk.gray(`(forked from ${harness.agent})`);
}

/** One-hop or two-hop fork origin label for the harness block header. */
function buildHarnessOrigin(harness: ProfileSummary, allHarnesses: ProfileSummary[]): string {
  if (!harness.forkedFrom || harness.forkedFrom === harness.agent) return 'custom';
  const parent = allHarnesses.find((h) => h.name === harness.forkedFrom);
  if (parent?.forkedFrom) {
    return `custom · forked from ${harness.forkedFrom} -> ${parent.forkedFrom}`;
  }
  return `custom · forked from ${harness.forkedFrom}`;
}

/**
 * Resolve a resource path to something the IDE can open inline. When `p` is a
 * directory, OSC 8 file:// links cause IDEs (Cursor/VS Code) to open it as a
 * new workspace window; pointing at the bundle's marker file (SKILL.md /
 * WORKFLOW.md / AGENT.md) opens in the current window instead.
 */
function linkTarget(p: string): string {
  try {
    if (!fs.statSync(p).isDirectory()) return p;
  } catch { return p; }
  for (const marker of ['SKILL.md', 'WORKFLOW.md', 'AGENT.md']) {
    const candidate = path.join(p, marker);
    if (fs.existsSync(candidate)) return candidate;
  }
  return p;
}

function formatLastActive(date: Date | null): string {
  if (!date) return '';
  const now = Date.now();
  const diff = now - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return chalk.green('just now');
  if (mins < 60) return chalk.green(`${mins}m ago`);
  if (hours < 24) return chalk.white(`${hours}h ago`);
  if (days < 7) return chalk.gray(`${days}d ago`);
  return chalk.gray(`${days}d ago`);
}


function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (partsA[i] > partsB[i]) return 1;
    if (partsA[i] < partsB[i]) return -1;
  }
  return 0;
}

function getProjectVersionFromCwd(agent: AgentId): string | null {
  const manifestPath = path.join(process.cwd(), '.agents', 'agents.yaml');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const manifest = readManifest(process.cwd());
    return manifest?.agents?.[agent] || null;
  } catch {
    return null;
  }
}


interface ResourceWithSync {
  name: string;
  path?: string;
  ruleCount?: number;
  syncState?: SyncState;
  scope?: 'user' | 'project';
  description?: string;
}

/** Per-section filter flags. When any are true, only those sections render. */
export interface ViewSectionFilter {
  commands?: boolean;
  skills?: boolean;
  mcp?: boolean;
  workflows?: boolean;
  plugins?: boolean;
  rules?: boolean;
  hooks?: boolean;
  promptcuts?: boolean;
  clis?: boolean;
}

const SECTION_KEYS = ['commands', 'skills', 'mcp', 'workflows', 'plugins', 'rules', 'hooks', 'promptcuts', 'clis'] as const;
type SectionKey = (typeof SECTION_KEYS)[number];

/**
 * Decide whether a section should render given the filter. If no flags are set,
 * everything renders (current behavior). If any flag is set, only those sections
 * render — flags are additive.
 */
function shouldRenderSection(key: SectionKey, filter: ViewSectionFilter | undefined): boolean {
  if (!filter) return true;
  const anySet = SECTION_KEYS.some((k) => filter[k]);
  if (!anySet) return true;
  return filter[key] === true;
}

/** Trim a description to a column-friendly snippet. Strips newlines, collapses whitespace. */
export function summarizeDescription(desc: string | undefined, maxLen = 80): string {
  if (!desc) return '';
  const cleaned = desc.replace(/\s+/g, ' ').trim();
  return truncateToWidth(cleaned, maxLen);
}

export function descriptionForPrefix(desc: string | undefined, prefix: string): string {
  if (!desc) return '';
  const visiblePrefix = prefix.replace(/\x1b]8;;[^\x1b]*(?:\x1b\\|\x07)/g, '');
  const budget = Math.max(1, terminalWidth() - stringWidth(visiblePrefix));
  return summarizeDescription(desc, budget);
}

/**
 * Render custom harnesses as their own agent-type blocks — peers of the native
 * Claude/Codex blocks, not indented rows under the host CLI that executes them.
 * `agents run <name>` already treats a custom harness like a native agent id, so
 * `agents view` lists it the same way: a bold name header, then one row carrying
 * the model, the account/auth state, and the host it runs on.
 *
 * `installedHosts` is the set of agent ids with a usable install; a harness whose
 * host is missing is flagged rather than silently listed as runnable.
 */
export function renderHarnessBlocks(
  harnesses: ProfileSummary[],
  installedHosts: Set<AgentId>,
  showPaths: boolean,
  byokMap?: Map<string, ByokUsageResult>,
): void {
  if (harnesses.length === 0) return;

  const modelWidth = Math.max(...harnesses.map((h) => h.model.length));
  const authWidth = Math.max(...harnesses.map((h) => h.auth.length));

  for (const harness of harnesses) {
    const origin = buildHarnessOrigin(harness, harnesses);
    const missingHost = installedHosts.has(harness.agent)
      ? ''
      : chalk.yellow(` (host ${harness.agent} not installed)`);
    console.log(`  ${chalk.bold(harness.label)}${chalk.gray(` (${origin})`)}${missingHost}`);
    const versionTag = harnessVersionLabel(harness, getGlobalDefault(harness.agent));
    const byokEntry = byokMap?.get(harness.name);
    const byokBar = byokEntry ? `  ${renderByokBar(byokEntry)}` : '';
    console.log(
      `    ${chalk.yellow(harness.model.padEnd(modelWidth))}  ` +
        `${chalk.cyan(harness.auth.padEnd(authWidth))}  ` +
        versionTag + byokBar,
    );
    if (showPaths) console.log(chalk.gray(`      ${harness.path}`));
    console.log();
  }
}

/**
 * Show installed versions for one or all agents.
 * Called when: `agents view` or `agents view claude`
 */
/** Color the source-layer tag for a host CLI, matching the rules-section convention. */
function hostCliSourceTag(source: string): string {
  if (source === 'project') return chalk.blue('[project]');
  if (source === 'user') return chalk.cyan('[user]');
  if (source === 'system') return chalk.gray('[system]');
  // Anything else is an extra repo, tagged by its alias.
  return chalk.magenta(`[${source}]`);
}

/**
 * Render the host-CLI section. Host CLIs are host-global: declared in any
 * DotAgents repo's `clis/` (project > user > system > extras), installed to PATH
 * rather than copied into a version home. They render identically in the overview
 * and in a per-agent detail view because every agent on the host shares them.
 * The source tag shows which repo layer declared each — so user-level and
 * extra-repo manifests are visibly supported.
 */
function renderHostClisSection(cwd: string): void {
  const { statuses, errors } = listCliStatus(cwd);
  console.log(chalk.bold('\nHost CLIs\n'));
  if (statuses.length === 0) {
    console.log(`  ${chalk.gray('none declared')} ${chalk.gray('— add one with `agents clis add <name>`')}`);
  } else {
    const nameWidth = Math.max(...statuses.map((s) => s.manifest.name.length));
    let anyMissing = false;
    for (const { manifest, installed } of statuses) {
      if (!installed) anyMissing = true;
      const status = installed ? chalk.green('installed') : chalk.red('missing  ');
      const linkedName = termLink(manifest.name.padEnd(nameWidth), linkTarget(manifest.path));
      const tag = hostCliSourceTag(manifest.source);
      const prefix = `  ${status}  ${chalk.cyan(linkedName)} ${tag}`;
      const descSnippet = descriptionForPrefix(manifest.description, `${prefix}  `);
      const desc = descSnippet ? chalk.gray(`  ${descSnippet}`) : '';
      console.log(prefix + desc);
    }
    if (anyMissing) {
      console.log(chalk.gray('  Install missing with `agents clis install`'));
    }
  }
  for (const err of errors) {
    console.log(`  ${chalk.red('error')}      ${chalk.gray(err.file)}: ${chalk.gray(err.reason)}`);
  }
}

/**
 * The USAGE-READ-2 decision, isolated from its runtime inputs so it can be
 * tested directly: a usage read may fall through to the interactive OAuth login
 * ONLY for a foreground human render on a headed device (`personal` or
 * `desktop`). Both conditions are required — role alone is not sufficient.
 */
export function allowInteractiveUsageLogin(
  role: ConfiguredDeviceRole | undefined,
  isTTY: boolean,
): boolean {
  return isHeadedDeviceRole(role) && isTTY === true;
}

/**
 * Whether this `agents view` invocation may fall through to the interactive
 * OAuth login for a usage read (USAGE-READ-2). True only for a foreground human
 * render on a headed device (`personal` or `desktop`): the interactive login is
 * the sole credential carrying the `user:profile` scope the usage endpoint needs,
 * and a human
 * running one command is not the unattended-loop revocation risk RUSH-1822
 * fixed. The `--json` path never reaches these render functions (it returns
 * early via `collectAgentsJson`), and a non-TTY (piped/scripted) run is excluded
 * here too, so a machine reader can never silently acquire the interactive
 * credential — role alone is not sufficient.
 */
function usageAllowInteractiveLogin(): boolean {
  return allowInteractiveUsageLogin(selfConfiguredDeviceRole(), process.stdout.isTTY === true);
}

async function showInstalledVersions(
  filterAgentId?: AgentId,
  viewOpts?: { forceRefresh?: boolean; versions?: boolean },
): Promise<void> {
  const spinnerText = filterAgentId
    ? `Checking ${agentLabel(filterAgentId)} agents...`
    : 'Checking installed agents...';
  const spinner = ora({ text: spinnerText, isSilent: !process.stdout.isTTY }).start();

  const agentsToShow = filterAgentId ? [filterAgentId] : ALL_AGENT_IDS;
  // Overview caps meter count; single-agent view shows every blocking window.
  const usageWindowCap = filterAgentId ? undefined : OVERVIEW_MAX_USAGE_WINDOWS;

  // A globally-installed CLI is superseded only by a NORMAL managed version — that
  // is when agents-cli owns the launcher and a "global" row would just be our own
  // shim reported back. `--isolated` promises the opposite: no default, no bare
  // shim, no adopted launcher, the user's own `~/.<agent>` untouched. So an
  // isolated-only install must not make that still-live global CLI disappear from
  // `agents view` — the two are genuinely separate installs and both get listed.
  const hasNonIsolatedVersion = (agentId: AgentId): boolean =>
    listInstalledVersions(agentId).some((v) => !isVersionIsolated(agentId, v));

  // Every `cliStates` read in this function feeds the "Not Managed by Agents CLI"
  // block, so resolve it the way that block means it: the user's own CLI on PATH.
  // `getCliState` would answer with a version-dir install — including an isolated
  // copy that is deliberately absent from PATH — and print it as "(global)".
  //
  // Resolved only for agents that can actually reach that block. `getCliState`
  // deliberately avoids subprocesses for a version-managed agent, and PATH
  // resolution costs a `<cli> --version` spawn on a cold cache — so probing an
  // agent whose global row is suppressed anyway would be pure added latency.
  const cliStates = Object.fromEntries(
    await Promise.all(
      agentsToShow
        .filter((agentId) => !hasNonIsolatedVersion(agentId))
        .map(async (agentId) => [agentId, await getUnmanagedCliState(agentId)] as const)
    )
  ) as Partial<Record<AgentId, CliState>>;
  const showPaths = !!filterAgentId && viewOpts?.versions === true;
  // A filtered native view is about that native harness's installed versions.
  // Custom forks are standalone agent types and only belong in the overview.
  const harnesses = filterAgentId ? [] : getHarnesses();

  // Auto-heal stale versioned aliases. Pre-v2 aliases (e.g. pre-CLAUDE_CONFIG_DIR
  // claude shims) silently route login through the default version's symlinked
  // home, so `agents view` would never reflect the right account. Regenerate on
  // sight — it's safe, idempotent, and fixes the symptom exactly where the user
  // notices it.
  // Yield between agents so the heal loop doesn't block the event loop as one
  // long sync burst — per-version readFileSync+writeFileSync across 5 agents
  // can otherwise stall spinners and stdout flushes.
  const healedAliases: string[] = [];
  for (const agentId of agentsToShow) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const version of listInstalledVersions(agentId)) {
      const status = ensureVersionedAliasCurrent(agentId, version);
      if (status === 'updated' || status === 'created') {
        healedAliases.push(`${agentId}@${version}`);
      }
    }
  }
  // Shim healing is silent — users don't need to know about internal repairs

  // Pre-fetch account info for all versions in parallel. Spinner stays up through
  // account + usage so a multi-account cold path doesn't leave a blank terminal
  // after "Checking…" vanishes (the hang the screenshots caught).
  spinner.text = filterAgentId
    ? `Loading ${agentLabel(filterAgentId)} accounts...`
    : 'Loading accounts and usage...';
  const infoFetches: Promise<{ agentId: AgentId; version: string; home: string; info: AccountInfo }>[] = [];
  const globalInfoFetches: Promise<{ agentId: AgentId; cliVersion: string | null; info: AccountInfo }>[] = [];
  for (const agentId of agentsToShow) {
    for (const ver of listInstalledVersions(agentId)) {
      const home = getVersionHomePath(agentId, ver);
      infoFetches.push(
        getAccountInfo(agentId, home).then((info) => ({
          agentId,
          version: ver,
          home,
          info,
        }))
      );
    }
    // Mirrors the classification below: fetch the global account whenever the
    // global install will still be rendered (no versions at all, or isolated-only).
    if (!hasNonIsolatedVersion(agentId)) {
      globalInfoFetches.push(
        getAccountInfo(agentId).then((info) => ({
          agentId,
          cliVersion: cliStates[agentId]?.version || null,
          info,
        }))
      );
    }
  }
  const infoResults = await Promise.all(infoFetches);
  const globalInfoResults = await Promise.all(globalInfoFetches);

  // Build lookup: agentId:version -> AccountInfo
  const infoMap = new Map<string, AccountInfo>();
  for (const { agentId, version, info } of infoResults) {
    infoMap.set(`${agentId}:${version}`, info);
  }
  const globalInfoMap = new Map<string, AccountInfo>();
  for (const { agentId, info } of globalInfoResults) {
    globalInfoMap.set(agentId, info);
  }

  // Usage status, plan, and overage credits belong to the same underlying account
  // or org scope, not a specific installed version. Version homes cache those
  // values independently, so older installs can show stale values. Reuse the
  // freshest cache entry per stable usage identity and keep lastActive per version.
  // Goes through the unified usage core (SWR cache + concurrency cap + timeout).
  const { canonicalByUsageKey, usageByKey } = await getUsageInfoByIdentity([
    ...infoResults.map(({ agentId, home, version, info }) => ({
      agentId,
      home,
      cliVersion: version,
      info,
    })),
    ...globalInfoResults.map(({ agentId, cliVersion, info }) => ({
      agentId,
      cliVersion,
      info,
    })),
  ], {
    forceRefresh: viewOpts?.forceRefresh,
    allowInteractiveLogin: usageAllowInteractiveLogin(),
  });

  spinner.stop();
  console.log(chalk.bold(viewOpts?.versions ? 'Installed Agent CLIs\n' : 'Agents and accounts\n'));

  const mergeCanonical = (info: AccountInfo): AccountInfo => {
    const key = getUsageLookupKey(info);
    if (!key) return info;
    const canon = canonicalByUsageKey.get(key);
    if (!canon) return info;
    return {
      ...info,
      // Prefer a plan the live usage fetch surfaced (Kimi reports membership
      // tier in /usages; its local auth file has none) and fall back to the
      // account-derived plan (Claude's billingType).
      plan: usageByKey.get(key)?.snapshot?.plan ?? canon.plan,
      // Throttle state comes from the live usage windows, not the pay-as-you-go
      // overage flag that AccountInfo.usageStatus used to carry. A maxed window
      // means rate-limited; no snapshot means no badge. See
      // deriveUsageStatusFromSnapshot.
      usageStatus: deriveUsageStatusFromSnapshot(usageByKey.get(key)?.snapshot),
      overageCredits: canon.overageCredits,
    };
  };

  // Separate version-managed from globally-installed agents
  const versionManaged: AgentId[] = [];
  const globallyInstalled: AgentId[] = [];

  for (const agentId of agentsToShow) {
    const versions = listInstalledVersions(agentId);
    const cliState = cliStates[agentId];

    if (versions.length > 0) {
      versionManaged.push(agentId);
    }
    if (cliState?.installed) {
      // Isolated-only installs sit alongside the global CLI rather than replacing it.
      if (!hasNonIsolatedVersion(agentId)) globallyInstalled.push(agentId);
    }
  }
  // A custom harness runs through its host CLI, so it is only launchable when
  // that host has an install of some kind.
  const installedHosts = new Set<AgentId>([...versionManaged, ...globallyInstalled]);

  // For self-updating global-binary agents (droid) the on-disk version-dir name
  // is a stale label — the real version is whatever `<cli> --version` reports.
  // Resolve it once so every row/width pass shows the live version, while the
  // per-version home + account lookups keep using the real dir name.
  const liveVersionByAgent = new Map<AgentId, string>();
  await Promise.all(
    versionManaged
      .filter((agentId) => isGlobalBinaryAgent(agentId))
      .map(async (agentId) => {
        const live = await getLiveVersion(agentId);
        if (live) liveVersionByAgent.set(agentId, live);
      })
  );
  const displayVersion = (agentId: AgentId, dirVersion: string): string =>
    liveVersionByAgent.get(agentId) ?? readInstallation(agentId, dirVersion)?.releaseVersion ?? dirVersion;

  // Uncolored row label, shared by the width pass and the render so padding lines
  // up. An isolated copy is never the global default (installing one deliberately
  // records no default), so the two tags can't collide.
  const versionRowLabel = (agentId: AgentId, version: string, globalDefault: string | null): string => {
    const release = displayVersion(agentId, version);
    const shown = release === version ? version : `${version} → ${release}`;
    if (version === globalDefault) return `${shown} (default)`;
    if (isVersionIsolated(agentId, version)) {
      // The isolated default is what a bare `agents run <agent>` reaches, so it is
      // worth distinguishing from the other isolated copies sitting beside it.
      return getIsolatedDefault(agentId) === version
        ? `${shown} (isolated default)`
        : `${shown} (isolated)`;
    }
    return shown;
  };

  // Show version-managed agents
  if (versionManaged.length > 0 && !viewOpts?.versions) {
    const catalog = await loadAccountCatalog();
    const note = secretsUnavailableNote(catalog);
    if (note) console.error(chalk.yellow(note));
    for (const agentId of versionManaged) {
      const accounts = catalog.native.filter((row) => row.agent === agentId);
      const providers = catalog.provider.filter((row) => row.harnesses.includes(agentId));
      let updateLabel = 'manual updates';
      try {
        if (selectUpdateStrategy(agentId).transactional) {
          updateLabel = `automatic updates ${isAutoUpdateEnabledForAgent(agentId) ? 'on' : 'off'}`;
        }
      } catch { /* unsupported updater: keep the truthful manual label */ }
      console.log(`  ${chalk.bold(agentLabel(agentId))}${chalk.gray(` · ${updateLabel}`)}`);
      if (accounts.length > 0 || providers.length > 0) {
        console.log(renderAccountRows(accounts, {
          heading: false,
          footer: false,
          harnessHeadings: false,
          providers,
          harness: agentId,
          maxUsageWindows: usageWindowCap,
          localDevice: machineId(),
        }));
      } else {
        const localIdentity = infoResults.some((row) => row.agentId === agentId && row.info.signedIn);
        const hint = addSupported(agentId) ? `agents accounts add ${agentId} <name>` : loginHint(agentId);
        console.log(chalk.gray(localIdentity
          ? '    Native login detected · account identity unavailable'
          : `    No native login detected · ${hint}`));
      }
      const isolatedCount = listInstalledVersions(agentId).filter((label) => isVersionIsolated(agentId, label)).length;
      if (isolatedCount > 0) console.log(chalk.gray(`    ${isolatedCount} isolated installation${isolatedCount === 1 ? '' : 's'}`));
      const projectVersion = getProjectVersionFromCwd(agentId);
      if (projectVersion) console.log(chalk.gray('    Project installation override configured'));
      console.log();
    }
    if (filterAgentId) {
      console.log(chalk.gray(`  Add an account: agents accounts add ${filterAgentId} [name]`));
      console.log(chalk.gray('  STATE: LIVE ready · LIMITED rate-limited · EXPIRED needs refresh · REVOKED needs login · UNVERIFIED unconfirmed · MISSING not provisioned · * stale usage\n'));
    } else {
      // Overview also renders account tables (footer:false) — explain STATE there too.
      console.log(chalk.gray('  STATE: LIVE ready · LIMITED rate-limited · EXPIRED needs refresh · REVOKED needs login · UNVERIFIED unconfirmed · MISSING not provisioned · * stale usage\n'));
    }
  }
  if (versionManaged.length > 0 && viewOpts?.versions) {
    // Calculate column widths across all agents for alignment
    let maxVerLabel = 0;
    let maxEmail = 0;
    let maxPlanWidth = 3;
    let maxUsageWidth = 0;
    let maxStatusWidth = 0;
    // The configured model sits right after the version, at the same priority.
    // Resolve once here (fs + catalog reads) and reuse in the render loop.
    let maxModelWidth = 0;
    const modelByKey = new Map<string, string>();
    for (const agentId of versionManaged) {
      const versions = listInstalledVersions(agentId);
      const globalDefault = getGlobalDefault(agentId);
      for (const v of versions) {
        maxVerLabel = Math.max(maxVerLabel, versionRowLabel(agentId, v, globalDefault).length);
        const rawInfo = infoMap.get(`${agentId}:${v}`);
        const info = rawInfo ? mergeCanonical(rawInfo) : undefined;
        const accountLabel = namedAccountColumnLabel(agentId, info);
        if (accountLabel) maxEmail = Math.max(maxEmail, accountLabel.length);
        if (info?.plan) maxPlanWidth = Math.max(maxPlanWidth, info.plan.length);
        const model = resolveConfiguredModel(agentId, v)?.model;
        if (model) {
          modelByKey.set(`${agentId}:${v}`, model);
          maxModelWidth = Math.max(maxModelWidth, model.length);
        }
      }
    }
    // Second pass: compute max visible usage + status widths (now that maxPlanWidth is settled).
    // stringWidth (not String.length) so chalk + block-bar glyphs pad correctly.
    for (const agentId of versionManaged) {
      const versions = listInstalledVersions(agentId);
      for (const v of versions) {
        const rawInfo = infoMap.get(`${agentId}:${v}`);
        const info = rawInfo ? mergeCanonical(rawInfo) : undefined;
        const usageKey = getUsageLookupKey(info);
        const usageInfo = usageKey ? usageByKey.get(usageKey) : undefined;
        const usageStr = formatUsageSummary(
          info?.plan || null,
          usageInfo?.snapshot || null,
          maxPlanWidth,
          viewUsageSummaryOptions(agentId, !!info?.signedIn, usageInfo, usageWindowCap, v),
        );
        maxUsageWidth = Math.max(maxUsageWidth, stringWidth(usageStr));
        const statusStr = formatUsageStatusBadge(info?.usageStatus);
        maxStatusWidth = Math.max(maxStatusWidth, stringWidth(statusStr));
      }
    }

    for (const agentId of versionManaged) {
	      const agent = AGENTS[agentId];
	      const versions = listInstalledVersions(agentId);
	      const globalDefault = getGlobalDefault(agentId);
	      const runStrategy = getConfiguredRunStrategy(agentId);

	      const strategyLabel = chalk.gray(` (${runStrategy})`);
	      // `(no default)` is a nudge to go set one. It would read as a contradiction
	      // directly above a row tagged `(isolated default)`, and it would be bad
	      // advice besides: for an isolated-only agent the pointer below IS how a
	      // bare `agents run <agent>` resolves, and setting a global default is
	      // precisely what `--isolated` exists to avoid.
	      const noDefaultLabel = !globalDefault && !getIsolatedDefault(agentId)
	        ? chalk.yellow(' (no default)')
	        : '';
	      console.log(`  ${chalk.bold(agentLabel(agentId))}${strategyLabel}${noDefaultLabel}`);

	      // Account information is already loaded above. Keep the selected default
	      // first, then make multi-account installs scannable by email. Harnesses
	      // without email identities retain their prior version-descending order.
      const sortedVersions = versions
        .map((version) => ({
          version,
          email: infoMap.get(`${agentId}:${version}`)?.email ?? null,
        }))
        .sort((a, b) => compareAccountOrderedVersions(a, b, globalDefault))
        .map(({ version }) => version);

      for (const version of sortedVersions) {
        const isDefault = version === globalDefault;
        const isolated = !isDefault && isVersionIsolated(agentId, version);
        const isolatedTag = getIsolatedDefault(agentId) === version ? ' (isolated default)' : ' (isolated)';
        const release = displayVersion(agentId, version);
        const shown = release === version ? version : `${version} → ${release}`;
        const base = versionRowLabel(agentId, version, globalDefault);
        const tagPad = ' '.repeat(maxVerLabel - base.length);
        const label = isDefault
          ? `${shown}${chalk.green(' (default)')}${tagPad}`
          : isolated
            ? `${shown}${chalk.gray(isolatedTag)}${tagPad}`
            : base.padEnd(maxVerLabel);
        const rawInfo = infoMap.get(`${agentId}:${version}`);
        const vInfo = rawInfo ? mergeCanonical(rawInfo) : undefined;
        const usageKey = getUsageLookupKey(vInfo);
        const usageInfo = usageKey ? usageByKey.get(usageKey) : undefined;

        // Fixed columns for every signed-in row so status / lastActive / auth
        // stay vertically aligned across agents — even when this row has no
        // usage bars or no rate-limit badge. Skipping empty columns mid-table
        // was what made the multi-agent view look unjustified next to
        // `agents view claude`.
        const parts = [`    ${label}`];
        // Configured model — same priority as the version, right beside it.
        if (maxModelWidth > 0) {
          const model = modelByKey.get(`${agentId}:${version}`) ?? '';
          parts.push(chalk.yellow(padToWidth(model, maxModelWidth)));
        }
        const hasEmail = !!vInfo?.email;
        const signedIn = !!vInfo?.signedIn;
        const usageStr = formatUsageSummary(
          vInfo?.plan || null,
          usageInfo?.snapshot || null,
          maxPlanWidth,
          viewUsageSummaryOptions(agentId, signedIn, usageInfo, usageWindowCap, version),
        );
        const hasUsage = usageStr.length > 0;
        // Only show lastActive for versions with an actual logged-in account.
        // Otherwise it reflects install time (misleading "just now" for fresh installs).
        const lastActive = vInfo && hasEmail ? formatLastActive(vInfo.lastActive) : '';
        const activeStr = lastActive;
        const hasActive = activeStr.length > 0;
        // The model now has its own column above; keep only the run mode here.
        const runDefaults = resolveRunDefaults(agentId, version);
        const runDefaultBits: string[] = [];
        if (runDefaults.mode) runDefaultBits.push(`mode:${runDefaults.mode}`);
        if (runDefaults.effort) runDefaultBits.push('effort:' + runDefaults.effort);

        if (!hasEmail && !hasUsage && !signedIn) {
          // No per-version credential. That is NOT the same as unusable: Claude
          // Code authenticates from `CLAUDE_CODE_OAUTH_TOKEN` when the
          // environment carries one, and a run then succeeds against whatever
          // account minted that token — while `signedIn` (agents.ts: `!!email`,
          // read from this version home's `.claude.json`) stays false because no
          // account was ever written here. Reporting that as "logged out" reads
          // as a locked-out account and sends people hunting a login that is not
          // missing; naming the ambient token instead points at the real state —
          // every version on this box resolves to the SAME account, so balanced
          // rotation across them is not actually rotating.
          parts.push(chalk.gray(
            ambientClaudeToken(agentId)
              ? '(no per-version login — using ambient CLAUDE_CODE_OAUTH_TOKEN)'
              : '(logged out — log in with: ' + loginHint(agentId) + ')',
          ));
        } else {
          // Always emit account / usage / status / lastActive columns once any
          // signed-in row exists in the table (widths are global). Empty cells
          // are space-padded so later columns do not drift left.
          const display = namedAccountColumnLabel(agentId, vInfo);
          parts.push(display ? chalk.cyan(padToWidth(display, maxEmail)) : ' '.repeat(maxEmail));
          if (maxUsageWidth > 0) {
            parts.push(padToWidth(usageStr, maxUsageWidth));
          }
          if (maxStatusWidth > 0) {
            const statusStr = formatUsageStatusBadge(vInfo?.usageStatus);
            parts.push(padToWidth(statusStr, maxStatusWidth));
          }
          if (hasActive) parts.push(activeStr);
        }
        if (runDefaultBits.length > 0) {
          parts.push(chalk.gray(`run ${runDefaultBits.join(' ')}`));
        }

        console.log(joinViewColumns(parts));
        if (showPaths) {
          const versionDir = getVersionDir(agentId, version);
          console.log(chalk.gray(`      ${versionDir}`));
        }
      }

      // Check for project override
      const projectVersion = getProjectVersionFromCwd(agentId);
      if (projectVersion && projectVersion !== globalDefault) {
        console.log(chalk.cyan(`    -> ${projectVersion} (project)`));
      }

      console.log();
    }
  }

  // Custom harnesses sit in the same list as the native ones — they are run the
  // same way (`agents run <name>`), so they read as their own agent type rather
  // than as an indented row under whichever host CLI executes them.
  const byokMap = new Map<string, ByokUsageResult>();
  const byKeychainItem = new Map<string, { profile: Profile; names: string[] }>();
  for (const h of harnesses) {
    if (!h.provider || !hasByokProvider(h.provider)) continue;
    let prof: Profile | null = null;
    try { prof = readProfile(h.name); } catch { continue; }
    if (!prof.auth) continue;
    const item = prof.auth.keychainItem;
    const existing = byKeychainItem.get(item);
    if (existing) { existing.names.push(h.name); }
    else { byKeychainItem.set(item, { profile: prof, names: [h.name] }); }
  }
  if (byKeychainItem.size > 0) {
    const fetched = await Promise.all(
      [...byKeychainItem.values()].map(({ profile, names }) =>
        getByokUsageForHarness(profile, { forceRefresh: viewOpts?.forceRefresh }).then((result) => ({ result, names }))
      )
    );
    for (const { result, names } of fetched) {
      if (!result?.budget) continue;
      for (const name of names) byokMap.set(name, result);
    }
  }
  renderHarnessBlocks(harnesses, installedHosts, showPaths, byokMap.size > 0 ? byokMap : undefined);

  // Show globally installed (not managed) agents
  if (globallyInstalled.length > 0) {
    console.log(chalk.bold('Not Managed by Agents CLI\n'));

    // Calculate max version label width for alignment
    const globalMaxVerLabel = Math.max(
      ...globallyInstalled.map((agentId) => {
        const cliState = cliStates[agentId];
        return `${cliState?.version || 'installed'} (global)`.length;
      })
    );
    // Pre-pass: max badge/usage/email widths so columns line up the same way
    // the version-managed block does (stringWidth for chalk-aware padding).
    let gMaxStatusWidth = 0;
    let gMaxUsageWidth = 0;
    let gMaxEmail = 0;
    for (const agentId of globallyInstalled) {
      const gInfoRaw = globalInfoMap.get(agentId);
      const gInfo = gInfoRaw ? mergeCanonical(gInfoRaw) : undefined;
      gMaxStatusWidth = Math.max(gMaxStatusWidth, stringWidth(formatUsageStatusBadge(gInfo?.usageStatus)));
      const gUsageKey = getUsageLookupKey(gInfo);
      const gUsage = gUsageKey ? usageByKey.get(gUsageKey) : undefined;
      const gUsageStr = formatUsageSummary(
        gInfo?.plan || null,
        gUsage?.snapshot || null,
        3,
        viewUsageSummaryOptions(agentId, !!gInfo?.signedIn, gUsage, usageWindowCap),
      );
      gMaxUsageWidth = Math.max(gMaxUsageWidth, stringWidth(gUsageStr));
      const gDisplay = accountColumnLabel(gInfo);
      if (gDisplay) gMaxEmail = Math.max(gMaxEmail, gDisplay.length);
    }

    for (const agentId of globallyInstalled) {
      const agent = AGENTS[agentId];
      const cliState = cliStates[agentId];

      console.log(`  ${chalk.bold(agentLabel(agentId))}`);
      const gInfoRaw = globalInfoMap.get(agentId);
      const gInfo = gInfoRaw ? mergeCanonical(gInfoRaw) : undefined;
      const verLabel = `${cliState?.version || 'installed'} ${chalk.gray('(global)')}`;
      const verLabelLen = `${cliState?.version || 'installed'} (global)`.length;
      const padding = ' '.repeat(Math.max(0, globalMaxVerLabel - verLabelLen));
      const parts = [`    ${verLabel}${padding}`];
      const gUsageKey = getUsageLookupKey(gInfo);
      const gUsage = gUsageKey ? usageByKey.get(gUsageKey) : undefined;
      const gUsageStr = formatUsageSummary(
        gInfo?.plan || null,
        gUsage?.snapshot || null,
        3,
        viewUsageSummaryOptions(agentId, !!gInfo?.signedIn, gUsage, usageWindowCap),
      );
      const gLastActive = gInfo ? formatLastActive(gInfo.lastActive) : '';
      const gActiveStr = gLastActive;
      if (gInfo?.email || gUsageStr || gActiveStr || gInfo?.signedIn) {
        const gDisplay = accountColumnLabel(gInfo);
        parts.push(gDisplay ? chalk.cyan(padToWidth(gDisplay, gMaxEmail)) : ' '.repeat(gMaxEmail));
      }
      if (gMaxUsageWidth > 0) parts.push(padToWidth(gUsageStr, gMaxUsageWidth));
      if (gMaxStatusWidth > 0) {
        parts.push(padToWidth(formatUsageStatusBadge(gInfo?.usageStatus), gMaxStatusWidth));
      }
      if (gActiveStr) parts.push(gActiveStr);
      console.log(joinViewColumns(parts));
      if (showPaths && cliState?.path) {
        console.log(chalk.gray(`      ${cliState.path}`));
      }
      if (agent.npmPackage && cliState?.version) {
        console.log(chalk.gray(`    Manage: agents add ${agentId}@${cliState.version} -y`));
      } else if (!agent.npmPackage && cliState?.installed) {
        // installScript-based agent already on PATH — direct users to adopt the
        // existing install with `agents import` instead of re-running curl.
        console.log(chalk.gray(`    Adopt:  agents import ${agentId}`));
      }
      console.log();
    }
  }

  // If filtering to a specific agent and not found
  if (
    filterAgentId &&
    versionManaged.length === 0 &&
    globallyInstalled.length === 0 &&
    harnesses.length === 0
  ) {
    console.log(`  ${chalk.bold(agentLabel(filterAgentId))}: ${chalk.gray('not installed')}`);
    console.log();
  }

  // No agents installed at all
  if (
    versionManaged.length === 0 &&
    globallyInstalled.length === 0 &&
    harnesses.length === 0 &&
    !filterAgentId
  ) {
    console.log(chalk.gray('  No agent CLIs installed.'));
    console.log(chalk.gray('  Run: agents add claude@latest'));
    console.log();
  }

  // `--refresh` used to print a table that looked fully refreshed no matter how
  // many accounts it had failed to reach, so a box whose every Claude credential
  // had expired rendered identically to a healthy one — the bars beside each row
  // came from a cache that the run had not managed to update. Name the accounts
  // it could not confirm, and why.
  if (viewOpts?.forceRefresh) {
    const unrefreshed: string[] = [];
    for (const [key, usage] of usageByKey) {
      if (!usage.error) continue;
      const label = canonicalByUsageKey.get(key)?.email ?? key;
      unrefreshed.push(`    ${label.padEnd(24)} ${chalk.gray(usage.error)}`);
    }
    if (unrefreshed.length > 0) {
      const noun = unrefreshed.length === 1 ? 'account' : 'accounts';
      console.log(chalk.yellow(`  Could not refresh ${unrefreshed.length} ${noun} — bars above are the last cached reading:`));
      for (const line of unrefreshed) console.log(line);
      console.log();
    }
  }

  // Host CLIs are host-global, not per-agent — show them once in the overview.
  if (!filterAgentId) {
    renderHostClisSection(process.cwd());
  }

}

/**
 * Show detailed resources for a specific agent version.
 * Called when: `agents view claude@2.0.65` or `agents view claude@default`
 */
async function showAgentResources(
  agentId: AgentId,
  requestedVersion: string,
  filter?: ViewSectionFilter,
): Promise<void> {
  const spinner = ora({ text: 'Loading...', isSilent: !process.stdout.isTTY }).start();

  const cwd = process.cwd();
  const agentsDir = getAgentsDir();
  const cliStates = await getAllCliStates();

  // Resolve 'default' to actual version
  let version: string | null = null;
  if (requestedVersion === 'default') {
    version = getGlobalDefault(agentId);
    if (!version) {
      spinner.stop();
      console.log(chalk.yellow(`No default version set for ${agentLabel(agentId)}`));
      console.log(chalk.gray(`Run: agents use ${agentId}@<version>`));
      return;
    }
  } else {
    const versions = listInstalledVersions(agentId);
    if (versions.includes(requestedVersion)) {
      version = requestedVersion;
    } else {
      spinner.stop();
      console.log(chalk.red(`Version ${requestedVersion} not installed for ${agentLabel(agentId)}`));
      console.log(chalk.gray(`Installed versions: ${versions.join(', ') || 'none'}`));
      return;
    }
  }
  const home = getVersionHomePath(agentId, version);

  // Git sync status if ~/.agents/ is a git repo (shared loader — see
  // loadResourceSyncData / resolveResourceSyncState, reused by --json --resources).
  const { hasGitRepo, commands: commandsSync, skills: skillsSync, hooks: hooksSync, memory: memorySync } =
    await loadResourceSyncData();

  // Collect resources for the specific version
  interface SkillError {
    name: string;
    path: string;
    error: string;
  }

  interface AgentResourceDisplay {
    agentId: AgentId;
    agentName: string;
    version: string | null;
    commands: ResourceWithSync[];
    skills: ResourceWithSync[];
    skillErrors: SkillError[];
    mcp: ResourceWithSync[];
    memory: ResourceWithSync[];
    hooks: ResourceWithSync[];
    workflows: ResourceWithSync[];
  }

  const resources = getAgentResources(agentId, {
    cwd,
    scope: 'all',
    cliInstalled: cliStates[agentId]?.installed ?? false,
    home,
  });

  const agentData: AgentResourceDisplay = {
    agentId,
    agentName: agentLabel(agentId),
    version,
    commands: resources.commands.map(r => ({
      ...r,
      syncState: r.scope === 'project' ? undefined : resolveResourceSyncState(agentId, r.name, 'commands', commandsSync),
    })),
    skills: resources.skills.map(r => ({
      ...r,
      // ruleCount of 0 is noise — every skill has 0 unless it ships subrules, which is rare.
      ruleCount: r.ruleCount && r.ruleCount > 0 ? r.ruleCount : undefined,
      syncState: r.scope === 'project' ? undefined : resolveResourceSyncState(agentId, r.name, 'skills', skillsSync),
    })),
    skillErrors: resources.skillErrors,
    mcp: resources.mcp.map(r => ({ name: r.name, scope: r.scope, syncState: r.scope === 'project' ? undefined : 'synced' as SyncState })),
    memory: resources.memory.map(r => ({
      ...r,
      syncState: r.scope === 'project' ? undefined : resolveResourceSyncState(agentId, r.name, 'memory', memorySync),
    })),
    hooks: resources.hooks.map(r => ({
      ...r,
      syncState: r.scope === 'project' ? undefined : resolveResourceSyncState(agentId, r.name, 'hooks', hooksSync),
    })),
    workflows: resources.workflows.map(r => ({ name: r.name, path: r.path, scope: r.scope })),
  };

  spinner.stop();

  // Render helper for resources
  function renderSection(
    title: string,
    items: ResourceWithSync[]
  ): void {
    console.log(chalk.bold(`\n${title}\n`));

    if (items.length === 0) {
      console.log(`  ${chalk.gray('none')}`);
      return;
    }

    const versionStr = agentData.version ? ` (${agentData.version})` : '';
    const agentHeader = home ? termLink(agentData.agentName, home) : agentData.agentName;
    console.log(`  ${chalk.bold(agentHeader)}${chalk.gray(versionStr)}:`);

    for (const r of items) {
      let nameColor = chalk.cyan;
      if (r.syncState === 'synced') nameColor = chalk.green;
      else if (r.syncState === 'new') nameColor = chalk.blue;
      else if (r.syncState === 'modified') nameColor = chalk.yellow;
      else if (r.syncState === 'deleted') nameColor = chalk.red;

      const linkedName = r.path ? termLink(r.name, linkTarget(r.path)) : r.name;
      let display = nameColor(linkedName);
      if (r.ruleCount !== undefined) display += chalk.gray(` (${r.ruleCount} rules)`);
      // Source annotation: project overrides user, user overrides system
      const sourceTag = r.scope === 'project' ? chalk.blue('[project]')
        : r.scope === 'user' ? chalk.cyan('[user]')
        : chalk.gray('[system]');
      display += ` ${sourceTag}`;
      const syncStr = r.syncState ? chalk.gray(` [${r.syncState}]`) : '';
      const prefix = `    ${display}${syncStr}`;
      const descSnippet = descriptionForPrefix(r.description, `${prefix}  `);
      const descStr = descSnippet ? chalk.gray(`  ${descSnippet}`) : '';
      console.log(prefix + descStr);
    }
  }

  // Render promptcuts (cross-agent, not per-version). Shortcuts are layered
  // across system + user files with user precedence; the displayed file path
  // is whichever is "live" — user if it exists, else system.
  function renderPromptcuts(): void {
    console.log(chalk.bold(`\nPromptcuts\n`));
    const merged = readMergedPromptcuts();
    const count = Object.keys(merged).length;
    if (count === 0) {
      console.log(`  ${chalk.gray('none')}`);
      return;
    }
    const label = `${count} shortcut${count === 1 ? '' : 's'}`;
    console.log(`  ${chalk.green(label).padEnd(24)} ${chalk.gray(formatPath(getEffectivePromptcutsPath(), cwd))}`);
  }

  const anyFilterSet = filter && SECTION_KEYS.some((k) => filter[k]);

  // 1. Agent CLI info — skip the header entirely when the user asked for a
  // specific section. They want "nothing more or less."
  if (!anyFilterSet) {
    console.log(chalk.bold('Agent CLIs\n'));
    const accountInfo = await getAccountInfo(agentId, home);
    const usageInfo = await getUsageInfoForIdentity({
      agentId,
      home,
      cliVersion: version,
      info: accountInfo,
    }, { allowInteractiveLogin: usageAllowInteractiveLogin() });
    const accountLabel = accountColumnLabel(accountInfo);
    const emailStr = accountLabel ? chalk.cyan(`  ${accountLabel}`) : '';
    const status = chalk.green(version);
    // Configured model sits right beside the version, same priority (no label).
    const configuredModel = resolveConfiguredModel(agentId, version);
    const modelStr = configuredModel ? chalk.yellow(`  ${configuredModel.model}`) : '';
    const usageStr = formatUsageSummary(usageInfo.snapshot?.plan ?? accountInfo.plan, null);
    const usagePart = usageStr ? `  ${usageStr}` : '';
    console.log(`  ${colorAgent(agentId)(AGENTS[agentId].name.padEnd(14))} ${status}${modelStr}${emailStr}${usagePart}`);

    const usageLines = formatUsageSection(usageInfo);
    if (usageLines.length > 0) {
      console.log();
      for (const line of usageLines) {
        console.log(line);
      }
    }
  }

  // 2. Resources
  if (shouldRenderSection('commands', filter)) {
    renderSection('Commands', agentData.commands);
  }
  if (shouldRenderSection('skills', filter)) {
    renderSection('Skills', agentData.skills);

    // Show skill parse errors only when skills section is visible
    if (agentData.skillErrors.length > 0) {
      console.log(`\n  ${chalk.red('Skill Errors')}:`);
      for (const err of agentData.skillErrors) {
        console.log(`    ${chalk.red(err.name.padEnd(20))} ${chalk.gray(err.error)}`);
        console.log(`      ${chalk.gray(formatPath(err.path, cwd))}`);
      }
    }
  }

  if (shouldRenderSection('mcp', filter)) {
    renderSection('MCP Servers', agentData.mcp);
  }

  if (shouldRenderSection('workflows', filter) && isCapable(agentId, 'workflows')) {
    renderSection('Workflows', agentData.workflows);
  }

  if (shouldRenderSection('plugins', filter) && isCapable(agentId, 'plugins')) {
    const plugins = discoverPlugins().filter(p => pluginSupportsAgent(p, agentId));
    console.log(chalk.bold('\nPlugins\n'));
    if (plugins.length === 0) {
      console.log(`  ${chalk.gray('none')}`);
    } else {
      const versionStr = agentData.version ? ` (${agentData.version})` : '';
      const agentHeader = home ? termLink(agentData.agentName, home) : agentData.agentName;
      console.log(`  ${chalk.bold(agentHeader)}${chalk.gray(versionStr)}:`);
      const pluralize = (n: number, singular: string) => `${n} ${singular}${n === 1 ? '' : 's'}`;
      for (const p of plugins) {
        const linkedName = termLink(p.name, linkTarget(p.root));
        const parts: string[] = [];
        if (p.skills.length > 0) parts.push(pluralize(p.skills.length, 'skill'));
        if (p.commands.length > 0) parts.push(pluralize(p.commands.length, 'command'));
        if (p.agentDefs.length > 0) parts.push(pluralize(p.agentDefs.length, 'subagent'));
        if (p.hooks.length > 0) parts.push(pluralize(p.hooks.length, 'hook'));
        if (p.mcpServers.length > 0) parts.push(`${p.mcpServers.length} MCP`);
        if (p.lspServers.length > 0) parts.push(`${p.lspServers.length} LSP`);
        if (p.monitors.length > 0) parts.push(pluralize(p.monitors.length, 'monitor'));
        if (p.bin.length > 0) parts.push(pluralize(p.bin.length, 'bin'));
        if (p.hasSettings) parts.push('settings');
        const contents = parts.length > 0 ? chalk.gray(` (${parts.join(', ')})`) : '';
        console.log(`    ${chalk.cyan(linkedName)}${contents} ${chalk.cyan('[user]')}`);
      }
    }
  }

  // Rules section with subrules breakdown
  function renderRulesSection(): void {
    console.log(chalk.bold('\nRules\n'));
    const items = agentData.memory;

    if (items.length === 0) {
      console.log(`  ${chalk.gray('none')}`);
      return;
    }

    const versionStr = agentData.version ? ` (${agentData.version})` : '';
    console.log(`  ${chalk.bold(agentData.agentName)}${chalk.gray(versionStr)}:`);

    // Get composed subrules for the user scope
    let composedSubrules: ComposedSubrule[] = [];
    try {
      const composed = composeRulesFromState({ cwd });
      composedSubrules = composed.subrules;
    } catch {
      // No preset configured or rules.yaml missing — show rules without subrule breakdown
    }

    for (const r of items) {
      let nameColor = chalk.cyan;
      if (r.syncState === 'synced') nameColor = chalk.green;
      else if (r.syncState === 'new') nameColor = chalk.blue;
      else if (r.syncState === 'modified') nameColor = chalk.yellow;
      else if (r.syncState === 'deleted') nameColor = chalk.red;

      const linkedName = r.path ? termLink(r.name, linkTarget(r.path)) : r.name;
      let display = nameColor(linkedName);
      if (r.ruleCount !== undefined) display += chalk.gray(` (${r.ruleCount} rules)`);
      const sourceTag = r.scope === 'project' ? chalk.blue('[project]')
        : r.scope === 'user' ? chalk.cyan('[user]')
        : chalk.gray('[system]');
      display += ` ${sourceTag}`;
      const syncStr = r.syncState ? chalk.gray(` [${r.syncState}]`) : '';
      console.log(`    ${display}${syncStr}`);

      // Show subrules for user-scope rules (the compiled CLAUDE.md)
      if (r.scope === 'user' && composedSubrules.length > 0) {
        for (const sub of composedSubrules) {
          const scopeLabel = sub.layerScope === 'project' ? chalk.blue('[project]')
            : sub.layerScope === 'user' ? chalk.cyan('[user]')
            : sub.layerScope === 'extra' ? chalk.magenta(`[${sub.layerAlias || 'extra'}]`)
            : chalk.gray('[system]');
          const linkedSubName = termLink(sub.name, sub.sourcePath);
          console.log(`      ${chalk.gray('-')} ${linkedSubName} ${scopeLabel}`);
        }
      }
    }
  }
  if (shouldRenderSection('rules', filter)) {
    renderRulesSection();
  }

  if (shouldRenderSection('hooks', filter)) {
    renderSection('Hooks', agentData.hooks);
  }
  if (shouldRenderSection('promptcuts', filter)) {
    renderPromptcuts();
  }
  if (shouldRenderSection('clis', filter)) {
    renderHostClisSection(cwd);
  }

  // Show legend at the end if git repo exists and we showed all sections.
  // Filtered single-section views skip it — noise for promptcuts or plugins.
  if (hasGitRepo && !anyFilterSet) {
    console.log();
    console.log(chalk.gray('Legend:'), chalk.green('Tracked'), chalk.blue('Local-only'), chalk.yellow('Modified'), chalk.red('Deleted'));
  }
}

const ALL_RESOURCE_SECTIONS: ResourceSection[] = ['commands', 'skills', 'mcp', 'memory', 'hooks', 'workflows', 'plugins'];

type ResourceSyncType = 'commands' | 'skills' | 'hooks' | 'memory';

/** Git sync-state for the four tracked resource kinds, loaded once from ~/.agents. */
interface ResourceSyncData {
  hasGitRepo: boolean;
  commands: Awaited<ReturnType<typeof getGitSyncStatus>>;
  skills: Awaited<ReturnType<typeof getGitSyncStatus>>;
  hooks: Awaited<ReturnType<typeof getGitSyncStatus>>;
  memory: Awaited<ReturnType<typeof getGitSyncStatus>>;
}

/** Load git sync-state for the tracked resource kinds. Shared by the human
 *  detail view (showAgentResources) and the `--json --resources` path. */
async function loadResourceSyncData(): Promise<ResourceSyncData> {
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

/** Resolve one resource's git sync-state. Extracted from showAgentResources so
 *  the human view and the JSON path derive drift identically. */
function resolveResourceSyncState(
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
    // Rules files: map agent-specific name (CLAUDE.md) back to canonical (AGENTS.md)
    const centralName = getCentralRulesFileName(agentId);
    relativePath = `rules/${centralName}`;
  }

  const matchesPath = (f: string) => f === relativePath || f.startsWith(relativePath + '/');

  if (syncStatus.new.some(matchesPath) || syncStatus.staged.some(matchesPath)) return 'new';
  if (syncStatus.modified.some(matchesPath)) return 'modified';
  if (syncStatus.deleted.some(matchesPath)) return 'deleted';
  if (syncStatus.synced.some(matchesPath)) return 'synced';
  // Not in any array = local-only (untracked with no files)
  return 'new';
}

/** Collect one version's resources for `--json`, limited to `sections`. Scans
 *  the version's `home`, so per-version differences are reported accurately. */
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
      // ruleCount of 0 is noise — every skill has 0 unless it ships subrules.
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

/** Build the set of resource sections to include in `--json` from the
 *  `--resources` / `--detailed` flags, plus (in --json mode) the per-section
 *  boolean filters (`--skills` etc.) that plain `--json` historically ignored. */
export function parseResourceSections(
  options: { resources?: string | boolean; detailed?: boolean } & ViewSectionFilter,
  jsonMode: boolean,
): Set<ResourceSection> {
  const set = new Set<ResourceSection>();
  const addAll = () => ALL_RESOURCE_SECTIONS.forEach((s) => set.add(s));

  if (options.detailed) addAll();

  const rv = options.resources;
  if (rv !== undefined) {
    if (rv === true || String(rv).trim() === '' || String(rv).toLowerCase() === 'all') {
      addAll();
    } else {
      for (const raw of String(rv).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
        const section = raw === 'rules' ? 'memory' : raw; // --rules is the memory file
        if ((ALL_RESOURCE_SECTIONS as string[]).includes(section)) set.add(section as ResourceSection);
      }
    }
  }

  if (jsonMode) {
    const flagToSection: Array<[keyof ViewSectionFilter, ResourceSection]> = [
      ['commands', 'commands'], ['skills', 'skills'], ['mcp', 'mcp'],
      ['workflows', 'workflows'], ['plugins', 'plugins'], ['hooks', 'hooks'], ['rules', 'memory'],
    ];
    for (const [flag, section] of flagToSection) if (options[flag]) set.add(section);
  }

  return set;
}

/**
 * Collect structured info for one or more agents without rendering to the
 * terminal. Used by `--json` output and any programmatic consumer (e.g. the
 * agents-cli extension's "resume current session in best available version"
 * command).
 */
export async function collectAgentsJson(
  filterAgentId?: AgentId,
  resourceSections?: Set<ResourceSection>,
  opts?: { forceRefresh?: boolean },
): Promise<ViewJsonAgent[]> {
  const agentsToShow = filterAgentId ? [filterAgentId] : ALL_AGENT_IDS;
  const authCache = readAuthHealthCache();
  const host = machineId();
  const wantResources = !!resourceSections && resourceSections.size > 0;
  // Only pay for the git-status + resource scans when resources were requested.
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
      // Prefer a plan the live usage fetch surfaced (Kimi reports membership
      // tier in /usages; its local auth file has none) and fall back to the
      // account-derived plan (Claude's billingType).
      plan: usageByKey.get(key)?.snapshot?.plan ?? canon.plan,
      // Throttle state comes from the live usage windows, not the pay-as-you-go
      // overage flag that AccountInfo.usageStatus used to carry. A maxed window
      // means rate-limited; no snapshot means no badge. See
      // deriveUsageStatusFromSnapshot.
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
      // The strict per-version launch truth (vs the display `signedIn` above,
      // which inherits the active/global HOME login). The same primitive
      // `collectRunCandidates` uses locally, so remote `--device auto` placement
      // is gated on identical launchability (PHNX-3466).
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

  // Keep filtered native JSON consistent with the text view: custom forks are
  // not children of the native harness they execute through.
  const harnesses = filterAgentId ? [] : getHarnesses();
  const catalog = await loadAccountCatalog();
  const note = secretsUnavailableNote(catalog);
  if (note) console.error(chalk.yellow(note)); // stderr — never corrupts --json stdout
  const out: ViewJsonAgent[] = [];
  for (const agentId of agentsToShow) {
    const versions = byAgent.get(agentId) ?? [];
    versions.sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return compareVersions(b.version, a.version);
    });
    // Project through the public JSON v2 serializer — the internal catalog row
    // (identityKey, home, installations) is not the machine contract.
    const accounts = accountListJson(
      catalog.native.filter((row) => row.agent === agentId),
      catalog.provider.filter((row) => row.harnesses.includes(agentId)),
      agentId,
    ).accounts;
    out.push({ agent: agentId, versions, accounts, harnesses: harnesses.filter((h) => h.agent === agentId) });
  }
  return out;
}

interface PrunePlanEntry {
  agentId: AgentId;
  version: string;
  email: string;
  keeper: string;
  isDefault: boolean;
  /**
   * 'duplicate'    — older version sharing an email with a newer install.
   * 'home-leftover' — home-only dir left over after a previous removeVersion;
   *                   no binary, but transcripts may still live here.
   */
  reason: 'duplicate' | 'home-leftover';
}

interface AgentPrunePlan {
  agentId: AgentId;
  toPrune: PrunePlanEntry[];
}

/**
 * Identity key for duplicate-install detection. Prefers accountKey — which
 * encodes account AND org — over the bare email: two installs can share an
 * email yet belong to different orgs (a personal Max plan and a Team seat),
 * and grouping those by email alone would propose pruning a live account.
 * Falls back to the lowercased email for agents whose credentials expose no
 * identity key. Null when there is no usable identity.
 */
export function pruneGroupKey(
  info: Pick<AccountInfo, 'accountKey' | 'email'>
): string | null {
  return info.accountKey ?? info.email?.toLowerCase() ?? null;
}

/** One installed home, reduced to the fields duplicate detection needs. */
export interface PruneCandidate {
  /** The version-dir label (opaque slot id). */
  version: string;
  /** The RUNNING release inside the home (installation.releaseVersion), or the label. */
  release: string;
  email: string | null;
  /** Present only once the home's native identity is captured (claude: account+org). */
  accountKey: string | null;
  signedIn: boolean;
  hasBinary: boolean;
}

/** A duplicate home to retire, and the keeper it collapses into. */
export interface DuplicatePruneEntry {
  version: string;
  email: string;
  keeper: string;
}

/**
 * PURE duplicate-home detection: given every installed home for one agent, decide
 * which are redundant duplicates of the SAME logical account and which single home
 * to keep per account. Extracted from buildAgentPrunePlan so the keeper/merge rules
 * are unit-tested without touching disk.
 *
 * Two rules, both conservative:
 *  - GROUPING. A home with a captured `accountKey` groups by it (account+org, so a
 *    personal Max and a Team seat on the same email stay separate). A home with NO
 *    accountKey folds into a same-email account ONLY when a sibling home for that
 *    email IS identified — that email-only home is an incompletely-captured re-login
 *    of the known account, not a distinct seat (PHNX-3887). Otherwise it groups by
 *    its bare email and only ever collapses against another equally-bare home.
 *  - KEEPER. Within a group the keeper is the home that best represents the account:
 *    captured identity first, then a signed-in credential, then the newest RUNNING
 *    release, then the highest dir label as a stable tiebreak. This is deliberately
 *    NOT "highest dir-name semver" — in the wild that is the freshly re-logged-in
 *    duplicate that never captured its identity or usage, and keeping it while
 *    trashing the identified home is the exact bug this replaces.
 */
export function planDuplicatePrune(candidates: PruneCandidate[]): DuplicatePruneEntry[] {
  // Only installs with a working binary compete for "the live install for this account".
  const installed = candidates.filter((c) => c.hasBinary && c.email);

  // email -> every DISTINCT captured accountKey seen for it. An email-only home
  // folds into an identified account only when that email maps to EXACTLY ONE
  // account; when two distinct orgs share the email (the Personal+Team case) the
  // fold is ambiguous, so the identity-less home is left ungrouped rather than
  // guessed into one — guessing could retire the actually-working re-login of the
  // OTHER org (the exact bug this function exists to prevent, one level up).
  const emailToAccountKeys = new Map<string, Set<string>>();
  for (const c of installed) {
    if (!c.accountKey) continue;
    const email = c.email!.toLowerCase();
    (emailToAccountKeys.get(email) ?? emailToAccountKeys.set(email, new Set()).get(email)!).add(c.accountKey);
  }
  const groupKeyFor = (c: PruneCandidate): string | null => {
    if (c.accountKey) return c.accountKey;
    const email = c.email?.toLowerCase();
    const keys = email ? emailToAccountKeys.get(email) : undefined;
    if (keys && keys.size === 1) return [...keys][0];
    // ≥2 identified orgs on this email: never merge the ambiguous home. A unique
    // key makes it its own singleton group (length 1 → never pruned).
    if (keys && keys.size >= 2) return `ambiguous:${c.email!.toLowerCase()}:${c.version}`;
    // No identified sibling at all: group equally-bare homes by email as before.
    return pruneGroupKey(c);
  };

  const byAccount = new Map<string, PruneCandidate[]>();
  for (const c of installed) {
    const key = groupKeyFor(c);
    if (!key) continue;
    (byAccount.get(key) ?? byAccount.set(key, []).get(key)!).push(c);
  }

  const rank = (c: PruneCandidate): [number, number] => [c.accountKey ? 1 : 0, c.signedIn ? 1 : 0];
  const better = (a: PruneCandidate, b: PruneCandidate): number => {
    const [aa, ab] = rank(a);
    const [ba, bb] = rank(b);
    if (aa !== ba) return ba - aa;
    if (ab !== bb) return bb - ab;
    if (a.release !== b.release) return compareVersions(b.release, a.release);
    return compareVersions(b.version, a.version);
  };

  const out: DuplicatePruneEntry[] = [];
  for (const group of byAccount.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(better);
    const keeper = sorted[0].version;
    for (const dup of sorted.slice(1)) {
      out.push({ version: dup.version, email: dup.email as string, keeper });
    }
  }
  return out;
}

async function buildAgentPrunePlan(agentId: AgentId): Promise<AgentPrunePlan> {
  const dirInfos = listInstalledVersionDirs(agentId);
  const entries = await Promise.all(
    dirInfos.map(async ({ version, hasBinary }) => {
      const home = getVersionHomePath(agentId, version);
      const info = await getAccountInfo(agentId, home);
      const release = readInstallation(agentId, version)?.releaseVersion ?? version;
      return { version, info, hasBinary, release };
    })
  );

  const globalDefault = getGlobalDefault(agentId);
  const toPrune: PrunePlanEntry[] = [];

  for (const d of planDuplicatePrune(
    entries.map((e) => ({
      version: e.version,
      release: e.release,
      email: e.info.email,
      accountKey: e.info.accountKey,
      signedIn: e.info.signedIn,
      hasBinary: e.hasBinary,
    })),
  )) {
    toPrune.push({
      agentId,
      version: d.version,
      email: d.email,
      keeper: d.keeper,
      // The default may itself be a to-be-retired duplicate (a freshly created
      // home often becomes the global default). We do NOT skip it: executePrune
      // repoints the default onto the keeper first, then retires the duplicate.
      isDefault: d.version === globalDefault,
      reason: 'duplicate',
    });
  }

  // Home-only leftovers: dirs without a binary. These are residue from a
  // prior removeVersion before the soft-delete migration, plus any hand-edited
  // installs. Surface them so the user can move them to trash.
  for (const e of entries) {
    if (e.hasBinary) continue;
    if (e.version === globalDefault) continue; // never auto-suggest the default
    toPrune.push({
      agentId,
      version: e.version,
      email: e.info.email || '',
      keeper: '',
      isDefault: false,
      reason: 'home-leftover',
    });
  }

  return { agentId, toPrune };
}

export async function executePrunePlan(plan: AgentPrunePlan): Promise<Array<{ agent: AgentId; version: string }>> {
  const moved: Array<{ agent: AgentId; version: string }> = [];
  // Repoint the global default onto the keeper BEFORE retiring a duplicate that
  // currently holds it, so consolidation collapses the duplicate instead of
  // leaving it pinned as the default (and so removeVersion's own fallback never
  // has to guess a replacement).
  for (const p of plan.toPrune) {
    if (p.reason === 'duplicate' && p.isDefault && p.keeper && p.keeper !== p.version) {
      setGlobalDefault(p.agentId, p.keeper);
      console.log(chalk.gray(`Default ${agentLabel(p.agentId)} moved ${p.version} → ${p.keeper} (keeper) before pruning the duplicate.`));
    }
  }
  for (const p of plan.toPrune) {
    const ok = removeVersion(p.agentId, p.version);
    if (ok) {
      console.log(chalk.green(`Moved ${agentLabel(p.agentId)}@${p.version} to trash`));
      moved.push({ agent: p.agentId, version: p.version });
    } else {
      console.log(chalk.yellow(`Already gone: ${agentLabel(p.agentId)}@${p.version}`));
    }
  }
  if (listInstalledVersions(plan.agentId).length === 0) {
    removeShim(plan.agentId);
  }
  return moved;
}

function printPrunePlan(plan: AgentPrunePlan, isFirst: boolean): void {
  if (plan.toPrune.length === 0) return;
  const heading = isFirst ? `Will move to trash for ${agentLabel(plan.agentId)}:` : `Also found candidates for ${agentLabel(plan.agentId)}:`;
  console.log(chalk.bold(heading));
  for (const p of plan.toPrune) {
    if (p.reason === 'duplicate') {
      console.log(
        `  ${agentLabel(p.agentId)}@${p.version}  ${chalk.cyan(p.email)}  ` +
        chalk.gray(`— duplicate, keeping ${p.agentId}@${p.keeper}`)
      );
    } else {
      console.log(
        `  ${agentLabel(p.agentId)}@${p.version}  ` +
        chalk.gray(`— home-only leftover (no binary; transcripts preserved in trash)`)
      );
    }
  }
  console.log();
}

/**
 * Consolidate to one home per logical account: retire the redundant duplicate
 * homes an account accumulated, keeping the single home that best represents it
 * (see {@link planDuplicatePrune} for the keeper/merge rules). When the retired
 * duplicate holds the global default, the default is first repointed onto the
 * keeper, so consolidation collapses it instead of leaving it pinned.
 *
 * When filterAgentId is set, prunes that agent first, then cascades: after
 * each agent, offers the next agent with duplicates. User answering "no"
 * stops the chain.
 */
export async function pruneDuplicates(
  filterAgentId: AgentId | undefined,
  yes: boolean,
  dryRun: boolean
): Promise<void> {
  const ordered: AgentId[] = filterAgentId
    ? [filterAgentId, ...ALL_AGENT_IDS.filter((a) => a !== filterAgentId)]
    : [...ALL_AGENT_IDS];

  const spinner = ora({ text: 'Scanning installed versions...', isSilent: !process.stdout.isTTY }).start();
  const plans = await Promise.all(ordered.map((a) => buildAgentPrunePlan(a)));
  spinner.stop();

  const actionable = plans.filter((p) => p.toPrune.length > 0);

  if (actionable.length === 0) {
    console.log(chalk.gray('Nothing to prune — no duplicate-account installs and no home-only leftovers.'));
    return;
  }

  const totalCandidates = actionable.reduce((n, plan) => n + plan.toPrune.length, 0);
  const allMoved: Array<{ agent: AgentId; version: string }> = [];
  let isFirst = true;
  let processedAny = false;

  for (const plan of actionable) {
    printPrunePlan(plan, isFirst);

    if (dryRun) {
      processedAny = true;
      isFirst = false;
      continue;
    }

    if (!yes) {
      if (!isInteractiveTerminal()) {
        console.log(chalk.red('Refusing to prune in a non-interactive shell without --yes.'));
        if (filterAgentId) {
          console.log(chalk.gray(`Re-run with: agents prune cleanup ${filterAgentId} --dry-run`));
        } else {
          console.log(chalk.gray('Re-run with: agents prune cleanup --dry-run'));
        }
        process.exit(1);
      }
      const n = plan.toPrune.length;
      const message = isFirst
        ? `Prune ${n} ${agentLabel(plan.agentId)} version${n === 1 ? '' : 's'}?`
        : `Also prune ${n} ${agentLabel(plan.agentId)} version${n === 1 ? '' : 's'}?`;
      let proceed = false;
      try {
        proceed = await confirm({ message, default: false });
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.gray('Cancelled'));
          break;
        }
        throw err;
      }
      if (!proceed) {
        console.log(chalk.gray('Stopping here.'));
        break;
      }
    }

    allMoved.push(...(await executePrunePlan(plan)));
    processedAny = true;
    isFirst = false;
    console.log();
  }

  if (dryRun) {
    console.log(chalk.gray(`${totalCandidates} version${totalCandidates === 1 ? '' : 's'} would be pruned. Run without --dry-run to delete.`));
    return;
  }

  if (processedAny) {
    console.log(chalk.bold(`Pruned ${allMoved.length} version${allMoved.length === 1 ? '' : 's'}.`));
    printTrashFooter(allMoved);
  }
}

/**
 * Main view action handler.
 * Exported for use by deprecated aliases.
 */
export async function viewAction(
  agentArg?: string,
  options?: {
    json?: boolean;
    versions?: boolean;
    prune?: boolean;
    yes?: boolean;
    dryRun?: boolean;
    resources?: string | boolean;
    detailed?: boolean;
    refresh?: boolean;
    live?: boolean;
    merged?: boolean;
  } & ViewSectionFilter,
): Promise<void> {
  // --merged renders the cross-layer, first-wins resource surface (the former
  // `agents resources`), independent of the per-version detail view below.
  if (options?.merged) {
    renderMergedResources();
    return;
  }
  // --live is a shorter-to-type alias of --refresh; both force a live probe.
  const forceRefresh = options?.refresh === true || options?.live === true;
  // --resources / --detailed imply --json (they only shape structured output).
  const explicitResources = options?.detailed === true || options?.resources !== undefined;
  const json = options?.json === true || explicitResources;
  const resourceSections = parseResourceSections(options ?? {}, json);
  const prune = options?.prune === true;
  const yes = options?.yes === true;
  const dryRun = options?.dryRun === true;
  const filter: ViewSectionFilter = {
    commands: options?.commands,
    skills: options?.skills,
    mcp: options?.mcp,
    workflows: options?.workflows,
    plugins: options?.plugins,
    rules: options?.rules,
    hooks: options?.hooks,
    promptcuts: options?.promptcuts,
    clis: options?.clis,
  };
  const filterIsSet = SECTION_KEYS.some((k) => filter[k]);

  // RUSH-1320: fold any stale literal `latest` version-home into its concrete
  // version before rendering, so it stops appearing as a bogus "version" next
  // to the real ones. Best-effort — must never break `agents view`. Scoped to
  // the queried agent when one is given (cheap no-op for agents with no
  // `latest` dir, i.e. almost all of them).
  {
    const target = agentArg ? resolveAgentName(agentArg.split('@')[0]) : null;
    const toReconcile = agentArg ? (target ? [target] : []) : ALL_AGENT_IDS;
    await Promise.all(toReconcile.map((a) => reconcileStaleLatestForAgent(a).catch(() => {})));
  }

  if (!agentArg) {
    if (prune) {
      await pruneDuplicates(undefined, yes, dryRun);
      return;
    }
    if (json) {
      const data = await collectAgentsJson(undefined, resourceSections, { forceRefresh });
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    await showInstalledVersions(undefined, { forceRefresh, versions: options?.versions });
    return;
  }

  // Parse agent@version syntax
  const parts = agentArg.split('@');
  const agentName = parts[0];

  // Match run resolution: an exact custom harness name wins over a native id or
  // alias with the same spelling, so every fork remains independently viewable.
  if (profileExists(agentName)) {
    const harness = profileSummary(readProfile(agentName));
    if (json) {
      console.log(JSON.stringify(harness, null, 2));
      return;
    }
    renderHarnessDetail(agentName);
    return;
  }

  const agentId = resolveAgentName(agentName);
  if (!agentId) {
    if (json) {
      console.log(JSON.stringify({ error: formatAgentError(agentName) }));
      process.exit(1);
    }
    console.log(chalk.red(formatAgentError(agentName)));
    process.exit(1);
  }
  // Resolve the @version filter through the agent-spec engine:
  //   bare/@any → null (show all versions), @default/@pinned → 'default'
  //   (showAgentResources handles it), @latest/@oldest/@x.y.z → concrete.
  let requestedVersion: string | null;
  try {
    requestedVersion = resolveVersionFilter(agentId, parts[1]).version;
  } catch (e) {
    if (e instanceof AgentSpecError) {
      if (json) {
        console.log(JSON.stringify({ error: e.message }));
      } else {
        console.log(chalk.red(e.message));
      }
      process.exit(1);
    }
    throw e;
  }

  if (prune) {
    if (requestedVersion) {
      console.log(chalk.red('--prune does not take a @version suffix.'));
      console.log(chalk.gray(`Run: agents view ${agentId} --prune`));
      process.exit(1);
    }
    await pruneDuplicates(agentId, yes, dryRun);
    return;
  }

  if (json) {
    // --json ignores the @version suffix, but --resources/--detailed (or a
    // section flag) now attach each version's resource inventory + sync-state.
    const data = await collectAgentsJson(agentId, resourceSections, { forceRefresh });
    console.log(JSON.stringify(data[0] ?? { agent: agentId, versions: [], harnesses: [] }, null, 2));
    return;
  }

  if (requestedVersion) {
    // Specific version requested: show detailed resources
    await showAgentResources(agentId, requestedVersion, filter);
  } else if (filterIsSet) {
    // `agents view claude --skills` → fall through to detail view on default.
    // Section filters only make sense for the per-version detail view.
    await showAgentResources(agentId, 'default', filter);
  } else {
    await showInstalledVersions(agentId, { forceRefresh, versions: options?.versions });
  }
}

/** Register the `agents view` command. */
export function registerViewCommand(program: Command): void {
  addHostOption(program.command('view [agent]'))
    .description('Show your agents, connected accounts, and usage.')
    .addOption(new Option('--versions', 'Show every installation, actual release, account, model, and home path (legacy diagnostic surface).').hideHelp())
    .option('--json', 'Emit machine-readable JSON (accounts plus backward-compatible installation list).')
    .option('--resources [sections]', 'In --json mode, include each version\'s resources: "all" (default) or a comma list (skills,plugins,mcp,commands,workflows,memory,hooks). Implies --json.')
    .option('--detailed', 'Include all resources in --json output (alias for --resources all). Implies --json.')
    .option('-r, --refresh', 'Force a live usage refresh, bypassing the cache (slower). Repopulates the S:/W: limit bars for every account whose token is reachable.')
    .option('--live', 'Alias of --refresh (shorter to type).')
    .option('--prune', 'Remove older installed versions that share an account with a newer installed version. Skips the global default.')
    .option('--dry-run', 'With --prune, show duplicate versions without deleting')
    .option('-y, --yes', 'Skip the prune confirmation prompt.')
    .option('--commands', 'Show only commands in the detail view.')
    .option('--skills', 'Show only skills in the detail view.')
    .option('--mcp', 'Show only MCP servers in the detail view.')
    .option('--workflows', 'Show only workflows in the detail view.')
    .option('--plugins', 'Show only plugins in the detail view.')
    .option('--rules', 'Show only rules in the detail view.')
    .option('--hooks', 'Show only hooks in the detail view.')
    .option('--promptcuts', 'Show only promptcuts in the detail view.')
    .option('--clis', 'Show only host CLIs (declared in clis/, installed to PATH).')
    .option('--merged', 'Show the merged, first-wins resource surface across all layers (project, user, extras, system) in one table with the winning layer per row.')
    .addHelpText('after', `
Examples:
  # Show installed agents with connected accounts and usage
  agents view

  # Show accounts for one agent
  agents view claude

  # Describe one custom harness (host, model, provider, auth, path)
  agents view deepseek-flash

  # Detailed view: resources, commands, skills, MCP servers for a specific version
  agents view claude@2.1.112
  agents view claude@default

  # Machine-readable output (used by tools that pick a version programmatically)
  agents view claude --json

  # One call: full inventory + what's synced on a host (installed agents,
  # versions, accounts, usage, and per-version resource sync-state)
  agents view claude --device yosemite-s0 --json --resources all
  agents view claude --json --resources skills,plugins   # just those sections

  # Prune older versions that duplicate an account already used by a newer version
  agents view --prune --dry-run
  agents view claude --prune
  agents view claude --prune -y

  # Filter the detail view to a single section (combinable)
  agents view claude@default --skills
  agents view claude@default --plugins --workflows
  agents view claude --commands    # implicitly the default version

  # Merged, first-wins resource surface across all layers, with the winning layer
  agents view --merged

When to use:
  - Checking which agents and accounts are connected on this device
  - Seeing the selected default account and each account's usage
  - Inspecting commands, skills, hooks, and MCP servers synced to a version
  - Verifying a version is installed before running it
  - Cleaning up stale versions left behind after upgrading (--prune)

Output:
  - Without arguments: table of all agents with accounts, connection state, usage,
    then one block per custom harness (see 'agents harness')
  - With agent name: one row per native identity, showing the default account
  - With a custom harness name: that harness's host, model, provider, and auth
  - With agent@version: detailed breakdown of resources synced to that version
  - With --json: structured JSON with version, isDefault, signedIn, authVerdict,
    email, plan, usageStatus, per-window usedPercent, lastActive, and path
  - With --prune: plan of which older versions will be removed, then confirm
  - With --prune --dry-run: preview only, no deletions
`)
    .action((
      agentArg: string | undefined,
      options: {
        json?: boolean;
        versions?: boolean;
        prune?: boolean;
        yes?: boolean;
        dryRun?: boolean;
        resources?: string | boolean;
        detailed?: boolean;
        refresh?: boolean;
        merged?: boolean;
      } & ViewSectionFilter,
    ) => viewAction(agentArg, options));
}
