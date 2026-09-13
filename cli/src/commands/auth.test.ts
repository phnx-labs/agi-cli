import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { Command } from 'commander';

/**
 * The `agents auth` command layer, driven against a REAL HTTP server standing in
 * for Phoenix ID (no mocked fetch, no mocked seam) — so these cover what the
 * seam-level tests cannot: the poll loop's branches, the signed-out paths, the
 * space resolution helpers, and that a user-actionable failure prints one clean
 * line rather than a Node stack dump.
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-auth-cmd-'));
process.env.AGENTS_STATE_DIR = path.join(HOME, 'state');
process.env.HOME = HOME;

let server: http.Server;
let queue: Array<{ status: number; body: unknown }> = [];
let received: Array<{ method: string; url: string; body: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', body });
      const next = queue.shift() ?? { status: 200, body: {} };
      res.writeHead(next.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  process.env.PHOENIX_ID_BASE = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(HOME, { recursive: true, force: true });
});

beforeEach(() => {
  queue = [];
  received = [];
});

/** Build the real command tree and run one invocation, capturing output + exit. */
async function run(...argv: string[]): Promise<{ out: string; err: string; exit: number | undefined }> {
  const { registerAuthCommand } = await import('./auth.js');
  const program = new Command();
  program.exitOverride();
  registerAuthCommand(program);

  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
  const error = vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')));
  let exit: number | undefined;
  const proc = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exit = code;
    throw new Error('__exit__');
  }) as never);

  try {
    await program.parseAsync(['node', 'agents', ...argv]);
  } catch (e) {
    if (!(e instanceof Error) || e.message !== '__exit__') throw e;
  } finally {
    log.mockRestore();
    error.mockRestore();
    proc.mockRestore();
  }
  return { out: out.join('\n'), err: err.join('\n'), exit };
}

async function signIn(token = 'pid_cmd_token'): Promise<void> {
  const { writeSession } = await import('../lib/identity/index.js');
  writeSession({ access_token: token, email: 'signed-in@test.local', userId: 'u-1' });
}

async function signOut(): Promise<void> {
  const { clearSession } = await import('../lib/identity/index.js');
  clearSession();
}

describe('agents auth — signed out', () => {
  it('prints one clean line and exits non-zero, never a stack trace', async () => {
    await signOut();
    const r = await run('auth', 'space', 'list');
    expect(r.exit).toBe(1);
    const text = `${r.out}${r.err}`;
    expect(text).toMatch(/Not signed in/);
    // The regression this guards (a5c4b420e): a raw Node stack reaching the user.
    expect(text).not.toMatch(/\bat \w+.*\(.*:\d+:\d+\)/);
    expect(text).not.toMatch(/PhoenixApiError:/);
  });

  it('whoami --json reports signedIn:false instead of failing', async () => {
    await signOut();
    const r = await run('auth', 'whoami', '--json');
    expect(JSON.parse(r.out)).toEqual({ signedIn: false });
    expect(received).toHaveLength(0);
  });
});

describe('agents auth — signed in', () => {
  it('whoami --json emits the account', async () => {
    await signIn();
    queue.push({ status: 200, body: { userId: 'u-1', email: 'signed-in@test.local', valid: true } });
    const r = await run('auth', 'whoami', '--json');
    expect(JSON.parse(r.out)).toMatchObject({ signedIn: true, email: 'signed-in@test.local' });
  });

  it('whoami persists a fresh avatar_url into the session so the actor env can stamp it', async () => {
    await signIn();
    const sessionFile = path.join(process.env.AGENTS_STATE_DIR!, 'phoenix-session.json');
    queue.push({ status: 200, body: { userId: 'u-1', email: 'signed-in@test.local', valid: true, avatar_url: 'https://lh3.googleusercontent.com/a/abc=s96-c' } });
    const r = await run('auth', 'whoami', '--json');
    expect(JSON.parse(r.out)).toMatchObject({ signedIn: true, avatar_url: 'https://lh3.googleusercontent.com/a/abc=s96-c' });
    expect(JSON.parse(fs.readFileSync(sessionFile, 'utf-8'))).toMatchObject({ email: 'signed-in@test.local', avatarUrl: 'https://lh3.googleusercontent.com/a/abc=s96-c' });
    // A later whoami with a changed picture updates it; one without a picture leaves it.
    queue.push({ status: 200, body: { userId: 'u-1', email: 'signed-in@test.local', valid: true, avatar_url: 'https://lh3.googleusercontent.com/a/def=s96-c' } });
    await run('auth', 'whoami', '--json');
    expect(JSON.parse(fs.readFileSync(sessionFile, 'utf-8')).avatarUrl).toBe('https://lh3.googleusercontent.com/a/def=s96-c');
    queue.push({ status: 200, body: { userId: 'u-1', email: 'signed-in@test.local', valid: true } });
    await run('auth', 'whoami', '--json');
    expect(JSON.parse(fs.readFileSync(sessionFile, 'utf-8')).avatarUrl).toBe('https://lh3.googleusercontent.com/a/def=s96-c');
  });

  it('translates an expired session into an actionable message', async () => {
    await signIn();
    queue.push({ status: 401, body: { error: 'invalid or revoked token' } });
    const r = await run('auth', 'whoami');
    expect(r.exit).toBe(1);
    expect(`${r.out}${r.err}`).toMatch(/no longer valid.*agents auth login/i);
  });

  it('space create sends the slugified name and honours --json', async () => {
    await signIn();
    const created = { id: 's1', slug: 'design-team', name: 'Design Team', organization_id: null, owner_user_id: 'u-1', user_role: 'owner', created_at: 'now' };
    queue.push({ status: 200, body: created });
    const r = await run('auth', 'space', 'create', 'Design Team', '--json');
    expect(JSON.parse(r.out)).toMatchObject({ slug: 'design-team' });
    expect(JSON.parse(received[0].body)).toEqual({ name: 'Design Team', slug: 'design-team' });
  });

  it('space invite surfaces the server refusal verbatim', async () => {
    await signIn();
    queue.push({ status: 200, body: [{ id: 's1', slug: 'only', name: 'Only', organization_id: null, owner_user_id: 'u-1', user_role: 'admin', created_at: 'now' }] });
    queue.push({ status: 403, body: { error: 'owner required to grant the admin role' } });
    const r = await run('auth', 'space', 'invite', 'ada@example.com', '--role', 'admin');
    expect(r.exit).toBe(1);
    expect(`${r.out}${r.err}`).toMatch(/owner required to grant the admin role/);
  });

  it('rejects an invalid --role before any network call', async () => {
    await signIn();
    const r = await run('auth', 'space', 'invite', 'ada@example.com', '--role', 'superuser');
    expect(r.exit).toBe(1);
    expect(`${r.out}${r.err}`).toMatch(/--role must be admin or member/);
    expect(received).toHaveLength(0);
  });

  it('names the candidates when the space is ambiguous', async () => {
    await signIn();
    queue.push({
      status: 200,
      body: [
        { id: 's1', slug: 'alpha', name: 'Alpha', organization_id: null, owner_user_id: 'u-1', user_role: 'owner', created_at: 'now' },
        { id: 's2', slug: 'beta', name: 'Beta', organization_id: null, owner_user_id: 'u-2', user_role: 'member', created_at: 'now' },
      ],
    });
    const r = await run('auth', 'space', 'members');
    expect(r.exit).toBe(1);
    expect(`${r.out}${r.err}`).toMatch(/alpha, beta/);
  });

  it('logout clears only this machine and is idempotent', async () => {
    await signIn();
    const first = await run('auth', 'logout');
    expect(first.out).toMatch(/Signed out/);
    const { readSession } = await import('../lib/identity/index.js');
    expect(readSession()).toBeNull();
    const second = await run('auth', 'logout');
    expect(second.out).toMatch(/Already signed out/);
    expect(second.exit).toBeUndefined();
  });
});

describe('agents auth login — the device poll loop', () => {
  /** The server hands back a 1s interval so the loop's waits stay short. */
  function authorization(expiresIn = 30) {
    return {
      status: 200,
      body: {
        device_code: 'dc', user_code: 'ABCD-2345',
        verification_uri: 'http://x/device', verification_uri_complete: 'http://x/device?code=ABCD-2345',
        expires_in: expiresIn, interval: 1,
      },
    };
  }

  it('keeps polling through pending and slow_down, then stores the session', async () => {
    await signOut();
    queue.push(authorization());
    queue.push({ status: 428, body: { error: 'authorization_pending' } });
    queue.push({ status: 429, body: { error: 'slow_down' } });
    queue.push({ status: 200, body: { status: 'authorized', access_token: 'pid_new', user: { email: 'new@test.local', id: 'u-9' } } });

    const r = await run('auth', 'login');

    expect(r.out).toMatch(/ABCD-2345/);
    expect(r.out).toMatch(/Signed in as new@test.local/);
    const { readSession } = await import('../lib/identity/index.js');
    expect(readSession()?.access_token).toBe('pid_new');
    // One authorization + three polls: it did not stop early or spin extra.
    expect(received).toHaveLength(4);
  }, 20_000);

  it('stops with an actionable message when the code is denied', async () => {
    await signOut();
    queue.push(authorization());
    queue.push({ status: 400, body: { error: 'access_denied' } });
    const r = await run('auth', 'login');
    expect(r.exit).toBe(1);
    expect(`${r.out}${r.err}`).toMatch(/denied/i);
    const { readSession } = await import('../lib/identity/index.js');
    expect(readSession()).toBeNull();
  }, 20_000);

  it('stops when the code expires rather than polling forever', async () => {
    await signOut();
    queue.push(authorization());
    queue.push({ status: 400, body: { error: 'expired_token' } });
    const r = await run('auth', 'login');
    expect(r.exit).toBe(1);
    expect(`${r.out}${r.err}`).toMatch(/expired.*agents auth login/i);
  }, 20_000);

  it('gives up at the deadline instead of hanging', async () => {
    await signOut();
    // expires_in: 0 — the loop must not enter even one poll.
    queue.push(authorization(0));
    const r = await run('auth', 'login');
    expect(r.exit).toBe(1);
    expect(`${r.out}${r.err}`).toMatch(/Timed out/);
    expect(received).toHaveLength(1);
  }, 20_000);
});

describe('agents auth — command surface', () => {
  it('has no mint verb (retired to accounts add/login)', async () => {
    const { registerAuthCommand } = await import('./auth.js');
    const program = new Command();
    registerAuthCommand(program);
    const auth = program.commands.find((c) => c.name() === 'auth')!;
    const help = auth.helpInformation();
    expect(help).toMatch(/^  login\b/m);
    expect(help).toMatch(/^  whoami\b/m);
    expect(help).not.toMatch(/^  mint\b/m);
    expect(help).not.toContain('agents auth mint');
    expect(auth.commands.find((c) => c.name() === 'mint')).toBeUndefined();
  });
});
