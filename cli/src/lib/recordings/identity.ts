import { invocation, resolveArtifactsBin } from '../artifacts-client.js';
import { processFailure, runProcess } from './process.js';

const PUBLIC_INBOX_DOMAINS = new Set([
  'aol.com', 'fastmail.com', 'gmail.com', 'googlemail.com', 'hey.com', 'hotmail.com',
  'icloud.com', 'live.com', 'mac.com', 'mail.com', 'me.com', 'msn.com', 'outlook.com',
  'pm.me', 'proton.me', 'protonmail.com', 'rocketmail.com', 'yahoo.com', 'ymail.com',
  'zoho.com', 'gmx.com', 'gmx.net',
]);

export type RecordingIdentityErrorCode = 'AUTH_REQUIRED' | 'PUBLIC_INBOX' | 'AUTH_UNAVAILABLE';

export class RecordingIdentityError extends Error {
  constructor(readonly code: RecordingIdentityErrorCode, message: string) {
    super(message);
    this.name = 'RecordingIdentityError';
  }
}

export function isPublicInboxEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split('@').at(-1) ?? '';
  return PUBLIC_INBOX_DOMAINS.has(domain);
}

function readIdentity(value: unknown): { signedIn: boolean; email?: string } {
  if (!value || typeof value !== 'object') return { signedIn: false };
  const record = value as Record<string, unknown>;
  const me = record.me && typeof record.me === 'object' ? record.me as Record<string, unknown> : record;
  return {
    signedIn: record.signedIn === true || typeof me.email === 'string',
    email: typeof me.email === 'string' ? me.email : undefined,
  };
}

export async function verifyOrganizationIdentity(
  signal?: AbortSignal,
  options: { artifactsBin?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ email: string }> {
  const bin = options.artifactsBin ?? resolveArtifactsBin();
  const launch = invocation(bin);
  const args = [...launch.prefix, 'auth', 'whoami', '--json'];
  const result = await runProcess(launch.command, args, { signal, env: options.env, timeoutMs: 15_000 });
  if (result.exitCode !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`;
    if (result.exitCode === 401 || /\b401\b|sign(?:ed)?[ -]?out|not signed in|unauthori[sz]ed/i.test(detail)) {
      throw new RecordingIdentityError('AUTH_REQUIRED', 'Artifacts authentication expired. Run `artifacts auth login`; recordings remain queued.');
    }
    throw new RecordingIdentityError('AUTH_UNAVAILABLE', processFailure('artifacts', args, result).message);
  }
  let identity: { signedIn: boolean; email?: string };
  try {
    identity = readIdentity(JSON.parse(result.stdout));
  } catch {
    throw new RecordingIdentityError('AUTH_UNAVAILABLE', 'artifacts auth whoami returned invalid JSON.');
  }
  if (!identity.signedIn || !identity.email) {
    throw new RecordingIdentityError('AUTH_REQUIRED', 'Artifacts is not signed in. Run `artifacts auth login`; recordings remain queued.');
  }
  if (isPublicInboxEmail(identity.email)) {
    throw new RecordingIdentityError(
      'PUBLIC_INBOX',
      `Refusing org recording uploads for public-inbox identity ${identity.email}. Sign in with an organization email.`,
    );
  }
  return { email: identity.email };
}
