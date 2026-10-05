import { describe, expect, it } from 'vitest';

import { buildForkRecap, forkLabelFor } from '../fork.js';

describe('forkLabelFor', () => {
  it('prefers label, then topic, then short id', () => {
    expect(forkLabelFor({ label: 'Prix Evals', topic: 't', shortId: 'abcd1234' })).toBe('Prix Evals');
    expect(forkLabelFor({ label: '', topic: 'the topic', shortId: 'abcd1234' })).toBe('the topic');
    expect(forkLabelFor({ label: undefined, topic: undefined, shortId: 'abcd1234' } as any)).toBe('abcd1234');
  });
});

describe('buildForkRecap', () => {
  it('folds label, cwd, ticket, last line, and changes into a seed with a /continue escape hatch', () => {
    const recap = buildForkRecap({
      agent: 'claude',
      label: 'Prix Evals',
      cwd: '/home/u/src/prix',
      ticketId: 'PHNX-3397',
      machine: 'yosemite-m1',
      shortId: 'b61cad38',
      id: 'b61cad38-ede2-4c1d-93de-9b8eef14607d',
      lastAssistant: 'the stat strip is real, insight widgets need gaps 1 & 2 closed.',
      changes: { created: 3, modified: 3, deleted: 7 },
    });

    expect(recap).toContain('Continue a prior claude session ("Prix Evals")');
    expect(recap).toContain('Working directory: /home/u/src/prix');
    expect(recap).toContain('Ticket: PHNX-3397');
    expect(recap).toContain('insight widgets need gaps 1 & 2 closed');
    expect(recap).toContain('Changes so far: +3 ~3 -7.');
    expect(recap).toContain('Source session b61cad38 on yosemite-m1');
    expect(recap).toContain('/continue b61cad38-ede2-4c1d-93de-9b8eef14607d');
  });

  it('omits optional lines when their data is absent (minimal source)', () => {
    const recap = buildForkRecap({
      agent: 'codex',
      label: 'quick thing',
      shortId: 'deadbeef',
      id: 'deadbeef-0000-0000-0000-000000000000',
    });
    expect(recap).toContain('Continue a prior codex session ("quick thing")');
    expect(recap).not.toContain('Working directory:');
    expect(recap).not.toContain('Ticket:');
    expect(recap).not.toContain('It last said:');
    expect(recap).not.toContain('Changes so far:');
    expect(recap).toContain('Source session deadbeef — run');
  });

  it('drops an all-zero change tally rather than printing "+0 ~0 -0"', () => {
    const recap = buildForkRecap({
      agent: 'claude', label: 'x', shortId: 'abcd1234', id: 'abcd1234-0000-0000-0000-000000000000',
      changes: { created: 0, modified: 0, deleted: 0 },
    });
    expect(recap).not.toContain('Changes so far:');
  });

  it('collapses whitespace and caps a very long last line', () => {
    const long = 'word '.repeat(500);
    const recap = buildForkRecap({
      agent: 'claude', label: 'x', shortId: 'abcd1234', id: 'abcd1234-0000-0000-0000-000000000000',
      lastAssistant: long,
    });
    const lastLine = recap.split('\n').find((l) => l.startsWith('It last said:'))!;
    expect(lastLine.length).toBeLessThan(430);
    expect(lastLine).toContain('…');
    expect(lastLine).not.toContain('\n');
  });
});
