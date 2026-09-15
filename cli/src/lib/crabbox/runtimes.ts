/**
 * Runtime detection + picker + credential-script builder for `agents run --lease`.
 *
 * The picker asks which coding-agent runtime(s) to provision on a leased box.
 * The default selection is whatever the user is currently signed into locally
 * (via `getAccountInfo`, the same source `agents view` uses). The chosen runtimes
 * drive both what gets installed on the box and which auth token file is copied
 * over — the token contents ride the uploaded `--script-stdin` body, never argv.
 *
 * SECURITY: copying a runtime's auth token to an ephemeral cloud box is a
 * credential transfer. It is strictly opt-in (a confirm prompt in the command
 * layer), the token never appears in argv/`ps`, and `--lease` one-shot runs tear
 * the box down afterward so the credential's lifetime is bounded by the run.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { AgentId } from '../types.js';
import { getAccountInfo } from '../agents.js';
import { getKeychainTokenSync } from '../secrets-client.js';
import { getClaudeKeychainService } from '../accounting/usage.js';
import { listInstalledVersions, getVersionHomePath } from '../installations/versions.js';

/**
 * Credential file locations per runtime. `localCandidates` are read in order
 * (first existing wins); `remote` is where the box's CLI reads it by default
 * (home-level — no per-version shim). Source of truth for these paths is
 * `getAccountInfo` in src/lib/agents.ts; keep them in sync.
 */
interface RuntimeCred {
  id: AgentId;
  label: string;
  localCandidates: string[];
  remote: string;
}

export const LEASE_RUNTIMES: RuntimeCred[] = [
  { id: 'claude', label: 'Claude Code', localCandidates: ['.claude/.claude.json', '.claude.json'], remote: '.claude.json' },
  { id: 'codex', label: 'Codex CLI', localCandidates: ['.codex/auth.json'], remote: '.codex/auth.json' },
  { id: 'grok', label: 'Grok CLI', localCandidates: ['.grok/auth.json'], remote: '.grok/auth.json' },
];

/**
 * Every runtime whose login this module can serialize (`LEASE_RUNTIMES`) is a
 * native, rotating OAuth / session credential (Claude OAuth token, codex/grok
 * `auth.json`). The fleet-auth contract forbids
 * copying any of them between devices — including to an ephemeral leased box —
 * because a shared refresh token rotates server-side on the next refresh and
 * invalidates every other copy (`docs/specifications.md` SING-1b,
 * `docs/secrets.md`). The set is derived from
 * `LEASE_RUNTIMES` so a newly-added runtime can never be silently exempted. This
 * is the single canonical predicate; `--copy-creds` (`hosts/credentials.ts`) and
 * `--lease` (this module's `buildCredentialScript`) both refuse against it.
 */
const NATIVE_OAUTH_RUNTIMES = new Set<AgentId>(LEASE_RUNTIMES.map((c) => c.id));

/** True when `id` is a native OAuth / session login that MUST NOT be copied between devices (SING-1b). */
export function isNativeOAuthRuntime(id: AgentId): boolean {
  return NATIVE_OAUTH_RUNTIMES.has(id);
}

/** The fail-loud message naming the forbidden runtimes and the portable path to use instead. */
export function nativeOAuthTransferRefusal(nativeRuntimes: AgentId[]): string {
  return (
    `Refusing to copy native OAuth / session credentials to another device: ${nativeRuntimes.join(', ')}.\n` +
    `A rotating harness login copied across machines is invalidated on its next server-side token ` +
    `refresh — it logs the rest of the fleet out — so agents-cli never stores or transfers a harness's ` +
    `interactive login (docs/specifications.md SING-1b).\n` +
    `Use a portable provider account instead — a long-lived, non-rotating API key / setup-token that is ` +
    `safe to reuse on many devices:\n` +
    `    agents accounts add <name> --provider <provider> --auth <api-key|setup-token>\n` +
    `    agents accounts sync <name> --device <host>`
  );
}

export interface DetectedRuntime {
  id: AgentId;
  label: string;
  email: string | null;
  signedIn: boolean;
  /** Absolute local path of the credential file, if found. */
  credPath: string | null;
}

/** First existing candidate path under the real home, or null. */
function findLocalCred(cred: RuntimeCred): string | null {
  const home = process.env.AGENTS_REAL_HOME || os.homedir();
  for (const rel of cred.localCandidates) {
    const p = path.join(home, rel);
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* unreadable — skip */
    }
  }
  return null;
}

/** Which lease-capable runtimes the user is signed into on this machine. */
export async function detectSignedInRuntimes(): Promise<DetectedRuntime[]> {
  const out: DetectedRuntime[] = [];
  for (const cred of LEASE_RUNTIMES) {
    let info;
    try {
      info = await getAccountInfo(cred.id);
    } catch {
      info = null;
    }
    out.push({
      id: cred.id,
      label: cred.label,
      email: info?.email ?? null,
      signedIn: !!info?.signedIn,
      credPath: findLocalCred(cred),
    });
  }
  return out;
}

/**
 * Interactive checkbox: which runtimes to provision on the box. Defaults to the
 * signed-in ones. Runtimes with no local credential are shown disabled.
 * `prompt` is injected so tests don't require a TTY.
 */
export async function pickRuntimes(
  detected: DetectedRuntime[],
  prompt?: (choices: { name: string; value: AgentId; checked: boolean; disabled: boolean | string }[]) => Promise<AgentId[]>,
): Promise<AgentId[]> {
  const choices = detected.map((d) => ({
    name: `${d.label}${d.email ? ` (${d.email})` : d.signedIn ? ' (signed in)' : ''}`,
    value: d.id,
    checked: d.signedIn && !!d.credPath,
    disabled: d.credPath ? false : 'no local credential — sign in first',
  }));
  if (prompt) return prompt(choices);
  const { checkbox } = await import('@inquirer/prompts');
  return checkbox({ message: 'Provision which runtime(s) on the leased box?', choices });
}

/**
 * The lease runtime to provision for a headless run of `agentName`.
 *
 * When the agent is itself a lease-capable runtime (claude/codex/gemini/grok)
 * that IS the runtime to install. Otherwise fall back to the single signed-in
 * lease runtime (preferring claude), or null when none is signed in. This is the
 * non-interactive replacement for the runtime checkbox picker: `--lease` requires
 * a prompt, so it is headless by contract and must never block on a TTY.
 *
 * Profile-dispatch agents (kimi/deepseek) and custom workflow agents that run
 * under a non-obvious runtime are resolved separately — see RUSH-1725.
 */
export function inferLeaseRuntime(agentName: string, detected: DetectedRuntime[]): AgentId | null {
  const signedIn = detected.filter((d) => d.signedIn && d.credPath);
  // The agent names a lease runtime directly: require that runtime to be signed
  // in — never silently substitute a different one for an explicit `run <runtime>`
  // (that would lease a billable box only to boot it "Not logged in"). Not signed
  // in → null, so the caller exits with "sign into it locally first".
  if (LEASE_RUNTIMES.some((c) => c.id === agentName)) {
    return signedIn.find((d) => d.id === agentName)?.id ?? null;
  }
  // Custom/workflow agent: fall back to the signed-in runtime (preferring claude).
  return signedIn.find((d) => d.id === 'claude')?.id ?? signedIn[0]?.id ?? null;
}

const PROFILE_AUTH_ENV_KEYS_BY_RUNTIME: Partial<Record<AgentId, readonly string[]>> = {
  claude: [
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_PROFILE',
    'AWS_BEARER_TOKEN_BEDROCK',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'ANTHROPIC_FOUNDRY_API_KEY',
  ],
  codex: ['OPENAI_API_KEY'],
  grok: ['XAI_API_KEY', 'GROK_API_KEY'],
};

/** True when a profile already carries auth for its host runtime via env. */
export function profileNeedsBaseRuntimeCredentials(agent: AgentId, env: Record<string, string>, authEnvVar?: string): boolean {
  if (!LEASE_RUNTIMES.some((c) => c.id === agent)) return false;
  if (authEnvVar && typeof env[authEnvVar] === 'string' && env[authEnvVar].trim() !== '') return false;
  const keys = PROFILE_AUTH_ENV_KEYS_BY_RUNTIME[agent] ?? [];
  return !keys.some((key) => typeof env[key] === 'string' && env[key].trim() !== '');
}

// A long random sentinel makes an accidental (or malicious) collision with a
// token's contents effectively impossible, so the quoted heredoc can never be
// closed early by the credential body.
const CRED_EOF = 'AGENTS_LEASE_CRED_EOF_9f3c1a7b5e2d4068';

/** Build a quoted heredoc write to a path under the remote user's home. */
export function buildHomeFileWriteScript(remote: string, contents: string): string {
  const dir = path.posix.dirname(remote);
  const mkdir = dir && dir !== '.' ? `mkdir -p "$HOME/${dir}"\n` : '';
  return (
    `${mkdir}cat > "$HOME/${remote}" <<'${CRED_EOF}'\n${contents}${contents.endsWith('\n') ? '' : '\n'}${CRED_EOF}\n` +
    `chmod 600 "$HOME/${remote}"`
  );
}

/**
 * Where Claude Code reads its OAuth token on the box. `.claude.json` (the file
 * LEASE_RUNTIMES copies) is config/account-metadata ONLY — the actual token
 * lives here, so without it the box boots "Not logged in".
 */
export const CLAUDE_TOKEN_REMOTE = '.claude/.credentials.json';

/** True when `s` parses to a Claude keychain payload with an OAuth access token. */
function isClaudeCredentialsBlob(s: string): boolean {
  try {
    const p = JSON.parse(s) as { claudeAiOauth?: { accessToken?: unknown } };
    return typeof p?.claudeAiOauth?.accessToken === 'string';
  } catch {
    return false;
  }
}

/**
 * The RAW wrapped Claude credential payload (`{"claudeAiOauth":{…}}`) to write to
 * the box's `~/.claude/.credentials.json`, or null if no signed-in token is found.
 *
 * On macOS the token is in the login Keychain, read SILENTLY via the standalone
 * `secrets` client's `getKeychainTokenSync` (the `/usr/bin/security … -w` path —
 * Claude's item trusts it, no Touch ID). A default native install uses the bare `Claude Code-credentials`
 * service; an agents-cli managed install (where `~/.claude` symlinks into a
 * versioned home) uses a hash-suffixed service, so we try the bare service first,
 * then enumerate installed version homes (preferring the account whose email
 * matches `preferEmail`, so the token matches the `.claude.json` config we copy).
 * Off macOS the local Claude CLI stores the wrapped rotating blob in
 * `.credentials.json` already. Read that file here with a shape check
 * (`claudeAiOauth.accessToken`). Do not reintroduce a shared helper that
 * also serves Rush Cloud dispatch — dispatch is email-only (SING-1b) and
 * the old `readClaudeCredentialsBlob` path was the #1767 TTY-banner leak
 * (RUSH-2359).
 *
 * The reader/service/version helpers are injected so unit tests never touch the
 * real Keychain.
 */
export async function resolveClaudeCredentialsBlob(opts?: {
  preferEmail?: string | null;
  readItem?: (service: string) => string;
  service?: (home?: string) => string;
  listVersions?: () => string[];
  versionHome?: (version: string) => string;
  accountEmail?: (home: string) => Promise<string | null>;
}): Promise<string | null> {
  const readItem = opts?.readItem ?? getKeychainTokenSync;
  const service = opts?.service ?? getClaudeKeychainService;
  const listVersions = opts?.listVersions ?? (() => listInstalledVersions('claude'));
  const versionHome = opts?.versionHome ?? ((v: string) => getVersionHomePath('claude', v));
  const accountEmail = opts?.accountEmail ?? (async (home: string) => (await getAccountInfo('claude', home)).email);

  const tryRead = (svc: string): string | null => {
    try {
      const raw = readItem(svc).trim();
      return isClaudeCredentialsBlob(raw) ? raw : null;
    } catch {
      return null;
    }
  };

  if (process.platform === 'darwin') {
    // 1) Bare service — the default native (non-managed) install.
    const bare = tryRead(service(undefined));
    if (bare) {
      if (!opts?.preferEmail) return bare;
      // preferEmail is set — verify the bare service belongs to the right account
      // before handing it back; on mismatch fall through to managed installs.
      const realHome = process.env.AGENTS_REAL_HOME || os.homedir();
      const bareEmail = await accountEmail(realHome).catch(() => null);
      if (bareEmail === opts.preferEmail) return bare;
      // email mismatch — fall through
    }

    // 2) Managed installs — hash-suffixed service keyed to each version home.
    //    Prefer the version whose account email matches the copied config.
    let homes: string[];
    try {
      homes = listVersions().map(versionHome);
    } catch {
      homes = [];
    }
    if (opts?.preferEmail) {
      const scored = await Promise.all(
        homes.map(async (home) => ({ home, match: (await accountEmail(home).catch(() => null)) === opts.preferEmail })),
      );
      homes = [...scored.filter((s) => s.match), ...scored.filter((s) => !s.match)].map((s) => s.home);
    }
    for (const home of homes) {
      const hit = tryRead(service(home));
      if (hit) return hit;
    }
    return null;
  }

  // Off darwin: the local Claude CLI stores the wrapped rotating blob on disk.
  // Read it directly so a file-based setup-token (Rush Cloud dispatch) is not
  // mistaken for a native OAuth login that SING-1b must refuse to copy.
  const home = process.env.AGENTS_REAL_HOME || os.homedir();
  const credsPath = path.join(home, '.claude', '.credentials.json');
  try {
    if (fs.existsSync(credsPath)) {
      const raw = fs.readFileSync(credsPath, 'utf-8').trim();
      if (raw && isClaudeCredentialsBlob(raw)) return raw;
    }
  } catch {
    /* no readable credentials file */
  }
  return null;
}

/**
 * The credential-provisioning snippet for a `--lease` box.
 *
 * Every runtime this could serialize is a native OAuth / session login
 * (`LEASE_RUNTIMES`), and SING-1b forbids copying one to another device —
 * including an ephemeral leased box, whose refresh of a shared rotating token
 * invalidates every other holder. So this no longer writes a login: it REFUSES
 * (throws, steering to the portable `agents accounts` path) whenever a picked
 * runtime actually has a native credential to copy — signed in locally
 * (`credPath`), or a Claude OAuth blob supplied. A picked runtime with nothing to
 * copy is simply skipped, so `buildCredentialScript` returns `''` (a no-op box
 * bootstrap) rather than throwing on a not-signed-in runtime.
 */
/**
 * The native OAuth runtimes among `picked` that actually have a credential to copy
 * — signed in locally (`credPath`) or a Claude OAuth blob supplied — i.e. the ones
 * a transfer would leak. A picked runtime with nothing to copy is not refused.
 */
export function refusedNativeOAuthRuntimes(
  picked: AgentId[],
  detected: DetectedRuntime[],
  extras?: { claudeCredentialsJson?: string | null },
): AgentId[] {
  const byId = new Map(detected.map((d) => [d.id, d]));
  return picked.filter((id) => {
    if (!isNativeOAuthRuntime(id)) return false;
    const hasLocalFile = !!byId.get(id)?.credPath && LEASE_RUNTIMES.some((c) => c.id === id);
    const hasClaudeToken = id === 'claude' && !!extras?.claudeCredentialsJson;
    return hasLocalFile || hasClaudeToken;
  });
}

/**
 * Throw the SING-1b refusal if any picked runtime would transfer a native OAuth
 * login. Callers should invoke this at a FAIL-FAST point — before any expensive or
 * costly side effect (e.g. before `crabboxWarmup` leases a paid box) — so a refused
 * `--lease` never leaks infra, mirroring how `--copy-creds` refuses before it opens
 * an SSH connection.
 */
export function assertNoNativeOAuthTransfer(
  picked: AgentId[],
  detected: DetectedRuntime[],
  extras?: { claudeCredentialsJson?: string | null },
): void {
  const refused = refusedNativeOAuthRuntimes(picked, detected, extras);
  if (refused.length > 0) {
    throw new Error(nativeOAuthTransferRefusal(refused));
  }
}

export function buildCredentialScript(
  picked: AgentId[],
  detected: DetectedRuntime[],
  extras?: { claudeCredentialsJson?: string | null },
): string {
  assertNoNativeOAuthTransfer(picked, detected, extras);
  // Past the refusal there is nothing to serialize — every runtime this handles is
  // native OAuth, so a non-refused set has no credential to copy. (Always '' today;
  // the shape stays general in case a non-native runtime is ever added.)
  return '';
}
