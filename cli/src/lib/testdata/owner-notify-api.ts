import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

const EVENTS = new Set(['needs_you', 'completed', 'failed', 'spend_threshold', 'message']);

export interface RecordedRequest {
  method: string;
  path: string;
  bearer: string | null;
  body: unknown;
}

interface DeviceToken {
  id: string;
  token: string;
  device: string;
  createdAt: string;
}

interface Delivery {
  id: string;
  address: string;
  body: string;
  createdAt: string;
  claimedBy?: string;
  result?: { ok: boolean; error?: string };
}

export interface OwnerNotifyApi {
  url: string;
  requests: RecordedRequest[];
  sessionToken: string;
  deviceTokens: DeviceToken[];
  deliveries: Delivery[];
  /** The dedupKey of every accepted-shape POST /me/notifications, exactly as received. */
  dedupKeys: string[];
  imessageAddress: string | null;
  preferencesStatus: number;
  close(): Promise<void>;
}

function send(res: http.ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

export async function startOwnerNotifyApi(sessionToken = 'phx-session-token'): Promise<OwnerNotifyApi> {
  let seq = 0;
  const seen = new Set<string>();
  const api: OwnerNotifyApi = {
    url: '',
    requests: [],
    sessionToken,
    deviceTokens: [],
    deliveries: [],
    dedupKeys: [],
    imessageAddress: '+15555550100',
    preferencesStatus: 200,
    close: async () => {},
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf-8'); });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fixture');
      const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? null;
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : null;
      api.requests.push({ method: req.method ?? '', path: url.pathname, bearer, body });

      const device = api.deviceTokens.find((t) => t.token === bearer);
      const isSession = bearer === api.sessionToken;
      if (!isSession && !device) return send(res, 401, { error: 'Unauthorized', code: 'UNAUTHORIZED' });

      const tokenId = url.pathname.match(/^\/api\/v1\/auth\/tokens\/([^/]+)$/);
      if (tokenId && req.method === 'DELETE') {
        if (!isSession) return send(res, 403, { error: 'device_token_forbidden' });
        const before = api.deviceTokens.length;
        api.deviceTokens = api.deviceTokens.filter((t) => t.id !== decodeURIComponent(tokenId[1]));
        return send(res, before === api.deviceTokens.length ? 404 : 204);
      }

      if (url.pathname === '/api/v1/auth/tokens') {
        if (!isSession) return send(res, 403, { error: 'device_token_forbidden' });
        if (req.method === 'GET') {
          return send(res, 200, api.deviceTokens.map((t) => ({ id: t.id, kind: 'device', device: t.device, scopes: ['notify'], createdAt: t.createdAt })));
        }
        const name = String(body?.device);
        api.deviceTokens = api.deviceTokens.filter((t) => t.device !== name);
        const minted = { id: `tok-${++seq}`, token: `phx-device-${name}-${seq}`, device: name, createdAt: new Date().toISOString() };
        api.deviceTokens.push(minted);
        return send(res, 201, { id: minted.id, token: minted.token, kind: 'device', device: name, scopes: ['notify'], createdAt: minted.createdAt });
      }

      if (url.pathname === '/me/preferences' && req.method === 'PUT') {
        if (!isSession) return send(res, 403, { error: 'device_token_scope', code: 'DEVICE_TOKEN_SCOPE' });
        return api.preferencesStatus === 200
          ? send(res, 200, { ok: true })
          : send(res, api.preferencesStatus, { error: 'unknown event: message', code: 'INVALID_EVENT' });
      }

      if (url.pathname === '/me/notifications' && req.method === 'POST') {
        if (!body || !EVENTS.has(String(body.event)) || typeof body.title !== 'string' || typeof body.body !== 'string' || typeof body.dedupKey !== 'string') {
          return send(res, 400, { error: 'invalid notification', code: 'INVALID_BODY' });
        }
        api.dedupKeys.push(body.dedupKey);
        const key = `${body.event}\0${body.dedupKey}`;
        if (seen.has(key)) return send(res, 200, { dispatchId: null, delivered: [], queued: [], skipped: [], suppressed: 'duplicate' });
        seen.add(key);
        const queued = api.imessageAddress ? ['imessage'] : [];
        if (api.imessageAddress) {
          api.deliveries.push({ id: `dlv-${++seq}`, address: api.imessageAddress, body: String(body.body), createdAt: new Date().toISOString() });
        }
        return send(res, 200, {
          dispatchId: `dsp-${++seq}`,
          delivered: ['slack'],
          queued,
          skipped: api.imessageAddress ? [] : [{ channel: 'imessage', reason: 'no imessage destination' }],
          suppressed: null,
        });
      }

      if (url.pathname === '/me/device-deliveries/claim' && req.method === 'POST') {
        const claimed = api.deliveries.filter((d) => !d.claimedBy && !d.result).slice(0, Number(body?.limit ?? 10));
        for (const d of claimed) d.claimedBy = String(body?.device);
        return send(res, 200, { deliveries: claimed.map((d) => ({ id: d.id, channel: 'imessage', address: d.address, body: d.body, createdAt: d.createdAt })) });
      }

      const result = url.pathname.match(/^\/me\/device-deliveries\/([^/]+)\/result$/);
      if (result && req.method === 'POST') {
        const delivery = api.deliveries.find((d) => d.id === decodeURIComponent(result[1]));
        if (!delivery) return send(res, 404, { error: 'not found' });
        delivery.result = { ok: Boolean(body?.ok), ...(typeof body?.error === 'string' ? { error: body.error } : {}) };
        return send(res, 204);
      }

      return send(res, 404, { error: `no route ${req.method} ${url.pathname}` });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  api.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  api.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return api;
}
