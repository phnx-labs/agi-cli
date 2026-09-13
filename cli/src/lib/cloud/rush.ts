/**
 * Rush Cloud provider -- dispatches tasks to the Factory Floor via api.prix.dev.
 *
 * Auth: reads the session token from ~/.rush/user.yaml (written by `rush login`).
 * Requires the Rush GitHub App installed on the target repo.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as yaml from 'yaml';
import type {
  CloudProvider,
  CloudTask,
  CloudTaskStatus,
  CloudEvent,
  DispatchOptions,
  ProviderCapabilities,
  ImageAttachment,
  SkillRef,
} from './types.js';
import { resolveDispatchRepos, normalizeProviderStatus, MAX_IMAGES_PER_DISPATCH } from './types.js';
import { isRushSessionExpired } from '../rush-session.js';
import { parseSSE } from './stream.js';
import { listInstalledVersions, getVersionHomePath } from '../installations/versions.js';
import { getAccountInfo } from '../agents.js';
import { selectBalancedVersion } from '../accounting/rotate.js';

const PROXY_BASE = process.env.RUSH_PROXY_BASE ?? 'https://api.prix.dev';
const USER_YAML = path.join(os.homedir(), '.rush', 'user.yaml');

// Native OAuth/session credentials never cross the cloud boundary. A server
// token request fails loud rather than materializing a harness login (see dispatch()).

interface UserYaml {
  session?: {
    email?: string;
    access_token?: string;
    refresh_token?: string;
    expires_at?: number;
  };
}

interface Installation {
  id: number;
  account_login: string;
  repositories?: { name: string; full_name: string }[];
  repository_selection?: string;
}

/**
 * Returns true when ~/.rush/user.yaml exists, carries an access_token, and
 * the token has not passed its expires_at timestamp (Unix milliseconds). A missing
 * expires_at, or `expires_at: 0` (a non-expiring Phoenix `pid_` bearer), is
 * treated as non-expired (see isRushSessionExpired, PHNX-3645). Pass yamlPath
 * to override the default path in tests.
 */
export function isRushSessionValid(yamlPath: string = USER_YAML): boolean {
  try {
    if (!fs.existsSync(yamlPath)) return false;
    const raw = fs.readFileSync(yamlPath, 'utf-8');
    const data = yaml.parse(raw) as UserYaml;
    if (!data?.session?.access_token) return false;
    if (isRushSessionExpired(data.session.expires_at)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the Rush session access token from ~/.rush/user.yaml. Exported (with an
 * overridable yamlPath, like isRushSessionValid) so the freshness behavior —
 * including the `expires_at: 0` non-expiring case (PHNX-3645) — is directly
 * testable; the class methods call it with the default path.
 */
export function readToken(yamlPath: string = USER_YAML): string {
  if (!fs.existsSync(yamlPath)) {
    throw new Error('Not logged in to Rush. Run `rush login` first.');
  }
  const raw = fs.readFileSync(yamlPath, 'utf-8');
  const data = yaml.parse(raw) as UserYaml;
  const token = data?.session?.access_token;
  if (!token) {
    throw new Error('No session token in ~/.rush/user.yaml. Run `rush login` first.');
  }
  const expiresAt = data.session?.expires_at;
  if (isRushSessionExpired(expiresAt)) {
    const expiredAt = new Date(expiresAt!).toISOString();
    throw new Error(`Rush session expired at ${expiredAt}. Run \`rush login\` to refresh.`);
  }
  return token;
}

/** Read the user's email from the Rush session config, if available. */
function readEmail(): string | undefined {
  try {
    const raw = fs.readFileSync(USER_YAML, 'utf-8');
    const data = yaml.parse(raw) as UserYaml;
    return data?.session?.email;
  } catch {
    return undefined;
  }
}

/** Make an authenticated request to the Rush API proxy. */
async function api(method: string, endpoint: string, token: string, body?: unknown): Promise<Response> {
  const url = endpoint.startsWith('http') ? endpoint : `${PROXY_BASE}${endpoint}`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  return fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Find the GitHub App installation ID for a given owner/repo pair. */
async function findInstallation(token: string, owner: string, repo: string): Promise<number> {
  const res = await api('GET', '/api/v1/github/app/installations', token);
  if (!res.ok) {
    throw new Error(`Failed to fetch GitHub installations (${res.status}). Is the Rush GitHub App installed?`);
  }
  const data = await res.json() as { installations: Installation[] };

  for (const inst of data.installations ?? []) {
    if (inst.account_login?.toLowerCase() === owner.toLowerCase()) {
      if (inst.repository_selection === 'all') return inst.id;
      if (inst.repositories?.some(r => r.name.toLowerCase() === repo.toLowerCase())) {
        return inst.id;
      }
    }
  }

  throw new Error(
    `No GitHub App installation found for ${owner}/${repo}. Install the Rush GitHub App at https://github.com/apps/cloud-bot.`,
  );
}

/** One version's entry in the account manifest sent on every dispatch. */
interface AccountManifestEntry {
  version: string;
  email: string;
}

/**
 * Manifest of the user's local Claude accounts (version + account email only).
 * Sent on a non-balanced dispatch so the server knows which accounts exist and
 * can route to one. It carries **no credential material** and does NOT read the
 * native OAuth login (RUSH-2527 / SING-1b): agents-cli never reads a harness's
 * interactive login to build this. When the server asks for the underlying token
 * (a new account, or a rotation it can't otherwise resolve), the client does NOT
 * upload it — there is no consented path to copy a native OAuth login to the
 * cloud. Dispatch fails loud and steers to a portable provider account instead
 * (see the 401 handler in `dispatch()`).
 */
interface AccountManifest {
  fp: string;
  versions: AccountManifestEntry[];
}

/** sha256 → hex. */
function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Strip tokens/credentials from a server error body before surfacing it.
 * If the body is JSON with a `message` or `error` field, prefer that.
 * Otherwise truncate and redact anything that looks like a bearer token or JWT.
 */
function sanitizeErrorBody(body: string): string {
  const MAX_LEN = 300;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const msg = (parsed.message ?? parsed.error ?? parsed.detail) as string | undefined;
    if (typeof msg === 'string') return msg.slice(0, MAX_LEN);
  } catch { /* not JSON, fall through */ }
  let safe = body.slice(0, MAX_LEN);
  safe = safe.replace(/eyJ[A-Za-z0-9_-]{20,}/g, '[REDACTED_TOKEN]');
  safe = safe.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  safe = safe.replace(/"(access_token|refresh_token|credentials_json)"\s*:\s*"[^"]*"/g, '"$1":"[REDACTED]"');
  if (body.length > MAX_LEN) safe += '...';
  return safe;
}

/**
 * Pull `prompt_code` out of a JSON-encoded error body. Returns null when the
 * body isn't JSON or doesn't carry one — caller falls through to the generic
 * dispatch-failed path.
 */
function parsePromptCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { prompt_code?: unknown };
    return typeof parsed.prompt_code === 'string' ? parsed.prompt_code : null;
  } catch {
    return null;
  }
}

/**
 * Build a manifest of the user's local Claude installations to send on every
 * cloud dispatch. The manifest is the contract the server uses to detect when
 * the user has added a new account or rotated a token.
 *
 * Returns null when no Claude versions are signed in (the dispatch falls back
 * to the platform-wide key, current behavior).
 */
async function buildAccountManifest(strategy?: string): Promise<AccountManifest | null> {
  let candidateVersions: Array<{ version: string; email: string }>;

  if (strategy === 'balanced') {
    // Use the same health-checked, deduped-by-email set that `agents run --balanced` uses.
    // `result.healthy` contains one candidate per unique email, ordered by remaining capacity.
    const result = await selectBalancedVersion('claude');
    if (!result || result.healthy.length === 0) return null;
    candidateVersions = result.healthy
      .filter((c) => !!c.email)
      .map((c) => ({ version: c.version, email: c.email! }));
  } else {
    // Default: all installed versions that have a signed-in account.
    const versions = listInstalledVersions('claude');
    if (versions.length === 0) return null;
    const rows = await Promise.all(
      versions.map(async (version) => {
        const home = getVersionHomePath('claude', version);
        const info = await getAccountInfo('claude', home);
        return info.email ? { version, email: info.email } : null;
      }),
    );
    candidateVersions = rows.filter((r): r is { version: string; email: string } => r !== null);
  }

  // RUSH-2527 / SING-1b: do NOT read the native OAuth login to fingerprint it.
  // The manifest carries version + account email only — enough for the server to
  // route to an account. If the server needs the token itself, the client does NOT
  // upload it (there is no consented path to copy a native OAuth login to the
  // cloud); dispatch fails loud and steers to a portable provider account.
  const entries: AccountManifestEntry[] = candidateVersions
    .map(({ version, email }) => ({ version, email }))
    .sort((a, b) => a.version.localeCompare(b.version));

  if (entries.length === 0) return null;
  const fp = sha256(JSON.stringify(entries));
  return { fp, versions: entries };
}

// buildAccountTokensPayload / accountTokensFingerprint (which read every installed
// Claude version's native OAuth token to upload it to the cloud) were REMOVED —
// SING-1b forbids reading or transferring a native OAuth / session login, even
// with consent. Cloud dispatch under a native login now fails loud and steers to a
// portable provider account (see the 401 handler in dispatch()).

/**
 * Build the POST body for /api/v1/cloud-runs. Exported so tests can verify
 * the back-compat shape (singular fields + repos[]) without needing real
 * GitHub installations or a live Rush session. `findInstallation` is the
 * only other I/O and it's tested by the cloud proxy integration suite.
 */
export function buildDispatchBody(input: {
  agent?: string;
  prompt: string;
  mode?: string;
  strategy?: string;
  resolvedRepos: Array<{ installation_id: number; repo_owner: string; repo_name: string }>;
  accountManifest?: AccountManifest | null;
  /**
   * Skill ride-alongs so the cloud pod isn't context-blind. Forwarded verbatim
   * as `skills` so the Factory Floor can mount them by id/version before the
   * agent runs. Omitted when empty.
   */
  skills?: SkillRef[] | null;
  /**
   * Base64 image attachments for vision dispatch. Sliced to
   * MAX_IMAGES_PER_DISPATCH — extras are dropped, never sent. Omitted when empty.
   */
  images?: ImageAttachment[] | null;
  /** Runtime env vars mounted into the cloud agent process. */
  env?: Record<string, string> | null;
}): Record<string, unknown> {
  if (input.resolvedRepos.length === 0) {
    throw new Error('buildDispatchBody: resolvedRepos must have at least one entry');
  }
  const primary = input.resolvedRepos[0];
  const body: Record<string, unknown> = {
    agent: input.agent ?? 'claude',
    prompt: input.prompt,
    repos: input.resolvedRepos,
    mode: input.mode,
    ...(input.strategy ? { strategy: input.strategy } : {}),
  };
  if (input.resolvedRepos.length === 1) {
    body.installation_id = primary.installation_id;
    body.repo_owner = primary.repo_owner;
    body.repo_name = primary.repo_name;
  }
  if (input.accountManifest) {
    body.account_manifest = input.accountManifest;
  }
  if (input.skills && input.skills.length > 0) {
    body.skills = input.skills;
  }
  if (input.images && input.images.length > 0) {
    body.images = input.images.slice(0, MAX_IMAGES_PER_DISPATCH);
  }
  if (input.env && Object.keys(input.env).length > 0) {
    body.env = input.env;
  }
  return body;
}

export class RushCloudProvider implements CloudProvider {
  id = 'rush' as const;
  name = 'Rush Cloud';

  capabilities(): ProviderCapabilities {
    return {
      available: isRushSessionValid(),
      dispatch: true,
      status: true,
      list: true,
      stream: true,
      cancel: true,
      message: true,
      multiRepo: true,
      skills: true,
      images: true,
    };
  }

  async dispatch(options: DispatchOptions): Promise<CloudTask> {
    const repos = resolveDispatchRepos(options);
    if (repos.length === 0) {
      throw new Error('Rush Cloud requires --repo <owner/repo> (or --repo repeated for multi-repo).');
    }

    // Budget pre-flight gate (issue #346). Cloud dispatches inherit the local
    // project's caps; we refuse to POST a run that would breach an on_exceed:block
    // cap. The repo slug is the project attribution key. Server-side spend is
    // authoritative for live enforcement; this pre-flight is the deterministic
    // "don't even start it" guard. Dormant when no caps are configured.
    {
      const { runPreflightGate } = await import('../budget/preflight.js');
      const projectKey = repos[0] ?? process.cwd();
      const gate = runPreflightGate({
        agent: options.agent ?? 'cloud',
        model: options.model ?? `${options.agent ?? 'cloud'}-default`,
        prompt: options.prompt,
        project: projectKey,
      });
      if (!gate.dormant && !gate.decision.allow) {
        throw new Error(`[budget] BLOCKED cloud dispatch (${projectKey}): ${gate.decision.reason}`);
      }
    }

    // Validate each repo's shape and resolve its installation_id up front.
    // Any bad entry fails the whole dispatch — we never want a half-started
    // multi-repo run that only found installations for some of the repos.
    const token = readToken();
    const parsed = repos.map((full) => {
      const parts = full.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid repo format: ${JSON.stringify(full)}. Use owner/repo.`);
      }
      return { full, owner: parts[0], name: parts[1] };
    });

    const resolvedRepos = await Promise.all(
      parsed.map(async (r) => ({
        installation_id: await findInstallation(token, r.owner, r.name),
        repo_owner: r.owner,
        repo_name: r.name,
      })),
    );

    const strategy = (options.providerOptions as { strategy?: string } | undefined)?.strategy;
    // When balanced, the server owns the pool and rotates internally — no
    // client-side manifest needed. We just forward the strategy so the server
    // knows to load from Vault instead of waiting for a manifest.
    const accountManifest = strategy === 'balanced' ? null : await buildAccountManifest();

    const body = buildDispatchBody({
      agent: options.agent,
      prompt: options.prompt,
      mode: options.providerOptions?.mode as string | undefined,
      resolvedRepos,
      accountManifest,
      strategy,
      skills: options.skills,
      images: options.images,
      env: options.env,
    });

    let res = await api('POST', '/api/v1/cloud-runs', token, body);

    // The server asks the client to upload the underlying Claude OAuth token when
    // it detects a new account or a rotation (401 + prompt_code). agents-cli NEVER
    // reads or transfers a native OAuth / session login off this machine — not
    // even with consent (SING-1b): a rotating token copied to the cloud is
    // invalidated on its next refresh and logs the fleet out. Fail loud and steer
    // to a portable provider account instead of exfiltrating the login.
    if (res.status === 401 && accountManifest) {
      const errBody = await res.clone().text();
      const promptCode = parsePromptCode(errBody);
      if (promptCode === 'NEW_ACCOUNT' || promptCode === 'TOKEN_ROTATED') {
        throw new Error(
          [
            `Rush Cloud asked to sync your Claude login (reason: ${promptCode.toLowerCase()}), but`,
            `agents-cli never copies a native OAuth / session login off this machine (SING-1b) —`,
            `a rotating token uploaded to the cloud is invalidated on its next refresh.`,
            ``,
            `Portable provider accounts can run locally or on a pinned fleet device, but cloud`,
            `placement does not securely inject them yet. Create and sync one with:`,
            `    agents accounts add <name> --provider anthropic --auth api-key    # or: --auth setup-token`,
            `    agents accounts sync <name> <device>`,
            `then run locally or on that device with --account <name>. See docs/secrets.md (SING-1b).`,
          ].join('\n'),
        );
      }
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Dispatch failed (${res.status}): ${sanitizeErrorBody(text)}`);
    }

    const data = await res.json() as { execution_id: string };
    const now = new Date().toISOString();

    return {
      id: data.execution_id,
      provider: 'rush',
      status: 'queued',
      agent: options.agent ?? 'claude',
      prompt: options.prompt,
      repo: repos[0],
      repos: repos,
      branch: options.branch,
      createdAt: now,
      updatedAt: now,
    };
  }

  async status(taskId: string): Promise<CloudTask> {
    const token = readToken();
    const res = await api('GET', `/api/v1/cloud-runs/${encodeURIComponent(taskId)}`, token);
    if (!res.ok) {
      throw new Error(`Failed to get task status (${res.status}).`);
    }
    const data = await res.json() as Record<string, unknown>;
    return {
      id: taskId,
      provider: 'rush',
      status: normalizeProviderStatus('rush', data.status as string),
      agent: (data.agent as string) || undefined,
      prompt: (data.prompt as string) || '',
      repo: data.repo_owner && data.repo_name ? `${data.repo_owner}/${data.repo_name}` : undefined,
      branch: (data.branch as string) || undefined,
      prUrl: (data.pr_url as string) || undefined,
      summary: (data.summary as string) || undefined,
      createdAt: (data.created_at as string) || new Date().toISOString(),
      updatedAt: (data.updated_at as string) || new Date().toISOString(),
    };
  }

  async list(filter?: { status?: CloudTaskStatus }): Promise<CloudTask[]> {
    const token = readToken();
    const params = new URLSearchParams();
    if (filter?.status) params.set('status', filter.status);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await api('GET', `/api/v1/cloud-runs${qs}`, token);
    if (!res.ok) {
      throw new Error(`Failed to list tasks (${res.status}).`);
    }
    const data = await res.json() as { executions: Record<string, unknown>[] };
    return (data.executions ?? []).map((e) => ({
      id: e.execution_id as string,
      provider: 'rush' as const,
      status: normalizeProviderStatus('rush', e.status as string),
      agent: (e.agent as string) || undefined,
      prompt: (e.prompt as string) || '',
      repo: e.repo_owner && e.repo_name ? `${e.repo_owner}/${e.repo_name}` : undefined,
      branch: (e.branch as string) || undefined,
      prUrl: (e.pr_url as string) || undefined,
      summary: (e.summary as string) || undefined,
      createdAt: (e.created_at as string) || '',
      updatedAt: (e.updated_at as string) || '',
    }));
  }

  async *stream(taskId: string): AsyncIterable<CloudEvent> {
    const token = readToken();
    const res = await fetch(`${PROXY_BASE}/api/v1/cloud-runs/${encodeURIComponent(taskId)}/stream`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Failed to connect to stream (${res.status}).`);
    }
    yield* parseSSE(res);
  }

  async cancel(taskId: string): Promise<void> {
    const token = readToken();
    // The cancel ACTION endpoint (POST .../cancel) is what the backend implements;
    // it works on paused runs too (queued / needs_review / input_required). A bare
    // DELETE on the run 404s, so `agents cloud cancel` silently failed on anything
    // that wasn't actively running.
    const res = await api('POST', `/api/v1/cloud-runs/${encodeURIComponent(taskId)}/cancel`, token);
    if (!res.ok) {
      throw new Error(`Failed to cancel task (${res.status}).`);
    }
  }

  async message(taskId: string, content: string): Promise<void> {
    const token = readToken();
    const res = await api('POST', `/api/v1/cloud-runs/${encodeURIComponent(taskId)}/message`, token, { content });
    if (!res.ok) {
      throw new Error(`Failed to send message (${res.status}).`);
    }
  }
}
