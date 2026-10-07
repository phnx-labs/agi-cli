import type { Command } from 'commander';
import { IsolationBoundaryError } from '../lib/installations/shims.js';
import { explainIsolationBoundary } from '../lib/isolation-boundary-report.js';
import { addHostOption } from '../lib/hosts/option.js';
import { buildRemoteAgentsInvocation } from '../lib/hosts/remote-cmd.js';
import { loadDevices } from '../lib/devices/registry.js';
import { fanOutDevices, planFleetTargets, remoteFleetTargets, type FanOutDeviceTarget } from '../lib/devices/fleet.js';
import { enterDoctorOverviewGate, writeDoctorOverviewCache } from '../lib/devices/doctor-overview-cache.js';
import { fleetDialTarget } from '../lib/devices/connect.js';
import { compareFleetInventories, FLEET_HOOK_RUNTIME_STATES, type FleetInventory, type FleetVersionSignIn } from '../lib/devices/fleet-divergence.js';
import { collectLocalFleetInventory } from '../lib/devices/fleet-inventory.js';
import {
  buildLocalFindings,
  fleetDivergenceToFindings,
  hookRuntimeToFindings,
  signInToFindings,
  renderFindings,
  remediationFor,
  FINDING_SEVERITY,
  type DoctorFinding,
  type LocalFindingInputs,
} from '../lib/devices/doctor-findings.js';
import { getCliVersion } from '../lib/version.js';
import { resolveHost } from '../lib/hosts/registry.js';
import { sshExecAsync } from '../lib/ssh-exec.js';
import { hostIdentityArgs, sshTargetFor } from '../lib/hosts/types.js';
import { deviceIdentityArgs } from '../lib/devices/connect.js';
import { machineId, normalizeHost } from '../lib/session/sync/config.js';
import { findAmbiguousDevicePins } from '../lib/scheduling/routines.js';
import { findLeakedDaemons } from '../lib/daemon/leaked-daemons.js';
import chalk from 'chalk';
import { checkAllClis, collectTeamsDoctorData, type TeamsDoctorEntry } from '../lib/teams/agents.js';
import { AGENTS, ALL_AGENT_IDS, resolveAgentName, formatAgentError, getAccountInfo, type AccountInfo } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import {
  getVersionHomePath,
  listInstalledVersions,
} from '../lib/installations/versions.js';
import { resolveAgentTargets, AgentSpecError } from '../lib/agent-spec/index.js';
import { loadManifest, isStale } from '../lib/staleness/index.js';
import {
  diffVersionResources,
  DOCTOR_ALL_KINDS,
  type DoctorKind,
  type ResourceDiff,
  type VersionResourceReport,
} from '../lib/doctor-diff.js';
import { inspectDuplicateVersionHooks, type DuplicateVersionHook, type HookWiringReport } from '../lib/hooks/install.js';
import { inspectReservedAuthBundle } from '../lib/secrets-policy.js';
import { isVersionIsolated } from '../lib/installations/versions.js';
import { computeDrift, checkSyncStatus, countOrphans, computeSourceBehind, type SyncStatusRow, type OrphanRow } from '../lib/drift.js';
import { readAuthHealthCache, summarizeHostAuth } from '../lib/auth-health.js';
import { resolveOwnerCredential } from '../lib/owner-notify.js';
import { unifiedDiff, colorizeUnifiedDiff } from '../lib/diff-text.js';
import { listCliStatus, listCliStatusAsync } from '../lib/cli-resources.js';
import { setHelpSections } from '../lib/help.js';
import { getEffectiveExecutionPolicy } from '../lib/platform/winpath.js';
import { auditWindowsSshEnrollment, diagnoseWindowsSshFailure } from '../lib/devices/windows-ssh-enrollment.js';
import {
  scanUserRcFilesSync,
  masterPassphraseInEnvSync,
  isSecretsTransportError,
} from '../lib/secrets-client.js';
import { terminalWidth, truncateToWidth, stringWidth, padToWidth } from '../lib/session/width.js';
import { readRepoBehindMarkers, type FetchStatusMarker } from '../lib/auto-pull.js';
import { detectAgentsBinaryShadows } from '../lib/binary-shadow.js';
import * as fs from 'fs';
import * as path from 'path';

const AGENT_NAMES: Record<string, string> = Object.fromEntries(
  ALL_AGENT_IDS.map((id) => [id, AGENTS[id].name]),
);

interface DoctorOptions {
  refresh?: boolean;
  json?: boolean;
  diff?: boolean;
  kind?: string;
  cwd?: string;
  adopt?: string;
  release?: string;
  device?: string;
  devices?: boolean;
  check?: boolean;
  quiet?: boolean;
}


function scanUserRcFiles(): ReturnType<typeof scanUserRcFilesSync> {
  try {
    return scanUserRcFilesSync();
  } catch (error) {
    if (isSecretsTransportError(error)) return [];
    throw error;
  }
}

function masterPassphraseInEnv(): boolean {
  try {
    return masterPassphraseInEnvSync();
  } catch (error) {
    if (isSecretsTransportError(error)) return false;
    throw error;
  }
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function wrapLine(prefix: string, text: string, width = terminalWidth()): string[] {
  const words = collapseWhitespace(text).split(' ').filter(Boolean);
  if (words.length === 0) return [prefix.trimEnd()];
  const continuation = ' '.repeat(stringWidth(prefix));
  const lines: string[] = [];
  let linePrefix = prefix;
  let line = prefix;
  let hasWord = false;
  for (const word of words) {
    const room = Math.max(1, width - stringWidth(linePrefix));
    const piece = stringWidth(word) > room ? truncateToWidth(word, room) : word;
    const candidate = hasWord ? `${line} ${piece}` : `${line}${piece}`;
    if (hasWord && stringWidth(candidate) > width) {
      lines.push(line);
      linePrefix = continuation;
      line = continuation + piece;
      hasWord = true;
    } else {
      line = candidate;
      hasWord = true;
    }
  }
  lines.push(line);
  return lines;
}

function toHostCliInput(
  status: ReturnType<typeof listCliStatus>,
): NonNullable<LocalFindingInputs['hostClis']> {
  return {
    statuses: status.statuses.map((c) => ({ name: c.manifest.name, installed: c.installed })),
    errors: status.errors.map((e) => ({ file: e.file, reason: e.reason })),
  };
}

function printWrappedLine(prefix: string, text: string): void {
  for (const line of wrapLine(prefix, text)) console.log(chalk.gray(line));
}




interface DeviceDoctorResult {
  name: string;
  online: boolean;
  error?: string;
  agents: Record<string, TeamsDoctorEntry>;
  inventory?: FleetInventory;
  secretFindings?: DoctorFinding[];
}

interface RemoteDoctorPayload {
  inventory: FleetInventory | null;
  secretFindings: DoctorFinding[];
}

/**
 * Narrow a remote `findings` array to rows only that device can observe.
 *
 * Deliberately NOT "forward every remote finding". The aggregator already
 * rebuilds a remote's sign-in rows from its inventory and its divergence rows
 * from the comparator, so forwarding wholesale would double them; and pulling a
 * remote's orphan/drift rows into a fleet readout is a much larger UX change
 * than this fix. These kinds are unrecomputable centrally: shell/process secret
 * hygiene and the Windows host's effective OpenSSH key path/content/ACL.
 *
 * **The remote contributes exactly one thing: the KIND.** Severity, message and
 * remediation are all generated HERE. That is not defensiveness for its own
 * sake — the remote runs its own agents-cli, whose version and integrity we do
 * not control, and each forwarded string is load-bearing in a different way:
 *
 *   - `remediation` is a command a human copies and runs. Accepting it from the
 *     wire is an injection channel, full stop.
 *   - `message` is the one place a secret VALUE could re-enter a readout that
 *     otherwise guarantees it never prints one. A local builder cannot leak what
 *     it never receives.
 *   - `severity` decides the CRITICAL section, so a remote could otherwise
 *     promote its own warning and bury real criticals under it.
 *   - `device` is overwritten with the name we dialled, so no box can pin a
 *     finding on another.
 *
 * The cost is detail: the fleet row says which box and which kind, not which
 * file and line. Run `agents doctor` on that box for the specifics — the
 * message says so.
 */
const REMOTE_FORWARDED_KINDS = ['rc-secret-export', 'env-secret-export', 'auth-bundle-wrong-backend', 'ssh-key-enrollment'] as const;
type RemoteForwardedKind = typeof REMOTE_FORWARDED_KINDS[number];

const REMOTE_SECRET_MESSAGE: Record<RemoteForwardedKind, string> = {
  'rc-secret-export': 'a credential-shaped export was found in this box\'s shell rc files'
    + ' — run `agents doctor` there for the file and line',
  'env-secret-export': 'AGENTS_SECRETS_PASSPHRASE is set in this box\'s process environment'
    + ' — run `agents doctor` there for detail',
  'auth-bundle-wrong-backend': "reserved secrets bundle 'auth' exists but is not file-backed"
    + ' — run `agents doctor` there to recreate it',
  'ssh-key-enrollment': 'Windows OpenSSH key enrollment is invalid'
    + ' — run `agents doctor` on this box for the effective path or ACL failure',
};

export function asRemoteSecretFindings(raw: unknown, device: string): DoctorFinding[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: DoctorFinding[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const kind = (item as Record<string, unknown>).kind;
    if (typeof kind !== 'string') continue;
    if (!(REMOTE_FORWARDED_KINDS as readonly string[]).includes(kind)) continue;
    if (seen.has(kind)) continue;
    seen.add(kind);
    const k = kind as RemoteForwardedKind;
    const base = {
      severity: FINDING_SEVERITY[k],
      kind: k as DoctorFinding['kind'],
      device,
      message: REMOTE_SECRET_MESSAGE[k],
    };
    out.push({ ...base, remediation: remediationFor({ ...base, remediation: '' }) });
  }
  return out;
}

interface FleetTarget {
  name: string;
  sshTarget: string;
  os?: string;
  extraSshArgs?: string[];
}

async function resolveFleetTargets(opts: DoctorOptions): Promise<FleetTarget[]> {
  const singleName = opts.device;
  if (singleName) {
    const registry = await loadDevices();
    const deviceProfile = registry[singleName];
    if (deviceProfile) {
      return [{
        name: deviceProfile.name,
        sshTarget: deviceProfile.name,
        os: deviceProfile.platform !== 'unknown' ? deviceProfile.platform : undefined,
        extraSshArgs: deviceIdentityArgs(deviceProfile),
      }];
    }
    const host = await resolveHost(singleName);
    if (host) {
      return [{ name: singleName, sshTarget: sshTargetFor(host), os: host.os, extraSshArgs: hostIdentityArgs(host) }];
    }
    console.error(chalk.red(`Unknown host or device '${singleName}'.`));
    process.exit(1);
  }

  const registry = await loadDevices();
  const localName = machineId();
  return Object.values(registry)
    .filter((d) => normalizeHost(d.name) !== localName)
    .map((d) => ({
      name: d.name,
      sshTarget: d.name,
      os: d.platform !== 'unknown' ? d.platform : undefined,
      extraSshArgs: deviceIdentityArgs(d),
    }));
}

async function probeFleetTarget(target: FleetTarget): Promise<DeviceDoctorResult> {
  const forwarded = ['teams', 'doctor', '--json'];
  const isWin = /^win/i.test((target.os ?? '').trim());
  const remoteCmd = buildRemoteAgentsInvocation(
    forwarded,
    undefined,
    isWin ? 'windows' : undefined,
    isWin ? undefined : { PATH: '$HOME/.agents/.cache/shims:$HOME/.local/bin:$PATH' },
  );
  const res = await sshExecAsync(target.sshTarget, remoteCmd, { timeoutMs: 30000, multiplex: true, extraSshArgs: target.extraSshArgs });
  if (res.code !== 0) {
    return {
      name: target.name,
      online: false,
      error: isWin
        ? diagnoseWindowsSshFailure(res.stderr, res.timedOut)
        : res.timedOut ? 'timed out' : (res.stderr || `exit ${res.code ?? 'unknown'}`),
      agents: {},
    };
  }
  try {
    const agents = JSON.parse(res.stdout) as Record<string, TeamsDoctorEntry>;
    return { name: target.name, online: true, agents };
  } catch (err: any) {
    const stderrHint = res.stderr ? ` stderr: ${res.stderr.trim()}` : '';
    return {
      name: target.name,
      online: true,
      error: `invalid JSON (${err?.message ?? 'parse error'})${stderrHint}`,
      agents: {},
    };
  }
}

export const FLEET_INVENTORY_TIMEOUT_MS = 180_000;

async function probeFleetInventory(target: FleetTarget): Promise<RemoteDoctorPayload | null> {
  const isWin = /^win/i.test((target.os ?? '').trim());
  const remoteCmd = buildRemoteAgentsInvocation(
    ['doctor', '--json'],
    undefined,
    isWin ? 'windows' : undefined,
    isWin ? undefined : { PATH: '$HOME/.agents/.cache/shims:$HOME/.local/bin:$PATH' },
  );
  const res = await sshExecAsync(target.sshTarget, remoteCmd, {
    timeoutMs: FLEET_INVENTORY_TIMEOUT_MS,
    multiplex: true,
    extraSshArgs: target.extraSshArgs,
  });
  if (res.code !== 0) return null;
  try {
    const parsed = JSON.parse(res.stdout) as { fleet?: unknown; findings?: unknown };
    return {
      inventory: asFleetInventory(parsed.fleet),
      secretFindings: asRemoteSecretFindings(parsed.findings, target.name),
    };
  } catch {
    return null;
  }
}

export function asFleetInventory(value: unknown): FleetInventory | null {
  const isMap = (x: unknown): x is Record<string, unknown> =>
    !!x && typeof x === 'object' && !Array.isArray(x);
  const isStringArray = (x: unknown): x is string[] =>
    Array.isArray(x) && x.every((e) => typeof e === 'string');

  if (!isMap(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isMap(v.resources) || !Object.values(v.resources).every(isStringArray)) return null;
  if (!isMap(v.agentVersions) || !Object.values(v.agentVersions).every(isStringArray)) return null;
  const isRepoState = (x: unknown): boolean =>
    x === null
    || (isMap(x)
      && (x.branch === null || typeof x.branch === 'string')
      && (x.head === null || typeof x.head === 'string')
      && typeof x.dirty === 'boolean');
  if (!isMap(v.repos) || !Object.values(v.repos).every(isRepoState)) return null;
  if (v.signIn !== undefined) {
    if (!isMap(v.signIn)) return null;
    const isSignInRow = (r: unknown): boolean =>
      isMap(r)
      && typeof r.version === 'string'
      && typeof r.signedIn === 'boolean'
      && typeof r.provable === 'boolean'
      && (r.account === null || typeof r.account === 'string');
    const rowsOk = Object.values(v.signIn).every(
      (rows) => Array.isArray(rows) && rows.every(isSignInRow),
    );
    if (!rowsOk) return null;
  }

  if (v.hookRuntime !== undefined) {
    if (!isMap(v.hookRuntime)) return null;
    const validStates = new Set<string>(FLEET_HOOK_RUNTIME_STATES);
    const agentVersions = v.agentVersions as Record<string, string[]>;
    const hookRuntime = v.hookRuntime as Record<string, Record<string, unknown>>;
    const expectedAgents = Object.keys(agentVersions);
    if (Object.keys(hookRuntime).length !== expectedAgents.length) return null;
    for (const agent of expectedAgents) {
      if (!ALL_AGENT_IDS.includes(agent as AgentId)) return null;
      const states = hookRuntime[agent];
      const versions = agentVersions[agent];
      if (!isMap(states) || Object.keys(states).length !== versions.length) return null;
      const expectedVersions = new Set(versions);
      for (const [version, state] of Object.entries(states)) {
        if (!expectedVersions.has(version) || typeof state !== 'string' || !validStates.has(state)) return null;
      }
    }
  }
  return v as unknown as FleetInventory;
}

async function runDevicesDoctor(opts: DoctorOptions): Promise<void> {
  const singleName = opts.device;
  const targets = await resolveFleetTargets(opts);
  const localName = machineId();
  const results: DeviceDoctorResult[] = [];

  if (!singleName) {
    results.push({
      name: localName,
      online: true,
      agents: await collectTeamsDoctorData(),
      inventory: await collectLocalFleetInventory(opts.cwd ?? process.cwd()),
    });
  }

  const [remoteResults, inventoryResults] = await Promise.all([
    fanOutDevices(targets, probeFleetTarget),
    fanOutDevices(targets, probeFleetInventory),
  ]);
  const payloadByName = new Map<string, RemoteDoctorPayload | null>();
  for (const r of inventoryResults) payloadByName.set(r.name, r.status === 'ok' ? (r.value ?? null) : null);
  results.push(...remoteResults.map((r): DeviceDoctorResult => {
    const payload = payloadByName.get(r.name) ?? null;
    const inventory = payload?.inventory ?? undefined;
    const secretFindings = payload?.secretFindings;
    if (r.status === 'ok' && r.value) return { ...r.value, inventory, secretFindings };
    return {
      name: r.name,
      online: false,
      error: r.error ?? String(r.reason ?? 'skipped'),
      agents: {},
      inventory,
      secretFindings,
    };
  }));

  const divergence = singleName
    ? null
    : compareFleetInventories(
        results.map((r) => ({ name: r.name, inventory: r.inventory ?? null })),
        localName,
      );

  if (opts.json && results.length === 0) {
    console.log(JSON.stringify({ devices: results, fleet: divergence, findings: [] }, null, 2));
    return;
  }

  if (results.length === 0) {
    console.log(chalk.gray('No registered devices. Run `agents devices` to register some.'));
    return;
  }

  const cwd = opts.cwd ?? process.cwd();
  const findings: DoctorFinding[] = [];
  const accounts: Record<string, Record<string, FleetVersionSignIn[]>> = {};

  for (const r of results) {
    if (r.name === localName) {
      const localReports: VersionResourceReport[] = [];
      for (const agent of ALL_AGENT_IDS) {
        for (const version of listInstalledVersions(agent)) {
          localReports.push(diffVersionResources(agent, version, { cwd, excludeProject: true }));
        }
      }
      const localCliMissing = ALL_AGENT_IDS.filter(
        (a) => listInstalledVersions(a).length > 0 && !checkAllClis()[a]?.installed,
      );
      findings.push(...buildLocalFindings({
        device: localName,
        syncRows: checkSyncStatus(cwd),
        orphanRows: countOrphans(),
        repoBehind: readRepoBehindMarkers(),
        reports: localReports,
        signIn: r.inventory?.signIn ?? {},
        cliMissing: localCliMissing,
        duplicateHooks: inspectDuplicateVersionHooks(cwd),
        hostClis: toHostCliInput(listCliStatus(cwd)),
        rcSecrets: scanUserRcFiles(),
        masterPassphraseInEnv: masterPassphraseInEnv(),
        authBundleWrongBackend: !inspectReservedAuthBundle().ok,
        execPolicy: process.platform === 'win32'
          ? { platform: process.platform, policy: getEffectiveExecutionPolicy() }
          : undefined,
        windowsSshEnrollment: auditWindowsSshEnrollment(),
        isolatedVersions: localReports
          .filter((rep) => isVersionIsolated(rep.agent, rep.version))
          .map((rep) => `${rep.agent}@${rep.version}`),
        ownerSignedIn: resolveOwnerCredential() !== null,
        binaryShadows: detectAgentsBinaryShadows(),
        leakedDaemons: findLeakedDaemons(),
      }));
      accounts[localName] = r.inventory?.signIn ?? {};
      continue;
    }

    if (!r.online) {
      findings.push({
        severity: 'warning', kind: 'stale-cli', device: r.name,
        message: r.error ? `unreachable — ${r.error}` : 'unreachable',
        remediation: 'check the device',
      });
      continue;
    }
    if (r.secretFindings?.length) findings.push(...r.secretFindings);

    findings.push(...hookRuntimeToFindings(r.name, r.inventory?.hookRuntime));

    if (r.inventory?.signIn) {
      findings.push(...signInToFindings(r.name, r.inventory.signIn));
      accounts[r.name] = r.inventory.signIn;
    } else {
      findings.push({
        severity: 'warning', kind: 'stale-cli', device: r.name,
        message: "older agents-cli — can't report per-version sign-in",
        remediation: 'upgrade',
      });
      accounts[r.name] = {};
    }
  }

  if (divergence) {
    findings.push(...fleetDivergenceToFindings(divergence.divergences, divergence.baseline));
  }

  if (opts.json) {
    console.log(JSON.stringify({ devices: results, fleet: divergence, findings }, null, 2));
    return;
  }

  const header = `${chalk.gray('agents doctor ·')} ${chalk.hex('#a3e635')(String(results.length))} ${chalk.gray('devices · baseline')} ${chalk.hex('#a3e635')(localName)}`;
  for (const line of renderFindings(findings, accounts, { fleet: true, baseline: localName, header })) {
    console.log(line);
  }
}


interface ResolvedTarget {
  agent: AgentId;
  versions: string[];
  versionExplicit: boolean;
}

function parseTargetArg(arg: string): ResolvedTarget | { error: string } {
  const at = arg.indexOf('@');
  const agentPart = at === -1 ? arg : arg.slice(0, at);
  const qualifier = at === -1 ? '' : arg.slice(at + 1);

  const agent = resolveAgentName(agentPart);
  if (!agent) return { error: formatAgentError(agentPart) };

  if (!qualifier) {
    const versions = listInstalledVersions(agent);
    if (versions.length === 0) return { error: `${AGENTS[agent].name} has no installed versions. Run \`agents add ${agent}@<version>\` first.` };
    return { agent, versions, versionExplicit: false };
  }

  try {
    const targets = resolveAgentTargets(`${agent}@${qualifier}`, { availableAgents: [agent] });
    const versions = targets.map((t) => t.version).filter((v): v is string => v !== null);
    if (versions.length === 0) return { error: `${AGENTS[agent].name} has no installed versions. Run \`agents add ${agent}@<version>\` first.` };
    return { agent, versions, versionExplicit: true };
  } catch (e) {
    if (e instanceof AgentSpecError) return { error: e.message };
    throw e;
  }
}

function parseKindFilter(arg: string | undefined): DoctorKind[] | { error: string } {
  if (!arg) return DOCTOR_ALL_KINDS as DoctorKind[];
  const requested = arg.split(',').map((s) => s.trim()).filter(Boolean);
  const valid = new Set<DoctorKind>(DOCTOR_ALL_KINDS);
  const out: DoctorKind[] = [];
  for (const k of requested) {
    if (!valid.has(k as DoctorKind)) {
      return { error: `Unknown kind: ${k}. Valid: ${DOCTOR_ALL_KINDS.join(', ')}` };
    }
    out.push(k as DoctorKind);
  }
  return out;
}

function statusLabel(status: ResourceDiff['status']): string {
  switch (status) {
    case 'ok': return chalk.green('ok   ');
    case 'diff': return chalk.yellow('DIFF ');
    case 'missing': return chalk.red('MISS ');
    case 'extra': return chalk.magenta('EXTRA');
  }
}

function sourceLabel(diff: ResourceDiff, layers: VersionResourceReport['layers']): string {
  if (!diff.source) return '';
  if (diff.source === 'extra') {
    const sourcePath = diff.sourcePath;
    if (sourcePath) {
      for (const e of layers.extras) {
        if (sourcePath.startsWith(e.dir + '/') || sourcePath === e.dir) {
          return chalk.gray(`source=extra:${e.alias}`);
        }
      }
    }
    return chalk.gray('source=extra');
  }
  return chalk.gray(`source=${diff.source}`);
}

function countByStatus(rows: ResourceDiff[]): { ok: number; diff: number; missing: number; extra: number } {
  let ok = 0, diff = 0, missing = 0, extra = 0;
  for (const r of rows) {
    if (r.status === 'ok') ok++;
    else if (r.status === 'diff') diff++;
    else if (r.status === 'missing') missing++;
    else if (r.status === 'extra') extra++;
  }
  return { ok, diff, missing, extra };
}

function renderKindSection(
  kind: DoctorKind,
  rows: ResourceDiff[],
  layers: VersionResourceReport['layers'],
  options: { showDiff: boolean; requestedKinds?: Set<DoctorKind> },
): void {
  const counts = countByStatus(rows);
  const total = rows.length;
  const summaryParts: string[] = [];
  if (counts.ok) summaryParts.push(`${counts.ok} ok`);
  if (counts.diff) summaryParts.push(chalk.yellow(`${counts.diff} diff`));
  if (counts.missing) summaryParts.push(chalk.red(`${counts.missing} missing`));
  if (counts.extra) summaryParts.push(chalk.magenta(`${counts.extra} extra`));
  const summary = total === 0 ? chalk.gray('(none)') : summaryParts.join(', ');
  console.log(`  ${chalk.bold(kind.padEnd(11))} ${chalk.gray(`${total} item${total === 1 ? '' : 's'}`)}  ${summary}`);

  if (total === 0) return;

  const visible = options.showDiff ? rows : rows.filter((r) => r.status !== 'ok');
  if (visible.length === 0) {
    console.log(`    ${chalk.gray('all ok')}`);
    return;
  }

  for (const r of visible) {
    const src = sourceLabel(r, layers);
    const name = padToWidth(truncateToWidth(r.name, 28), 28);
    const prefix = `    ${statusLabel(r.status)}  ${name} ${src}`;
    const detail = r.detail
      ? chalk.gray(`  ${truncateToWidth(collapseWhitespace(r.detail), Math.max(1, terminalWidth() - stringWidth(prefix) - 2))}`)
      : '';
    console.log(prefix + detail);

    if (options.showDiff && r.status === 'diff' && r.sourcePath && r.homePath) {
      const expected = readExpectedForDiff(kind, r);
      const actual = safeRead(r.homePath);
      if (expected != null && actual != null) {
        const patch = unifiedDiff(expected, actual, {
          fromLabel: r.sourcePath,
          toLabel: r.homePath,
          context: 2,
        });
        if (patch) console.log(colorizeUnifiedDiff(patch, '      '));
      }
    }
  }
}

function safeRead(p: string): string | null {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

function readExpectedForDiff(kind: DoctorKind, row: ResourceDiff): string | null {
  if (kind === 'skills') return null;
  if (!row.sourcePath) return null;
  return safeRead(row.sourcePath);
}

export type IssueSeverity = 'critical' | 'warning' | 'info';

export interface VerdictIssue {
  severity: IssueSeverity;
  category: string;
  subject: string;
  impact: string;
  fix: string;
  text: string;
  color: 'yellow' | 'red' | 'magenta';
}

export interface DoctorVerdict {
  healthy: boolean;
  issues: VerdictIssue[];
  reconciled: number;
}

const AUTO_FIXABLE_CATEGORIES = new Set([
  'hook-runtime-broken', 'unwired-hook', 'settings-missing', 'settings-unparseable', 'missing', 'divergent', 'stale', 'never-synced',
]);

export function verdictIsAutoFixable(v: DoctorVerdict): boolean {
  return v.issues.some((i) => AUTO_FIXABLE_CATEGORIES.has(i.category));
}

function missingResourceSeverity(kind: DoctorKind): IssueSeverity {
  if (kind === 'hooks') return FINDING_SEVERITY['missing-hook'];
  if (kind === 'plugins') return FINDING_SEVERITY['missing-plugin'];
  return FINDING_SEVERITY['missing-resource'];
}

export function computeVerdict(report: VersionResourceReport): DoctorVerdict {
  const issues: VerdictIssue[] = [];
  const idLabel = `${report.agent}@${report.version}`;
  const fixCmd = `agents sync ${idLabel} --yes`;
  const syncCmd = fixCmd;

  const w = report.hookWiring;
  for (const issue of w?.runtimeBroken ?? []) {
    issues.push({
      severity: 'critical', category: 'hook-runtime-broken', subject: issue.name,
      impact: `generated hook wrapper is ${issue.reason}; the hook cannot run`,
      fix: fixCmd,
      text: `${issue.name} hook runtime broken`, color: 'red',
    });
  }
  if (w?.settingsMissing) {
    const n = w.expected ?? 0;
    issues.push({
      severity: 'critical', category: 'settings-missing', subject: 'settings.json',
      impact: `not found; ${n} declared hook${n === 1 ? '' : 's'} never fire`,
      fix: syncCmd,
      text: `settings.json missing (${n} hook${n === 1 ? '' : 's'} unwired)`, color: 'red',
    });
  } else if (w?.settingsUnparseable) {
    issues.push({
      severity: 'critical', category: 'settings-unparseable', subject: 'settings.json',
      impact: `unparseable; hook wiring can't be verified`,
      fix: syncCmd,
      text: 'settings.json unparseable', color: 'red',
    });
  } else if (w) {
    for (const u of w.unwired) {
      issues.push({
        severity: 'critical', category: 'unwired-hook', subject: u.name,
        impact: 'on disk but not wired into settings.json; the hook never fires',
        fix: syncCmd,
        text: `${u.name} unwired`, color: 'red',
      });
    }
  }

  for (const kind of DOCTOR_ALL_KINDS) {
    for (const r of report.kinds[kind]) {
      if (r.status !== 'missing') continue;
      const severity = missingResourceSeverity(kind);
      issues.push({
        severity, category: 'missing', subject: r.name,
        impact: `declared in sources but absent from the version home (${kind})`,
        fix: fixCmd,
        text: `${r.name} missing`, color: severity === 'critical' ? 'red' : 'yellow',
      });
    }
  }

  for (const b of report.sourceBehind ?? []) {
    if (b.behind <= 0) continue;
    issues.push({
      severity: 'warning', category: 'source-behind', subject: b.label,
      impact: `${b.behind} commit${b.behind === 1 ? '' : 's'} behind ${b.branch}; you're running stale config`,
      fix: `agents repo pull ${b.alias}`,
      text: `source ${b.label} ${b.behind} commit${b.behind === 1 ? '' : 's'} behind ${b.branch}`, color: 'yellow',
    });
  }

  for (const kind of DOCTOR_ALL_KINDS) {
    for (const r of report.kinds[kind]) {
      if (r.status !== 'diff') continue;
      issues.push({
        severity: 'warning', category: 'divergent', subject: r.name,
        impact: r.detail ? collapseWhitespace(r.detail) : 'differs from source',
        fix: fixCmd,
        text: `${r.name} divergent`, color: 'yellow',
      });
    }
  }

  for (const kind of DOCTOR_ALL_KINDS) {
    for (const r of report.kinds[kind]) {
      if (r.status !== 'extra') continue;
      issues.push({
        severity: 'info', category: 'extra', subject: r.name,
        impact: `orphan in the version home with no source (${kind})`,
        fix: 'agents prune cleanup',
        text: `${r.name} extra`, color: 'magenta',
      });
    }
  }

  return { healthy: issues.length === 0, issues, reconciled: report.summary.ok };
}


const SEVERITY_COLOR: Record<IssueSeverity, (s: string) => string> = {
  critical: chalk.red,
  warning: chalk.yellow,
  info: chalk.magenta,
};
const SEVERITY_GLYPH: Record<IssueSeverity, string> = {
  critical: '✗',
  warning: '⚠',
  info: '·',
};

function severityCounts(issues: VerdictIssue[]): { critical: number; warning: number; info: number } {
  return {
    critical: issues.filter((i) => i.severity === 'critical').length,
    warning: issues.filter((i) => i.severity === 'warning').length,
    info: issues.filter((i) => i.severity === 'info').length,
  };
}

const INFO_CAP = 5;

export function healthBlockLines(verdict: DoctorVerdict, opts: { healthySummary: string; healFix?: string }): string[] {
  if (verdict.healthy) {
    return [`  ${chalk.green('✓')} ${chalk.green('healthy')} ${chalk.gray('— ' + opts.healthySummary)}`];
  }
  const lines: string[] = [];
  const c = severityCounts(verdict.issues);
  const bits: string[] = [];
  if (c.critical) bits.push(`${c.critical} critical`);
  if (c.warning) bits.push(`${c.warning} warning${c.warning === 1 ? '' : 's'}`);
  if (c.info) bits.push(`${c.info} info`);
  const total = verdict.issues.length;
  lines.push(`  ${chalk.red('✗')} ${chalk.red('unhealthy')} ${chalk.gray(`— ${total} issue${total === 1 ? '' : 's'} (${bits.join(' · ')})`)}`);
  lines.push('');

  const cont = ' '.repeat(14);
  const issueLines = (i: VerdictIssue): void => {
    const glyph = SEVERITY_COLOR[i.severity](SEVERITY_GLYPH[i.severity]);
    const word = SEVERITY_COLOR[i.severity](i.severity.padEnd(8));
    lines.push(`  ${glyph} ${word}  ${chalk.bold(i.subject)} ${chalk.gray('— ' + i.impact)}`);
    lines.push(chalk.gray(`${cont}→ ${i.fix}`));
  };
  const actionable = verdict.issues.filter((i) => i.severity !== 'info');
  const infoIssues = verdict.issues.filter((i) => i.severity === 'info');
  for (const i of actionable) issueLines(i);
  for (const i of infoIssues.slice(0, INFO_CAP)) issueLines(i);
  const hiddenInfo = infoIssues.length - Math.min(infoIssues.length, INFO_CAP);
  if (hiddenInfo > 0) {
    const glyph = SEVERITY_COLOR.info(SEVERITY_GLYPH.info);
    const word = SEVERITY_COLOR.info('info'.padEnd(8));
    lines.push(`  ${glyph} ${word}  ${chalk.gray(`+${hiddenInfo} more orphan${hiddenInfo === 1 ? '' : 's'}`)} ${chalk.gray('— agents prune cleanup')}`);
  }

  if (opts.healFix) {
    lines.push('');
    lines.push(`  ${chalk.gray("heal what's auto-fixable:")}  ${opts.healFix}`);
  }
  return lines;
}

function renderHealthBlock(verdict: DoctorVerdict, opts: { healthySummary: string; healFix?: string }): void {
  for (const line of healthBlockLines(verdict, opts)) console.log(line);
}

export function computeOverviewHealth(
  syncRows: SyncStatusRow[],
  orphanRows: OrphanRow[],
  repoBehindMarkers: FetchStatusMarker[],
  duplicateHooks: DuplicateVersionHook[] = [],
): DoctorVerdict {
  const issues: VerdictIssue[] = [];
  const pretty = (agent: string, version: string) => `${AGENT_NAMES[agent] || agent}@${version}`;

  for (const finding of duplicateHooks) {
    const versions = finding.copies.map((copy) => copy.version).join(', ');
    const active = finding.authoritative.version;
    const drift = finding.kind === 'drift';
    issues.push({
      severity: drift ? 'critical' : 'warning',
      category: drift ? 'duplicate-hook-drift' : 'duplicate-hook',
      subject: `${finding.agent}/${finding.name}`,
      impact: `${drift ? 'different content' : 'identical content'} across versions ${versions}; ${active} is authoritative`,
      fix: `agents sync ${finding.agent}@${active} --yes`,
      text: `${finding.name} ${drift ? 'drift' : 'duplicated'} across ${versions}`,
      color: drift ? 'red' : 'yellow',
    });
  }

  for (const row of syncRows) {
    const brokenRuntime = row.brokenHookRuntime ?? 0;
    if (brokenRuntime > 0) {
      const label = pretty(row.agent, row.version);
      issues.push({
        severity: 'critical', category: 'hook-runtime-broken', subject: label,
        impact: `${brokenRuntime} generated hook wrapper${brokenRuntime === 1 ? '' : 's'} unusable; affected hooks cannot run`,
        fix: `agents sync ${row.agent}@${row.version} --yes`,
        text: `${label} ${brokenRuntime} hook runtime broken`, color: 'red',
      });
    }
    const n = row.unwiredHooks ?? 0;
    if (n <= 0) continue;
    const label = pretty(row.agent, row.version);
    issues.push({
      severity: 'critical', category: 'unwired-hook', subject: label,
      impact: `${n} hook${n === 1 ? '' : 's'} present on disk but not wired into settings.json; never fire`,
      fix: `agents sync ${row.agent}@${row.version} --yes`,
      text: `${label} ${n} unwired`, color: 'red',
    });
  }

  for (const m of repoBehindMarkers) {
    if (m.behind <= 0) continue;
    const label = m.alias === 'user' ? '~/.agents' : m.alias;
    issues.push({
      severity: 'warning', category: 'source-behind', subject: label,
      impact: `${m.behind} commit${m.behind === 1 ? '' : 's'} behind ${m.branch}; you're running stale config`,
      fix: `agents repo pull ${m.alias}`,
      text: `${label} ${m.behind} behind`, color: 'yellow',
    });
  }

  for (const row of syncRows) {
    const label = pretty(row.agent, row.version);
    if (row.status === 'stale') {
      issues.push({
        severity: 'warning', category: 'stale', subject: label,
        impact: 'sources changed since last sync',
        fix: `agents sync ${row.agent}@${row.version} --yes`,
        text: `${label} stale`, color: 'yellow',
      });
    } else if (row.status === 'never-synced') {
      issues.push({
        severity: 'warning', category: 'never-synced', subject: label,
        impact: 'installed but never synced',
        fix: `agents sync ${row.agent}@${row.version} --yes`,
        text: `${label} never-synced`, color: 'yellow',
      });
    }
  }

  for (const row of orphanRows) {
    const parts: string[] = [];
    if (row.commands) parts.push(`${row.commands} command${row.commands === 1 ? '' : 's'}`);
    if (row.skills) parts.push(`${row.skills} skill${row.skills === 1 ? '' : 's'}`);
    if (row.hooks) parts.push(`${row.hooks} hook${row.hooks === 1 ? '' : 's'}`);
    const label = pretty(row.agent, row.version);
    issues.push({
      severity: 'info', category: 'orphan', subject: label,
      impact: `${parts.join(', ')} in the version home with no source`,
      fix: 'agents prune cleanup',
      text: `${label} orphan`, color: 'magenta',
    });
  }

  const reconciled = syncRows.filter(
    (r) => r.status === 'fresh' && (r.unwiredHooks ?? 0) === 0 && (r.brokenHookRuntime ?? 0) === 0,
  ).length;
  return { healthy: issues.length === 0, issues, reconciled };
}

function renderHookWiringRows(w: HookWiringReport): void {
  if (!w.supported) return;
  if (w.settingsMissing) {
    const where = w.settingsPath ? ` at ${w.settingsPath}` : '';
    console.log(`    ${chalk.red('UNWIRED')}  ${chalk.gray(`settings.json not found${where} — ${w.expected ?? 0} declared hook(s) never fire`)}`);
    return;
  }
  if (w.settingsUnparseable) {
    const where = w.settingsPath ? ` at ${w.settingsPath}` : '';
    console.log(`    ${chalk.red('UNWIRED')}  ${chalk.gray(`settings.json unparseable${where} — wiring can't be verified`)}`);
    return;
  }
  for (const u of w.unwired) {
    const name = padToWidth(truncateToWidth(u.name, 28), 28);
    const scope = u.matcher ? `event=${u.event} matcher=${u.matcher}` : `event=${u.event}`;
    console.log(`    ${chalk.red('UNWIRED')}  ${name} ${chalk.gray(scope)}`);
  }
}

function renderTargetText(report: VersionResourceReport, options: { showDiff: boolean; requestedKinds?: Set<DoctorKind> }): void {
  const label = `${AGENT_NAMES[report.agent] || report.agent}@${report.version}`;
  console.log(chalk.bold(label));
  const homePrefix = '  home: ';
  const cwdPrefix = '  cwd:  ';
  console.log(chalk.gray(homePrefix + truncateToWidth(report.home, Math.max(1, terminalWidth() - stringWidth(homePrefix)))));
  console.log(chalk.gray(cwdPrefix + truncateToWidth(report.cwd, Math.max(1, terminalWidth() - stringWidth(cwdPrefix)))));
  const layerStr = [
    report.layers.project ? `project=${report.layers.project}` : null,
    `user=${report.layers.user}`,
    `system=${report.layers.system}`,
    report.layers.extras.length > 0
      ? `extras=[${report.layers.extras.map((e) => e.alias).join(',')}]`
      : null,
  ].filter(Boolean).join(' ');
  printWrappedLine('  layers: ', layerStr);

  const manifest = loadManifest(report.agent, report.version);
  if (!manifest) {
    console.log(chalk.gray(`  manifest: ${chalk.gray('cold')} (never synced)`));
  } else {
    const stale = isStale(manifest, report.agent, report.version, report.cwd);
    if (stale) {
      console.log(chalk.gray('  manifest: ') + chalk.yellow('stale') + chalk.gray(' (sources changed since last sync)'));
    } else {
      console.log(chalk.gray('  manifest: ') + chalk.green('fresh'));
    }
  }
  console.log();

  for (const kind of DOCTOR_ALL_KINDS) {
    const rows = report.kinds[kind];
    if (options.requestedKinds && !options.requestedKinds.has(kind)) continue;
    if (kind === 'hooks' && report.hookInventory) {
      const wired = report.hookInventory.wiringSupported ? String(report.hookInventory.wired.length) : 'unknown';
      const unmanaged = report.hookInventory.unmanaged.length > 0 ? ` · unmanaged ${report.hookInventory.unmanaged.length}` : '';
      console.log(chalk.gray(`  inventory: capable ${report.hookInventory.capable ? 'yes' : 'no'} · on-disk ${report.hookInventory.onDisk.length} · wired ${wired}${unmanaged}`));
    }
    renderKindSection(kind, rows, report.layers, options);
    if (kind === 'hooks' && report.hookWiring) renderHookWiringRows(report.hookWiring);
  }

  console.log();
  const verdict = computeVerdict(report);
  const hooksWired = report.hookWiring?.supported ? ' · hooks wired' : '';
  renderHealthBlock(verdict, {
    healthySummary: `${verdict.reconciled} resource${verdict.reconciled === 1 ? '' : 's'} reconciled${hooksWired} · sources current`,
    healFix: verdictIsAutoFixable(verdict) ? `agents sync ${report.agent}@${report.version} --yes` : undefined,
  });
}


interface DeviceCheckResult {
  device: string;
  hasDrift: boolean;
  stale: number;
  neverSynced: number;
  orphanVersions: number;
  error?: string;
}

function checkLabel(row: SyncStatusRow): string {
  return `${AGENT_NAMES[row.agent] || row.agent}@${row.version}`;
}

function runCheckGate(opts: DoctorOptions, cwd: string): void {
  const drift = computeDrift(cwd);

  if (opts.json) {
    console.log(JSON.stringify({
      hasDrift: drift.hasDrift,
      stale: drift.staleCount,
      neverSynced: drift.neverSyncedCount,
      unwiredHookVersions: drift.unwiredHookVersions,
      brokenHookRuntimeVersions: drift.brokenHookRuntimeVersions,
      orphanVersions: drift.orphanVersionCount,
      sourceBehind: drift.sourceBehind,
      versions: drift.syncRows.map((r) => ({
        agent: r.agent,
        version: r.version,
        status: r.status,
        isDefault: r.isDefault,
        unwiredHooks: r.unwiredHooks ?? 0,
        brokenHookRuntime: r.brokenHookRuntime ?? 0,
        divergence: r.divergence ?? [],
      })),
    }, null, 2));
    process.exit(drift.hasDrift ? 1 : 0);
  }

  if (drift.syncRows.length === 0) {
    console.log(chalk.gray('check: no installed versions — nothing to verify'));
    process.exit(0);
  }

  if (!drift.hasDrift) {
    const orphanNote = drift.orphanVersionCount > 0
      ? chalk.gray(` (${drift.orphanVersionCount} version(s) carry orphans — run \`agents prune cleanup\`)`)
      : '';
    console.log(`${chalk.gray('check:')} ${chalk.green('ok')} — ${drift.syncRows.length} version(s) in sync${orphanNote}`);
    process.exit(0);
  }

  const parts: string[] = [];
  if (drift.staleCount > 0) parts.push(`${drift.staleCount} stale`);
  if (drift.neverSyncedCount > 0) parts.push(`${drift.neverSyncedCount} never-synced`);
  if (drift.unwiredHookVersions > 0) parts.push(`${drift.unwiredHookVersions} with unwired hooks`);
  if (drift.brokenHookRuntimeVersions > 0) parts.push(`${drift.brokenHookRuntimeVersions} with broken hook runtime`);
  if (drift.sourceBehind.length > 0) parts.push(`${drift.sourceBehind.length} source layer(s) behind origin`);
  console.error(`${chalk.gray('check:')} ${chalk.red('drift')} — ${parts.join(', ')} across ${drift.syncRows.length} version(s)`);

  if (!opts.quiet) {
    const STATUS_BADGE_WIDTH = 'never-synced'.length + 2;
    for (const row of drift.syncRows) {
      const unwired = (row.unwiredHooks ?? 0) > 0;
      const brokenRuntime = (row.brokenHookRuntime ?? 0) > 0;
      if (row.status === 'fresh' && !unwired && !brokenRuntime) continue;
      const tag = row.status === 'stale' ? chalk.yellow('stale'.padEnd(STATUS_BADGE_WIDTH))
        : row.status === 'never-synced' ? chalk.gray('never-synced'.padEnd(STATUS_BADGE_WIDTH))
        : chalk.red((brokenRuntime ? 'hook-runtime' : 'unwired').padEnd(STATUS_BADGE_WIDTH));
      console.error(`  ${tag}${checkLabel(row)}`);
      for (const line of row.divergence ?? []) {
        console.error(chalk.gray(`           ${line}`));
      }
    }
    for (const b of drift.sourceBehind) {
      console.error(`  ${chalk.red('behind')} source ${b.label}  ${chalk.gray(`${b.behind} commit${b.behind === 1 ? '' : 's'} behind ${b.branch}`)}`);
    }
    const hints: string[] = [];
    if (drift.staleCount > 0 || drift.neverSyncedCount > 0 || drift.unwiredHookVersions > 0 || drift.brokenHookRuntimeVersions > 0) {
      hints.push('`agents sync <agent>@all` (or `agents sync <agent>@<version>`)');
    }
    if (drift.sourceBehind.length > 0) hints.push('`agents repo pull <alias>` for a source layer behind origin');
    console.error(chalk.gray(`\nReconcile with ${hints.join('; ')}.`));
  }

  process.exit(1);
}

function checkPayload(device: string, drift: ReturnType<typeof computeDrift>): DeviceCheckResult {
  return {
    device,
    hasDrift: drift.hasDrift,
    stale: drift.staleCount,
    neverSynced: drift.neverSyncedCount,
    orphanVersions: drift.orphanVersionCount,
  };
}

interface CheckFanOutTarget extends FanOutDeviceTarget {
  platform?: string;
  dialTarget: string;
  extraSshArgs?: string[];
}

async function probeDeviceCheck(target: CheckFanOutTarget): Promise<DeviceCheckResult> {
  const isWin = /^win/i.test((target.platform ?? '').trim());
  const remoteCmd = buildRemoteAgentsInvocation(
    ['doctor', '--check', '--json'],
    undefined,
    isWin ? 'windows' : undefined,
    isWin ? undefined : { PATH: '$HOME/.agents/.cache/shims:$HOME/.local/bin:$PATH' },
  );
  const res = await sshExecAsync(target.dialTarget, remoteCmd, { timeoutMs: 30000, multiplex: true, extraSshArgs: target.extraSshArgs });
  if (res.code !== 0 && !res.stdout.trim()) {
    throw new Error(res.timedOut ? 'timed out' : (res.stderr.trim() || `exit ${res.code ?? 'unknown'}`));
  }
  try {
    const parsed = JSON.parse(res.stdout) as Omit<DeviceCheckResult, 'device'>;
    return {
      device: target.name,
      hasDrift: Boolean(parsed.hasDrift),
      stale: parsed.stale ?? 0,
      neverSynced: parsed.neverSynced ?? 0,
      orphanVersions: parsed.orphanVersions ?? 0,
    };
  } catch (err: any) {
    throw new Error(`invalid JSON (${err?.message ?? 'parse error'})`);
  }
}

async function runDevicesCheck(opts: DoctorOptions, cwd: string): Promise<void> {
  const registry = await loadDevices();
  const self = machineId();
  const planned = planFleetTargets(registry);
  const local = checkPayload(self, computeDrift(cwd));
  const remoteTargets: CheckFanOutTarget[] = remoteFleetTargets(planned, self)
    .map((t) => ({
      name: t.device.name,
      platform: t.device.platform,
      skip: t.skip,
      dialTarget: fleetDialTarget(t.device),
      extraSshArgs: deviceIdentityArgs(t.device),
    }));
  const remote = await fanOutDevices(remoteTargets, probeDeviceCheck);
  const devices: DeviceCheckResult[] = [local];
  for (const result of remote) {
    if (result.status === 'ok' && result.value) {
      devices.push(result.value);
    } else {
      devices.push({
        device: result.name,
        hasDrift: true,
        stale: 0,
        neverSynced: 0,
        orphanVersions: 0,
        error: result.error ?? String(result.reason ?? 'skipped'),
      });
    }
  }
  const hasDrift = devices.some((d) => d.hasDrift || d.error);
  if (opts.json) {
    console.log(JSON.stringify({ hasDrift, devices }, null, 2));
    process.exit(hasDrift ? 1 : 0);
  }
  if (!hasDrift) {
    console.log(chalk.green('ok') + chalk.gray(`  ${devices.length} device(s) in sync`));
    process.exit(0);
  }
  console.error(chalk.red('drift') + chalk.gray(`  ${devices.filter((d) => d.hasDrift || d.error).length} of ${devices.length} device(s)`));
  if (!opts.quiet) {
    for (const d of devices) {
      if (!d.hasDrift && !d.error) continue;
      const detail = d.error
        ? d.error
        : [`${d.stale} stale`, `${d.neverSynced} never-synced`].filter((p) => !p.startsWith('0 ')).join(', ');
      console.error(`  ${chalk.yellow(d.device.padEnd(18))} ${detail || 'drift'}`);
    }
    console.error(chalk.gray('\nReconcile each device with `agents sync <agent>@all` or `agents repo pull user`.'));
  }
  process.exit(1);
}


export function registerDoctorCommand(program: Command): void {
  const doctorCmd = addHostOption(program.command('doctor [target]'))
    .description('Diagnose CLI availability, sync status, and resource divergence (optionally for a specific agent[@version]).')
    .option('--json', 'Output machine-readable JSON')
    .option('--diff', 'In target mode, include unified diffs for divergent files')
    .option('--kind <kinds>', 'Restrict to comma-separated resource kinds (commands,skills,hooks,rules,mcp,permissions,subagents,plugins,workflows,memory)')
    .option('--cwd <path>', 'Resolution cwd for project layer detection (default: process.cwd())')
    .option('--adopt <agent>', "Take over the agent's native launcher that shadows the shim (symlink it to the version-managed shim; reversible with --release)")
    .option('--release <agent>', 'Undo --adopt: restore the native launcher agents-cli previously adopted')
    .option('--devices', 'Check agent readiness AND cross-device harness divergence (missing resources/versions, repo drift) on every registered device')
    .option('--check', 'CI drift gate: exit non-zero when any installed version is out of sync (stale or never-synced), zero when clean. Combine with --devices to gate the whole fleet.')
    .option('--refresh', 'Bypass the cached overview snapshot: recompute the bare `doctor --json` overview live and refresh the shared cache that the menu-bar and other pollers read')
    .option('-q, --quiet', 'With --check, suppress per-version lines; print only the one-line verdict');

  setHelpSections(doctorCmd, {
    examples: `
      # Overview: CLI availability + sync status + orphans across all defaults
      agents doctor

      # Machine-readable overview (served from a ~90s cache for pollers like the
      # menu-bar helper); --refresh recomputes live and refreshes that cache
      agents doctor --json
      agents doctor --json --refresh

      # Full per-resource report for the active default
      agents doctor claude@default

      # All installed versions of one agent
      agents doctor antigravity

      # Pin to a specific installed version
      agents doctor codex@0.117.0

      # Inspect only rules and hooks, with full diffs
      agents doctor claude@default --kind rules,hooks --diff

      # Fix every gap across all installed versions (the one fixer)
      agents sync claude@all

      # Fix just one version
      agents sync claude@2.1.207

      # Fleet: agent readiness + cross-device divergence (missing plugins/skills,
      # agent-version gaps, .agents/.system repo drift) vs this machine
      agents doctor --devices

      # CI drift gate: exit 1 if anything drifted (stale/never-synced), 0 if clean
      agents doctor --check
      agents doctor --check --quiet          # just the verdict line
      agents doctor --check --json           # machine-readable, for scripting
      agents doctor --check --devices        # gate every registered device
      agents doctor --check || { echo "resources drifted — run 'agents sync <agent>@all'"; exit 1; }
    `,
  });

  doctorCmd.action(async (target: string | undefined, opts: DoctorOptions) => {
      const cwd = opts.cwd ? opts.cwd : process.cwd();

      if (opts.check) {
        if (target) {
          console.error(chalk.red('Cannot combine --check with a target argument.'));
          process.exit(1);
        }
        if (opts.devices) {
          await runDevicesCheck(opts, cwd);
        } else {
          runCheckGate(opts, cwd);
        }
        return;
      }

      if (opts.devices) {
        if (target) {
          console.error(chalk.red('Cannot combine --devices with a target argument.'));
          process.exit(1);
        }
        await runDevicesDoctor(opts);
        return;
      }

      if (opts.adopt || opts.release) {
        if (opts.adopt && opts.release) {
          console.error(chalk.red('--adopt and --release are mutually exclusive; pass only one.'));
          process.exit(1);
        }
        const { adoptShadowingLauncher, releaseAdoptedLauncher } = await import('../lib/installations/shims.js');
        const raw = (opts.adopt || opts.release) as string;
        const agent = resolveAgentName(raw);
        if (!agent) {
          console.error(chalk.red(formatAgentError(raw)));
          process.exit(1);
        }
        if (opts.release) {
          const restored = releaseAdoptedLauncher(agent);
          if (restored) {
            console.log(chalk.green(`Released ${AGENTS[agent].cliCommand}: launcher restored to ${restored}.`));
          } else {
            console.log(chalk.gray(`${AGENTS[agent].cliCommand} has no adopted launcher to release.`));
          }
          return;
        }
        let result;
        try {
          result = adoptShadowingLauncher(agent);
        } catch (err) {
          if (err instanceof IsolationBoundaryError) { explainIsolationBoundary(err); process.exit(1); }
          throw err;
        }
        if (result.adopted) {
          console.log(chalk.green(`Adopted ${AGENTS[agent].cliCommand} launcher (${result.launcher} -> shim). Original recorded for --release; version management now wins regardless of PATH order.`));
        } else if (result.reason === 'already-adopted') {
          console.log(chalk.gray(`${AGENTS[agent].cliCommand} launcher is already adopted.`));
        } else if (result.reason === 'no-shadow') {
          console.log(chalk.gray(`Nothing to adopt — no ${AGENTS[agent].cliCommand} launcher found shadowing the shim (checked PATH and ~/.local/bin).`));
        } else if (result.reason === 'not-a-symlink') {
          console.log(chalk.yellow(`${AGENTS[agent].cliCommand} is shadowed by a real binary (${result.launcher}), not a symlink. agents-cli won't move a real binary — remove/reorder it or reorder PATH.`));
        } else {
          console.log(chalk.yellow(`Could not adopt ${AGENTS[agent].cliCommand} (${result.reason}).`));
        }
        return;
      }

      if (!target) {
        let releaseOverviewGate: (() => void) | undefined;
        if (opts.json) {
          const gate = await enterDoctorOverviewGate({ forceRefresh: !!opts.refresh });
          if (gate.cached !== null) {
            console.log(gate.cached);
            return;
          }
          releaseOverviewGate = gate.release;
        }
        const clis = checkAllClis();
        const syncRows = checkSyncStatus(cwd);
        const orphanRows = countOrphans();
        const hostClis = await listCliStatusAsync(cwd);
        const repoBehindMarkers = readRepoBehindMarkers();
        const inventory = await collectLocalFleetInventory(cwd);
        const localName = machineId();
        const duplicateHooks = inspectDuplicateVersionHooks(cwd);
        const ambiguousPins = findAmbiguousDevicePins(cwd);

        const signIn: Record<string, Pick<AccountInfo, 'signedIn' | 'email' | 'accountId'>> = {};
        await Promise.all(
          Object.entries(clis)
            .filter(([, e]) => e.installed)
            .map(async ([name]) => {
              try {
                signIn[name] = await getAccountInfo(name as AgentId);
              } catch {
              }
            }),
        );

        const reports: VersionResourceReport[] = [];
        for (const agent of ALL_AGENT_IDS) {
          for (const version of listInstalledVersions(agent)) {
            reports.push(diffVersionResources(agent, version, { cwd, excludeProject: true }));
          }
        }
        const cliMissing = ALL_AGENT_IDS.filter(
          (a) => listInstalledVersions(a).length > 0 && clis[a] && !clis[a].installed,
        );

        const isolatedVersions = reports
          .filter((r) => isVersionIsolated(r.agent, r.version))
          .map((r) => `${r.agent}@${r.version}`);

        const findings = buildLocalFindings({
          device: localName,
          binaryShadows: detectAgentsBinaryShadows(),
          syncRows,
          orphanRows,
          repoBehind: repoBehindMarkers,
          reports,
          signIn: inventory.signIn ?? {},
          cliMissing,
          duplicateHooks,
          hostClis: toHostCliInput(hostClis),
          rcSecrets: scanUserRcFiles(),
          masterPassphraseInEnv: masterPassphraseInEnv(),
          authBundleWrongBackend: !inspectReservedAuthBundle().ok,
          execPolicy: process.platform === 'win32'
            ? { platform: process.platform, policy: getEffectiveExecutionPolicy() }
            : undefined,
          isolatedVersions,
          ownerSignedIn: resolveOwnerCredential() !== null,
          leakedDaemons: findLeakedDaemons(),
        });

        if (opts.json) {
          const overviewPayload = {
            clis,
            signIn,
            auth: summarizeHostAuth(readAuthHealthCache(), machineId()),
            sync: syncRows,
            orphans: orphanRows,
            health: computeOverviewHealth(syncRows, orphanRows, repoBehindMarkers, duplicateHooks),
            duplicateHooks,
            ambiguousDevicePins: ambiguousPins,
            findings,
            fleet: inventory,
            hostClis: {
              statuses: hostClis.statuses.map((s) => ({
                name: s.manifest.name,
                source: s.manifest.source,
                description: s.manifest.description ?? null,
                installed: s.installed,
              })),
              errors: hostClis.errors,
            },
            repos: repoBehindMarkers.map((m) => ({
              alias: m.alias,
              dir: m.dir,
              behind: m.behind,
              branch: m.branch,
              fetchedAt: m.fetchedAt,
            })),
          };
          writeDoctorOverviewCache(overviewPayload);
          releaseOverviewGate?.();
          console.log(JSON.stringify(overviewPayload, null, 2));
          return;
        }

        const accounts: Record<string, Record<string, FleetVersionSignIn[]>> = {
          [localName]: inventory.signIn ?? {},
        };
        const header = `${chalk.gray('agents doctor ·')} ${chalk.hex('#a3e635')(localName)}${chalk.gray(`  ${getCliVersion()}`)}`;
        for (const line of renderFindings(findings, accounts, { fleet: false, baseline: localName, header })) {
          console.log(line);
        }
        if (syncRows.some((r) => r.status !== 'fresh' || (r.unwiredHooks ?? 0) > 0) || repoBehindMarkers.some((m) => m.behind > 0)) {
          console.log(chalk.gray('\nRun `agents sync status` to review and sync what has drifted.'));
        }
        if (ambiguousPins.length > 0) {
          console.log();
          console.log(chalk.yellow(`${ambiguousPins.length} routine(s) pin more than one device — a routine runs on exactly one:`));
          for (const pin of ambiguousPins) {
            console.log(
              `  ${chalk.cyan(pin.name)} ${chalk.gray(`[${pin.devices.join(', ')}]`)} ` +
              `${chalk.gray('→ fires only on')} ${pin.owner}`,
            );
            console.log(chalk.gray(
              `      fix: agents routines devices ${pin.name} --set <${pin.devices.join('|')}>`,
            ));
          }
        }
        return;
      }

      const parsed = parseTargetArg(target);
      if ('error' in parsed) {
        console.error(chalk.red(parsed.error));
        process.exit(1);
      }

      const kinds = parseKindFilter(opts.kind);
      if (!Array.isArray(kinds)) {
        console.error(chalk.red(kinds.error));
        process.exit(1);
      }

      const reports: VersionResourceReport[] = parsed.versions.map((v) =>
        diffVersionResources(parsed.agent, v, { cwd, kinds }),
      );

      const sourceBehind = computeSourceBehind();
      for (const r of reports) r.sourceBehind = sourceBehind;

      if (opts.json) {
        const withVerdict = reports.map((r) => ({ ...r, verdict: computeVerdict(r) }));
        console.log(JSON.stringify(withVerdict.length === 1 ? withVerdict[0] : withVerdict, null, 2));
        return;
      }

      const showDiff = !!opts.diff;
      const requestedKinds = opts.kind ? new Set(kinds) : undefined;
      reports.forEach((r, i) => {
        if (i > 0) console.log();
        const home = getVersionHomePath(r.agent, r.version);
        if (!fs.existsSync(home)) {
          console.log(chalk.red(`${AGENT_NAMES[r.agent] || r.agent}@${r.version}: version home not found at ${home}`));
          return;
        }
        renderTargetText(r, { showDiff, requestedKinds });
      });
    });
}
