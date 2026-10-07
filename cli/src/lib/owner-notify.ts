/**
 * The only path that reaches the owner (PHNX-4267). Every owner notification is
 * one authenticated call to rush/api, which owns the preferences, quiet hours,
 * dedup and delivery. Email and Slack go out server-side; iMessage is queued as
 * a device delivery that a signed-in Mac claims (owner-device-delivery service).
 *
 * The bearer is this box's Phoenix session, else the scoped device token a
 * headed box minted and pushed into this worker's reserved store. Neither means
 * the owner is unreachable from here: that is an error, never a local fallback.
 */
import { readSession } from './identity/client.js';
import { readReservedCredential } from './claude-account-token.js';
import { machineId, normalizeHost } from './machine-id.js';
import { OWNER_NOTIFY_TOKEN_KEY, ownerNotifyStoreName } from './reserved-stores.js';
import { RUSH_API_BASE } from './rush-api.js';

export const OWNER_EVENTS = ['needs_you', 'completed', 'failed', 'spend_threshold', 'message'] as const;
export type OwnerEvent = (typeof OWNER_EVENTS)[number];

export type OwnerChannel = 'email' | 'slack' | 'imessage';

export interface OwnerNotification {
  event: OwnerEvent;
  title: string;
  body: string;
  url?: string;
  sessionId?: string;
  ticket?: string;
  dedupKey: string;
  source?: { device?: string; agent?: string };
}

export interface OwnerNotifyResult {
  dispatchId: string | null;
  delivered: OwnerChannel[];
  queued: OwnerChannel[];
  skipped: Array<{ channel: OwnerChannel; reason: string }>;
  suppressed: null | 'duplicate' | 'quiet_hours';
}

export interface DeviceDelivery {
  id: string;
  channel: 'imessage';
  address: string;
  body: string;
  createdAt: string;
}

export interface OwnerPreferencesPatch {
  preferences?: Array<{ event: OwnerEvent; channel: OwnerChannel; enabled: boolean }>;
  settings?: { timezone?: string; quietStart?: string | null; quietEnd?: string | null };
  destinations?: { imessage?: { address: string } | null };
}

export class OwnerNotSignedInError extends Error {
  readonly code = 'OWNER_NOT_SIGNED_IN';
  constructor() {
    super("This box cannot reach the owner: no Phoenix session and no device token. Run 'agents auth login' (a worker receives its device token from a signed-in personal device).");
    this.name = 'OwnerNotSignedInError';
  }
}

export class OwnerNotifyApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'OwnerNotifyApiError';
  }
}

export interface OwnerCredential {
  kind: 'session' | 'device';
  token: string;
}

export function selfDeviceName(): string {
  return normalizeHost(machineId());
}

export function resolveOwnerCredential(): OwnerCredential | null {
  const session = readSession()?.access_token?.trim();
  if (session) return { kind: 'session', token: session };
  const device = readReservedCredential(ownerNotifyStoreName(selfDeviceName()), OWNER_NOTIFY_TOKEN_KEY);
  return device ? { kind: 'device', token: device } : null;
}

function requireOwnerCredential(): OwnerCredential {
  const credential = resolveOwnerCredential();
  if (!credential) throw new OwnerNotSignedInError();
  return credential;
}

async function rushRequest<T>(method: 'POST' | 'PUT', route: string, body: unknown): Promise<T> {
  const credential = requireOwnerCredential();
  let response: Response;
  try {
    response = await fetch(`${RUSH_API_BASE}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new OwnerNotifyApiError(`Could not reach ${RUSH_API_BASE} (${(err as Error).message}).`, 0);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let payload: unknown = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) {
    const fields = payload && typeof payload === 'object' ? payload as { error?: unknown; code?: unknown } : {};
    const detail = typeof fields.error === 'string' ? fields.error : `${response.status} ${response.statusText}`;
    const code = typeof fields.code === 'string' ? fields.code : undefined;
    const hint = response.status === 401
      ? (credential.kind === 'session'
          ? " Run 'agents auth login'."
          : ' The device token was rejected; a signed-in personal device re-mints it on its next auth-sync tick.')
      : '';
    throw new OwnerNotifyApiError(`rush/api ${route}: ${detail}.${hint}`, response.status, code);
  }
  return payload as T;
}

export function postOwnerNotification(notification: OwnerNotification): Promise<OwnerNotifyResult> {
  return rushRequest<OwnerNotifyResult>('POST', '/me/notifications', notification);
}

export async function claimDeviceDeliveries(device: string, limit = 10): Promise<DeviceDelivery[]> {
  const out = await rushRequest<{ deliveries: DeviceDelivery[] }>('POST', '/me/device-deliveries/claim', { device, limit });
  return out.deliveries;
}

export async function reportDeviceDelivery(id: string, result: { ok: boolean; error?: string }): Promise<void> {
  await rushRequest<void>('POST', `/me/device-deliveries/${encodeURIComponent(id)}/result`, result);
}

export async function putOwnerPreferences(patch: OwnerPreferencesPatch): Promise<void> {
  await rushRequest<unknown>('PUT', '/me/preferences', patch);
}

export function describeOwnerResult(result: OwnerNotifyResult): string {
  if (result.suppressed === 'duplicate') return 'suppressed: already sent';
  if (result.suppressed === 'quiet_hours') return 'suppressed: quiet hours';
  const parts: string[] = [];
  if (result.delivered.length) parts.push(`delivered ${result.delivered.join(', ')}`);
  if (result.queued.length) parts.push(`queued ${result.queued.join(', ')}`);
  for (const s of result.skipped) parts.push(`skipped ${s.channel} (${s.reason})`);
  return parts.join('; ') || 'no channel enabled for this event';
}
