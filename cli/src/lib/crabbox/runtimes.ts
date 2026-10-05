/** Runtime detection, picker and credential-script builder for `agents run --lease`. SECURITY:
 * copying a token to a cloud box is a credential transfer: opt-in via confirm prompt, contents
 * ride the `--script-stdin` body never argv/`ps`, and one-shot runs tear the box down. */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { AgentId } from '../types.js';
import { getAccountInfo } from '../agents.js';
import { getKeychainTokenSync } from '../secrets-client.js';
import { getClaudeKeychainService } from '../accounting/usage.js';
import { listInstalledVersions, getVersionHomePath } from '../installations/versions.js';

/** Credential file locations per runtime: `localCandidates` read in order (first existing wins);
 * `remote` is where the box's CLI reads it. Source of truth is `getAccountInfo` in
 * src/lib/agents.ts; keep in sync. */
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

/** Every runtime `LEASE_RUNTIMES` can serialize is a native rotating OAuth credential; SING-1b
 * forbids copying any between devices, even to an ephemeral box (a shared refresh token kills
 * other copies). Derived from LEASE_RUNTIMES; `--copy-creds` and `--lease` both refuse on it. */
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

/** Interactive checkbox of runtimes to provision, defaulting to signed-in ones; those with no local
 * credential are disabled. `prompt` is injected so tests need no TTY. */
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

/** The lease runtime for a headless run of `agentName`: the agent itself if lease-capable
 * (claude/codex/gemini/grok), else the single signed-in runtime (preferring claude), else null.
 * Never blocks on a TTY (`--lease` needs a prompt). Profile agents resolve separately (RUSH-1725). */
export function inferLeaseRuntime(agentName: string, detected: DetectedRuntime[]): AgentId | null {
  const signedIn = detected.filter((d) => d.signedIn && d.credPath);
  // The agent names a lease runtime directly: require it to be signed in and never substitute
  // another (that would lease a billable box only to boot it "Not logged in"). Not signed in
  // returns null.
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

/** Where Claude Code reads its OAuth token on the box. `.claude.json` is config/account metadata
 * only; without this file the box boots "Not logged in". */
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

/** Raw wrapped Claude credential (`{"claudeAiOauth":{...}}`) for the box's `.credentials.json`, or
 * null: macOS reads the Keychain silently (`getKeychainTokenSync`), else the local file. Never
 * share with Rush Cloud dispatch (email-only, SING-1b); the old blob reader leaked (RUSH-2359). */
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

/** The credential snippet for a `--lease` box. Every serializable runtime is a native OAuth login
 * and SING-1b forbids copying one, so this REFUSES (throws, steering to the portable `agents
 * accounts` path) when a picked runtime has a native credential to copy; otherwise `''`. */
/** The native OAuth runtimes among `picked` that actually have a credential to copy (signed in
 * locally or a Claude blob supplied), i.e. what a transfer would leak. */
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

/** Throw the SING-1b refusal if any picked runtime would transfer a native OAuth login. Call at a
 * fail-fast point, before any costly side effect like `crabboxWarmup`, as `--copy-creds` does
 * before SSH. */
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
