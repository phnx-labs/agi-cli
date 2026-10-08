
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
  avatar_url?: string;
  name?: string;
  tokenKind?: 'session' | 'device';
  scopes?: string[];
  device?: string | null;
}

export type DevicePoll =
  | {
      status: 'authorized';
      access_token: string;
      user: {
        email: string;
        id: string;
        avatar_url?: string;
        picture?: string;
        name?: string;
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

export type DeviceTokenScope = 'notify';

export interface MintedDeviceToken {
  id: string;
  token: string;
  kind: 'device';
  device: string;
  scopes: DeviceTokenScope[];
  createdAt: string;
}

export interface ApiTokenSummary {
  id: string;
  kind: 'session' | 'device';
  device: string | null;
  scopes: string[];
  createdAt: string;
}

export const mintDeviceToken = (device: string, scopes: DeviceTokenScope[]): Promise<MintedDeviceToken> =>
  phoenixRequest<MintedDeviceToken>('POST', '/api/v1/auth/tokens', { body: { device, scopes } });

export const listApiTokens = (): Promise<ApiTokenSummary[]> =>
  phoenixRequest<ApiTokenSummary[]>('GET', '/api/v1/auth/tokens');

export const revokeApiToken = (id: string): Promise<void> =>
  phoenixRequest<void>('DELETE', `/api/v1/auth/tokens/${encodeURIComponent(id)}`);

export async function refreshSessionProfile(known?: WhoAmI): Promise<void> {
  const session = readSession();
  if (!session) return;
  if (!known && session.avatarUrl) return;
  try {
    const me = known ?? (await fetchWhoAmI());
    const current = readSession();
    if (!current || current.access_token !== session.access_token || current.userId !== session.userId) return;
    const hosted = me.avatar_url?.trim();
    const avatarUrl = hosted && /^https:\/\//i.test(hosted) ? hosted : current.avatarUrl;
    const name = me.name?.trim() || current.name;
    if (avatarUrl !== current.avatarUrl || name !== current.name) {
      writeSession({ ...current, ...(avatarUrl ? { avatarUrl } : {}), ...(name ? { name } : {}) });
    }
  } catch {
  }
}


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


export interface Subscription {
  tierName?: string;
  [key: string]: unknown;
}

export const fetchSubscription = (agent = 'agents-cli'): Promise<Subscription> =>
  phoenixRequest<Subscription>(
    'GET',
    `/api/v1/billing/subscription?agent=${encodeURIComponent(agent)}`,
  );


export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

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

export function resolveMemberFromList(members: SpaceMember[], ref: string): SpaceMember | null {
  const needle = ref.trim().toLowerCase();
  return (
    members.find((m) => m.user_id === ref) ??
    members.find((m) => m.email.toLowerCase() === needle) ??
    null
  );
}

export type { PhoenixSession as Session };
