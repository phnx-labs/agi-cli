import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-titletick-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { getSessionsDir } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const db = await import('./db.js');
const { runSessionTitleTick, SESSION_TITLE_PROMPT_MARKER, CloudSessionTitleProvider } = await import('./title.js');
const { machineId } = await import('./sync/config.js');
import type { SessionTitleProvider } from './title.js';

const self = machineId();

/** The model's batched reply for one session (ref 1). */
const reply = (title: string, workstream = 'Session titles') => JSON.stringify([{ ref: '1', title, workstream }]);

function seed(id: string, over: Record<string, unknown> = {}): void {
  const meta: any = {
    id,
    shortId: id.slice(0, 8),
    agent: 'claude',
    timestamp: '2026-09-01T10:00:00.000Z',
    lastActivity: new Date().toISOString(),
    filePath: `/tmp/${id}.jsonl`,
    machine: self,
    project: 'agents-cli',
    topic: 'fix the session headline',
    firstUserMessage: 'The Sessions list shows the agent latest message as the headline. Fix it.',
    ...over,
  };
  db.upsertSession(meta, String(meta.firstUserMessage ?? ''));
}

describe('runSessionTitleTick (real index, injected model call)', () => {
  it('generates once, persists it, and cache-hits on the next sweep', async () => {
    seed('11111111-0000-0000-0000-000000000001');
    let calls = 0;
    const run = async () => {
      calls++;
      return reply('Session headline ladder fix');
    };

    const first = await runSessionTitleTick({ run, limit: 5 });
    expect(first.generated).toBe(1);
    expect(calls).toBe(1);
    expect(db.getSessionById('11111111-0000-0000-0000-000000000001')?.generatedTitle)
      .toBe('Session headline ladder fix');
    expect(db.getSessionWorkstream('11111111-0000-0000-0000-000000000001')).toBe('Session titles');

    const second = await runSessionTitleTick({ run, limit: 5 });
    expect(second.generated).toBe(0);
    expect(second.cached).toBe(1);
    expect(calls).toBe(1);
  });

  it('re-titles when the first user message changes, and on an explicit refresh', async () => {
    const id = '22222222-0000-0000-0000-000000000002';
    seed(id);
    await runSessionTitleTick({ run: async () => reply('First title'), limit: 5 });
    expect(db.getSessionById(id)?.generatedTitle).toBe('First title');

    seed(id, { firstUserMessage: 'Actually: make the fleet mirror carry the title too.' });
    const changed = await runSessionTitleTick({ run: async () => reply('Mirror carries title', 'Fleet mirror'), limit: 5 });
    expect(changed.generated).toBe(1);
    expect(db.getSessionById(id)?.generatedTitle).toBe('Mirror carries title');
    expect(db.getSessionWorkstream(id)).toBe('Fleet mirror');

    const forced = await runSessionTitleTick({ id, force: true, run: async () => reply('Refreshed title') });
    expect(forced.generated).toBe(1);
    expect(db.getSessionById(id)?.generatedTitle).toBe('Refreshed title');
  });

  it('leaves the row untitled when generation fails — the fallback stays the user\'s own words', async () => {
    const id = '33333333-0000-0000-0000-000000000003';
    seed(id, { firstUserMessage: 'A request nobody could title right now.' });
    const result = await runSessionTitleTick({
      id,
      run: async () => { throw new Error('no signed-in harness'); },
    });
    expect(result.failed).toBe(1);
    expect(result.generated).toBe(0);
    const meta = db.getSessionById(id)!;
    expect(meta.generatedTitle).toBeUndefined();
    expect(meta.firstUserMessage).toBe('A request nobody could title right now.');
  });

  it('never titles a session whose own prompt IS a title-generation prompt', async () => {
    const id = '44444444-0000-0000-0000-000000000004';
    seed(id, {
      topic: SESSION_TITLE_PROMPT_MARKER,
      firstUserMessage: `${SESSION_TITLE_PROMPT_MARKER} naming what this coding session worked on.`,
    });
    let calls = 0;
    await runSessionTitleTick({ id, run: async () => { calls++; return 'Nope'; } });
    expect(calls).toBe(0);
    expect(db.getSessionById(id)?.generatedTitle).toBeUndefined();
  });

  it('never titles a session that carries a /rename label, but gives it a workstream', async () => {
    const id = '55555555-0000-0000-0000-000000000005';
    seed(id, { label: 'ship the auth fix' });
    let prompt = '';
    const swept = await runSessionTitleTick({ id, run: async (p) => { prompt = p; return reply('Should not be used', 'Auth'); } });
    expect(prompt).toContain('Current title: ship the auth fix');
    expect(swept.titles.some((t) => t.id === id)).toBe(false);
    expect(swept.grouped).toBe(1);
    expect(db.getSessionById(id)?.generatedTitle).toBeUndefined();
    expect(db.getSessionWorkstream(id)).toBe('Auth');
  });

  it('keeps the stored title across a later transcript rescan', async () => {
    const id = '66666666-0000-0000-0000-000000000006';
    seed(id);
    await runSessionTitleTick({ id, run: async () => reply('Durable across rescan', 'Rescans') });
    seed(id, { messageCount: 42 });
    expect(db.getSessionById(id)?.generatedTitle).toBe('Durable across rescan');
    expect(db.getSessionWorkstream(id)).toBe('Rescans');
  });
});

describe('one batched call per tick (titles and workstreams together)', () => {
  it('titles several sessions with ONE model call and offers the existing workstreams', async () => {
    const ids = ['aaaa0000-0000-0000-0000-00000000000a', 'aaaa0000-0000-0000-0000-00000000000b', 'aaaa0000-0000-0000-0000-00000000000c'];
    seed(ids[0], { firstUserMessage: 'post the PR 83 review for the Rush Mac launch' });
    seed(ids[1], { firstUserMessage: 'include TextEdit in the Rush Mac test' });
    seed(ids[2], { firstUserMessage: 'set up Ahrefs for SEO and AEO' });
    const prompts: string[] = [];
    const result = await runSessionTitleTick({
      limit: 12,
      maxAgeMs: 60_000,
      run: async (prompt) => {
        prompts.push(prompt);
        const refs = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((m) => m[1]);
        return JSON.stringify(refs.map((ref) => {
          const ask = prompt.split(`[${ref}]`)[1].split('\n[')[0];
          return { ref, title: `Session ${ref} headline`, workstream: /Ahrefs/.test(ask) ? 'Ahrefs SEO' : 'Rush Mac' };
        }));
      },
    });
    expect(prompts).toHaveLength(1);
    expect(result.generated).toBeGreaterThanOrEqual(3);
    expect(ids.map((id) => db.getSessionWorkstream(id))).toEqual(['Rush Mac', 'Rush Mac', 'Ahrefs SEO']);
    expect(prompts[0]).toContain('Reuse one of these existing workstreams whenever it fits; coin a new one only when none does: Session titles');
  });

  it('counts every session in a batch as failed when the reply is not the JSON array', async () => {
    const id = 'bbbb0000-0000-0000-0000-00000000000b';
    seed(id, { firstUserMessage: 'an unparseable reply' });
    const result = await runSessionTitleTick({ id, run: async () => 'Session headline ladder fix' });
    expect(result).toMatchObject({ generated: 0, grouped: 0, failed: 1 });
    expect(db.getSessionById(id)?.generatedTitle).toBeUndefined();
  });
});

describe('a batch that fails never holds the queue (review of #4066)', () => {
  const answerAll = (prompt: string, workstream: string) =>
    JSON.stringify([...prompt.matchAll(/^\[(\d+)\]/gm)].map((m) => ({ ref: m[1], title: `Session ${m[1]} headline`, workstream })));

  it('retries an unparseable reply in halves, so the sessions the model can answer still get named', async () => {
    const ids = ['cccc0000-0000-0000-0000-00000000000a', 'cccc0000-0000-0000-0000-00000000000b'];
    seed(ids[0], { firstUserMessage: 'POISON: answer this one in prose' });
    seed(ids[1], { firstUserMessage: 'name the halving retry' });
    const sizes: number[] = [];
    const result = await runSessionTitleTick({
      limit: 2,
      maxAgeMs: 60_000,
      run: async (prompt) => {
        sizes.push([...prompt.matchAll(/^\[(\d+)\]/gm)].length);
        return prompt.includes('POISON') ? 'Sure! Here is my thinking about the sessions.' : answerAll(prompt, 'Retries');
      },
    });
    expect(sizes).toEqual([2, 1, 1]);
    expect(db.getSessionWorkstream(ids[1])).toBe('Retries');
    expect(db.getSessionWorkstream(ids[0])).toBeUndefined();
    expect(result.failed).toBeGreaterThanOrEqual(1);
  });

  it('a model that only answers prose costs at most three calls a batch', async () => {
    const ids = ['ffff0000-0000-0000-0000-00000000000a', 'ffff0000-0000-0000-0000-00000000000b', 'ffff0000-0000-0000-0000-00000000000c', 'ffff0000-0000-0000-0000-00000000000d'];
    ids.forEach((id, n) => seed(id, { firstUserMessage: `prose-only request ${n}` }));
    let calls = 0;
    await runSessionTitleTick({ limit: 12, maxAgeMs: 60_000, run: async () => { calls++; return 'I would rather talk about it.'; } });
    expect(calls).toBe(3);
  });

  it('records why the call failed, once, and an abort is neither a success nor a failure', async () => {
    const id = 'dddd0000-0000-0000-0000-00000000000d';
    seed(id, { firstUserMessage: 'a call that cannot run' });
    const failed = await runSessionTitleTick({ id, run: async () => { throw new Error('no installed harness can generate a session title\nstack'); } });
    expect(failed).toMatchObject({ failed: 1, errors: ['no installed harness can generate a session title'] });
    const ac = new AbortController();
    const aborted = await runSessionTitleTick({ id, signal: ac.signal, run: async () => { ac.abort(); throw new Error('aborted'); } });
    expect(aborted).toMatchObject({ failed: 0, generated: 0, errors: [] });
  });

  it('a workstream that differs from a known one only in case takes the known spelling', async () => {
    const id = 'eeee0000-0000-0000-0000-00000000000e';
    seed(id, { firstUserMessage: 'another session about session titles' });
    await runSessionTitleTick({ id, run: async () => reply('Title the session', 'session TITLES') });
    expect(db.getSessionWorkstream(id)).toBe('Session titles');
  });
});

describe('swappable title provider (PHNX-3797)', () => {
  it('generates through an injected provider — the seam a local backend drops into', async () => {
    const id = '88888888-0000-0000-0000-000000000008';
    seed(id, { firstUserMessage: 'wire up the local title backend' });
    let seen: { input?: string } = {};
    const provider: SessionTitleProvider = {
      name: 'fake-local',
      async generateBatch(items) {
        seen = { input: items[0].input.firstUserMessage ?? undefined };
        return reply('Wire up the local backend');
      },
    };
    const result = await runSessionTitleTick({ id, provider });
    expect(result.generated).toBe(1);
    expect(seen.input).toBe('wire up the local title backend');
    expect(db.getSessionById(id)?.generatedTitle).toBe('Wire up the local backend');
  });

  it('an explicit provider takes precedence over the run shortcut', async () => {
    const id = '99999999-0000-0000-0000-000000000009';
    seed(id, { firstUserMessage: 'provider beats run' });
    let ranRunner = false;
    const provider: SessionTitleProvider = { name: 'p', async generateBatch() { return reply('Provider wins'); } };
    const result = await runSessionTitleTick({
      id,
      provider,
      run: async () => { ranRunner = true; return reply('Runner wins'); },
    });
    expect(result.generated).toBe(1);
    expect(ranRunner).toBe(false);
    expect(db.getSessionById(id)?.generatedTitle).toBe('Provider wins');
  });

  it('the cloud provider renders the shared batch prompt through its runner', async () => {
    let promptSeen = '';
    const provider = new CloudSessionTitleProvider(async (prompt) => {
      promptSeen = prompt;
      return 'raw reply';
    });
    const raw = await provider.generateBatch([{ ref: '1', input: { firstUserMessage: 'name this session' } }], ['Rush Mac']);
    expect(provider.name).toBe('cloud');
    expect(raw).toBe('raw reply');
    expect(promptSeen).toContain(SESSION_TITLE_PROMPT_MARKER);
    expect(promptSeen).toContain('name this session');
    expect(promptSeen).toContain('Rush Mac');
  });
});

describe('explicit --session targeting', () => {
  it('fails loud for an id no indexed session matches, instead of reporting a quiet zero', async () => {
    await expect(runSessionTitleTick({ id: 'not-a-real-session', run: async () => 'x' }))
      .rejects.toThrow(/no indexed session matches "not-a-real-session"/);
  });

  it('accepts a short id', async () => {
    const id = '77777777-0000-0000-0000-000000000007';
    seed(id);
    const result = await runSessionTitleTick({ id: id.slice(0, 8), run: async () => reply('Short id target') });
    expect(result.generated).toBe(1);
    expect(db.getSessionById(id)?.generatedTitle).toBe('Short id target');
  });
});
