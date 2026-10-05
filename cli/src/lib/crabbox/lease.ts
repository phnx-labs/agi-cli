/** `agents run --lease` orchestrator (RUSH-1920/1921/1924): acquire a box (reuse-first from the
 * warm pool; `--fresh` leases a new torn-down box), provision runtimes and credentials, run via
 * `crabbox run` (owns SSH), tear down. One `--script-stdin` body keeps tokens out of argv. */

import type { AgentId } from '../types.js';
import { crabboxFind, crabboxList, crabboxStatusReady, crabboxWarmup, crabboxWaitReady, crabboxRunScript, crabboxStop, poolReusableBoxes, type CrabboxBox } from './cli.js';
import * as yaml from 'yaml';
import { assertNoNativeOAuthTransfer, buildCredentialScript, buildHomeFileWriteScript, CLAUDE_TOKEN_REMOTE, type DetectedRuntime } from './runtimes.js';
import { LEASE_AGENT_MARKER, leasePhaseSentinel } from './progress.js';
import { copySetupToBox } from './setup-copy.js';
import { DEFAULT_CRABBOX_PROFILE } from './config.js';

/** Phase signal for a lease run, so the command layer can drive a progress UI. */
type LeasePhase =
  | { kind: 'warmup'; backend?: string }
  | { kind: 'reuse'; slug: string }
  | { kind: 'ready'; box: CrabboxBox; elapsedMs: number }
  | { kind: 'teardown' };

interface LeaseRunOptions {
  agent: string;
  prompt: string;
  mode?: string;
  model?: string;
  /** Cloud backend crabbox provisions on (hetzner/aws/do/…). */
  backend?: string;
  boxClass?: string;
  profile?: string;
  /** Per-run directory under ~/workspaces; isolates concurrent runs on one box. */
  workspaceId?: string;
  /** Runtimes to install on the box. */
  runtimes: AgentId[];
  /** Runtime credentials to copy; defaults to `runtimes`. */
  credentialRuntimes?: AgentId[];
  detected: DetectedRuntime[];
  /** Profile-dispatch config to materialize on the leased box before the run. */
  dispatchProfile?: LeaseDispatchProfile;
  /** Secrets bundle providing crabbox's provider token. */
  secretsBundle?: string;
  /** Push the git-tracked subset of local `~/.agents` onto the box before the run (default true;
   * `--bare` sets false). When true, `buildBootstrapScript` emits the `copy-setup` sentinel; the
   * push itself is `copySetupToBox` (setup-copy.ts), run by the command layer. */
  copySetup?: boolean;
  /** Network mode passed to `crabboxWarmup` (default `'public'`); `'tailscale'` joins the tailnet
   * and adds a `joined-tailnet` step. The command layer decides when; this is plumbing only. */
  netMode?: 'public' | 'tailscale';
  onData?: (s: string) => void;
  /** Progress phases (warmup → ready → teardown) for a command-layer spinner. */
  onPhase?: (phase: LeasePhase) => void;
  /** Keep the box after the run instead of stopping it. */
  keep?: boolean;
  /** Existing warm crabbox slug to reuse instead of provisioning a new lease. */
  reuseBox?: string;
  /** Force a brand-new box: skip warm pool reuse and tear the box down after the run (the pre-pool
   * `--lease` behavior). `--fresh` at the command layer. */
  fresh?: boolean;
  /** Raw wrapped Claude OAuth payload (from `resolveClaudeCredentialsBlob`) written to
   * `~/.claude/.credentials.json` on the box. The command layer resolves it after consent so this
   * module stays free of Keychain I/O. */
  claudeCredentialsJson?: string | null;
}

export interface LeaseDispatchProfile {
  name: string;
  agent: AgentId;
  version?: string;
  env: Record<string, string>;
  description?: string;
  preset?: string;
  provider?: string;
  fallbackModel?: string;
}

interface LeaseRunResult {
  box: CrabboxBox;
  exitCode: number | null;
  toreDown: boolean;
}

/** Exit code the box-side bootstrap raises when `agents setup` left no usable install
 * (`~/.agents/.system` still not a git repo), which the run-side `ensureInitialized` gate would
 * refuse anyway. `leaseAndRun` reads it to stop a box this run provisioned. */
export const LEASE_BOOTSTRAP_FAILED_CODE = 97;

/** POSIX single-quote for safe embedding in the generated bootstrap script. */
function q(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Build a shell-safe, collision-resistant workspace id for one lease run. */
export function leaseWorkspaceId(repoRoot: string, startedAtMs = Date.now(), pid = process.pid): string {
  const repo = repoRoot.split(/[\\/]/).filter(Boolean).pop() ?? 'repo';
  const safeRepo = repo.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
  return `${safeRepo}-${startedAtMs.toString(36)}-${pid.toString(36)}`;
}

/** Isolated box-home path for one run, relative to the shared box user's home. */
function leaseHomeDir(workspaceId: string): string {
  return `lease-homes/${workspaceId}`;
}

function profileRemotePath(name: string): string {
  return `.agents/profiles/${name}.yml`;
}

function buildProfileScript(profile: LeaseDispatchProfile): string {
  const body = yaml.stringify({
    name: profile.name,
    ...(profile.description ? { description: profile.description } : {}),
    host: {
      agent: profile.agent,
      ...(profile.version ? { version: profile.version } : {}),
    },
    env: profile.env,
    ...(profile.fallbackModel ? { fallback_model: profile.fallbackModel } : {}),
    ...(profile.preset ? { preset: profile.preset } : {}),
    ...(profile.provider ? { provider: profile.provider } : {}),
  });
  return buildHomeFileWriteScript(profileRemotePath(profile.name), body);
}

function runtimeInstallSpec(id: AgentId, dispatchProfile?: LeaseDispatchProfile): string {
  if (dispatchProfile?.agent === id && dispatchProfile.version) {
    return `${id}@${dispatchProfile.version}`;
  }
  return id;
}

/** Bash snippet ensuring `agents` is runnable and set up on the box. Fresh images lack node and the
 * user may not own the npm prefix, so everything installs under ~/.local. Exits 96 if the CLI is
 * not runnable, LEASE_BOOTSTRAP_FAILED_CODE if setup left no git-repo `.system`. */
const ENSURE_AGENTS_CLI = [
  'export PATH="$HOME/.local/bin:$PATH"',
  'if ! command -v node >/dev/null 2>&1; then',
  '  case "$(uname -m)" in aarch64|arm64) narch=arm64;; *) narch=x64;; esac',
  '  nver=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ | grep -oE "v22\\.[0-9]+\\.[0-9]+" | head -1)',
  '  mkdir -p "$HOME/.local"',
  '  curl -fsSL "https://nodejs.org/dist/latest-v22.x/node-$nver-linux-$narch.tar.xz" | tar -xJ -C "$HOME/.local" --strip-components=1',
  'fi',
  'if ! command -v agents >/dev/null 2>&1; then',
  '  npm config set prefix "$HOME/.local" >/dev/null 2>&1 || true',
  '  npm install -g @phnx-labs/agents-cli >/dev/null 2>&1',
  'fi',
  'if ! command -v agents >/dev/null 2>&1; then',
  '  echo "lease bootstrap: agents-cli install failed (node: $(command -v node || echo missing))" >&2',
  '  exit 96',
  'fi',
  // The run-side gate (`ensureInitialized`) refuses `agents run` until `~/.agents/.system` is a
  // git repo, so gate setup on that same postcondition: capture output and abort with the cause,
  // never `|| true`. `-e` (not `-d`) matches `isGitRepo`, so a gitfile `.system` is fine.
  'if [ ! -e "$HOME/.agents/.system/.git" ]; then',
  '  setup_out=$(agents setup 2>&1)',
  '  if [ ! -e "$HOME/.agents/.system/.git" ]; then',
  '    echo "lease bootstrap: agents setup did not complete (~/.agents/.system is not a git repo)" >&2',
  '    printf "%s\\n" "$setup_out" >&2',
  `    exit ${LEASE_BOOTSTRAP_FAILED_CODE}`,
  '  fi',
  'fi',
].join('\n');

/** Build the single box-side bootstrap script: ensure agents-cli, install the picked runtime CLIs,
 * write credentials, run the agent, then shred the credential files. Best-effort install steps
 * never abort the run. */
export function buildBootstrapScript(opts: LeaseRunOptions): string {
  const credentialRuntimes = opts.credentialRuntimes ?? opts.runtimes;
  const credScript = buildCredentialScript(credentialRuntimes, opts.detected, {
    claudeCredentialsJson: opts.claudeCredentialsJson,
  });
  const profileScript = opts.dispatchProfile ? buildProfileScript(opts.dispatchProfile) : '';
  const runParts = ['agents', 'run', q(opts.agent), q(opts.prompt), '--quiet'];
  if (opts.mode) runParts.push('--mode', q(opts.mode));
  if (opts.model) runParts.push('--model', q(opts.model));

  // Credential files to shred after the run (home-level paths written above).
  // Runs regardless of --keep-box (it's in the box body, not teardown), so a kept
  // box still loses the token after the run — minimizing the credential window.
  const shredPaths = credentialRuntimes.flatMap((id) => {
    const paths = { claude: ['.claude.json', CLAUDE_TOKEN_REMOTE], codex: ['.codex/auth.json'], grok: ['.grok/auth.json'] }[id as string];
    return paths ?? [];
  });
  if (opts.dispatchProfile) shredPaths.push(profileRemotePath(opts.dispatchProfile.name));
  const shred = shredPaths.map((p) => `rm -f "$HOME/${p}" 2>/dev/null || true`).join('\n');

  const installRuntimes = opts.runtimes
    .map((id) => `agents add ${q(runtimeInstallSpec(id, opts.dispatchProfile))} >/dev/null 2>&1 || true`)
    .join('\n');

  // `echo`-ed phase sentinels (progress.ts) let the command layer drive a
  // step-by-step UI. `createLeaseOutputRouter` swallows these lines and surfaces
  // them as a structured step stream — they never appear as setup noise.
  const step = (name: string) => `echo ${q(leasePhaseSentinel(name))}`;
  const copySetup = opts.copySetup !== false; // default TRUE
  const workspace = opts.workspaceId
    ? [
        'BOX_HOME="$HOME"',
        'REPO_DIR="$(pwd)"',
        `WORKSPACE_DIR="$BOX_HOME"/${q(`workspaces/${opts.workspaceId}`)}`,
        'mkdir -p "$WORKSPACE_DIR"',
        'rsync -a --delete --exclude=node_modules --exclude=.agents/worktrees "$REPO_DIR/" "$WORKSPACE_DIR/"',
        'cd "$WORKSPACE_DIR"',
      ].join('\n')
    : '';
  const isolatedHome = opts.workspaceId
    ? [
        `export HOME="$BOX_HOME"/${q(leaseHomeDir(opts.workspaceId))}`,
        'mkdir -p "$HOME/.agents"',
        'ln -sfn "$BOX_HOME/.agents/.system" "$HOME/.agents/.system"',
        'export PATH="$BOX_HOME/.local/bin:$PATH"',
      ].join('\n')
    : '';

  return [
    'set -uo pipefail',
    // crabbox has finished its workspace resync by the time this script runs;
    // the sync sentinel marks the transition out of that (crabbox-driven) phase.
    step('sync'),
    workspace,
    // Only meaningful on a tailnet lease — the box already joined during warmup.
    opts.netMode === 'tailscale' ? step('joined-tailnet') : '',
    step('install'),
    ENSURE_AGENTS_CLI,
    isolatedHome,
    step('runtime'),
    installRuntimes,
    step('creds'),
    credScript,
    profileScript,
    // copy-setup: the host already rsync'd the git-tracked ~/.agents onto the box, so after
    // ENSURE_AGENTS_CLI we materialize it into the runtime home. Gated by copySetup (cleared for
    // --bare); best-effort.
    copySetup ? [step('copy-setup'), 'agents sync --local -y >/dev/null 2>&1 || true'].join('\n') : '',
    // Marker on its own line: the command layer shows everything before this as
    // setup progress and everything after (the agent's output) verbatim.
    `echo ${q(LEASE_AGENT_MARKER)}`,
    `${runParts.join(' ')}`,
    'rc=$?',
    shred,
    'exit $rc',
  ]
    .filter((l) => l.length > 0)
    .join('\n');
}

/** The first warm pool box that is actually SSH-ready, or null. Mirrors scripts/sandbox.sh
 * `pick_ready_box`: gate each running box on `crabbox status` ready=true, since a failed-bootstrap
 * box lists as `running`. A skipped box is never stopped: a concurrent run may be mid-boot. */
function pickReadyPoolBox(opts: LeaseRunOptions): CrabboxBox | null {
  const candidates = poolReusableBoxes(crabboxList({ secretsBundle: opts.secretsBundle }), {
    profile: opts.profile,
    netMode: opts.netMode,
  });
  for (const b of candidates) {
    if (crabboxStatusReady(b.slug, { secretsBundle: opts.secretsBundle })) return b;
  }
  return null;
}

/** Untouched-for-this-long ⇒ no active run holds the box, so an expired one is a stray. */
export const STRAY_GRACE_SECS = 600;

interface StrayMatchOptions {
  /** Pool the lease belongs to (defaults to DEFAULT_CRABBOX_PROFILE). */
  profile?: string;
  /** Network mode of the lease (default 'public'); a box is partitioned by it. */
  netMode?: 'public' | 'tailscale';
  /** The box this run is using — never a stray. */
  keepSlug: string;
  /** Injectable clock (unix seconds). */
  nowSecs?: number;
  /** Idle grace window (defaults to {@link STRAY_GRACE_SECS}). */
  graceSecs?: number;
}

/** Whether `box` is an expired, idle stray in this run's pool: running, same profile+netMode,
 * EXPIRED lease, untouched for the grace window. An expired box can never be reused yet
 * `keep:true` leaves it billing until `gc`'s 1h window. Mid-boot or in-use boxes are never strays. */
export function isExpiredPoolStray(box: CrabboxBox, opts: StrayMatchOptions): boolean {
  const profile = opts.profile ?? DEFAULT_CRABBOX_PROFILE;
  const netMode = opts.netMode ?? 'public';
  const nowSecs = opts.nowSecs ?? Math.floor(Date.now() / 1000);
  const graceSecs = opts.graceSecs ?? STRAY_GRACE_SECS;
  if (box.slug === opts.keepSlug) return false;
  if (box.status !== 'running') return false;
  if ((box.profile ?? DEFAULT_CRABBOX_PROFILE) !== profile) return false;
  const boxNet = box.tailscaleIPv4 || box.tailscaleFQDN ? 'tailscale' : 'public';
  if (boxNet !== netMode) return false;
  if (box.expiresAt === null || box.expiresAt > nowSecs) return false; // unexpired ⇒ reusable
  if (box.lastTouchedAt === null) return false; // unknown age is never reap-safe
  if (nowSecs - box.lastTouchedAt < graceSecs) return false; // maybe active
  return true;
}

/** Opportunistically stop expired, idle strays in this run's pool. Rides the lease (no scheduler),
 * best-effort, never throws or blocks; returns the count stopped. */
function reapExpiredPoolStrays(opts: LeaseRunOptions, keepSlug: string): number {
  let boxes: CrabboxBox[];
  try {
    boxes = crabboxList({ secretsBundle: opts.secretsBundle });
  } catch {
    return 0;
  }
  let reaped = 0;
  for (const b of boxes) {
    if (!isExpiredPoolStray(b, { profile: opts.profile, netMode: opts.netMode, keepSlug })) continue;
    if (crabboxStop(b.slug, { secretsBundle: opts.secretsBundle })) reaped++;
  }
  return reaped;
}

export async function leaseAndRun(opts: LeaseRunOptions): Promise<LeaseRunResult> {
  // SING-1b, fail fast: `buildBootstrapScript` refuses to copy a native OAuth login but only after
  // a box is leased, and a `--fresh` box would leak since the throw escapes the teardown
  // `finally`. Refuse here before any box is provisioned or paid for.
  assertNoNativeOAuthTransfer(opts.credentialRuntimes ?? opts.runtimes, opts.detected, {
    claudeCredentialsJson: opts.claudeCredentialsJson,
  });

  const startedAt = Date.now();
  let box: CrabboxBox;
  // A box this run did NOT provision — either the caller named it (`--box`) or
  // it came out of the warm profile pool. Reused boxes are never torn down.
  let reused = false;
  if (opts.reuseBox) {
    opts.onPhase?.({ kind: 'reuse', slug: opts.reuseBox });
    const found = crabboxFind(opts.reuseBox, { secretsBundle: opts.secretsBundle });
    if (!found) throw new Error(`crabbox box "${opts.reuseBox}" was not found. Check \`crabbox list\` or pass a different --box slug.`);
    box = found.ready
      ? found
      : await crabboxWaitReady(opts.reuseBox, { secretsBundle: opts.secretsBundle });
    reused = true;
  } else {
    // Reuse-first: before paying for a fresh lease, look for a warm box in this
    // run's profile pool (same profile label the warmup would use, same netMode).
    // `--fresh` opts out and always provisions.
    const pooled = opts.fresh ? null : pickReadyPoolBox(opts);
    if (pooled) {
      opts.onPhase?.({ kind: 'reuse', slug: pooled.slug });
      box = pooled;
      reused = true;
    } else {
      opts.onPhase?.({ kind: 'warmup', backend: opts.backend });
      box = await crabboxWarmup({
        class: opts.boxClass,
        profile: opts.profile,
        provider: opts.backend,
        secretsBundle: opts.secretsBundle,
        netMode: opts.netMode,
      });
      await crabboxWaitReady(box.slug, { secretsBundle: opts.secretsBundle });
    }
  }
  opts.onPhase?.({ kind: 'ready', box, elapsedMs: Date.now() - startedAt });

  // Reap expired, idle strays now that we hold our box: they can never be reused and are pure cost
  // until the 1h `gc` window. Skipped for an explicit `--box`; best-effort.
  if (!opts.reuseBox) {
    reapExpiredPoolStrays(opts, box.slug);
  }

  // Setup-copy (F1, RUSH-1920): rsync the git-tracked ~/.agents from the host over crabbox's
  // per-lease ssh (raw ssh fails publickey). The matching `agents sync --local` runs in the
  // bootstrap script after install. Best-effort: a copy failure never aborts the run.
  if (opts.copySetup !== false) {
    try {
      await copySetupToBox({
        slug: box.slug,
        secretsBundle: opts.secretsBundle,
        onData: opts.onData,
        refresh: false,
        remoteDir: opts.workspaceId ? `${leaseHomeDir(opts.workspaceId)}/.agents/` : undefined,
      });
    } catch (err) {
      // Best-effort — a config-copy failure never blocks the run (the agent runs
      // without the pushed ~/.agents config), but surface it instead of swallowing
      // it silently so a broken sync is visible rather than a mystery.
      opts.onData?.(`lease: setup copy failed — running without pushed ~/.agents config (${(err as Error).message})\n`);
    }
  }

  const script = buildBootstrapScript(opts);
  let exitCode: number | null = null;
  let toreDown = false;
  // Track whether the box script reached the agent: the bootstrap echoes LEASE_AGENT_MARKER right
  // before `agents run` and aborts strictly before it, so a missing marker tells a bootstrap abort
  // from an agent exiting with the same code. A rolling tail handles a split marker.
  let sawAgentMarker = false;
  let markerTail = '';
  const trackedOnData = (chunk: string) => {
    if (!sawAgentMarker) {
      const combined = markerTail + chunk;
      if (combined.includes(LEASE_AGENT_MARKER)) sawAgentMarker = true;
      // Keep only enough tail to catch a marker straddling the NEXT chunk boundary.
      else markerTail = combined.slice(-(LEASE_AGENT_MARKER.length + 8));
    }
    opts.onData?.(chunk);
  };
  try {
    const renewIdleTimeoutSecs = reused && !opts.reuseBox && box.idleTimeoutSecs !== null
      ? box.idleTimeoutSecs
      : undefined;
    exitCode = await crabboxRunScript(box.slug, script, {
      secretsBundle: opts.secretsBundle,
      onData: trackedOnData,
      renewIdleTimeoutSecs,
    });
  } finally {
    // A box this run provisioned (never a reused one) whose bootstrap failed is unusable capacity,
    // so stop it regardless of --keep-box. The failed-code check requires the agent marker unseen,
    // so an agent exiting with the same code keeps its box.
    const bootstrapFailed = exitCode === LEASE_BOOTSTRAP_FAILED_CODE && !sawAgentMarker;
    // Normal --lease establishes or reuses the warm pool, so a healthy box outlives
    // this run; credentials are still shredded inside the script above. Only --fresh
    // requests the old one-shot lifecycle and tears its new box down.
    const teardownHealthy = !opts.keep && opts.fresh && !reused;
    const teardownBroken = bootstrapFailed && !reused;
    if (teardownHealthy || teardownBroken) {
      opts.onPhase?.({ kind: 'teardown' });
      toreDown = crabboxStop(box.slug, { secretsBundle: opts.secretsBundle });
    }
  }
  return { box, exitCode, toreDown };
}
