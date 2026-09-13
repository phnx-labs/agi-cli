import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { redactEmails } from '../lib/redact.js';
import { renderSessionHtmlDocument } from '../lib/session/share-html.js';
import type { SessionMeta } from '../lib/session/types.js';
import { buildArtifactsShareArgs, defaultSessionSlug } from './sessions-share.js';

const TESTDATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/session/testdata/render');

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'a1b2c3d4-0000-0000-0000-000000000000',
    shortId: 'a1b2c3d4',
    agent: 'claude',
    timestamp: '2026-08-17T10:00:00.000Z',
    project: 'agents-cli',
    filePath: path.join(TESTDATA, 'claude.jsonl'),
    ...overrides,
  };
}

describe('defaultSessionSlug', () => {
  it('is stable per session, so re-sharing updates one URL instead of littering new ones', () => {
    const session = meta();
    expect(defaultSessionSlug(session)).toBe('session-a1b2c3d4');
    expect(defaultSessionSlug(session)).toBe(defaultSessionSlug({ ...session, project: 'other' }));
  });

  it('falls back to the full id when a session carries no short id', () => {
    expect(defaultSessionSlug(meta({ shortId: '' }))).toBe('session-a1b2c3d4-0000-0000-0000-000000000000');
  });
});

describe('buildArtifactsShareArgs', () => {
  const file = '/tmp/x/session-a1b2c3d4.html';

  it('is unlisted unless --public — the one default that must not silently invert', () => {
    // `artifacts share` defaults to PUBLIC; a session transcript must not, so the
    // command passes --visibility explicitly. A mapping bug here leaks a transcript.
    expect(buildArtifactsShareArgs(meta(), {}, file)).toContain('unlisted');
    expect(buildArtifactsShareArgs(meta(), {}, file)).not.toContain('public');
    expect(buildArtifactsShareArgs(meta(), { public: false }, file)).toContain('unlisted');
    const pub = buildArtifactsShareArgs(meta(), { public: true }, file);
    expect(pub).toContain('public');
    expect(pub).not.toContain('unlisted');
  });

  it('tags the share as a session and requests JSON so the command can parse the URL', () => {
    const args = buildArtifactsShareArgs(meta(), {}, file);
    const metaIdx = args.indexOf('--meta');
    expect(args[metaIdx + 1]).toBe('kind=session');
    expect(args).toContain('--json');
  });

  it('always leads with `share <file> --slug <default>`', () => {
    const args = buildArtifactsShareArgs(meta(), {}, file);
    expect(args.slice(0, 2)).toEqual(['share', file]);
    const slugIdx = args.indexOf('--slug');
    expect(args[slugIdx + 1]).toBe('session-a1b2c3d4');
  });

  it('passes the optional flags through only when set, without inventing values', () => {
    const bare = buildArtifactsShareArgs(meta(), {}, file);
    expect(bare).not.toContain('--expire'); // artifacts share applies the 30d default
    expect(bare).not.toContain('--force');
    expect(bare).not.toContain('--no-cover');
    expect(bare).not.toContain('--label');

    const full = buildArtifactsShareArgs(
      meta(),
      { slug: 'custom', label: 'Title', expire: 'never', force: true, cover: false },
      file,
    );
    expect(full[full.indexOf('--slug') + 1]).toBe('custom');
    expect(full[full.indexOf('--expire') + 1]).toBe('never');
    expect(full[full.indexOf('--label') + 1]).toBe('Title');
    expect(full).toContain('--force');
    expect(full).toContain('--no-cover');
  });
});

describe('email masking runs on the artifact the scanner scans', () => {
  it('catches an address Markdown escaping hid from a Markdown-stage mask', () => {
    // `foo\@example.com` does not match the email pattern in Markdown (the
    // backslash breaks the local part), but marked drops the backslash, so the
    // published HTML carries a live address `artifacts share`'s scan would refuse.
    const markdown = 'contact foo\\@example.com for context';
    const page = renderSessionHtmlDocument(meta(), markdown);
    expect(page).toContain('foo@example.com'); // survived the Markdown stage

    const masked = redactEmails(page);
    expect(masked).not.toContain('foo@example.com');
    expect(masked).toContain('[EMAIL]');
  });
});
