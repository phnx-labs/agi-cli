import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Command } from 'commander';
import { registerSendCommand } from './send.js';

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
    // AGENT_SESSION_ID is checked first and is set by the real run this suite
    // executes inside — pin both to the fixture and clear the other signals so
    // resolvePostIdentity resolves OUR session, not the live one.
    stash('AGENT_SESSION_ID', SESSION);
    stash('AGENTS_SESSION_ID', SESSION);
    stash('AGENTS_MAILBOX_DIR', undefined);
    stash('AGENT_LAUNCH_ID', undefined);
    stash('AGENTS_AGENT_NAME', 'claude');
    stash('AGENTS_MACHINE_ID', 'zion');

    // Owner config so the dry-run resolves a destination (no delivery on dry-run).
    const home = process.env.HOME ?? os.homedir();
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'notify:\n  owner:\n    channel: desktop\n    to: local\n');
  });

  afterEach(async () => {
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
    // The composer ran: raw body is short-shaped with a "Sent from" footer. The
    // owner transport (iMessage/rush) can't render a labeled link, so the key
    // stays plain text and NO URL is dumped (PHNX-3698 — labeled links are a
    // Slack-sink-only behavior).
    expect(payload.text).toContain('PHNX-3689 is the root cause.');
    expect(payload.text).toContain('Sent from claude/');
    expect(payload.text).not.toContain('https://linear.app/getrush/issue/PHNX-3689');
    expect(payload.text).not.toContain(`https://prix.dev/console/sessions/${SESSION}`);
    expect(payload.text).not.toContain('http');
  });
});
