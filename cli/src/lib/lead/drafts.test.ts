import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { leadDraftsDir, readLeadDraft, writeLeadDraft } from './drafts.js';
import { listLeadProjects } from './paths.js';

describe('Lead drafts', () => {
  it('stores one draft per attention key, read back only for that key, and drafts/ is never a project', () => {
    writeLeadDraft({ key: 'zion/s1/v1', text: 'Wait for CI', label: 'Wait for CI', project: 'demo', at: '2026-10-19T12:00:00.000Z' });
    expect(readLeadDraft('zion/s1/v1')).toMatchObject({ text: 'Wait for CI', project: 'demo' });
    expect(readLeadDraft('zion/s1/v2')).toBeUndefined();
    expect(listLeadProjects()).not.toContain('drafts');
  });

  it('drops drafts older than a day when it writes', () => {
    writeLeadDraft({ key: 'zion/old/v1', label: 'x', text: 'x', project: 'demo', at: '2026-10-18T00:00:00.000Z' });
    const old = fs.readdirSync(leadDraftsDir()).map((n) => path.join(leadDraftsDir(), n)).find((f) => fs.readFileSync(f, 'utf8').includes('zion/old/v1'))!;
    fs.utimesSync(old, new Date(Date.now() - 2 * 86_400_000), new Date(Date.now() - 2 * 86_400_000));
    writeLeadDraft({ key: 'zion/new/v1', label: 'y', text: 'y', project: 'demo', at: '2026-10-19T00:00:00.000Z' });
    expect(readLeadDraft('zion/old/v1')).toBeUndefined();
  });
});
