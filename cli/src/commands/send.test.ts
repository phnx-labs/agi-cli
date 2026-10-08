import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerSendCommand } from './send.js';
import { clearSession, writeSession } from '../lib/identity/client.js';

describe('agents send --to owner routes through the feed composer (PHNX-3698)', () => {
  const SESSION = 'a1b2c3d4-1111-4222-8333-444455556666';
  const saved: Record<string, string | undefined> = {};
  const stdout: string[] = [];
  let originalLog: typeof console.log;
  let originalErr: typeof console.error;

  function stash(key: string, value: string | undefined) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  beforeEach(async () => {
    stdout.length = 0;
    originalLog = console.log;
    originalErr = console.error;
    console.log = (...args: unknown[]) => {
      stdout.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    };
    console.error = () => {};
    stash('LINEAR_WORKSPACE', 'getrush');
    stash('AGENT_SESSION_ID', SESSION);
    stash('AGENTS_SESSION_ID', SESSION);
    stash('AGENTS_MAILBOX_DIR', undefined);
    stash('AGENT_LAUNCH_ID', undefined);
    stash('AGENTS_AGENT_NAME', 'claude');
    stash('AGENTS_MACHINE_ID', 'zion');

    writeSession({ access_token: 'phx-dry-run' });
  });

  afterEach(async () => {
    clearSession();
    console.log = originalLog;
    console.error = originalErr;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('--dry-run --json shows the composed message as a plain owner sentence with no dumped URLs', async () => {
    const program = new Command();
    registerSendCommand(program);

    await program.parseAsync([
      'node', 'agents', 'send', '--to', 'owner',
      '--text', 'Deploy never ran. PHNX-3689 is the root cause.',
      '--dry-run', '--json',
    ]);

    const line = stdout.find((l) => l.trim().startsWith('{'));
    expect(line, 'expected a JSON payload on stdout').toBeTruthy();
    const payload = JSON.parse(line!);
    expect(payload.dryRun).toBe(true);
    expect(payload.text).toContain('PHNX-3689 is the root cause.');
    expect(payload.text).toContain('Sent from claude/');
    expect(payload.text).not.toContain('https://linear.app/getrush/issue/PHNX-3689');
    expect(payload.text).not.toContain(`https://prix.dev/console/sessions/${SESSION}`);
    expect(payload.text).not.toContain('http');
  });

  it('--dry-run on a signed-out box fails loud instead of pretending to reach the owner', async () => {
    clearSession();
    const exit = process.exit;
    let code: number | undefined;
    process.exit = ((c?: number) => { code = c; throw new Error('exit'); }) as typeof process.exit;
    try {
      await dryRunJson(['--to', 'owner', '--text', 'probe']).catch(() => undefined);
    } finally {
      process.exit = exit;
    }
    expect(code).toBe(1);
    expect(stdout.join('\n')).toContain('agents auth login');
  });

  async function dryRunJson(args: string[]): Promise<Record<string, unknown>> {
    const program = new Command();
    registerSendCommand(program);
    await program.parseAsync(['node', 'agents', 'send', ...args, '--dry-run', '--json']);
    const line = stdout.find((l) => l.trim().startsWith('{'));
    expect(line, 'expected a JSON payload on stdout').toBeTruthy();
    return JSON.parse(line!);
  }

  it('an explicit channel trims the body and folds --url, unchanged by the session options', async () => {
    const payload = await dryRunJson(['--channel', 'mailbox', '--to', 'peer-1', '--text', '  hi  ', '--url', 'https://x.test']);
    expect(payload).toMatchObject({ ok: true, channel: 'mailbox', id: 'peer-1', text: 'hi\nhttps://x.test', dryRun: true });
    expect(payload).not.toHaveProperty('writes');
  });

  it('--pane, --no-enter and --combined reach the terminal engine with the text kept verbatim', async () => {
    expect(await dryRunJson(['--channel', 'session', '--pane', '%9', '--text', ' x ', '--no-enter']))
      .toMatchObject({ ok: true, channel: 'session', id: '%9', text: ' x ', backend: 'tmux', writes: 1, dryRun: true });
    stdout.length = 0;
    expect(await dryRunJson(['--channel', 'session', '--pane', '%9', '--text', 'y']))
      .toMatchObject({ id: '%9', text: 'y', writes: 2 });
    stdout.length = 0;
    expect(await dryRunJson(['--channel', 'session', '--pane', '%9', '--text', 'y', '--combined']))
      .toMatchObject({ id: '%9', writes: 1 });
  });
});
