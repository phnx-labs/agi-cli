
import { spawn, spawnSync } from 'child_process';
import { readAndResolveBundleEnvSync, listBundlesSync, bundleExistsSync } from '../secrets-client.js';
import type { SecretsBundle } from '../secrets-types.js';
import { readMeta, writeMeta } from '../state.js';
import { DEFAULT_CRABBOX_PROFILE } from './config.js';

export interface CrabboxBox {
  name: string;
  status: string;
  slug: string;
  lease: string;
  state: string;
  ip?: string;
  tailscaleIPv4?: string;
  tailscaleFQDN?: string;
  profile?: string;
  class?: string;
  ready: boolean;
  keep: boolean;
  createdAt: number | null;
  expiresAt: number | null;
  lastTouchedAt: number | null;
  idleTimeoutSecs: number | null;
}

interface CrabboxOptions {
  secretsBundle?: string;
  timeoutMs?: number;
}

export function findCrabbox(): string {
  const r = spawnSync('crabbox', ['--help'], { encoding: 'utf-8' });
  if (r.error) {
    throw new Error(
      'crabbox is not installed or not on PATH. Install it and run `crabbox login`, then `crabbox doctor` to verify provider access.',
    );
  }
  return 'crabbox';
}

const LEASE_PROVIDER_TOKEN_KEYS = ['HCLOUD_TOKEN', 'AWS_ACCESS_KEY_ID', 'DIGITALOCEAN_TOKEN', 'DO_TOKEN'];

export function pickLeaseBundleFromList(bundles: SecretsBundle[]): string | undefined {
  for (const b of bundles) {
    if (Object.keys(b.vars ?? {}).some((k) => LEASE_PROVIDER_TOKEN_KEYS.includes(k))) return b.name;
  }
  return undefined;
}

const TAILSCALE_AUTH_KEY_NAMES = ['CRABBOX_TAILSCALE_AUTH_KEY', 'TAILSCALE_AUTH_KEY', 'TS_AUTHKEY'];

export function pickTailscaleBundleFromList(bundles: SecretsBundle[]): { name: string; key: string } | undefined {
  for (const b of bundles) {
    const key = Object.keys(b.vars ?? {}).find((k) => TAILSCALE_AUTH_KEY_NAMES.includes(k));
    if (key) return { name: b.name, key };
  }
  return undefined;
}

let tailscaleBundleMemo: { value: { name: string; key: string } | undefined } | undefined;
function resolveTailscaleBundleMemo(): { name: string; key: string } | undefined {
  if (!tailscaleBundleMemo) {
    let value: { name: string; key: string } | undefined;
    try {
      value = pickTailscaleBundleFromList(listBundlesSync());
    } catch {
    }
    tailscaleBundleMemo = { value };
  }
  return tailscaleBundleMemo.value;
}

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
    }
    tailscaleValueMemo = { value };
  }
  return tailscaleValueMemo.value;
}

export function resetCrabboxSecretsMemosForTest(): void {
  tailscaleBundleMemo = undefined;
  tailscaleValueMemo = undefined;
  leaseBundleMemo = undefined;
  leaseEnvMemo = undefined;
}

interface ResolvedLeaseBundle {
  name: string;
  keys?: string[];
}

export function resolveLeaseBundle(): ResolvedLeaseBundle | undefined {
  // Auto-detection exposes only recognized provider-token keys, never the rest of a bundle.
  const env = process.env.AGENTS_LEASE_SECRETS_BUNDLE;
  if (env) return { name: env };
  try {
    const configured = readMeta().lease?.secretsBundle;
    if (configured && bundleExistsSync(configured)) return { name: configured };
  } catch {
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
  }
  return undefined;
}

let leaseBundleMemo: { value: ResolvedLeaseBundle | undefined } | undefined;
function resolveLeaseBundleMemo(): ResolvedLeaseBundle | undefined {
  if (!leaseBundleMemo) leaseBundleMemo = { value: resolveLeaseBundle() };
  return leaseBundleMemo.value;
}

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
        // Lease setup is unattended: broker-held values only, never a Touch ID prompt.
        const { env } = readAndResolveBundleEnvSync(resolved.name, {
          caller: 'agents run --lease (crabbox)',
          keys: resolved.keys,
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

export function setLeaseSecretsBundle(name: string): void {
  const meta = readMeta();
  writeMeta({ ...meta, lease: { ...meta.lease, secretsBundle: name } });
  leaseBundleMemo = undefined;
}

export function crabboxEnv(opts: CrabboxOptions): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env };

  const leaseEnv = resolveLeaseEnvMemo(opts.secretsBundle);
  if (leaseEnv) Object.assign(out, leaseEnv);

  if (!out.CRABBOX_TAILSCALE_AUTH_KEY) {
    // Tailnet attachment is best-effort and cannot block paid-lease cleanup.
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

export function crabboxFind(slug: string, opts: CrabboxOptions = {}): CrabboxBox | null {
  return crabboxList(opts).find((b) => b.slug === slug) ?? null;
}

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
  profile?: string;
  netMode?: 'public' | 'tailscale';
  nowSecs?: number;
}

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
  code?: boolean;
  provider?: string;
  netMode?: 'public' | 'tailscale';
}

export async function crabboxWarmup(opts: WarmupOptions = {}): Promise<CrabboxBox> {
  findCrabbox();
  const env = crabboxEnv(opts);
  const before = new Set(crabboxList(opts).map((b) => b.lease));

  const args = ['warmup'];
  if (opts.class) args.push('--class', opts.class);
  if (opts.profile) args.push('--profile', opts.profile);
  if (opts.provider) args.push('--provider', opts.provider);
  if (opts.code) args.push('--code');
  if (opts.netMode === 'tailscale') args.push('--network', 'tailscale', '-tailscale-tags', 'tag:crabbox');

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
      }
      throw new Error(`crabbox warmup failed: provider server limit reached.${hint}`);
    }
    throw new Error(
      `crabbox warmup failed: ${detail || 'unknown error'}. ` +
        `Check provider access with \`crabbox doctor\`; a missing cloud token often means \`crabbox login\` or a lease.secretsBundle is needed.`,
    );
  }

  const after = crabboxList(opts);
  const fresh = after.filter((b) => !before.has(b.lease));
  if (fresh.length === 1) return fresh[0];

  const m = (r.stdout || '').match(/cbx_[0-9a-f]+/i);
  if (m) {
    const byLease = after.find((b) => b.lease === m[0]);
    if (byLease) return byLease;
  }
  if (fresh.length > 1) {
    const ready = fresh.filter((b) => b.ready);
    if (ready.length) return ready[ready.length - 1];
    return fresh[fresh.length - 1];
  }
  throw new Error('crabbox warmup succeeded but the new box could not be located in `crabbox list`.');
}

export async function crabboxWaitReady(
  slug: string,
  opts: CrabboxOptions & { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<CrabboxBox> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms)));
  const deadline = Date.now() + timeoutMs;
  let last: CrabboxBox | null = null;
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
  onData?: (chunk: string) => void;
  fullResync?: boolean;
  renewIdleTimeoutSecs?: number;
}

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

export function parseCrabboxSshArgv(stdout: string): string[] | null {
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith("'ssh'") && !line.startsWith('ssh ')) continue;
    const toks = [...line.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2]);
    if (toks[0] === 'ssh' && toks.length >= 3) return toks;
  }
  return null;
}

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

export function crabboxStop(slug: string, opts: CrabboxOptions = {}): boolean {
  try {
    const r = spawnSync('crabbox', ['stop', slug], { encoding: 'utf-8', env: crabboxEnv(opts) });
    return r.status === 0;
  } catch {
    return false;
  }
}

export const REAP_MIN_IDLE_SECS = 3600;

export function isReapSafe(box: CrabboxBox, nowSecs: number): boolean {
  if (box.expiresAt === null || box.lastTouchedAt === null) return false;
  if (box.expiresAt > nowSecs) return false;
  const window = Math.max((box.idleTimeoutSecs ?? 0) * 2, REAP_MIN_IDLE_SECS);
  return nowSecs - box.lastTouchedAt >= window;
}

export function reapSafeOrphans(boxes: CrabboxBox[], nowSecs: number): CrabboxBox[] {
  return boxes
    .filter((b) => isReapSafe(b, nowSecs))
    .sort((a, b) => (a.lastTouchedAt ?? 0) - (b.lastTouchedAt ?? 0));
}

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
