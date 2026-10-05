
import type { AgentId } from '../types.js';
import { crabboxFind, crabboxList, crabboxStatusReady, crabboxWarmup, crabboxWaitReady, crabboxRunScript, crabboxStop, poolReusableBoxes, type CrabboxBox } from './cli.js';
import * as yaml from 'yaml';
import { assertNoNativeOAuthTransfer, buildCredentialScript, buildHomeFileWriteScript, CLAUDE_TOKEN_REMOTE, type DetectedRuntime } from './runtimes.js';
import { LEASE_AGENT_MARKER, leasePhaseSentinel } from './progress.js';
import { copySetupToBox } from './setup-copy.js';
import { DEFAULT_CRABBOX_PROFILE } from './config.js';

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
  backend?: string;
  boxClass?: string;
  profile?: string;
  workspaceId?: string;
  runtimes: AgentId[];
  credentialRuntimes?: AgentId[];
  detected: DetectedRuntime[];
  dispatchProfile?: LeaseDispatchProfile;
  secretsBundle?: string;
  copySetup?: boolean;
  netMode?: 'public' | 'tailscale';
  onData?: (s: string) => void;
  onPhase?: (phase: LeasePhase) => void;
  keep?: boolean;
  reuseBox?: string;
  fresh?: boolean;
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

export const LEASE_BOOTSTRAP_FAILED_CODE = 97;

function q(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function leaseWorkspaceId(repoRoot: string, startedAtMs = Date.now(), pid = process.pid): string {
  const repo = repoRoot.split(/[\\/]/).filter(Boolean).pop() ?? 'repo';
  const safeRepo = repo.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
  return `${safeRepo}-${startedAtMs.toString(36)}-${pid.toString(36)}`;
}

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
  'if [ ! -e "$HOME/.agents/.system/.git" ]; then',
  '  setup_out=$(agents setup 2>&1)',
  '  if [ ! -e "$HOME/.agents/.system/.git" ]; then',
  '    echo "lease bootstrap: agents setup did not complete (~/.agents/.system is not a git repo)" >&2',
  '    printf "%s\\n" "$setup_out" >&2',
  `    exit ${LEASE_BOOTSTRAP_FAILED_CODE}`,
  '  fi',
  'fi',
].join('\n');

export function buildBootstrapScript(opts: LeaseRunOptions): string {
  const credentialRuntimes = opts.credentialRuntimes ?? opts.runtimes;
  const credScript = buildCredentialScript(credentialRuntimes, opts.detected, {
    claudeCredentialsJson: opts.claudeCredentialsJson,
  });
  const profileScript = opts.dispatchProfile ? buildProfileScript(opts.dispatchProfile) : '';
  const runParts = ['agents', 'run', q(opts.agent), q(opts.prompt), '--quiet'];
  if (opts.mode) runParts.push('--mode', q(opts.mode));
  if (opts.model) runParts.push('--model', q(opts.model));

  const shredPaths = credentialRuntimes.flatMap((id) => {
    const paths = { claude: ['.claude.json', CLAUDE_TOKEN_REMOTE], codex: ['.codex/auth.json'], grok: ['.grok/auth.json'] }[id as string];
    return paths ?? [];
  });
  if (opts.dispatchProfile) shredPaths.push(profileRemotePath(opts.dispatchProfile.name));
  const shred = shredPaths.map((p) => `rm -f "$HOME/${p}" 2>/dev/null || true`).join('\n');

  const installRuntimes = opts.runtimes
    .map((id) => `agents add ${q(runtimeInstallSpec(id, opts.dispatchProfile))} >/dev/null 2>&1 || true`)
    .join('\n');

  const step = (name: string) => `echo ${q(leasePhaseSentinel(name))}`;
  const copySetup = opts.copySetup !== false;
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
    step('sync'),
    workspace,
    opts.netMode === 'tailscale' ? step('joined-tailnet') : '',
    step('install'),
    ENSURE_AGENTS_CLI,
    isolatedHome,
    step('runtime'),
    installRuntimes,
    step('creds'),
    credScript,
    profileScript,
    copySetup ? [step('copy-setup'), 'agents sync --local -y >/dev/null 2>&1 || true'].join('\n') : '',
    `echo ${q(LEASE_AGENT_MARKER)}`,
    `${runParts.join(' ')}`,
    'rc=$?',
    shred,
    'exit $rc',
  ]
    .filter((l) => l.length > 0)
    .join('\n');
}

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

export const STRAY_GRACE_SECS = 600;

interface StrayMatchOptions {
  profile?: string;
  netMode?: 'public' | 'tailscale';
  keepSlug: string;
  nowSecs?: number;
  graceSecs?: number;
}

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
  if (box.expiresAt === null || box.expiresAt > nowSecs) return false;
  if (box.lastTouchedAt === null) return false;
  if (nowSecs - box.lastTouchedAt < graceSecs) return false;
  return true;
}

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
  assertNoNativeOAuthTransfer(opts.credentialRuntimes ?? opts.runtimes, opts.detected, {
    claudeCredentialsJson: opts.claudeCredentialsJson,
  });

  const startedAt = Date.now();
  let box: CrabboxBox;
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

  if (!opts.reuseBox) {
    reapExpiredPoolStrays(opts, box.slug);
  }

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
      opts.onData?.(`lease: setup copy failed — running without pushed ~/.agents config (${(err as Error).message})\n`);
    }
  }

  const script = buildBootstrapScript(opts);
  let exitCode: number | null = null;
  let toreDown = false;
  let sawAgentMarker = false;
  let markerTail = '';
  const trackedOnData = (chunk: string) => {
    if (!sawAgentMarker) {
      const combined = markerTail + chunk;
      if (combined.includes(LEASE_AGENT_MARKER)) sawAgentMarker = true;
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
    const bootstrapFailed = exitCode === LEASE_BOOTSTRAP_FAILED_CODE && !sawAgentMarker;
    const teardownHealthy = !opts.keep && opts.fresh && !reused;
    const teardownBroken = bootstrapFailed && !reused;
    if (teardownHealthy || teardownBroken) {
      opts.onPhase?.({ kind: 'teardown' });
      toreDown = crabboxStop(box.slug, { secretsBundle: opts.secretsBundle });
    }
  }
  return { box, exitCode, toreDown };
}
