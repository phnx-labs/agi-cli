/**
 * `agents fleet apply` / `agents devices apply` — reconcile the whole fleet
 * to a declared profile: install agents-cli + agents and sync config. Native
 * harness logins remain device-local; portable provider credentials move only
 * through explicit `agents accounts sync`.
 *
 * The manifest is the `fleet:` block of any `-f` file (default `agents.yaml`).
 * Top-level `agents apply` is retired (RUSH-2981).
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import chalk from 'chalk';
import { setHelpSections } from '../lib/help.js';
import { machineId } from '../lib/session/sync/config.js';
import { loadDevices, type DeviceProfile } from '../lib/devices/registry.js';
import { isHostPinned, isDevicePinned, managedKnownHostsPath } from '../lib/devices/known-hosts.js';
import { ensureDevicesRegistered } from '../lib/devices/sync.js';
import { readFleetFile, resolveDesired, emptyTargetsMessage } from '../lib/fleet/manifest.js';
import { snapshotAuth } from '../lib/fleet/auth-sync.js';
import { AUTH_STORE_ALIAS } from '../lib/secrets-policy.js';
import {
  agentIdOf,
  diffFleet,
  probeDevice,
  runFleetApply,
  pool,
  sourceHome,
  expandAllSpecs,
  rosterNeedsVersions,
  fleetSecretsBundles,
  type SourceAuth,
  type DeviceApplyResult,
} from '../lib/fleet/apply.js';
import { listInstalledVersions } from '../lib/installations/versions.js';
import type { AgentId } from '../lib/types.js';
import type { DeviceDesired, DeviceProbe, DeviceDiff, FleetPlan } from '../lib/fleet/types.js';

interface ApplyOptions {
  file?: string;
  plan?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  device?: string;
  agent?: string[]; // --agent claude@all codex@latest (variadic)
  only?: string;
  login?: boolean; // Commander sets false for --no-login
  provisionSecrets?: boolean;
  force?: boolean;
}

/** Version of the running agents-cli — the fleet target version. */
function localCliVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'package.json'), 'utf-8'));
    return String(pkg.version ?? '');
  } catch {
    return '';
  }
}

function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const onData = (d: Buffer) => {
      process.stdin.pause();
      process.stdin.off('data', onData);
      resolve(/^y(es)?$/i.test(d.toString().trim()));
    };
    process.stdin.resume();
    process.stdin.once('data', onData);
  });
}

const ONLY_KINDS: Record<string, Set<string>> = {
  agents: new Set(['install-cli', 'upgrade-cli', 'add-agent']),
  config: new Set(['sync-config']),
  login: new Set(['needs-login']),
};

/** Render the device x dimension matrix (cribbed from `doctor --devices`). */
function renderPlan(plan: FleetPlan): void {
  const rows = plan.devices;
  const nameWidth = Math.max('device'.length, ...rows.map((r) => r.device.length));

  const cell = (row: DeviceDiff, kinds: string[], okLabel: string): string => {
    if (!row.probe.reachable) return chalk.gray('- offline');
    const acts = row.actions.filter((a) => kinds.includes(a.kind));
    if (acts.length === 0) return chalk.green(`ok ${okLabel}`);
    if (acts.some((a) => a.kind === 'needs-login')) {
      const need = acts.filter((a) => a.kind === 'needs-login').length;
      return chalk.yellow(`${need} manual`);
    }
    return chalk.cyan('↑ ' + acts.map((a) => a.agent ?? a.kind.replace('-cli', '')).join(','));
  };

  // Only show the secrets column when the manifest declares any — an all-`-`
  // column on every fleet that uses no bundles is noise.
  const anySecrets = rows.some((r) => r.actions.some((a) => a.kind === 'push-secret' || a.kind === 'needs-secret'));
  const header = `  ${'device'.padEnd(nameWidth)}   ${'agents-cli'.padEnd(12)}${'agents'.padEnd(20)}${'config'.padEnd(10)}${anySecrets ? 'login'.padEnd(18) + 'secrets' : 'login'}`;
  console.log(chalk.gray(header));
  for (const row of rows) {
    const cli = row.probe.reachable
      ? (row.actions.find((a) => a.kind === 'install-cli') ? chalk.cyan('install')
        : row.actions.find((a) => a.kind === 'upgrade-cli') ? chalk.cyan('upgrade')
        : chalk.green(`ok ${row.probe.cliVersion ?? ''}`))
      : chalk.gray('- offline');
    const agentsCell = row.probe.reachable
      ? (() => {
        const add = row.actions.filter((a) => a.kind === 'add-agent');
        return add.length === 0 ? chalk.green(`ok ${row.desired.agents.length}/${row.desired.agents.length}`) : chalk.cyan('+ ' + add.map((a) => a.spec ?? a.agent).join(','));
      })()
      : chalk.gray('-');
    const configCell = row.probe.reachable
      ? (row.actions.some((a) => a.kind === 'sync-config') ? chalk.cyan('↑ sync') : chalk.green('ok'))
      : chalk.gray('-');
    const loginCell = cell(row, ['needs-login'], `${row.desired.agents.length}/${row.desired.agents.length}`);
    const secretsCell = (() => {
      if (!anySecrets) return '';
      if (!row.probe.reachable) return chalk.gray('- offline');
      const push = row.actions.filter((a) => a.kind === 'push-secret').length;
      const blocked = row.actions.filter((a) => a.kind === 'needs-secret').length;
      if (push === 0 && blocked === 0) return chalk.green('ok');
      if (push > 0 && blocked === 0) return chalk.cyan(`↑ push ${push}`);
      if (push === 0) return chalk.yellow(`blocked ${blocked}`);
      return chalk.yellow(`↑ push ${push} · blocked ${blocked}`);
    })();
    const loginPart = anySecrets ? stripPad(loginCell, 18) + secretsCell : loginCell;
    console.log(`  ${row.device.padEnd(nameWidth)}   ${stripPad(cli, 12)}${stripPad(agentsCell, 20)}${stripPad(configCell, 10)}${loginPart}`);
  }
  console.log();
  console.log(chalk.gray(`  ${plan.actions.length} action(s) across ${rows.filter((r) => r.probe.reachable).length} reachable device(s)`));

  // The capability is opt-in, so when it is OFF and the manifest declares
  // bundles, say that it exists. Otherwise an operator reads "manual recreate"
  // and concludes there is no supported path — which is exactly the conclusion
  // that led to a master key being hand-exported across the fleet (RUSH-1968).
  if (anySecrets && !rows.some((r) => r.actions.some((a) => a.kind === 'push-secret'))) {
    console.log(chalk.gray('  secrets: not pushed. `--provision-secrets` pushes declared bundles to devices whose host key is pinned.'));
  }

  // `apply` no longer propagates ANY login (SING-1b: a native OAuth / session
  // login is never copied between devices). Every login:sync agent that has a
  // login to establish is surfaced here with the one honest reason + the portable
  // alternative — never a silent skip.
  const needsLogin = [...new Set(rows.flatMap((r) => r.loginBlocked.map((a) => `${a}@${r.device}`)))];
  if (needsLogin.length > 0) {
    console.log(
      chalk.yellow(
        `  manual login needed — a native OAuth login is never copied between devices (SING-1b); ` +
        `log in on the box itself, or sync a portable provider account (\`agents accounts sync\`): ${needsLogin.join(', ')}`,
      ),
    );
  }
  // Secrets bundles are declared once for the fleet; surface the distinct set the
  // gate did NOT push, so a refusal is never silent. "never pushed" used to be
  // literally true here and no longer is — `--provision-secrets` pushes them.
  const bundles = [...new Set(rows.flatMap((r) => r.secretsNeeded))];
  if (bundles.length > 0) {
    const shown = bundles.slice(0, 12);
    const more = bundles.length - shown.length;
    const list = shown.join(', ') + (more > 0 ? `, +${more} more` : '');
    console.log(chalk.yellow(`  ${bundles.length} secrets bundle(s) not pushed — recreate where missing: ${list}`));
  }
}

/** padEnd on the visible width, ignoring chalk color codes. Exported for tests. */
export function stripPad(s: string, width: number): string {
  // Strip the whole SGR sequence (ESC `[` ... `m`). Matching only the `[...m`
  // tail leaves each leading ESC byte counted as visible, so every colored
  // cell over-pads and the plan table misaligns in a real TTY.
  // eslint-disable-next-line no-control-regex
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '').length;
  return s + ' '.repeat(Math.max(1, width - visible));
}

async function runApply(opts: ApplyOptions): Promise<void> {
  const file = opts.file ?? 'agents.yaml';
  const manifest = readFleetFile(path.resolve(file));
  const source = machineId();

  // Fresh-machine bootstrap: an explicit `devices:` map may name boxes this
  // machine has never registered (e.g. a freshly-cloned agents.yaml). Resolve
  // those names live from Tailscale and register them BEFORE resolveDesired
  // validates the roster — so replication needs only the repo, never committed
  // IPs/usernames. `devices: all` needs no bootstrap (it targets what's already
  // registered + online).
  let unresolved: string[] = [];
  if (manifest.devices !== 'all') {
    const wanted = Object.keys(manifest.devices).filter((n) => n !== source);
    const boot = await ensureDevicesRegistered(wanted);
    unresolved = boot.unresolved;
    if (boot.registered.length > 0) {
      console.log(chalk.gray(`Registered ${boot.registered.length} device(s) from Tailscale: ${boot.registered.join(', ')}`));
    }
    if (boot.unresolved.length > 0) {
      console.log(chalk.yellow(`Not resolvable on Tailscale — skipped, reconcile continues for the rest: ${boot.unresolved.join(', ')}`));
    }
  }

  const registry = await loadDevices();
  const all = Object.values(registry);
  const online = all.filter((d) => d.tailscale?.online === true).map((d) => d.name);
  const registered = all.map((d) => d.name);

  // Unresolved names are skipped (surfaced above), never fatal — a manifest
  // naming an asleep box must not abort the reconcile for every other device.
  let desired = resolveDesired(manifest, { onlineDevices: online, registeredDevices: registered, source, unresolved });
  if (opts.device) {
    desired = desired.filter((d) => d.device === opts.device);
    if (desired.length === 0) throw new Error(`Device '${opts.device}' is not a target in this manifest.`);
  }
  // --agent overrides the roster for the targeted device(s): install exactly these
  // specs instead of the manifest's. `claude@all` expands to every claude version
  // installed on THIS machine, so a fresh box inherits the same version set. Pair
  // with --device to seed one box; without it, every targeted device gets the set.
  if (opts.agent && opts.agent.length > 0) {
    const specs = expandAllSpecs(opts.agent, (id) => listInstalledVersions(id as AgentId));
    desired = desired.map((d) => ({ ...d, agents: specs }));
    console.log(chalk.gray(`Roster override (--agent): ${specs.join(', ')}`));
  }
  if (opts.login === false) desired = desired.map((d) => ({ ...d, login: 'skip' as const }));
  if (desired.length === 0) {
    const msg = emptyTargetsMessage(manifest);
    if (msg.style === 'hint') {
      console.log(chalk.yellow(msg.lines[0]));
      for (const line of msg.lines.slice(1)) console.log(chalk.gray(`  ${line}`));
    } else {
      console.log(chalk.gray(msg.lines[0]));
    }
    return;
  }

  // Snapshot source auth once for every agent named anywhere in the profile.
  const allAgents = [...new Set(desired.flatMap((d) => d.agents.map(agentIdOf)))];
  const snap = snapshotAuth(allAgents, { home: sourceHome(), platform: process.platform });
  const filesByAgent = new Map<string, typeof snap.files>();
  for (const f of snap.files) {
    const arr = filesByAgent.get(f.agent) ?? [];
    arr.push(f);
    filesByAgent.set(f.agent, arr);
  }
  const sourceAuth: SourceAuth = {
    available: new Set(snap.files.map((f) => f.agent)),
    bound: new Set(snap.bound),
    filesByAgent,
  };

  // Probe every target device in parallel.
  const nameToProfile = new Map<string, DeviceProfile>(desired.map((d) => [d.device, registry[d.device]!]));
  const withVersions = rosterNeedsVersions(desired);
  // One extra `secrets list --json` per device, and only when it can change the
  // plan: the manifest declares bundles AND provisioning is on. Same cost
  // discipline as `withVersions` — a fleet that uses no bundles never pays it.
  const secretsBundles = fleetSecretsBundles(manifest.secrets?.bundles);
  const withSecrets = (opts.provisionSecrets === true && secretsBundles.length > 0)
    || secretsBundles.includes(AUTH_STORE_ALIAS);
  console.log(chalk.gray(`Probing ${desired.length} device(s)…`));
  const probeList = await pool(desired, 6, async (d) => probeDevice(nameToProfile.get(d.device)!, { withVersions, withSecrets }));
  const probes = new Map<string, DeviceProbe>(probeList.map((p) => [p.device, p]));

  const targetCliVersion = localCliVersion();
  let plan = diffFleet(desired, probes, {
    targetCliVersion,
    sourceAuth,
    secretsBundles,
    provisionSecrets: opts.provisionSecrets === true,
    forceSecrets: opts.force === true,
    // Portable secret values only ever go to a host whose key is already pinned.
    // Resolve the device to its profile so the pin is checked against the FQDN the
    // ssh connection dials (isDevicePinned), not the bare name — a tailnet worker
    // pinned only under its FQDN would otherwise be refused as "not pinned"
    // (PHNX-3505). A name with no profile falls back to the raw host-string check.
    isHostPinned: (device) => {
      const p = nameToProfile.get(device);
      return p ? isDevicePinned(p) : isHostPinned(device, managedKnownHostsPath());
    },
  });

  // --only filter.
  if (opts.only) {
    const keep = new Set<string>();
    for (const k of opts.only.split(',').map((s) => s.trim())) for (const x of ONLY_KINDS[k] ?? []) keep.add(x);
    plan = {
      devices: plan.devices.map((r) => ({ ...r, actions: r.actions.filter((a) => keep.has(a.kind)) })),
      actions: plan.actions.filter((a) => keep.has(a.kind)),
    };
  }

  console.log();
  console.log(chalk.bold(`Fleet profile · ${desired.length} device(s) · ${allAgents.length} agent(s) (${allAgents.join(', ')})`));
  renderPlan(plan);

  const isDry = opts.plan || opts.dryRun;
  if (isDry) return;
  // `needs-login`/`needs-secret` are surfaced manual reminders, not executable
  // mutations — exclude them so an otherwise-converged fleet still says "nothing
  // to do" instead of looping forever on un-actionable surfacing. `push-secret`
  // IS executable and deliberately stays counted.
  if (plan.actions.filter((a) => a.kind !== 'needs-login' && a.kind !== 'needs-secret').length === 0) {
    console.log(chalk.green('\nNothing to do — fleet already matches the profile.'));
    return;
  }

  if (!opts.yes) {
    const ok = await confirm(chalk.bold(`\nApply this plan? (${plan.actions.length} action(s)) [y/N] `));
    if (!ok) {
      console.log(chalk.gray('Aborted.'));
      return;
    }
  }

  console.log();
  const results = await runFleetApply(plan.devices, nameToProfile, {
    targetCliVersion,
    source,
    sourceAuth,
  });
  reportResults(results);
}

function reportResults(results: DeviceApplyResult[]): void {
  let failures = 0;
  for (const r of results) {
    if (r.note && r.steps.length === 0) {
      console.log(`  ${chalk.gray(r.device.padEnd(16))} ${chalk.yellow('skipped')} ${chalk.gray(r.note)}`);
      continue;
    }
    const badge = r.ok ? chalk.green('ok  ') : chalk.red('fail');
    if (!r.ok) failures++;
    const summary = r.steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.kind}`).join('  ');
    console.log(`  ${chalk.bold(r.device.padEnd(16))} ${badge}  ${chalk.gray(summary)}`);
    for (const s of r.steps.filter((x) => x.kind === 'needs-login')) {
      console.log(`      ${chalk.yellow('→')} ${chalk.gray(s.detail)}`);
    }
  }
  console.log();
  if (failures > 0) {
    console.error(chalk.red(`${failures} device(s) had failures.`));
    process.exit(1);
  }
  console.log(chalk.green('Fleet reconciled.'));
}

/**
 * Attach the reconcile options + action to a command node.
 */
function configureApplyCommand(cmd: Command): Command {
  return cmd
    .description('Reconcile the fleet to a declared profile: install agents and sync config.')
    .option('-f, --file <path>', 'Manifest file carrying a fleet: block (default: agents.yaml)')
    .option('--plan', 'Show the reconcile plan and exit (no changes)')
    .option('--dry-run', 'Alias for --plan')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .option('--device <name>', 'Scope the apply to a single device')
    .option('--agent <specs...>', 'Override the roster for targeted device(s): install these specs instead of the manifest\'s. Use `claude@all` to replicate every version installed on this machine.')
    .option('--only <dims>', 'Limit to dimensions: comma list of agents,config,login')
    .option('--no-login', 'Deprecated no-op: native logins are always device-local')
    .option('--provision-secrets', "Push the manifest's declared secrets bundles to each device (OFF by default; moves credential values over SSH, and only to a device whose host key is already pinned)")
    .option('--force', 'With --provision-secrets: re-push a bundle the device already has')
    .action(async (opts: ApplyOptions) => {
      try {
        await runApply(opts);
      } catch (e) {
        console.error(chalk.red((e as Error).message));
        process.exit(1);
      }
    });
}

/**
 * Canonical surface: `agents fleet apply` / `agents devices apply`.
 * Top-level `agents apply` is retired (RUSH-2981) — not a noun, already nested
 * here. Same reconcile engine, kept in lockstep via {@link configureApplyCommand}.
 */
export function registerFleetApplyAlias(devicesCmd: Command): void {
  const sub = configureApplyCommand(devicesCmd.command('apply'));
  setHelpSections(sub, {
    examples: `
      # Preview the fleet reconcile
      agents fleet apply --plan

      # Reconcile every device to the profile
      agents fleet apply -y

      # One device only
      agents fleet apply --device yosemite-s1 -y

      # Replicate every claude version on this machine onto a fresh box
      agents fleet apply --agent claude@all --device yosemite-s0 -y
    `,
  });
}
