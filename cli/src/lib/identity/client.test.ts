import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';


const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-identity-'));
process.env.AGENTS_STATE_DIR = path.join(HOME, 'state');
process.env.HOME = HOME;

let server: http.Server;
let base: string;
let queue: Array<{ status: number; body: unknown; onRequest?: () => void }> = [];
let received: Array<{ method: string; url: string; auth: string | undefined; body: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body });
      const next = queue.shift() ?? { status: 200, body: { ok: true } };
      next.onRequest?.();
      res.writeHead(next.status, { 'Content-Type': 'application/json' });
      res.end(next.body === undefined ? '' : JSON.stringify(next.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  process.env.PHOENIX_ID_BASE = base;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(HOME, { recursive: true, force: true });
});

beforeEach(() => {
  queue = [];
  received = [];
});

async function identity() {
  return import('./index.js');
}

describe('the identity seam', () => {
  it('pins the shipped production default to the branded Phoenix ID host (PHNX-3543)', async () => {
    const { DEFAULT_PHOENIX_ID_BASE } = await import('./client.js');
    expect(DEFAULT_PHOENIX_ID_BASE).toBe('https://id.byphoenix.com');
  });

  it('sends the stored session token, and only that token', async () => {
    const { writeSession, fetchWhoAmI } = await identity();
    writeSession({ access_token: 'pid_test_token', email: 'a@b.test' });
    queue.push({ status: 200, body: { userId: 'u1', email: 'a@b.test', valid: true } });

    const me = await fetchWhoAmI();

    expect(me.email).toBe('a@b.test');
    expect(received[0]?.auth).toBe('Bearer pid_test_token');
    expect(received[0]?.url).toBe('/api/v1/auth/me');
  });

  it('refuses to call an authenticated route when signed out, instead of sending nothing', async () => {
    const { clearSession, listSpaces, PhoenixApiError } = await identity();
    clearSession();

    await expect(listSpaces()).rejects.toThrowError(PhoenixApiError);
    await expect(listSpaces()).rejects.toThrow(/Not signed in/);
    expect(received).toHaveLength(0);
  });

  it('starts the device flow without a token', async () => {
    const { clearSession, startDeviceAuthorization } = await identity();
    clearSession();
    queue.push({
      status: 200,
      body: {
        device_code: 'dc', user_code: 'ABCD-2345',
        verification_uri: `${base}/device`, verification_uri_complete: `${base}/device?code=ABCD-2345`,
        expires_in: 900, interval: 5,
      },
    });

    const grant = await startDeviceAuthorization();

    expect(grant.user_code).toBe('ABCD-2345');
    expect(received[0]?.auth).toBeUndefined();
  });

  it('decodes every RFC 8628 poll state the server signals through the error body', async () => {
    const { pollDeviceToken } = await identity();
    const cases: Array<[number, string, string]> = [
      [428, 'authorization_pending', 'pending'],
      [429, 'slow_down', 'slow_down'],
      [400, 'expired_token', 'expired'],
      [400, 'access_denied', 'denied'],
    ];
    for (const [status, serverError, expected] of cases) {
      queue.push({ status, body: { error: serverError } });
      const poll = await pollDeviceToken('dc');
      expect(poll.status).toBe(expected);
    }
    queue.push({ status: 200, body: { status: 'authorized', access_token: 'pid_x', user: { email: 'a@b.test', id: 'u1' } } });
    const ok = await pollDeviceToken('dc');
    expect(ok).toEqual({ status: 'authorized', access_token: 'pid_x', user: { email: 'a@b.test', id: 'u1' } });
  });

  it('surfaces a server error message rather than a bare status', async () => {
    const { writeSession, createSpace, PhoenixApiError } = await identity();
    writeSession({ access_token: 'pid_test_token' });
    queue.push({ status: 403, body: { error: 'free tier allows 1 owned space' } });

    await expect(createSpace({ name: 'Second', slug: 'second' })).rejects.toThrow(/free tier allows 1 owned space/);
    queue.push({ status: 403, body: { error: 'free tier allows 1 owned space' } });
    await expect(createSpace({ name: 'Second', slug: 'second' })).rejects.toMatchObject({ status: 403 });
    expect(PhoenixApiError).toBeDefined();
  });

  it('writes the session private to the user', async () => {
    const { writeSession, sessionFilePath } = await identity();
    writeSession({ access_token: 'pid_secret' });
    const mode = fs.statSync(sessionFilePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('never reads another product\'s credential file', async () => {
    const { clearSession, readSession } = await identity();
    clearSession();
    fs.mkdirSync(path.join(HOME, '.rush'), { recursive: true });
    fs.writeFileSync(path.join(HOME, '.rush', 'user.yaml'), 'session:\n  access_token: rush-token\n');
    expect(readSession()).toBeNull();
  });

  it('refreshSessionProfile merges a hosted avatar_url into the session and leaves everything else alone (PHNX-3547)', async () => {
    const { writeSession, readSession, refreshSessionProfile } = await identity();
    writeSession({ access_token: 'pid_alice', userId: 'alice-1', email: 'alice@example.com' });
    queue.push({
      status: 200,
      body: { userId: 'alice-1', email: 'alice@example.com', valid: true, avatar_url: 'https://cdn.id.example/a.png' },
    });

    await refreshSessionProfile();

    expect(readSession()).toEqual({
      access_token: 'pid_alice',
      userId: 'alice-1',
      email: 'alice@example.com',
      avatarUrl: 'https://cdn.id.example/a.png',
    });
  });

  it('refreshSessionProfile(known) applies an already-fetched /auth/me without a network call, including a changed picture', async () => {
    const { writeSession, readSession, refreshSessionProfile } = await identity();
    writeSession({ access_token: 'pid_alice', userId: 'alice-1', email: 'alice@example.com', avatarUrl: 'https://cdn.id.example/old.png' });
    await refreshSessionProfile({ userId: 'alice-1', email: 'alice@example.com', valid: true, avatar_url: 'https://cdn.id.example/new.png' });
    expect(received).toHaveLength(0);
    expect(readSession()?.avatarUrl).toBe('https://cdn.id.example/new.png');
    await refreshSessionProfile({ userId: 'alice-1', email: 'alice@example.com', valid: true, avatar_url: 'http://insecure/x.png' });
    await refreshSessionProfile({ userId: 'alice-1', email: 'alice@example.com', valid: true });
    expect(readSession()?.avatarUrl).toBe('https://cdn.id.example/new.png');
    await refreshSessionProfile({ userId: 'alice-1', email: 'alice@example.com', valid: true, name: 'Alice Liddell' });
    await refreshSessionProfile({ userId: 'alice-1', email: 'alice@example.com', valid: true, name: ' ' });
    expect(readSession()).toMatchObject({ name: 'Alice Liddell', avatarUrl: 'https://cdn.id.example/new.png' });
  });

  it('refreshSessionProfile is a no-op when signed out, already carrying an avatar, or the server exposes none', async () => {
    const { clearSession, writeSession, readSession, refreshSessionProfile } = await identity();
    clearSession();
    await refreshSessionProfile();
    expect(received).toHaveLength(0);

    writeSession({ access_token: 'pid_alice', userId: 'alice-1', email: 'alice@example.com', avatarUrl: 'https://x/a.png' });
    await refreshSessionProfile();
    expect(received).toHaveLength(0);

    writeSession({ access_token: 'pid_alice', userId: 'alice-1', email: 'alice@example.com' });
    queue.push({ status: 200, body: { userId: 'alice-1', email: 'alice@example.com', valid: true } });
    await refreshSessionProfile();
    expect(readSession()).toEqual({ access_token: 'pid_alice', userId: 'alice-1', email: 'alice@example.com' });

    queue.push({ status: 500, body: { error: 'boom' } });
    await refreshSessionProfile();
    expect(readSession()).toEqual({ access_token: 'pid_alice', userId: 'alice-1', email: 'alice@example.com' });
  });

  it('refreshSessionProfile never lands a profile on a session that changed during the fetch', async () => {
    const { writeSession, clearSession, readSession, refreshSessionProfile } = await identity();
    const alice = { userId: 'alice-1', email: 'alice@example.com', valid: true, name: 'Alice', avatar_url: 'https://cdn.id.example/a.png' };

    writeSession({ access_token: 'pid_alice', userId: 'alice-1', email: 'alice@example.com' });
    const bob = { access_token: 'pid_bob', userId: 'bob-2', email: 'bob@example.com' };
    queue.push({ status: 200, body: alice, onRequest: () => writeSession(bob) });
    await refreshSessionProfile();
    expect(readSession()).toEqual(bob);

    writeSession({ access_token: 'pid_alice', userId: 'alice-1', email: 'alice@example.com' });
    queue.push({ status: 200, body: alice, onRequest: () => clearSession() });
    await refreshSessionProfile();
    expect(readSession()).toBeNull();

    writeSession({ access_token: 'pid_alice', userId: 'alice-1', email: 'alice@example.com' });
    queue.push({
      status: 200,
      body: alice,
      onRequest: () => writeSession({ access_token: 'pid_alice', userId: 'alice-1', email: 'alice@example.com', expires_at: 42 }),
    });
    await refreshSessionProfile();
    expect(readSession()).toEqual({
      access_token: 'pid_alice', userId: 'alice-1', email: 'alice@example.com', expires_at: 42,
      name: 'Alice', avatarUrl: 'https://cdn.id.example/a.png',
    });
  });

  it('writeSession replaces the file by rename and leaves it 0600, even over a 0644 file', async () => {
    if (process.platform === 'win32') return;
    const { writeSession, readSession, sessionFilePath } = await import('./client.js');
    const file = sessionFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"access_token":"old"}', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    const before = fs.statSync(file).ino;

    writeSession({ access_token: 'pid_new', email: 'n@example.com' });

    const after = fs.statSync(file);
    expect(after.mode & 0o777).toBe(0o600);
    expect(after.ino).not.toBe(before);
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp-'))).toEqual([]);
    expect(readSession()?.access_token).toBe('pid_new');
  });
});
