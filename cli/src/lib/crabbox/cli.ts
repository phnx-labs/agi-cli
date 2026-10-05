/** Typed wrapper over the external `crabbox` binary (github.com/openclaw/crabbox), which leases
 * ephemeral cloud boxes and runs commands; the transport for `agents run --lease`, owning SSH. Its
 * provider API token is injected from a secrets bundle (see `crabboxEnv`). */

import { spawn, spawnSync } from 'child_process';
import { readAndResolveBundleEnvSync, listBundlesSync, bundleExistsSync } from '../secrets-client.js';
import type { SecretsBundle } from '../secrets-types.js';
import { readMeta, writeMeta } from '../state.js';
import { DEFAULT_CRABBOX_PROFILE } from './config.js';

/** A crabbox machine as reported by `crabbox list --json`. */
export interface CrabboxBox {
  /** Provider machine name, e.g. `crabbox-blue-hermit-1039689b`. */
  name: string;
  /** Provider run state, e.g. `running`. */
  status: string;
  /** Friendly slug used with `--id`, e.g. `blue-hermit`. */
  slug: string;
  /** Lease id, e.g. `cbx_9968746bb15c`. */
  lease: string;
  /** crabbox bootstrap state; `ready` once the box is usable. */
  state: string;
  /** Public IPv4, when the provider exposes one. */
  ip?: string;
  /** Tailnet IPv4 (100.x), when the box was leased with `--network tailscale`. */
  tailscaleIPv4?: string;
  /** Tailnet MagicDNS FQDN, when the box joined the tailnet. */
  tailscaleFQDN?: string;
  profile?: string;
  class?: string;
  /** True when running + bootstrap-complete. */
  ready: boolean;
  /** crabbox `keep` label — a kept box survives `crabbox cleanup` past its TTL. */
  keep: boolean;
  /** Unix seconds the box was created, or null when the label is absent. */
  createdAt: number | null;
  /** Unix seconds the lease expires, or null. */
  expiresAt: number | null;
  /** Unix seconds the box was last touched (reused / run against), or null. */
  lastTouchedAt: number | null;
  /** Idle-timeout window in seconds, or null. */
  idleTimeoutSecs: number | null;
}

interface CrabboxOptions {
  /** Name of a secrets bundle whose env (e.g. `HCLOUD_TOKEN`) crabbox needs for its cloud provider,
   * resolved via the keychain-backed secrets. When unset, crabbox uses ambient env or its own
   * `crabbox login`. */
  secretsBundle?: string;
  /** Hard cap (ms) on one crabbox call that hits the provider API (`list`), so a slow provider
   * cannot hang commands like `agents devices`. Defaults to 8s; fast paths pass a shorter bound. */
  timeoutMs?: number;
}

/** Locate the crabbox binary, or throw an actionable error. */
export function findCrabbox(): string {
  const r = spawnSync('crabbox', ['--help'], { encoding: 'utf-8' });
  if (r.error) {
    throw new Error(
      'crabbox is not installed or not on PATH. Install it and run `crabbox login`, then `crabbox doctor` to verify provider access.',
    );
  }
  return 'crabbox';
}

/** Env keys that mark a secrets bundle usable for `--lease` (provider tokens). Matching needs only
 * declared key NAMES; only the matched key's VALUE is injected (see `crabboxEnv`), so an
 * auto-detected bundle can't leak other secrets. */
const LEASE_PROVIDER_TOKEN_KEYS = ['HCLOUD_TOKEN', 'AWS_ACCESS_KEY_ID', 'DIGITALOCEAN_TOKEN', 'DO_TOKEN'];

/** The first bundle that declares a provider token key, or undefined. Pure over `bundles`. */
export function pickLeaseBundleFromList(bundles: SecretsBundle[]): string | undefined {
  for (const b of bundles) {
    if (Object.keys(b.vars ?? {}).some((k) => LEASE_PROVIDER_TOKEN_KEYS.includes(k))) return b.name;
  }
  return undefined;
}

/** Env keys a bundle may use for a Tailscale auth key. crabbox reads `CRABBOX_TAILSCALE_AUTH_KEY`;
 * common alternates are accepted and renamed to it on injection. */
const TAILSCALE_AUTH_KEY_NAMES = ['CRABBOX_TAILSCALE_AUTH_KEY', 'TAILSCALE_AUTH_KEY', 'TS_AUTHKEY'];

/** The first bundle + key that declares a Tailscale auth key, or undefined. Pure over `bundles`. */
export function pickTailscaleBundleFromList(bundles: SecretsBundle[]): { name: string; key: string } | undefined {
  for (const b of bundles) {
    const key = Object.keys(b.vars ?? {}).find((k) => TAILSCALE_AUTH_KEY_NAMES.includes(k));
    if (key) return { name: b.name, key };
  }
  return undefined;
}

/** Process-lifetime memo so the tailscale bundle `listBundles()` scan runs at most once. */
let tailscaleBundleMemo: { value: { name: string; key: string } | undefined } | undefined;
function resolveTailscaleBundleMemo(): { name: string; key: string } | undefined {
  if (!tailscaleBundleMemo) {
    let value: { name: string; key: string } | undefined;
    try {
      value = pickTailscaleBundleFromList(listBundlesSync());
    } catch {
      /* secrets unreadable — no auto-detect */
    }
    tailscaleBundleMemo = { value };
  }
  return tailscaleBundleMemo.value;
}

/** Process-lifetime memo for the resolved tailscale key: `crabboxEnv` runs several times per lease
 * and the single-key read is not auto-cached, so the keychain was re-read per call. Always
 * `agentOnly: true` (SEC-13): `--lease` is headless and must never pop Touch ID. */
let tailscaleValueMemo: { value: string | undefined } | undefined;
function resolveTailscaleKeyValueMemo(ts: { name: string; key: string }): string | undefined {
  if (!tailscaleValueMemo) {
    let value: string | undefined;
    try {
      const { env } = readAndResolveBundleEnvSync(ts.name, {
        caller: 'agents run --lease (crabbox tailscale)',
        keys: [ts.key],
        agentOnly: true,
      });
      value = env[ts.key];
    } catch {
      /* best-effort — tailscale is opt-in plumbing, never blocks a public lease */
    }
    tailscaleValueMemo = { value };
  }
  return tailscaleValueMemo.value;
}

/** Test seam: drop every crabboxEnv secrets memo so each test resolves fresh. */
export function resetCrabboxSecretsMemosForTest(): void {
  tailscaleBundleMemo = undefined;
  tailscaleValueMemo = undefined;
  leaseBundleMemo = undefined;
  leaseEnvMemo = undefined;
}

/** A resolved lease bundle: its name, plus (auto-detect only) the exact keys to inject. */
interface ResolvedLeaseBundle {
  name: string;
  /** When set (auto-detect), inject ONLY these keys — not the whole bundle. */
  keys?: string[];
}

/** The secrets bundle for crabbox, in priority: `AGENTS_LEASE_SECRETS_BUNDLE` env,
 * `lease.secretsBundle` config (set by `lease setup`), then auto-detect the first keychain bundle
 * declaring a provider token key. Only the last tier reads bundle metadata, so it is memoized. */
export function resolveLeaseBundle(): ResolvedLeaseBundle | undefined {
  const env = process.env.AGENTS_LEASE_SECRETS_BUNDLE;
  if (env) return { name: env };
  try {
    const configured = readMeta().lease?.secretsBundle;
    if (configured && bundleExistsSync(configured)) return { name: configured };
  } catch {
    /* config unreadable — fall through to auto-detect */
  }
  try {
    const bundles = listBundlesSync();
    const name = pickLeaseBundleFromList(bundles);
    if (name) {
      const b = bundles.find((x) => x.name === name);
      const keys = LEASE_PROVIDER_TOKEN_KEYS.filter((k) => !!b && k in (b.vars ?? {}));
      return { name, keys };
    }
  } catch {
    /* secrets unreadable — no auto-detect */
  }
  return undefined;
}

/** Process-lifetime memo so the tier-3 `listBundles()` scan runs at most once. */
let leaseBundleMemo: { value: ResolvedLeaseBundle | undefined } | undefined;
function resolveLeaseBundleMemo(): ResolvedLeaseBundle | undefined {
  if (!leaseBundleMemo) leaseBundleMemo = { value: resolveLeaseBundle() };
  return leaseBundleMemo.value;
}

/** Process-lifetime memo for the resolved provider-token env, resolved once up front: `crabboxEnv`
 * runs on every `crabboxWaitReady` poll, so the keychain read repeated every ~5s. The read is
 * `agentOnly: true` (SEC-13); a locked bundle throws the memoized unlock error once. */
let leaseEnvMemo: { env?: NodeJS.ProcessEnv; error?: Error } | undefined;
function resolveLeaseEnvMemo(explicitBundle?: string): NodeJS.ProcessEnv | undefined {
  if (!leaseEnvMemo) {
    const resolved: ResolvedLeaseBundle | undefined = explicitBundle
      ? { name: explicitBundle }
      : resolveLeaseBundleMemo();
    if (!resolved) {
      leaseEnvMemo = {};
    } else {
      try {
        // An auto-detected bundle injects only the provider token key(s) (least privilege); an
        // explicitly named bundle (env/config or `opts.secretsBundle`) injects whole since the
        // user chose it. Same resolver as `agents secrets exec`.
        const { env } = readAndResolveBundleEnvSync(resolved.name, {
          caller: 'agents run --lease (crabbox)',
          keys: resolved.keys,
          // --lease is headless by contract and a locked bundle must fail loud with
          // an unlock hint, NEVER pop a Touch ID sheet — the read cannot be answered
          // in a background lease (SEC-13).
          agentOnly: true,
        });
        leaseEnvMemo = { env };
      } catch (e) {
        leaseEnvMemo = {
          error: new Error(
            `Could not load secrets bundle "${resolved.name}" for crabbox: ${(e as Error).message}. ` +
              `Fix the bundle (agents secrets view ${resolved.name}) or unset lease.secretsBundle to use crabbox's own login.`,
          ),
        };
      }
    }
  }
  if (leaseEnvMemo.error) throw leaseEnvMemo.error;
  return leaseEnvMemo.env;
}

/** Persist `lease.secretsBundle` in agents config so `--lease` needs no env var. */
export function setLeaseSecretsBundle(name: string): void {
  const meta = readMeta();
  writeMeta({ ...meta, lease: { ...meta.lease, secretsBundle: name } });
  leaseBundleMemo = undefined; // invalidate so the next resolve sees the new config
}

/** Build the child env for crabbox, injecting a secrets bundle when configured. */
export function crabboxEnv(opts: CrabboxOptions): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env };

  // The lease provider-token read is resolved once and memoized (env or thrown error) because
  // crabboxEnv runs every poll. A locked bundle re-raises the memoized "unlock <name>" error so it
  // surfaces on the first call.
  const leaseEnv = resolveLeaseEnvMemo(opts.secretsBundle);
  if (leaseEnv) Object.assign(out, leaseEnv);

  // Tailscale plumbing (F5): inject CRABBOX_TAILSCALE_AUTH_KEY from a bundle declaring one when
  // the ambient env lacks it. Best-effort and opt-in; a missing bundle never fails a public lease,
  // and `crabboxWarmup` netMode decides use. Memoized per process.
  if (!out.CRABBOX_TAILSCALE_AUTH_KEY) {
    const ts = resolveTailscaleBundleMemo();
    if (ts) {
      const value = resolveTailscaleKeyValueMemo(ts);
      if (value) out.CRABBOX_TAILSCALE_AUTH_KEY = value;
    }
  }

  return out;
}

function normalizeBox(raw: Record<string, unknown>): CrabboxBox | null {
  const labels = (raw.labels ?? {}) as Record<string, string>;
  const slug = labels.slug ?? '';
  if (!slug) return null;
  const status = String(raw.status ?? '');
  const state = String(labels.state ?? '');
  const publicNet = (raw.public_net ?? {}) as { ipv4?: { ip?: string } };
  const num = (v: string | undefined): number | null => {
    if (v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    name: String(raw.name ?? ''),
    status,
    slug,
    lease: labels.lease ?? '',
    state,
    ip: publicNet.ipv4?.ip || undefined,
    tailscaleIPv4: labels.tailscale_ipv4 || undefined,
    tailscaleFQDN: labels.tailscale_fqdn || undefined,
    profile: labels.profile,
    class: labels.class,
    ready: status === 'running' && state === 'ready',
    keep: labels.keep === 'true',
    createdAt: num(labels.created_at),
    expiresAt: num(labels.expires_at),
    lastTouchedAt: num(labels.last_touched_at),
    idleTimeoutSecs: num(labels.idle_timeout_secs ?? labels.idle_timeout),
  };
}

/** All crabbox machines the broker knows about. */
export function crabboxList(opts: CrabboxOptions = {}): CrabboxBox[] {
  findCrabbox();
  const timeoutMs = opts.timeoutMs ?? 8000;
  const r = spawnSync('crabbox', ['list', '--json'], { encoding: 'utf-8', env: crabboxEnv(opts), timeout: timeoutMs });
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    throw new Error(`crabbox list timed out after ${Math.round(timeoutMs / 1000)}s (provider slow or unreachable)`);
  }
  if (r.status !== 0) {
    throw new Error(`crabbox list failed: ${(r.stderr || r.stdout || '').trim() || 'unknown error'}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((b) => normalizeBox(b as Record<string, unknown>)).filter((b): b is CrabboxBox => b !== null);
}

/** Find one box by slug, or null. */
export function crabboxFind(slug: string, opts: CrabboxOptions = {}): CrabboxBox | null {
  return crabboxList(opts).find((b) => b.slug === slug) ?? null;
}

/** Whether `crabbox status` reports the box SSH-ready. A box whose cloud-init failed still lists as
 * `running` but never becomes ready, so warm-pool reuse gates on it (mirrors scripts/sandbox.sh
 * `box_ready`). */
export function crabboxStatusReady(slug: string, opts: CrabboxOptions = {}): boolean {
  findCrabbox();
  const r = spawnSync('crabbox', ['status', '--id', slug], {
    encoding: 'utf-8',
    env: crabboxEnv(opts),
    timeout: opts.timeoutMs ?? 15000,
  });
  if (r.status !== 0 || !r.stdout) return false;
  return /(^|\s)ready=true(\s|$)/m.test(r.stdout);
}

interface PoolMatchOptions {
  /** Lease pool label (shared default, or `.crabbox.yaml leaseProfile:` opt-in; see config.ts).
   * Unset normalizes to DEFAULT_CRABBOX_PROFILE on both sides. */
  profile?: string;
  /** Network mode of the run (default 'public'). A tailnet box is never handed to a public run or
   * vice versa, so the pool is partitioned by it. */
  netMode?: 'public' | 'tailscale';
  /** Injectable clock (unix seconds) for the expiry check. */
  nowSecs?: number;
}

/** Warm boxes this run could reuse: `running`, same profile and network mode, lease unexpired,
 * most-recently-touched first. Readiness is not required here (mirrors sandbox.sh); callers gate
 * on `crabboxStatusReady`. A not-ready box is skipped, never stopped. */
export function poolReusableBoxes(boxes: CrabboxBox[], opts: PoolMatchOptions = {}): CrabboxBox[] {
  const profile = opts.profile ?? DEFAULT_CRABBOX_PROFILE;
  const netMode = opts.netMode ?? 'public';
  const nowSecs = opts.nowSecs ?? Math.floor(Date.now() / 1000);
  return boxes
    .filter((b) => {
      if (b.status !== 'running') return false;
      if ((b.profile ?? DEFAULT_CRABBOX_PROFILE) !== profile) return false;
      const boxNet = b.tailscaleIPv4 || b.tailscaleFQDN ? 'tailscale' : 'public';
      if (boxNet !== netMode) return false;
      return b.expiresAt === null || b.expiresAt > nowSecs;
    })
    .sort((a, b) => (b.lastTouchedAt ?? 0) - (a.lastTouchedAt ?? 0));
}

interface WarmupOptions extends CrabboxOptions {
  class?: string;
  profile?: string;
  /** Provision web code-server capability on the box. */
  code?: boolean;
  /** Cloud backend override (crabbox provider id, e.g. hetzner/aws/do). */
  provider?: string;
  /** Network mode for the leased box: `'public'` (default) or `'tailscale'` (`--network tailscale`,
   * tagged `tag:crabbox`). The command layer decides when to enable it; this is plumbing only. */
  netMode?: 'public' | 'tailscale';
}

/** Lease a box and block until ready. Diffs `crabbox list` before and after to identify the new box
 * even if warmup's stdout format changes. */
export async function crabboxWarmup(opts: WarmupOptions = {}): Promise<CrabboxBox> {
  findCrabbox();
  const env = crabboxEnv(opts);
  const before = new Set(crabboxList(opts).map((b) => b.lease));

  const args = ['warmup'];
  if (opts.class) args.push('--class', opts.class);
  if (opts.profile) args.push('--profile', opts.profile);
  if (opts.provider) args.push('--provider', opts.provider);
  if (opts.code) args.push('--code');
  // Tailscale plumbing (F5): join the box to the tailnet, tagged tag:crabbox.
  // The auth key rides the child env as CRABBOX_TAILSCALE_AUTH_KEY (see crabboxEnv).
  if (opts.netMode === 'tailscale') args.push('--network', 'tailscale', '-tailscale-tags', 'tag:crabbox');

  // Async spawn (not spawnSync): provisioning takes 30-90s and a blocking call
  // would freeze any caller's progress spinner. Output is captured, not streamed.
  const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const proc = spawn('crabbox', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf-8')));
    proc.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf-8')));
    proc.on('error', () => resolve({ status: null, stdout, stderr }));
    proc.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || '').trim();
    // A provider `server_limit` / `resource_limit_exceeded` 403 means the account's
    // box quota is full. Turn the raw 403 into an actionable message that names the
    // reap-safe orphans + the one-command fix, instead of a generic failure.
    if (/server_limit|resource_limit_exceeded/i.test(detail)) {
      let hint = ' Stop unused boxes (`crabbox list`) or raise your provider server limit.';
      try {
        const orphans = reapSafeOrphans(crabboxList(opts), Math.floor(Date.now() / 1000));
        if (orphans.length) {
          hint =
            ` ${orphans.length} expired, idle box(es) are holding the quota — free them with ` +
            `\`agents devices lease prune\` (or \`crabbox stop ${orphans[0].slug}\`).`;
        }
      } catch {
        /* best-effort hint; fall back to the generic guidance above */
      }
      throw new Error(`crabbox warmup failed: provider server limit reached.${hint}`);
    }
    throw new Error(
      `crabbox warmup failed: ${detail || 'unknown error'}. ` +
        `Check provider access with \`crabbox doctor\`; a missing cloud token often means \`crabbox login\` or a lease.secretsBundle is needed.`,
    );
  }

  // Prefer the freshly-created box (lease absent from the pre-warmup snapshot).
  const after = crabboxList(opts);
  const fresh = after.filter((b) => !before.has(b.lease));
  if (fresh.length === 1) return fresh[0];

  // Fallback: parse the cbx_ lease id crabbox prints and match it.
  const m = (r.stdout || '').match(/cbx_[0-9a-f]+/i);
  if (m) {
    const byLease = after.find((b) => b.lease === m[0]);
    if (byLease) return byLease;
  }
  if (fresh.length > 1) {
    // Multiple new boxes (concurrent warmups) — pick the newest ready one.
    const ready = fresh.filter((b) => b.ready);
    if (ready.length) return ready[ready.length - 1];
    return fresh[fresh.length - 1];
  }
  throw new Error('crabbox warmup succeeded but the new box could not be located in `crabbox list`.');
}

/** Poll until the box reports ready, or throw after timeoutMs. `sleep` is injectable so tests don't
 * wall-clock wait. */
export async function crabboxWaitReady(
  slug: string,
  opts: CrabboxOptions & { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<CrabboxBox> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms)));
  const deadline = Date.now() + timeoutMs;
  let last: CrabboxBox | null = null;
  // First check is immediate (warmup usually returns an already-ready box).
  for (;;) {
    last = crabboxFind(slug, opts);
    if (last?.ready) return last;
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }
  throw new Error(
    `crabbox box "${slug}" did not become ready within ${Math.round(timeoutMs / 1000)}s (state: ${last?.state ?? 'gone'}).`,
  );
}

interface CrabboxRunOptions extends CrabboxOptions {
  /** Called with each chunk of combined stdout/stderr as it streams. */
  onData?: (chunk: string) => void;
  /** Force a full remote resync before running. */
  fullResync?: boolean;
  /** Refresh an existing lease with this idle window before running. */
  renewIdleTimeoutSecs?: number;
}

/** Upload `script` via `crabbox run --script-stdin` and run it. The body travels over stdin to a
 * file on the box, never in argv, `ps` or shell history, which is why it carries credential
 * provisioning. Resolves with the remote exit code (null on dispatch failure). */
export function crabboxRunScript(slug: string, script: string, opts: CrabboxRunOptions = {}): Promise<number | null> {
  findCrabbox();
  const args = ['run', '--id', slug, '--reclaim'];
  if (opts.renewIdleTimeoutSecs !== undefined) args.push('--idle-timeout', `${opts.renewIdleTimeoutSecs}s`);
  if (opts.fullResync) args.push('--full-resync');
  args.push('--script-stdin');
  return new Promise((resolve) => {
    const proc = spawn('crabbox', args, { env: crabboxEnv(opts), stdio: ['pipe', 'pipe', 'pipe'] });
    const pump = (chunk: Buffer) => {
      const s = chunk.toString('utf-8');
      if (opts.onData) opts.onData(s);
      else process.stdout.write(s);
    };
    proc.stdout.on('data', pump);
    proc.stderr.on('data', pump);
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => resolve(code));
    proc.stdin.write(script);
    proc.stdin.end();
  });
}

/** Parse crabbox's shell-quoted `ssh` command into an argv array. Exported for testing. */
export function parseCrabboxSshArgv(stdout: string): string[] | null {
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith("'ssh'") && !line.startsWith('ssh ')) continue;
    const toks = [...line.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2]);
    if (toks[0] === 'ssh' && toks.length >= 3) return toks;
  }
  return null;
}

/** The `ssh` argv crabbox uses to reach box `slug`, with its per-lease identity key and
 * known_hosts; a raw `ssh crabbox@ip` fails publickey. `crabbox ssh --id` prints, not connects;
 * `--reclaim` resolves regardless of lease claim. Null when unresolvable (best-effort callers). */
export function crabboxSshArgv(slug: string, opts: CrabboxOptions = {}): string[] | null {
  findCrabbox();
  const r = spawnSync('crabbox', ['ssh', '--id', slug, '--reclaim'], {
    encoding: 'utf-8',
    env: crabboxEnv(opts),
    timeout: opts.timeoutMs ?? 15000,
  });
  if (r.status !== 0 || !r.stdout) return null;
  return parseCrabboxSshArgv(r.stdout);
}

/** Release the lease / delete the box. Best-effort; never throws. */
export function crabboxStop(slug: string, opts: CrabboxOptions = {}): boolean {
  try {
    // Positional target: crabbox's stop subcommand has no --id flag (unlike
    // status/run/ssh) — `stop --id <slug>` dies with "flag provided but not
    // defined: -id" and the box leaks past the run it was leased for.
    const r = spawnSync('crabbox', ['stop', slug], { encoding: 'utf-8', env: crabboxEnv(opts) });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Never reap a box touched within this many seconds, regardless of idle-timeout. */
export const REAP_MIN_IDLE_SECS = 3600;

/** Whether a box is a genuine orphan safe to reap: only when the lease has expired AND it has been
 * untouched for `max(2 x idleTimeout, 1h)`. The freshness guard prevents a TOCTOU race with a box
 * a concurrent run just reused. Unknown age is never reaped; `nowSecs` is injected. */
export function isReapSafe(box: CrabboxBox, nowSecs: number): boolean {
  if (box.expiresAt === null || box.lastTouchedAt === null) return false;
  if (box.expiresAt > nowSecs) return false;
  const window = Math.max((box.idleTimeoutSecs ?? 0) * 2, REAP_MIN_IDLE_SECS);
  return nowSecs - box.lastTouchedAt >= window;
}

/** The reap-safe orphans among `boxes`, most-stale (oldest touch) first. */
export function reapSafeOrphans(boxes: CrabboxBox[], nowSecs: number): CrabboxBox[] {
  return boxes
    .filter((b) => isReapSafe(b, nowSecs))
    .sort((a, b) => (a.lastTouchedAt ?? 0) - (b.lastTouchedAt ?? 0));
}

/** List reap-safe orphans and, unless `dryRun`, stop them; returns candidates and stopped slugs.
 * Best-effort per box. Backs `agents devices lease prune` and the 403 auto-reap opt-in. */
export function reapOrphans(
  opts: CrabboxOptions & { nowSecs?: number; dryRun?: boolean } = {},
): { candidates: CrabboxBox[]; reaped: string[] } {
  const nowSecs = opts.nowSecs ?? Math.floor(Date.now() / 1000);
  const candidates = reapSafeOrphans(crabboxList(opts), nowSecs);
  if (opts.dryRun) return { candidates, reaped: [] };
  const reaped: string[] = [];
  for (const b of candidates) {
    if (crabboxStop(b.slug, opts)) reaped.push(b.slug);
  }
  return { candidates, reaped };
}
