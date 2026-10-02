import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeOwnerMessage } from './owner-message.js';

// Real path, no mocks of the composer: composeOwnerMessage resolves the run
// identity from the environment (the same resolver feed post uses) and shapes the
// body through composeBroadcastMessage. We drive identity through env vars — the
// explicit-session branch of resolvePostIdentity — and set a workspace so ticket
// keys resolve. vitest's setup.ts already pins HOME to a private sandbox, so the
// session-index lookup opens an empty db and finds no ticket, exactly the
// "body only NAMES the ticket" case.
const SESSION = '6fc1db18-1111-4222-8333-444455556666';
const saved: Record<string, string | undefined> = {};

function stash(key: string, value: string | undefined) {
  saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  stash('LINEAR_WORKSPACE', 'getrush');
  // AGENT_SESSION_ID is checked before AGENTS_SESSION_ID, and the real run this
  // suite executes inside sets it — pin both to the fixture and clear the other
  // identity signals so resolvePostIdentity resolves OUR session deterministically.
  stash('AGENT_SESSION_ID', SESSION);
  stash('AGENTS_SESSION_ID', SESSION);
  stash('AGENTS_MAILBOX_DIR', undefined);
  stash('AGENT_LAUNCH_ID', undefined);
  stash('AGENTS_AGENT_NAME', 'claude');
  stash('AGENTS_MACHINE_ID', 'zion');
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('composeOwnerMessage — the shared owner-ping composer (PHNX-3698)', () => {
  // The owner ping is delivered over the owner-scoped rush/iMessage transport,
  // which cannot render a labeled link — so it stays the plain human sentence
  // with NO dumped URLs (a naked URL reads as noise; dumping it is still wrong).
  // Slack labeled links are a Slack-sink-only behavior of composeBroadcastMessage.
  it('keeps a TEAM-N key as bare text and never dumps a URL for it', () => {
    const msg = composeOwnerMessage('Deploy never ran. PHNX-3689 is the root cause of the drift.');
    expect(msg).toContain('PHNX-3689 is the root cause');
    expect(msg).not.toContain('https://linear.app/getrush/issue/PHNX-3689');
    // The session crumb stays the plain footer sentence — no console URL dumped.
    expect(msg).not.toContain(`https://prix.dev/console/sessions/${SESSION}`);
    expect(msg).not.toContain('http');
  });

  it('with no session in the environment, still keeps the key as plain text (no URL)', () => {
    delete process.env.AGENTS_SESSION_ID;
    delete process.env.AGENT_SESSION_ID;
    delete process.env.AGENTS_MAILBOX_DIR;
    // AGENT_LAUNCH_ID absent → no activity/registry session either; a bare shell
    // run of notify resolves no session.
    const msg = composeOwnerMessage('Heads up on PHNX-3689 before the next deploy.');
    expect(msg).toContain('PHNX-3689');
    expect(msg).not.toContain('http');
  });

  it('uses a passed title as the scannable head, body below it', () => {
    const msg = composeOwnerMessage('prod is missing the migration.', { title: 'Deploy never ran' });
    expect(msg.startsWith('Deploy never ran')).toBe(true);
    expect(msg).toContain('prod is missing the migration.');
  });

  // PHNX-3698: a Slack owner destination CAN render `<url|label>`, so the same
  // raw post composed with `format: 'mrkdwn'` turns the ticket key and the
  // session crumb into blue tappable links in place — the exact thing the plain
  // owner path (and the tests above) must NOT do for iMessage.
  it("with format 'mrkdwn', linkifies a TEAM-N key in place as a Slack labeled link", () => {
    const msg = composeOwnerMessage('Deploy never ran. PHNX-3689 is the root cause of the drift.', {
      format: 'mrkdwn',
    });
    expect(msg).toContain('<https://linear.app/getrush/issue/PHNX-3689|PHNX-3689>');
    // The key is linked in place — the bare token is not left dangling as text.
    expect(msg).not.toMatch(/(?<![|/])PHNX-3689(?!\|)/);
  });

  it("with format 'mrkdwn', turns the session crumb into a tappable console link", () => {
    const msg = composeOwnerMessage('prod is missing the migration.', { format: 'mrkdwn' });
    expect(msg).toContain(`<https://prix.dev/console/sessions/${SESSION}|claude/6fc1db18>`);
  });

  it('plain and mrkdwn differ: the same post is a link-free sentence vs labeled links', () => {
    const raw = 'Deploy never ran. PHNX-3689 is the root cause.';
    const plain = composeOwnerMessage(raw);
    const mrkdwn = composeOwnerMessage(raw, { format: 'mrkdwn' });
    expect(plain).not.toContain('http');
    expect(mrkdwn).toContain('<https://');
    expect(plain).not.toEqual(mrkdwn);
  });
});
