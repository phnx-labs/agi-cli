/**
 * `agents devices lease` — manage the disposable cloud boxes used by `agents run --lease`.
 *
 * Today: `agents devices lease prune`, which stops expired + idle "orphan" boxes that are
 * holding a provider's server quota (the cause of the `server_limit` 403 a new
 * lease hits). Reaping is conservative: only boxes whose lease has expired AND
 * that have been untouched for a safety window are eligible (see `isReapSafe`),
 * so a box a concurrent run just reused is never stopped.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { showUrl } from '../lib/open-url.js';
import { crabboxList, crabboxStop, reapSafeOrphans, reapOrphans, setLeaseSecretsBundle, type CrabboxBox } from '../lib/crabbox/cli.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { bundleExists, keychainRef, readBundle, secretsKeychainItem, writeBundleWithItems } from '../lib/secrets-client.js';
import type { SecretsBundle } from '../lib/secrets-types.js';

function fmtIdle(box: CrabboxBox): string {
  if (box.lastTouchedAt === null) return 'idle ?';
  const iso = new Date(box.lastTouchedAt * 1000).toISOString().slice(0, 16).replace('T', ' ');
  return `idle since ${iso}Z`;
}

// ── Shared box helpers (consumed by exec.ts's reuse picker + ssh.ts's devices
// section, so the reuse/format logic lives in exactly one place) ─────────────

/** Compact human duration: "45s", "12m", "2h", "1h 5m". Clamps negatives to 0. */
export function fmtDurationShort(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

/** Idle time since the box was last touched, e.g. "idle 5m" / "idle ?". */
export function fmtIdleShort(box: CrabboxBox, nowSecs: number): string {
  if (box.lastTouchedAt === null) return 'idle ?';
  return `idle ${fmtDurationShort(nowSecs - box.lastTouchedAt)}`;
}

/** Time until the lease expires, e.g. "expires 42m" / "expires ?" / "expired". */
export function fmtExpiresShort(box: CrabboxBox, nowSecs: number): string {
  if (box.expiresAt === null) return 'expires ?';
  const left = box.expiresAt - nowSecs;
  return left <= 0 ? 'expired' : `expires ${fmtDurationShort(left)}`;
}

/** Reachable address for a leased box: tailnet FQDN/IP first, else public IP. */
export function boxAddress(box: CrabboxBox): string | undefined {
  return box.tailscaleFQDN || box.tailscaleIPv4 || box.ip || undefined;
}

/** Human status: "ready" when usable, else the raw bootstrap state/status. */
export function boxStatus(box: CrabboxBox): string {
  return box.ready ? 'ready' : box.state || box.status || 'pending';
}

/**
 * Warm boxes eligible for reuse: `ready` and the lease has not expired.
 * Sorted most-recently-touched first so `--reuse` / the auto-pick lands on the
 * freshest box (an untouched `lastTouchedAt` sorts last).
 */
export function reusableBoxes(boxes: CrabboxBox[], nowSecs: number): CrabboxBox[] {
  return boxes
    .filter((b) => b.ready && (b.expiresAt === null || b.expiresAt > nowSecs))
    .sort((a, b) => (b.lastTouchedAt ?? 0) - (a.lastTouchedAt ?? 0));
}

/** One aligned row for the reuse picker / `agents devices lease list`. */
export function formatBoxRow(box: CrabboxBox, nowSecs: number): string {
  const slug = box.slug.padEnd(16);
  const cls = (box.class ?? '?').padEnd(10);
  const addr = (boxAddress(box) ?? '—').padEnd(24);
  const status = boxStatus(box).padEnd(8);
  const idle = fmtIdleShort(box, nowSecs).padEnd(12);
  return `${slug} ${cls} ${addr} ${status} ${idle} ${fmtExpiresShort(box, nowSecs)}`;
}

const HETZNER_BUNDLE = 'hetzner.com';
const HCLOUD_KEY = 'HCLOUD_TOKEN';
const HETZNER_CONSOLE_URL = 'https://console.hetzner.cloud/';

const TAILSCALE_BUNDLE = 'tailscale.com';
const TAILSCALE_KEY = 'CRABBOX_TAILSCALE_AUTH_KEY';
const TAILSCALE_KEYS_URL = 'https://login.tailscale.com/admin/settings/keys';

/**
 * Optional Tailscale setup for private-network leases (`--tailscale`). Collects
 * an EPHEMERAL, pre-authorized, `tag:crabbox` auth key and stores it in the
 * `tailscale.com` keychain bundle under `CRABBOX_TAILSCALE_AUTH_KEY` (the exact
 * key `crabboxEnv` auto-injects). Blank input skips — public-IP leases still
 * work with no Tailscale key. Never throws for cancel; mirrors the Hetzner
 * capture above but does no live validation (Tailscale has no cheap probe).
 */
async function captureTailscaleAuthKey(): Promise<void> {
  console.error(chalk.bold('\nOptional: private-network leases over Tailscale'));
  console.error(chalk.dim('Mint an EPHEMERAL, pre-authorized auth key tagged `tag:crabbox` in the Tailscale admin,'));
  console.error(chalk.dim('then paste it to reach leased boxes only over your tailnet (`--tailscale`). Leave blank to skip.\n'));

  const { password } = await import('@inquirer/prompts');
  let key: string;
  try {
    await showUrl(TAILSCALE_KEYS_URL);
    key = (await password({ message: 'Paste a Tailscale auth key (blank to skip):', mask: true })).trim();
  } catch (e) {
    if (isPromptCancelled(e)) {
      console.error(chalk.yellow('Skipped Tailscale setup.'));
      return;
    }
    throw e;
  }
  if (!key) {
    console.error(chalk.dim('Skipped Tailscale setup — public-IP leases only.'));
    return;
  }

  const bundle: SecretsBundle = (await bundleExists(TAILSCALE_BUNDLE))
    ? await readBundle(TAILSCALE_BUNDLE)
    : { name: TAILSCALE_BUNDLE, description: 'Tailscale ephemeral auth key for crabbox tailnet leases', vars: {} };
  bundle.vars[TAILSCALE_KEY] = keychainRef(TAILSCALE_KEY);
  await writeBundleWithItems(bundle, new Map([[secretsKeychainItem(TAILSCALE_BUNDLE, TAILSCALE_KEY), key]]));
  console.error(chalk.green(`✔ Stored Tailscale auth key in keychain bundle '${TAILSCALE_BUNDLE}'.`));
  console.error(chalk.dim('  Add --tailscale to a lease (reuse defaults to it) to reach the box over your tailnet.'));
}

/** Validate a Hetzner token against the live API. Exported for unit tests (fetch injectable). */
export async function validateHetznerToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<'valid' | 'invalid' | 'unreachable'> {
  try {
    const res = await fetchImpl('https://api.hetzner.cloud/v1/servers?per_page=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return 'valid';
    if (res.status === 401 || res.status === 403) return 'invalid';
    return 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/**
 * One-time credential setup for `agents run --lease` (Hetzner today). Opens the
 * token page, collects a token, validates it against the live API, stores it in
 * the keychain bundle `hetzner.com`, and persists it as the default lease bundle
 * (so `--lease` needs no env var or flag afterward). Returns true on success.
 * Never throws for expected outcomes (non-interactive, cancel, repeated failure).
 */
export async function runLeaseSetup(opts: { provider?: string } = {}): Promise<boolean> {
  const provider = opts.provider ?? 'hetzner';
  if (provider !== 'hetzner') {
    console.error(chalk.yellow(`lease setup: only 'hetzner' is supported today (got '${provider}').`));
    return false;
  }
  if (!isInteractiveTerminal()) {
    console.error(
      chalk.red(
        'lease setup needs an interactive terminal. For CI/headless, set AGENTS_LEASE_SECRETS_BUNDLE ' +
          'or store HCLOUD_TOKEN in a keychain bundle.',
      ),
    );
    return false;
  }

  console.error(chalk.bold('\nSet up leasing (Hetzner) — one time (~30s):'));
  console.error(chalk.dim('Opening the Hetzner console. Create/select a project, then Security → API Tokens →'));
  console.error(chalk.dim('Generate a token with Read & Write permission, and copy it.\n'));
  await showUrl(HETZNER_CONSOLE_URL);

  const { password } = await import('@inquirer/prompts');
  const ora = (await import('ora')).default;

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = (await password({ message: 'Paste your Hetzner API token:', mask: true })).trim();
      if (!token) {
        console.error(chalk.yellow('No token entered.'));
        continue;
      }

      const spinner = ora('Validating token against the Hetzner API…').start();
      const result = await validateHetznerToken(token);
      if (result === 'invalid') {
        spinner.fail('Token rejected by Hetzner (401/403). Try again.');
        continue;
      }
      if (result === 'unreachable') spinner.warn('Could not reach the Hetzner API to validate — storing anyway.');
      else spinner.succeed('Token valid — Hetzner API reachable.');

      // Store into the `hetzner.com` keychain bundle (mirrors writeSyncBundle).
      const bundle: SecretsBundle = (await bundleExists(HETZNER_BUNDLE))
        ? await readBundle(HETZNER_BUNDLE)
        : { name: HETZNER_BUNDLE, description: 'Hetzner Cloud API token for crabbox leases', vars: {} };
      bundle.vars[HCLOUD_KEY] = keychainRef(HCLOUD_KEY);
      await writeBundleWithItems(bundle, new Map([[secretsKeychainItem(HETZNER_BUNDLE, HCLOUD_KEY), token]]));

      setLeaseSecretsBundle(HETZNER_BUNDLE);
      console.error(chalk.green(`\n✔ Stored in keychain bundle '${HETZNER_BUNDLE}' and set as the default lease provider.`));
      console.error(chalk.dim('  Run `agents run <agent> "…" --lease` — no env var, no flag needed.'));

      // Also offer to capture a Tailscale auth key for private-network leases.
      await captureTailscaleAuthKey();
      return true;
    }
    console.error(chalk.yellow('lease setup: no valid token after 3 attempts — aborted.'));
    return false;
  } catch (e) {
    if (isPromptCancelled(e)) {
      console.error(chalk.yellow('lease setup cancelled.'));
      return false;
    }
    throw e;
  }
}

export function registerLeaseCommand(devicesCommand: Command): void {
  const lease = devicesCommand
    .command('lease')
    .description('Manage the disposable cloud boxes used by `agents run --lease`.');

  lease
    .command('setup')
    .description('One-time credential setup so `agents run --lease` works with no env var or flag.')
    .option('--provider <name>', 'Cloud provider (only hetzner today)', 'hetzner')
    .action(async (opts: { provider?: string }) => {
      const ok = await runLeaseSetup({ provider: opts.provider });
      process.exit(ok ? 0 : 1);
    });

  lease
    .command('list')
    .alias('ls')
    .description('List warm crabbox boxes you can reuse with `agents run --box <slug>`.')
    .option('--json', 'Output JSON', false)
    .action((opts: { json?: boolean }) => {
      const boxOpts = { secretsBundle: process.env.AGENTS_LEASE_SECRETS_BUNDLE };
      let boxes: CrabboxBox[];
      try {
        boxes = crabboxList(boxOpts);
      } catch (e) {
        console.error(chalk.red(`lease list: ${(e as Error).message}`));
        process.exit(1);
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(boxes, null, 2));
        return;
      }
      if (boxes.length === 0) {
        console.error(chalk.gray('No crabbox boxes. `agents run <agent> "…" --lease` provisions one.'));
        return;
      }
      const nowSecs = Math.floor(Date.now() / 1000);
      console.log(chalk.bold(`Warm boxes (${boxes.length})`));
      for (const b of boxes) console.log('  ' + formatBoxRow(b, nowSecs));
      console.log(
        chalk.gray('  Reuse: agents run <agent> "…" --box <slug>   ·   Stop: agents devices lease stop <slug>'),
      );
    });

  lease
    .command('stop <slug>')
    .description('Stop (release) a leased crabbox box now.')
    .action((slug: string) => {
      const boxOpts = { secretsBundle: process.env.AGENTS_LEASE_SECRETS_BUNDLE };
      const ok = crabboxStop(slug, boxOpts);
      if (ok) console.error(chalk.green(`Stopped box ${slug}.`));
      else console.error(chalk.red(`Could not stop box ${slug} (already gone, or crabbox is unavailable).`));
      process.exit(ok ? 0 : 1);
    });

  lease
    .command('prune')
    .alias('gc')
    .description(
      'Stop expired, idle lease boxes that are holding your provider quota. Safe: never stops a box in active use.',
    )
    .option('--dry-run', 'List reap-safe orphan boxes without stopping any', false)
    .option('--yes', 'Stop them without the interactive confirm', false)
    .option('--json', 'Output JSON', false)
    .action(async (opts: { dryRun?: boolean; yes?: boolean; json?: boolean }) => {
      const boxOpts = { secretsBundle: process.env.AGENTS_LEASE_SECRETS_BUNDLE };
      const nowSecs = Math.floor(Date.now() / 1000);

      let candidates: CrabboxBox[];
      try {
        candidates = reapSafeOrphans(crabboxList(boxOpts), nowSecs);
      } catch (e) {
        console.error(chalk.red(`lease prune: ${(e as Error).message}`));
        process.exit(1);
        return;
      }

      if (candidates.length === 0) {
        if (opts.json) console.log(JSON.stringify({ candidates: [], reaped: [] }));
        else console.error(chalk.gray('No reap-safe orphan boxes — nothing to collect.'));
        return;
      }

      if (!opts.json) {
        console.error(chalk.bold(`${candidates.length} reap-safe orphan box(es):`));
        for (const b of candidates) {
          console.error(`  ${chalk.cyan(b.slug)} ${chalk.dim(`(${b.class ?? '?'}, ${fmtIdle(b)})`)}`);
        }
      }

      if (opts.dryRun) {
        if (opts.json) console.log(JSON.stringify({ candidates, reaped: [] }, null, 2));
        else console.error(chalk.gray('\n--dry-run: nothing stopped. Re-run with --yes to stop them.'));
        return;
      }

      // Destructive: stopping boxes the agent did not create needs an explicit yes.
      if (!opts.yes) {
        const { isInteractiveTerminal, isPromptCancelled } = await import('./utils.js');
        if (!isInteractiveTerminal()) {
          console.error(chalk.yellow('Refusing to stop boxes without --yes in a non-interactive shell.'));
          process.exit(1);
          return;
        }
        try {
          const { confirm } = await import('@inquirer/prompts');
          const ok = await confirm({ message: `Stop these ${candidates.length} box(es)?`, default: false });
          if (!ok) {
            console.error(chalk.yellow('Aborted — no boxes stopped.'));
            return;
          }
        } catch (e) {
          if (isPromptCancelled(e)) {
            console.error(chalk.yellow('Aborted — no boxes stopped.'));
            return;
          }
          throw e;
        }
      }

      // Re-list at stop time (freshness re-check) so a box touched since the
      // preview is not stopped out from under an active run.
      const { candidates: stopped, reaped } = reapOrphans({ ...boxOpts, nowSecs });
      if (opts.json) console.log(JSON.stringify({ candidates: stopped, reaped }, null, 2));
      else console.error(chalk.green(`Stopped ${reaped.length}/${stopped.length} box(es): ${reaped.join(', ') || '(none)'}`));
    });
}
