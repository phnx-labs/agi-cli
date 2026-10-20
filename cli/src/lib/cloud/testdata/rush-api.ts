import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

const CREATE_FIELDS = new Set(['agent', 'input', 'model', 'effort', 'strategy', 'account_id', 'skills', 'connections', 'resources']);

export interface RecordedRequest {
  method: string;
  path: string;
  bearer: string | null;
  body: unknown;
}

export interface RushApi {
  url: string;
  apiKey: string;
  org: string;
  requests: RecordedRequest[];
  sessions: Map<string, Record<string, unknown>>;
  close(): Promise<void>;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function startRushApi(apiKey = 'rk_live_fixture', org = 'acme'): Promise<RushApi> {
  let seq = 0;
  const api: RushApi = { url: '', apiKey, org, requests: [], sessions: new Map(), close: async () => {} };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf-8'); });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fixture');
      const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? null;
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : null;
      api.requests.push({ method: req.method ?? '', path: url.pathname + url.search, bearer, body });

      if (bearer !== api.apiKey) return send(res, 401, { error: 'Authentication required', code: 'AUTH_FAILED' });
      const prefix = `/o/${api.org}/sessions`;
      if (!url.pathname.startsWith(prefix)) return send(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
      const [id, action] = url.pathname.slice(prefix.length).split('/').filter(Boolean);

      if (!id && req.method === 'POST') {
        const unknown = Object.keys(body ?? {}).find((k) => !CREATE_FIELDS.has(k));
        if (unknown) return send(res, 400, { error: `Unknown field: ${unknown}`, code: 'UNKNOWN_FIELD' });
        const execution_id = `7c1e9a4f-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
        const session = { execution_id, org_id: api.org, status: 'allocating', harness: body?.agent, created_at: '2026-10-19T00:00:00.000Z' };
        api.sessions.set(execution_id, { ...session, status: 'completed', result: 'ok', completed_at: '2026-10-19T00:01:00.000Z' });
        return send(res, 202, session);
      }
      if (!id) return send(res, 200, { sessions: [...api.sessions.values()].reverse() });

      const session = api.sessions.get(id);
      if (!session) return send(res, 404, { error: 'Execution not found', code: 'NOT_FOUND' });
      if (!action) return send(res, 200, session);
      if (action === 'cancel') {
        if (session.status === 'completed') return send(res, 409, { error: 'Cannot cancel: already completed', code: 'RUN_STATE_CONFLICT' });
        return send(res, 202, { ...session, status: 'cancelling' });
      }
      if (action === 'messages' && req.method === 'POST') return send(res, 202, { ...session, status: 'running' });
      if (action === 'messages') {
        return send(res, 200, {
          execution_id: id,
          events: [
            { type: 'message', role: 'user', content: 'reply with the word ok' },
            { type: 'tool_use', tool: 'Bash', args: { command: 'echo ok' }, call_id: 'c1' },
            { type: 'tool_result', tool: 'Bash', output: 'ok', success: true, call_id: 'c1' },
            { type: 'message', role: 'assistant', content: 'ok' },
          ],
        });
      }
      if (action === 'events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`event: status\ndata: {"status":"running"}\n\n: keepalive\n\nevent: message\ndata: {"role":"assistant","content":"ok"}\n\nevent: done\ndata: {"status":"completed","output":"runtime: guest harness completed","result":{"text":"ok","structured":null,"schema_valid":null}}\n\n`);
        return;
      }
      return send(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  api.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  api.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return api;
}
