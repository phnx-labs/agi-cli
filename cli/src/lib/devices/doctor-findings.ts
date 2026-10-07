/**
 * Prioritized, fleet-aware findings model for `agents doctor` (RUSH-2069).
 *
 * The redesign is a HYBRID, comprehensive-by-default readout (no `--verbose`):
 *
 *   1. `✗ CRITICAL — needs you now  (N)` — EVERY critical across the whole fleet,
 *      worst-first, each `device · harness@version · account? · message →
 *      remediation`. A healthy machine can never bury a critical.
 *   2. `─── by computer ───` — one block per device (worst-first): that machine's
 *      WARNINGS plus a compact accounts/versions line listing every installed
 *      version and its account (provable ✓ / ✗). A device that has criticals
 *      carries a `✗ N critical (above)` marker; the criticals stay at the top.
 *
 * A single-machine `agents doctor` (no `--devices`) collapses to the CRITICAL
 * section, then one `▸ <machine>` block.
 *
 * Severity rubric — every kind the builders emit, by the severity they emit it
 * with. Keep this list exhaustive; a kind missing from it is a doc that lies.
 *   CRITICAL — logged-out (provable) · missing-hook · missing-plugin ·
 *              unwired-hook (a hook on disk that settings.json never fires) ·
 *              hook-runtime-broken (a wired hook's generated shim wrapper is
 *              missing or unusable) · cli-missing · ssh-key-enrollment ·
 *              owner-not-signed-in (no Phoenix session or worker device
 *              token, so this box cannot reach the owner).
 *   WARNING  — logout-unprovable (hedged) · missing-resource · content-drift ·
 *              never-synced · stale · repo-behind · repo-drift · version-skew ·
 *              fleet-resource-gap · hook-runtime-visibility-unavailable · orphan · duplicate-hook ·
 *              duplicate-hook-drift · host-cli-missing · host-cli-invalid ·
 *              rc-secret-export · env-secret-export · auth-bundle-wrong-backend · exec-policy · stale-cli ·
 *              binary-shadow · leaked-daemon.
 *   (RUSH-2162 moved never-synced and duplicate-hook-drift to WARNING: both are
 *   stale-sync states one `agents sync` resolves, not "needs you now".)
 *
 * This module is pure: it maps already-collected signals (drift rows, orphan
 * rows, repo-behind markers, per-version resource diffs, cross-device divergence,
 * and per-version sign-in) into {@link DoctorFinding}s and renders them. The SSH
 * fan-out and the live probes live in the doctor command; here we only shape and
 * format, so the layout is unit-tested against fixtures with no live fleet.
 */
import chalk from 'chalk';
import * as path from 'path';
import { AGENTS, ALL_AGENT_IDS, supportsAccountInspection } from '../agents.js';
import { blocksLocalScripts } from '../platform/winpath.js';
import { loginHint, loginSubcommand, SUBCOMMAND_LOGIN_AGENTS } from '../signin-badge.js';
import { CONFIG_ENV_ISOLATED_AGENTS } from '../installations/shims.js';
import { padToWidth, stringWidth } from '../text/width.js';
import type { AgentId } from '../types.js';
import type { DuplicateVersionHook } from '../hooks/install.js';
import type { AgentsBinaryShadow } from '../binary-shadow.js';
import type { LeakedDaemon } from '../daemon/leaked-daemons.js';
import type { RcSecretFinding } from '../secrets-types.js';
import { windowsSshEnrollmentProblem, type WindowsSshEnrollmentAudit } from './windows-ssh-enrollment.js';
import type { SyncStatusRow, OrphanRow } from '../drift.js';
import type { FetchStatusMarker } from '../auto-pull.js';
import { DOCTOR_ALL_KINDS, type VersionResourceReport, type DoctorKind } from '../doctor-diff.js';

const KIND_SINGULAR: Record<DoctorKind, string> = {
  commands: 'command',
  skills: 'skill',
  hooks: 'hook',
  rules: 'rule',
  mcp: 'mcp',
  permissions: 'permission',
  subagents: 'subagent',
  plugins: 'plugin',
  workflows: 'workflow',
  memory: 'memory',
};
import type {
  FleetDivergence,
  FleetHookRuntimeState,
  FleetVersionSignIn,
} from './fleet-divergence.js';

const AGENT_NAMES: Record<string, string> = Object.fromEntries(
  ALL_AGENT_IDS.map((id) => [id, AGENTS[id].name]),
);

const ISOLATED_LOGIN = new Set<AgentId>(CONFIG_ENV_ISOLATED_AGENTS);
const NO_PER_VERSION_LOGIN = new Set<AgentId>(
  ALL_AGENT_IDS.filter((a) => !ISOLATED_LOGIN.has(a)),
);

const LOGIN_SUBCOMMAND: Partial<Record<AgentId, string>> = Object.fromEntries(
  SUBCOMMAND_LOGIN_AGENTS.map((agent) => [agent, loginSubcommand(agent)!]),
);

const NEVER_COLLAPSED = new Set<FindingKind>(['logged-out', 'logout-unprovable']);

function loginShape(agent: AgentId): 'subcommand' | 'in-tui' | 'on-launch' {
  if (LOGIN_SUBCOMMAND[agent]) return 'subcommand';
  return agent === 'claude' ? 'in-tui' : 'on-launch';
}

export type FindingSeverity = 'critical' | 'warning';

export const ALL_FINDING_KINDS = [
  'logged-out',
  'logout-unprovable',
  'missing-hook',
  'missing-plugin',
  'unwired-hook',
  'hook-runtime-broken',
  'hook-runtime-visibility-unavailable',
  'cli-missing',
  'missing-resource',
  'content-drift',
  'never-synced',
  'stale',
  'repo-behind',
  'repo-drift',
  'fleet-resource-gap',
  'host-cli-missing',
  'host-cli-invalid',
  'version-skew',
  'orphan',
  'duplicate-hook',
  'duplicate-hook-drift',
  'rc-secret-export',
  'env-secret-export',
  'auth-bundle-wrong-backend',
  'exec-policy',
  'ssh-key-enrollment',
  'stale-cli',
  'binary-shadow',
  'owner-not-signed-in',
  'leaked-daemon',
] as const;

export const FINDING_SEVERITY: Record<FindingKind, FindingSeverity> = {
  'logged-out': 'critical',
  'missing-hook': 'critical',
  'missing-plugin': 'critical',
  'unwired-hook': 'critical',
  'hook-runtime-broken': 'critical',
  'cli-missing': 'critical',
  'owner-not-signed-in': 'critical',
  'logout-unprovable': 'warning',
  'hook-runtime-visibility-unavailable': 'warning',
  'missing-resource': 'warning',
  'content-drift': 'warning',
  'never-synced': 'warning',
  'stale': 'warning',
  'repo-behind': 'warning',
  'repo-drift': 'warning',
  'fleet-resource-gap': 'warning',
  'version-skew': 'warning',
  'orphan': 'warning',
  'duplicate-hook': 'warning',
  'duplicate-hook-drift': 'warning',
  'host-cli-missing': 'warning',
  'host-cli-invalid': 'warning',
  'rc-secret-export': 'warning',
  'env-secret-export': 'warning',
  'auth-bundle-wrong-backend': 'warning',
  'exec-policy': 'warning',
  'ssh-key-enrollment': 'critical',
  'stale-cli': 'warning',
  'binary-shadow': 'warning',
  'leaked-daemon': 'warning',
};

export type FindingKind = typeof ALL_FINDING_KINDS[number];

export interface DoctorFinding {
  severity: FindingSeverity;
  kind: FindingKind;
  device: string;
  agent?: AgentId;
  version?: string;
  versions?: string[];
  account?: string | null;
  message: string;
  remediation: string;
}

function agentName(agent: AgentId): string {
  return AGENT_NAMES[agent] || agent;
}

function sortedAgentIds(ids: string[]): string[] {
  const rank = (a: string) => {
    const i = ALL_AGENT_IDS.indexOf(a as AgentId);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...ids].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export function remediationFor(finding: DoctorFinding): string {
  const { kind, agent, version } = finding;
  const idLabel = agent && version ? `${agent}@${version}` : agent ?? '';
  switch (kind) {
    case 'logged-out':
    case 'logout-unprovable': {
      if (!agent) return 'log in';
      const native = loginHint(agent);
      if (!version || NO_PER_VERSION_LOGIN.has(agent)) {
        return NO_PER_VERSION_LOGIN.has(agent)
          ? `${native} (shared across all ${agentName(agent)} versions)`
          : native;
      }
      switch (loginShape(agent)) {
        case 'subcommand':
          return `agents run ${idLabel} -- ${LOGIN_SUBCOMMAND[agent]}`;
        case 'in-tui':
          return `agents run ${idLabel}, then /login`;
        case 'on-launch':
          return `agents run ${idLabel}`;
      }
    }
    case 'missing-hook':
    case 'missing-plugin':
    case 'unwired-hook':
    case 'hook-runtime-broken':
    case 'missing-resource':
    case 'content-drift':
    case 'stale':
      if (agent && version) return `agents sync ${agent}@${version} --yes`;
      return agent ? `agents sync ${agent}@all --yes` : 'agents sync';
    case 'hook-runtime-visibility-unavailable':
      return 'upgrade agents-cli on this device';
    case 'never-synced':
      if (!agent) return 'agents sync';
      return version ? `agents sync ${agent}@${version} --yes` : `agents sync ${agent}@all --yes`;
    case 'cli-missing':
      return agent ? `agents add ${agent}` : 'agents add <agent>';
    case 'orphan':
      return 'agents prune cleanup --all';
    case 'repo-behind':
      return `agents repo pull ${finding.version ?? 'user'}`;
    case 'repo-drift':
      return `agents repo pull ${version ?? 'user'}`;
    case 'fleet-resource-gap':
      return 'agents repo pull user (or upgrade agents-cli if it ships in .system)';
    case 'version-skew':
      return idLabel ? `agents add ${idLabel}` : 'agents add <agent>@<version>';
    case 'duplicate-hook':
    case 'duplicate-hook-drift':
      return agent ? `agents sync ${agent}@all --yes` : 'agents sync';
    case 'host-cli-missing':
      return 'agents cli install';
    case 'host-cli-invalid':
      return 'fix the manifest';
    case 'rc-secret-export':
      return 'agents secrets add';
    case 'env-secret-export':
      return 'unset at the source, then restart every process that inherited it (shells, editor, tmux, agents daemon)';
    case 'auth-bundle-wrong-backend':
      return 'agents secrets delete auth --yes && agents secrets create auth --backend file';
    case 'exec-policy':
      return 'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned';
    case 'ssh-key-enrollment':
      return 'repair the reported AuthorizedKeysFile, then rerun agents doctor';
    case 'stale-cli':
      return 'upgrade';
    case 'binary-shadow':
      return 'remove or repoint the shadowing agents install(s)';
    case 'leaked-daemon':
      return 'kill <pid>';
    case 'owner-not-signed-in':
      return 'agents auth login';
  }
}

function finding(f: Omit<DoctorFinding, 'remediation'>): DoctorFinding {
  return { ...f, remediation: remediationFor({ ...f, remediation: '' }) };
}

interface ResourceItem {
  short: string;
  full: string;
}

function emitGroup(
  out: DoctorFinding[],
  items: ResourceItem[],
  severity: FindingSeverity,
  kind: FindingKind,
  device: string,
  agent: AgentId,
  version: string,
  noun: string,
  verb: 'missing' | 'drifted',
): void {
  if (items.length === 0) return;
  const message = items.length === 1
    ? items[0].full
    : `${items.length} ${noun}s ${verb} (incl. ${items.slice(0, 2).map((i) => i.short).join(', ')})`;
  out.push(finding({ severity, kind, device, agent, version, message }));
}


export interface LocalFindingInputs {
  device: string;
  syncRows: SyncStatusRow[];
  orphanRows: OrphanRow[];
  repoBehind: FetchStatusMarker[];
  reports: VersionResourceReport[];
  signIn: Record<string, FleetVersionSignIn[]>;
  cliMissing?: AgentId[];
  hostClis?: {
    statuses: Array<{ name: string; installed: boolean }>;
    errors: Array<{ file: string; reason: string }>;
  };
  duplicateHooks?: DuplicateVersionHook[];
  rcSecrets?: RcSecretFinding[];
  masterPassphraseInEnv?: boolean;
  authBundleWrongBackend?: boolean;
  execPolicy?: { platform: NodeJS.Platform; policy: string | null };
  windowsSshEnrollment?: WindowsSshEnrollmentAudit | null;
  isolatedVersions?: string[];
  ownerSignedIn?: boolean;
  binaryShadows?: AgentsBinaryShadow[];
  leakedDaemons?: LeakedDaemon[];
}

export function buildLocalFindings(input: LocalFindingInputs): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  const device = input.device;
  const detailedVersions = new Set<string>();

  for (const agent of input.cliMissing ?? []) {
    out.push(finding({
      severity: FINDING_SEVERITY['cli-missing'], kind: 'cli-missing', device, agent,
      message: `${agentName(agent)} binary not found`,
    }));
  }

  if (input.ownerSignedIn === false) {
    out.push(finding({
      severity: FINDING_SEVERITY['owner-not-signed-in'], kind: 'owner-not-signed-in', device,
      message: 'cannot reach the owner: no Phoenix session or worker device token',
    }));
  }

  for (const report of input.reports) {
    const agent = report.agent as AgentId;
    const version = report.version;
    const w = report.hookWiring;
    if (w?.supported) {
      if (w.settingsMissing) {
        out.push(finding({
          severity: FINDING_SEVERITY['unwired-hook'], kind: 'unwired-hook', device, agent, version,
          message: `settings.json missing — ${w.expected ?? 0} declared hook${(w.expected ?? 0) === 1 ? '' : 's'} never fire`,
        }));
      } else if (w.settingsUnparseable) {
        out.push(finding({
          severity: FINDING_SEVERITY['unwired-hook'], kind: 'unwired-hook', device, agent, version,
          message: `settings.json unparseable — hook wiring can't be verified`,
        }));
      } else {
        for (const u of w.unwired) {
          out.push(finding({
            severity: FINDING_SEVERITY['unwired-hook'], kind: 'unwired-hook', device, agent, version,
            message: `hook '${u.name}' present on disk but not wired into settings.json`,
          }));
        }
      }
    }
    for (const issue of w?.runtimeBroken ?? []) {
      out.push(finding({
        severity: FINDING_SEVERITY['hook-runtime-broken'], kind: 'hook-runtime-broken', device, agent, version,
        message: `hook '${issue.name}' wired but its generated shim is ${issue.reason}`,
      }));
    }
    const neverSynced = input.syncRows.some(
      (s) => s.agent === agent && s.version === version && s.status === 'never-synced',
    );

    const missingHooks: ResourceItem[] = [];
    const missingPlugins: ResourceItem[] = [];
    const missingOther: ResourceItem[] = [];
    const drifted: ResourceItem[] = [];
    for (const kind of DOCTOR_ALL_KINDS) {
      const singular = KIND_SINGULAR[kind];
      for (const r of report.kinds[kind] ?? []) {
        if (r.status === 'missing') {
          if (kind === 'hooks') missingHooks.push({ short: `'${r.name}'`, full: `hook '${r.name}' missing` });
          else if (kind === 'plugins') missingPlugins.push({ short: `'${r.name}'`, full: `plugin '${r.name}' missing` });
          else missingOther.push({ short: `${singular} '${r.name}'`, full: `${singular} '${r.name}' missing` });
        } else if (r.status === 'diff') {
          drifted.push({
            short: `${singular} '${r.name}'`,
            full: r.detail
              ? `${singular} '${r.name}' — ${r.detail}`
              : `${singular} '${r.name}' changed upstream — re-sync`,
          });
        }
      }
    }

    if (neverSynced) {
      const total = missingHooks.length + missingPlugins.length + missingOther.length;
      if (total > 0) {
        const breakdown = [
          missingHooks.length ? `${missingHooks.length} hook${missingHooks.length === 1 ? '' : 's'}` : '',
          missingPlugins.length ? `${missingPlugins.length} plugin${missingPlugins.length === 1 ? '' : 's'}` : '',
        ].filter(Boolean).join(', ');
        out.push(finding({
          severity: FINDING_SEVERITY['never-synced'], kind: 'never-synced', device, agent, version,
          message: `never synced — ${total} resource${total === 1 ? '' : 's'}${breakdown ? ` (incl. ${breakdown})` : ''} not installed`,
        }));
      }
    } else {
      emitGroup(out, missingHooks, FINDING_SEVERITY['missing-hook'], 'missing-hook', device, agent, version, 'hook', 'missing');
      emitGroup(out, missingPlugins, FINDING_SEVERITY['missing-plugin'], 'missing-plugin', device, agent, version, 'plugin', 'missing');
      emitGroup(out, missingOther, FINDING_SEVERITY['missing-resource'], 'missing-resource', device, agent, version, 'resource', 'missing');
      emitGroup(out, drifted, FINDING_SEVERITY['content-drift'], 'content-drift', device, agent, version, 'resource', 'drifted');
      if (missingHooks.length + missingPlugins.length + missingOther.length + drifted.length > 0) {
        detailedVersions.add(`${agent}@${version}`);
      }
    }
  }

  for (const row of input.syncRows) {
    if (row.status === 'stale') {
      if (detailedVersions.has(`${row.agent}@${row.version}`)) continue;
      out.push(finding({
        severity: FINDING_SEVERITY['stale'], kind: 'stale', device, agent: row.agent, version: row.version,
        message: 'sources changed since last sync',
      }));
    } else if (row.status === 'never-synced') {
      const hadCritical = input.reports.some(
        (rep) => rep.agent === row.agent && rep.version === row.version &&
          Object.values(rep.kinds).some((rows) => rows.some((r) => r.status === 'missing')),
      );
      if (!hadCritical) {
        out.push(finding({
          severity: FINDING_SEVERITY['never-synced'], kind: 'never-synced', device, agent: row.agent, version: row.version,
          message: 'installed but never synced',
        }));
      }
    }
  }

  for (const m of input.repoBehind) {
    if (m.behind <= 0) continue;
    const stales = input.syncRows.filter((r) => r.status === 'stale').length;
    const staleNote = stales > 0 ? ` → stales ${stales} version${stales === 1 ? '' : 's'}` : '';
    out.push(finding({
      severity: FINDING_SEVERITY['repo-behind'], kind: 'repo-behind', device, version: m.alias,
      message: `${m.behind} behind ${m.branch}${staleNote}`,
    }));
  }

  out.push(...orphanFinding(device, input.orphanRows));

  const missingClis = (input.hostClis?.statuses ?? []).filter((c) => !c.installed).map((c) => c.name);
  if (missingClis.length > 0) {
    out.push({
      severity: FINDING_SEVERITY['host-cli-missing'], kind: 'host-cli-missing', device,
      message: missingClis.length === 1
        ? `host CLI '${missingClis[0]}' declared but not installed`
        : `${missingClis.length} declared host CLIs not installed (${missingClis.slice(0, 2).join(', ')}${missingClis.length > 2 ? ', …' : ''})`,
      remediation: missingClis.length === 1
        ? `agents cli install ${missingClis[0]}`
        : 'agents cli install',
    });
  }
  for (const e of input.hostClis?.errors ?? []) {
    out.push(finding({
      severity: FINDING_SEVERITY['host-cli-invalid'], kind: 'host-cli-invalid', device,
      message: `host-CLI manifest ${e.file} could not be read: ${e.reason}`,
    }));
  }

  out.push(...duplicateHookFindings(device, input.duplicateHooks ?? []));

  for (const f of rcSecretFindings(device, input.rcSecrets ?? [])) out.push(f);

  const envFinding = envSecretFinding(device, input.masterPassphraseInEnv ?? false);
  if (envFinding) out.push(envFinding);

  const authFinding = authBundleWrongBackendFinding(device, input.authBundleWrongBackend ?? false);
  if (authFinding) out.push(authFinding);

  const policyFinding = execPolicyFinding(device, input.execPolicy);
  if (policyFinding) out.push(policyFinding);

  if (input.windowsSshEnrollment) {
    const problem = windowsSshEnrollmentProblem(input.windowsSshEnrollment);
    if (problem) {
      out.push(finding({
        severity: FINDING_SEVERITY['ssh-key-enrollment'], kind: 'ssh-key-enrollment', device,
        message: problem,
      }));
    }
  }

  out.push(...signInToFindings(device, input.signIn));

  const shadows = input.binaryShadows ?? [];
  if (shadows.length > 0) {
    const examples = shadows.slice(0, 2).map((s) => `${s.path}${s.version ? ` (${s.version})` : ''}`).join(', ');
    out.push(finding({
      severity: FINDING_SEVERITY['binary-shadow'], kind: 'binary-shadow', device,
      message: shadows.length === 1
        ? `agents binary shadowed by ${examples}`
        : `${shadows.length} agents binaries may shadow the running copy (incl. ${examples})`,
    }));
  }

  for (const d of input.leakedDaemons ?? []) {
    const home = d.home ?? 'unknown HOME';
    const started = d.startedAt ? `, started ${d.startedAt}` : '';
    const entry = d.entry && path.isAbsolute(d.entry) ? ` · ${d.entry}` : '';
    out.push({
      severity: FINDING_SEVERITY['leaked-daemon'], kind: 'leaked-daemon', device,
      message: `stray agents daemon (pid ${d.pid}) no unit or pid file owns — HOME=${home}${started}${entry}`,
      remediation: `kill ${d.pid}`,
    });
  }

  return collapseAcrossVersions(out, new Set(input.isolatedVersions ?? []));
}

function orphanFinding(device: string, rows: OrphanRow[]): DoctorFinding[] {
  const affected = rows.filter((r) => r.commands + r.skills + r.hooks > 0);
  if (affected.length === 0) return [];
  const total = affected.reduce((n, r) => n + r.commands + r.skills + r.hooks, 0);
  const where = affected.length === 1
    ? `${affected[0].agent}@${affected[0].version}`
    : `${affected.length} versions`;
  return [finding({
    severity: FINDING_SEVERITY['orphan'], kind: 'orphan', device,
    message: `${total} orphaned resource${total === 1 ? '' : 's'} on ${where} (cleanup only)`,
  })];
}

function duplicateHookFindings(device: string, dups: DuplicateVersionHook[]): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  const byAgentKind = new Map<string, DuplicateVersionHook[]>();
  for (const d of dups) {
    const key = `${d.agent} ${d.kind}`;
    if (!byAgentKind.has(key)) byAgentKind.set(key, []);
    byAgentKind.get(key)!.push(d);
  }
  for (const group of byAgentKind.values()) {
    const drift = group[0].kind === 'drift';
    const agent = group[0].agent;
    const active = group[0].authoritative.version;
    const versions = Array.from(new Set(group.flatMap((d) => d.copies.map((c) => c.version))));
    const authority = `${active} is authoritative`;
    const message = group.length === 1
      ? drift
        ? `hook '${group[0].name}' differs across ${versions.join(', ')} — ${authority}`
        : `hook '${group[0].name}' duplicated (identical) across ${versions.join(', ')} — ${authority}`
      : `${group.length} hooks ${drift ? 'differ' : 'duplicated (identical)'} across ` +
        `${versions.length} version${versions.length === 1 ? '' : 's'} ` +
        `(incl. ${group.slice(0, 2).map((d) => `'${d.name}'`).join(', ')}) — ${authority}`;
    out.push({
      severity: FINDING_SEVERITY[drift ? 'duplicate-hook-drift' : 'duplicate-hook'],
      kind: drift ? 'duplicate-hook-drift' : 'duplicate-hook',
      device, agent, versions, message,
      remediation: `agents sync ${agent}@all --yes`,
    });
  }
  return out;
}

function rcSecretFindings(device: string, rc: RcSecretFinding[]): DoctorFinding[] {
  if (rc.length === 0) return [];
  const out: DoctorFinding[] = [];
  const groups: Array<{ rows: RcSecretFinding[]; remediation: string }> = [
    {
      rows: rc.filter((f) => f.isMasterPassphrase),
      remediation: 'move it to ~/.agents/.secrets-key/passphrase (chmod 600)',
    },
    { rows: rc.filter((f) => !f.isMasterPassphrase), remediation: '' },
  ];
  for (const g of groups) {
    if (g.rows.length === 0) continue;
    const n = g.rows.length;
    const examples = g.rows.slice(0, 2).map((f) => `${f.file}:${f.line} ${f.name}`).join(', ');
    const master = g.rows[0].isMasterPassphrase;
    const what = master
      ? `file-store master key exported from a shell rc file`
      : `${n} credential-shaped export${n === 1 ? '' : 's'} in shell rc files`;
    const remediation = master
      ? g.remediation
      : n === 1
        ? 'agents secrets add, then delete the rc line'
        : `agents secrets add once per export (${n}), then delete each rc line`;
    out.push({
      severity: FINDING_SEVERITY['rc-secret-export'], kind: 'rc-secret-export', device,
      message: `${what} (${examples}) — readable by any same-user process`,
      remediation,
    });
  }
  return out;
}

function envSecretFinding(device: string, present: boolean): DoctorFinding | null {
  if (!present) return null;
  return finding({
    severity: FINDING_SEVERITY['env-secret-export'], kind: 'env-secret-export', device,
    message: 'AGENTS_SECRETS_PASSPHRASE is set in this process environment — every '
      + 'child inherits it and any same-user process can read it from /proc/<pid>/environ. '
      + 'It outlives the shell rc line that set it, so deleting that line is not enough. '
      + '(Expected inside a release sign context, which sets it deliberately.)',
  });
}

function authBundleWrongBackendFinding(device: string, present: boolean): DoctorFinding | null {
  if (!present) return null;
  return finding({
    severity: FINDING_SEVERITY['auth-bundle-wrong-backend'], kind: 'auth-bundle-wrong-backend', device,
    message: "reserved secrets bundle 'auth' exists but is not file-backed — "
      + 'usage/probe ignores the setup-tokens and falls through to the interactive login',
  });
}

function execPolicyFinding(
  device: string,
  execPolicy: LocalFindingInputs['execPolicy'],
): DoctorFinding | null {
  if (!execPolicy || execPolicy.platform !== 'win32') return null;
  if (!blocksLocalScripts(execPolicy.policy)) return null;
  return finding({
    severity: FINDING_SEVERITY['exec-policy'], kind: 'exec-policy', device,
    message: `PowerShell execution policy is ${execPolicy.policy} — it blocks the generated agents.ps1 launcher (agents.cmd still works)`,
  });
}

/**
 * Fold findings that say the SAME thing about several versions of one agent into
 * a single row carrying `versions`, and widen its remediation to the agent-wide
 * sweep (`agents sync claude@all --yes` heals every non-isolated version in one
 * go). Five identical `plugin 'code' — mirror missing` rows, one per installed
 * claude, is the same fact five times.
 *
 * Three things never merge, because for each of them the widened remediation
 * would be wrong:
 *  - **Isolated copies** — the agent-wide sweep deliberately skips them, so a
 *    folded row would print a command that leaves one broken.
 *  - **Findings with no agent** (repo-behind, rc-secret-export, …) — their
 *    `version` field is an alias, not a version.
 *  - **Logouts** ({@link NEVER_COLLAPSED}) — a login is inherently per-version:
 *    the fix is `agents run <agent>@<version> -- login`, and there is no `@all`
 *    equivalent. Dropping `version` would fall back to the bare native hint,
 *    which the shim resolves to the DEFAULT version — logging into the wrong one
 *    and leaving the finding to reappear.
 *
 * Pure; input order is kept.
 */
export function collapseAcrossVersions(
  findings: DoctorFinding[],
  isolated: Set<string>,
): DoctorFinding[] {
  const groups = new Map<string, DoctorFinding[]>();
  const order: string[] = [];
  for (const f of findings) {
    const mergeable = f.agent && f.version
      && !isolated.has(`${f.agent}@${f.version}`)
      && !NEVER_COLLAPSED.has(f.kind);
    const key = mergeable
      ? `${f.device}\0${f.agent}\0${f.kind}\0${f.severity}\0${f.account ?? ''}\0${f.message}`
      : `${order.length}`;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key)!.push(f);
  }
  const out: DoctorFinding[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    if (group.length === 1) { out.push(group[0]); continue; }
    const versions = group.map((f) => f.version!);
    const merged: DoctorFinding = {
      ...group[0], version: undefined, versions, remediation: '',
    };
    merged.remediation = remediationFor(merged);
    out.push(merged);
  }
  return out;
}

/**
 * Map a device's per-version sign-in into logout findings: a PROVABLE logout is
 * CRITICAL, an unprovable one is a hedged WARNING ("could not verify sign-in"),
 * and a signed-in version yields nothing.
 *
 * An agent with no inspectable identity never appears at all — not even as the
 * hedged warning: agents-cli knows no credential file for it, so "logged out" is
 * unknowable and silence beats a false claim. Membership is
 * `supportsAccountInspection` (`lib/agents.ts`) and is deliberately NOT listed
 * here — agents move between the sets, and a copy of the list in prose becomes a
 * lie the next time one does. Note the caller also requires
 * `CredentialPresence.knownLocation`: the inspection set and the credential-path
 * map move independently, so being inspectable is not on its own enough to call a
 * logout provable. Pure.
 */
export function signInToFindings(
  device: string,
  signIn: Record<string, FleetVersionSignIn[]>,
): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  for (const agentId of sortedAgentIds(Object.keys(signIn))) {
    const rows = signIn[agentId];
    const agent = agentId as AgentId;
    if (!supportsAccountInspection(agent)) continue;
    for (const row of rows) {
      if (row.signedIn) continue;
      if (row.provable) {
        out.push(finding({
          severity: FINDING_SEVERITY['logged-out'], kind: 'logged-out', device, agent, version: row.version,
          account: row.account ?? null,
          message: 'logged out — no account signed in',
        }));
      } else {
        out.push(finding({
          severity: FINDING_SEVERITY['logout-unprovable'], kind: 'logout-unprovable', device, agent, version: row.version,
          account: row.account ?? null,
          message: 'could not verify sign-in',
        }));
      }
    }
  }
  return out;
}

export function hookRuntimeToFindings(
  device: string,
  hookRuntime: Record<string, Record<string, FleetHookRuntimeState>> | undefined,
): DoctorFinding[] {
  if (!hookRuntime) {
    return [finding({
      severity: FINDING_SEVERITY['hook-runtime-visibility-unavailable'],
      kind: 'hook-runtime-visibility-unavailable',
      device,
      message: "older agents-cli — can't report generated hook-wrapper health",
    })];
  }

  const out: DoctorFinding[] = [];
  for (const agent of ALL_AGENT_IDS) {
    const versions = hookRuntime[agent];
    if (!versions) continue;
    for (const [version, state] of Object.entries(versions)) {
      if (state !== 'broken') continue;
      out.push(finding({
        severity: FINDING_SEVERITY['hook-runtime-broken'],
        kind: 'hook-runtime-broken',
        device,
        agent,
        version,
        message: 'generated hook wrapper is unusable',
      }));
    }
  }
  return out;
}

export function fleetDivergenceToFindings(
  divergences: FleetDivergence[],
  baseline: string,
): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  for (const d of divergences) {
    const laggingDevice = d.kind.endsWith('-missing-local') ? baseline : d.device;
    switch (d.kind) {
      case 'agent-version-missing-remote':
      case 'agent-version-missing-local':
        out.push(finding({
          severity: FINDING_SEVERITY['version-skew'], kind: 'version-skew', device: laggingDevice,
          agent: d.category as AgentId, version: d.name,
          message: 'not installed (present elsewhere in the fleet)',
        }));
        break;
      case 'repo-drift':
        out.push(finding({
          severity: FINDING_SEVERITY['repo-drift'], kind: 'repo-drift', device: laggingDevice,
          version: d.category === 'system' ? 'system' : 'user',
          message: d.message,
        }));
        break;
      case 'resource-missing-remote':
      case 'resource-missing-local':
        out.push(finding({
          severity: FINDING_SEVERITY['fleet-resource-gap'], kind: 'fleet-resource-gap', device: laggingDevice,
          message: `${d.category.replace(/s$/, '')} '${d.name}' missing (present elsewhere)`,
        }));
        break;
    }
  }
  return out;
}


function deviceSeverityRank(findings: DoctorFinding[]): number {
  const crit = findings.filter((f) => f.severity === 'critical').length;
  const warn = findings.filter((f) => f.severity === 'warning').length;
  return crit * 1000 + warn;
}

function subjectLabel(f: DoctorFinding): string {
  if (!f.agent) return '';
  if (f.versions && f.versions.length > 1) return `${f.agent} (${f.versions.length} versions)`;
  return f.version ? `${f.agent} @${f.version}` : f.agent;
}

function critLabel(f: DoctorFinding): { left: string; account: string; message: string } {
  if (f.kind === 'owner-not-signed-in') return { left: 'owner', account: '', message: f.message };
  return {
    left: subjectLabel(f),
    account: f.account ?? '',
    message: f.message,
  };
}

function pad(s: string, width: number): string {
  return padToWidth(s, width);
}

function widestOf(values: string[], min: number): number {
  return Math.max(...values.map(stringWidth), min);
}

export interface RenderOptions {
  fleet: boolean;
  baseline?: string;
  header?: string;
}

export function renderFindings(
  findings: DoctorFinding[],
  accounts: Record<string, Record<string, FleetVersionSignIn[]>>,
  opts: RenderOptions,
): string[] {
  const lines: string[] = [];

  if (opts.header) lines.push(opts.header);
  lines.push('');

  const byDevice = new Map<string, DoctorFinding[]>();
  for (const f of findings) {
    (byDevice.get(f.device) ?? byDevice.set(f.device, []).get(f.device)!).push(f);
  }
  for (const device of Object.keys(accounts)) {
    if (!byDevice.has(device)) byDevice.set(device, []);
  }

  const devices = Array.from(byDevice.keys()).sort((a, b) => {
    const ra = deviceSeverityRank(byDevice.get(a)!);
    const rb = deviceSeverityRank(byDevice.get(b)!);
    if (rb !== ra) return rb - ra;
    if (a === opts.baseline) return -1;
    if (b === opts.baseline) return 1;
    return a.localeCompare(b);
  });
  const deviceOrder = new Map(devices.map((d, i) => [d, i]));

  const criticals = findings
    .filter((f) => f.severity === 'critical')
    .sort((a, b) => (deviceOrder.get(a.device) ?? 0) - (deviceOrder.get(b.device) ?? 0));
  lines.push(`${chalk.red('✗')} ${chalk.red('CRITICAL — needs you now')}  (${criticals.length})`);
  if (criticals.length === 0) {
    lines.push(`  ${chalk.green('✓')} ${chalk.gray('nothing critical across the fleet')}`);
  } else {
    const rows = criticals.map((f) => ({ f, ...critLabel(f) }));
    const showDevice = opts.fleet;
    const devW = showDevice ? widestOf(rows.map((r) => r.f.device), 6) : 0;
    const leftW = widestOf(rows.map((r) => r.left), 4);
    const acctW = widestOf(rows.map((r) => r.account), 0);
    const msgW = widestOf(rows.map((r) => r.message), 4);
    for (const r of rows) {
      const dev = showDevice ? `${pad(r.f.device, devW)}  ` : '';
      const left = pad(r.left, leftW);
      const acct = acctW > 0 ? `  ${pad(r.account, acctW)}` : '';
      const msg = pad(r.message, msgW);
      lines.push(
        `  ${chalk.hex('#a3e635')(dev)}${chalk.bold(left)}${acct ? chalk.cyan(acct) : ''}  ${msg} ${chalk.blue('→')} ${chalk.blue(r.f.remediation)}`,
      );
    }
  }

  if (opts.fleet) {
    lines.push('');
    lines.push(chalk.gray('─── by computer ───'));
  }

  for (const device of devices) {
    const df = byDevice.get(device)!;
    lines.push('');
    const critN = df.filter((f) => f.severity === 'critical').length;
    const tags: string[] = [];
    if (device === opts.baseline) tags.push('this machine');
    const tagStr = tags.length ? chalk.gray(` · ${tags.join(' · ')}`) : '';
    const critMarker = critN > 0
      ? `  ${chalk.red(`✗ ${critN} critical (above)`)}`
      : '';
    lines.push(`${chalk.hex('#a3e635')(`▸ ${device}`)}${tagStr}${critMarker}`);

    const warnings = df.filter((f) => f.severity === 'warning');
    if (warnings.length === 0) {
      lines.push(`    ${chalk.green('✓')} ${chalk.gray('no warnings')}`);
    } else {
      const subjW = widestOf(warnings.map(warningSubject), 4);
      for (const w of warnings) {
        const subj = pad(warningSubject(w), subjW);
        lines.push(
          `    ${chalk.yellow('⚠')} ${chalk.yellow(subj)}  ${w.message} ${chalk.blue('→')} ${chalk.blue(w.remediation)}`,
        );
      }
    }

    const acctLine = renderAccountsLine(accounts[device] ?? {});
    if (acctLine) lines.push(`    ${acctLine}`);
  }

  return lines;
}

function warningSubject(f: DoctorFinding): string {
  if (f.kind === 'repo-behind') return f.version ? `~/.agents (${f.version})` : '~/.agents';
  if (f.kind === 'repo-drift') return 'config repo';
  if (f.kind === 'stale-cli') return 'agents-cli';
  if (f.kind === 'binary-shadow') return 'agents-cli';
  if (f.kind === 'orphan') return 'orphans';
  if (f.kind === 'rc-secret-export') return 'shell rc';
  if (f.kind === 'env-secret-export') return 'environment';
  if (f.kind === 'auth-bundle-wrong-backend') return 'auth bundle';
  if (f.kind === 'exec-policy') return 'PowerShell';
  if (f.kind === 'fleet-resource-gap') return 'fleet gap';
  if (f.kind === 'host-cli-missing') return 'host CLIs';
  if (f.kind === 'missing-resource' && !f.agent) return 'fleet gap';
  if (f.agent) return subjectLabel(f);
  return f.kind;
}

export function renderAccountsLine(signIn: Record<string, FleetVersionSignIn[]>): string {
  const parts: string[] = [];
  const agents = sortedAgentIds(Object.keys(signIn));
  for (const agentId of agents) {
    const rows = signIn[agentId];
    if (!rows || rows.length === 0) continue;
    const agent = agentId as AgentId;
    if (rows.length === 1) {
      const r = rows[0];
      parts.push(`${agentId} ${badge(agent, r)}`);
    } else {
      const versionParts = rows
        .map((r) => `${r.version} ${badge(agent, r)}`)
        .join(' ');
      parts.push(`${agentId} ${versionParts}`);
    }
  }
  return parts.join(chalk.gray(' · '));
}

/**
 * The per-version sign-in badge: green `✓` + cyan account when signed in, red `✗`
 * only for a PROVABLE logout, gray `?` when the state is unknown.
 *
 * The third case is load-bearing. A probe that threw, or an agent whose
 * credential location we do not know, yields `signedIn: false` with
 * `provable: false` — and the finding for that row is deliberately the hedged
 * "could not verify sign-in". Painting it red here would have the same report say
 * "unverifiable" in the warning and "logged out" in the accounts line.
 */
function badge(agent: AgentId, row: FleetVersionSignIn): string {
  if (row.signedIn) {
    const who = row.account ?? '';
    return who ? `${chalk.green('✓')}${chalk.cyan(who)}` : chalk.green('✓');
  }
  return row.provable ? chalk.red('✗') : chalk.gray('?');
}
