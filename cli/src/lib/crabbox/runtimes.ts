
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { AgentId } from '../types.js';
import { getAccountInfo } from '../agents.js';

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

export function isNativeOAuthRuntime(id: AgentId): boolean {
  return NATIVE_OAUTH_RUNTIMES.has(id);
}

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
  credPath: string | null;
}

function findLocalCred(cred: RuntimeCred): string | null {
  const home = process.env.AGENTS_REAL_HOME || os.homedir();
  for (const rel of cred.localCandidates) {
    const p = path.join(home, rel);
    try {
      if (fs.existsSync(p)) return p;
    } catch {
    }
  }
  return null;
}

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

export function inferLeaseRuntime(agentName: string, detected: DetectedRuntime[]): AgentId | null {
  const signedIn = detected.filter((d) => d.signedIn && d.credPath);
  if (LEASE_RUNTIMES.some((c) => c.id === agentName)) {
    return signedIn.find((d) => d.id === agentName)?.id ?? null;
  }
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

export function profileNeedsBaseRuntimeCredentials(agent: AgentId, env: Record<string, string>, authEnvVar?: string): boolean {
  if (!LEASE_RUNTIMES.some((c) => c.id === agent)) return false;
  if (authEnvVar && typeof env[authEnvVar] === 'string' && env[authEnvVar].trim() !== '') return false;
  const keys = PROFILE_AUTH_ENV_KEYS_BY_RUNTIME[agent] ?? [];
  return !keys.some((key) => typeof env[key] === 'string' && env[key].trim() !== '');
}

const CRED_EOF = 'AGENTS_LEASE_CRED_EOF_9f3c1a7b5e2d4068';

export function buildHomeFileWriteScript(remote: string, contents: string): string {
  const dir = path.posix.dirname(remote);
  const mkdir = dir && dir !== '.' ? `mkdir -p "$HOME/${dir}"\n` : '';
  return (
    `${mkdir}cat > "$HOME/${remote}" <<'${CRED_EOF}'\n${contents}${contents.endsWith('\n') ? '' : '\n'}${CRED_EOF}\n` +
    `chmod 600 "$HOME/${remote}"`
  );
}

export const CLAUDE_TOKEN_REMOTE = '.claude/.credentials.json';

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

export function assertNoNativeOAuthTransfer(
  picked: AgentId[],
  detected: DetectedRuntime[],
  extras?: { claudeCredentialsJson?: string | null },
): void {
  // Reject native OAuth before leasing a paid box; only durable worker credentials transfer.
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
  return '';
}
