/**
 * Phoenix ID — the typed surface commands use. Every route the account backend
 * exposes is a function here; no command builds a URL or reads a token itself.
 */

import { phoenixRequest, PhoenixApiError, readSession, writeSession, type PhoenixSession } from './client.js';

export {
  PHOENIX_ID_BASE,
  PhoenixApiError,
  clearSession,
  readSession,
  sessionFilePath,
  writeSession,
  type PhoenixSession,
} from './client.js';

// ─── Auth ────────────────────────────────────────────────────────────────────

export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface WhoAmI {
  userId: string;
  email: string;
  valid: true;
  /** Hosted OAuth profile image, when Phoenix ID stores one for this user. */
  avatar_url?: string;
  /** Display name, when Phoenix ID stores one for this user. */
  name?: string;
}

/**
 * RFC 8628 poll outcomes. `pending` and `slow_down` are normal states of a
 * login in progress, not failures — the server signals them through the error
 * body, and this is where that wire detail stops.
 */
export type DevicePoll =
  | {
      status: 'authorized';
      access_token: string;
      user: {
        email: string;
        id: string;
        /** Hosted OAuth profile image, when the provider exposed one to Phoenix ID. */
        avatar_url?: string;
        /** Google-style alias some providers use for the same field. */
        picture?: string;
      };
    }
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'expired' }
  | { status: 'denied' };

export function startDeviceAuthorization(): Promise<DeviceAuthorization> {
  return phoenixRequest<DeviceAuthorization>('POST', '/api/v1/auth/device/authorization', {
    auth: false,
    body: {},
  });
}

export async function pollDeviceToken(deviceCode: string): Promise<DevicePoll> {
  try {
    return await phoenixRequest<DevicePoll & { status: 'authorized' }>(
      'POST',
      '/api/v1/auth/device/token',
      {
        auth: false,
        body: {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
        },
      },
    );
  } catch (err) {
    if (!(err instanceof PhoenixApiError)) throw err;
    // The server encodes poll state in the error body (RFC 8628 §3.5).
    if (err.message.includes('authorization_pending')) return { status: 'pending' };
    if (err.message.includes('slow_down')) return { status: 'slow_down' };
    if (err.message.includes('expired_token')) return { status: 'expired' };
    if (err.message.includes('access_denied')) return { status: 'denied' };
    throw err;
  }
}

export function fetchWhoAmI(token?: string): Promise<WhoAmI> {
  return phoenixRequest<WhoAmI>('GET', '/api/v1/auth/me', { token });
}

/**
 * Keep the session's profile current (PHNX-3547): merge the `avatar_url` and
 * `name` Phoenix ID reports on `/api/v1/auth/me` into the persisted session, so
 * the actor env, share attribution and the menu-bar snapshot can show the
 * person without a network call of their own. Pass `known` when the caller
 * already fetched `/auth/me` (whoami) — then a changed picture or name is
 * written too. Without it, a session that already carries a picture is left
 * alone rather than spending a network round trip to re-check it (the share
 * publish path). A no-op when signed out or when the server exposes neither;
 * network/server failures are swallowed (the Gravatar fallback covers
 * attribution either way).
 */
export async function refreshSessionProfile(known?: WhoAmI): Promise<void> {
  const session = readSession();
  if (!session) return;
  if (!known && session.avatarUrl) return;
  try {
    const me = known ?? (await fetchWhoAmI());
    const hosted = me.avatar_url?.trim();
    const avatarUrl = hosted && /^https:\/\//i.test(hosted) ? hosted : session.avatarUrl;
    const name = me.name?.trim() || session.name;
    if (avatarUrl !== session.avatarUrl || name !== session.name) {
      writeSession({ ...session, ...(avatarUrl ? { avatarUrl } : {}), ...(name ? { name } : {}) });
    }
  } catch {
    // Offline or server without the field — the Gravatar fallback covers it.
  }
}

// ─── Spaces ──────────────────────────────────────────────────────────────────

export interface SpaceSummary {
  id: string;
  slug: string;
  name: string;
  organization_id: string | null;
  owner_user_id: string;
  invite_code?: string;
  user_role: 'owner' | 'admin' | 'member';
  created_at: string;
}

export interface SpaceMember {
  user_id: string;
  email: string;
  name?: string;
  avatar_url?: string;
  role: 'owner' | 'admin' | 'member';
  joined_at: string;
}

export interface SpaceInvite {
  id: string;
  space_id: string;
  email: string;
  role: 'admin' | 'member';
  invite_code: string;
  created_at: string;
}

export type CreateInviteResult =
  | { invited: true; email: string; role: string; member_added: true }
  | { invited: true; email: string; role: string; invite_code: string; member_added: false };

export const listSpaces = (): Promise<SpaceSummary[]> =>
  phoenixRequest<SpaceSummary[]>('GET', '/api/v1/spaces');

export const createSpace = (input: { name: string; slug: string }): Promise<SpaceSummary> =>
  phoenixRequest<SpaceSummary>('POST', '/api/v1/spaces', { body: input });

export const getSpace = (id: string): Promise<SpaceSummary> =>
  phoenixRequest<SpaceSummary>('GET', `/api/v1/spaces/${encodeURIComponent(id)}`);

export const listSpaceMembers = (id: string): Promise<SpaceMember[]> =>
  phoenixRequest<SpaceMember[]>('GET', `/api/v1/spaces/${encodeURIComponent(id)}/members`);

export const createSpaceInvite = (
  id: string,
  input: { email: string; role: 'admin' | 'member' },
): Promise<CreateInviteResult> =>
  phoenixRequest<CreateInviteResult>('POST', `/api/v1/spaces/${encodeURIComponent(id)}/invites`, {
    body: input,
  });

export const listSpaceInvites = (id: string): Promise<SpaceInvite[]> =>
  phoenixRequest<SpaceInvite[]>('GET', `/api/v1/spaces/${encodeURIComponent(id)}/invites`);

export const revokeSpaceInvite = (id: string, inviteId: string): Promise<{ revoked: true }> =>
  phoenixRequest<{ revoked: true }>(
    'DELETE',
    `/api/v1/spaces/${encodeURIComponent(id)}/invites/${encodeURIComponent(inviteId)}`,
  );

export const updateSpaceMemberRole = (
  id: string,
  userId: string,
  role: 'admin' | 'member',
): Promise<{ user_id: string; role: string; updated: true }> =>
  phoenixRequest('PATCH', `/api/v1/spaces/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, {
    body: { role },
  });

export const removeSpaceMember = (id: string, userId: string): Promise<void> =>
  phoenixRequest<void>(
    'DELETE',
    `/api/v1/spaces/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
  );

export const deleteSpace = (id: string): Promise<void> =>
  phoenixRequest<void>('DELETE', `/api/v1/spaces/${encodeURIComponent(id)}`);

// ─── Billing ─────────────────────────────────────────────────────────────────

export interface Subscription {
  tierName?: string;
  [key: string]: unknown;
}

export const fetchSubscription = (agent = 'agents-cli'): Promise<Subscription> =>
  phoenixRequest<Subscription>(
    'GET',
    `/api/v1/billing/subscription?agent=${encodeURIComponent(agent)}`,
  );

// ─── Helpers shared by the commands ──────────────────────────────────────────

/** `Design Team` → `design-team`; the slug a space gets when the user gives only a name. */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

/** Resolve a space by id, slug, or name from a list the caller already fetched. */
export function resolveSpaceFromList(spaces: SpaceSummary[], ref?: string): SpaceSummary | null {
  if (!ref) return spaces.length === 1 ? spaces[0] : null;
  const needle = ref.trim().toLowerCase();
  return (
    spaces.find((s) => s.id === ref) ??
    spaces.find((s) => s.slug.toLowerCase() === needle) ??
    spaces.find((s) => s.name.toLowerCase() === needle) ??
    null
  );
}

/** Resolve a member by email or user id from a list the caller already fetched. */
export function resolveMemberFromList(members: SpaceMember[], ref: string): SpaceMember | null {
  const needle = ref.trim().toLowerCase();
  return (
    members.find((m) => m.user_id === ref) ??
    members.find((m) => m.email.toLowerCase() === needle) ??
    null
  );
}

export type { PhoenixSession as Session };
