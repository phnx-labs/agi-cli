import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  AgentManager,
  AgentProcess,
  AgentStatus,
  type AgentType,
} from '../agents.js';
import {
  parseForEachBlock,
  parseVerifyBlock,
  expandForEach,
  renderForEachTemplate,
  DEFAULT_FOR_EACH_CAP,
  type ForEachSpec,
  type ForEachTeammate,
} from '../../workflows.js';
import {
  parseProducedItems,
  produceItems,
  evaluateKeepIf,
  tallyForEach,
} from '../forEach.js';

describe('parseForEachBlock — defensive coercion (issue #343)', () => {
  it('parses a well-formed for_each block with a verify panel', () => {
    const spec = parseForEachBlock({
      produce: "rg -l 'router\\.(get|post)' src/routes/",
      agent: 'auth-checker',
      name: 'audit',
      prompt: 'Audit {{item}} for missing auth checks',
      concurrency: 8,
      max_items: 50,
      verify: { agent: 'skeptic', votes: 3, keep_if: 'majority' },
    });
    expect(spec).toEqual({
      produce: "rg -l 'router\\.(get|post)' src/routes/",
      agent: 'auth-checker',
      name: 'audit',
      prompt: 'Audit {{item}} for missing auth checks',
      concurrency: 8,
      max_items: 50,
      verify: { agent: 'skeptic', votes: 3, keep_if: 'majority' },
    });
  });

  it('drops the block unless both agent and prompt are present', () => {
    expect(parseForEachBlock({ agent: 'x' })).toBeUndefined();
    expect(parseForEachBlock({ prompt: 'do {{item}}' })).toBeUndefined();
    expect(parseForEachBlock({ agent: '  ', prompt: 'p' })).toBeUndefined();
    expect(parseForEachBlock(undefined)).toBeUndefined();
    expect(parseForEachBlock([1, 2])).toBeUndefined();
    expect(parseForEachBlock('for_each')).toBeUndefined();
  });

  it('captures an itemsRef from a for_each reference or items_ref', () => {
    expect(parseForEachBlock({ for_each: '${endpoints}', agent: 'a', prompt: 'p' }))
      .toMatchObject({ itemsRef: '${endpoints}' });
    expect(parseForEachBlock({ items_ref: '${prior}', agent: 'a', prompt: 'p' }))
      .toMatchObject({ itemsRef: '${prior}' });
  });

  it('drops malformed numeric fields rather than passing a bad shape', () => {
    const spec = parseForEachBlock({
      agent: 'a',
      prompt: 'p',
      concurrency: 0,
      max_items: 2.5,
    })!;
    expect(spec.concurrency).toBeUndefined();
    expect(spec.max_items).toBeUndefined();
  });

  it('parseVerifyBlock defaults votes to 1 and keep_if to majority', () => {
    expect(parseVerifyBlock({ agent: 'skeptic' }))
      .toEqual({ agent: 'skeptic', votes: 1, keep_if: 'majority' });
    expect(parseVerifyBlock({ agent: 'skeptic', votes: -3, keep_if: 'whenever' }))
      .toEqual({ agent: 'skeptic', votes: 1, keep_if: 'majority' });
    expect(parseVerifyBlock({ votes: 3 })).toBeUndefined();
  });

  it('drops a malformed verify sub-block but keeps the for_each', () => {
    const spec = parseForEachBlock({ agent: 'a', prompt: 'p', verify: { votes: 3 } })!;
    expect(spec.verify).toBeUndefined();
    expect(spec.agent).toBe('a');
  });
});

describe('renderForEachTemplate', () => {
  it('substitutes item, index (0-based), and n (1-based)', () => {
    expect(renderForEachTemplate('audit {{item}} (#{{n}}, idx {{index}})', 'src/a.ts', 2))
      .toBe('audit src/a.ts (#3, idx 2)');
  });
  it('leaves unknown tokens intact', () => {
    expect(renderForEachTemplate('{{item}} — {{unknown}}', 'x', 0)).toBe('x — {{unknown}}');
  });
});

describe('expandForEach — one stage per produced item + verify (issue #343)', () => {
  const spec: ForEachSpec = {
    agent: 'auth-checker',
    name: 'audit',
    prompt: 'Audit {{item}} for missing auth checks',
    verify: { agent: 'skeptic', votes: 3, keep_if: 'majority' },
  };

  it('fans out exactly one stage teammate per item, N unknown until produced', () => {
    const items = ['src/routes/a.ts', 'src/routes/b.ts', 'src/routes/c.ts'];
    const { teammates, producedCount, usedCount, truncated } = expandForEach(spec, items);

    const stages = teammates.filter((t) => t.role === 'stage');
    expect(stages).toHaveLength(items.length);
    expect(stages.map((t) => t.item)).toEqual(items);
    expect(stages.map((t) => t.name)).toEqual(['audit-1', 'audit-2', 'audit-3']);
    expect(stages[0].prompt).toBe('Audit src/routes/a.ts for missing auth checks');
    expect(producedCount).toBe(3);
    expect(usedCount).toBe(3);
    expect(truncated).toBe(0);
  });

  it('expands `votes` skeptics per item, each depending on that item stage', () => {
    const items = ['a', 'b'];
    const { teammates } = expandForEach(spec, items);

    const verifiers = teammates.filter((t) => t.role === 'verify');
    expect(verifiers).toHaveLength(6);

    const forA = verifiers.filter((t) => t.item === 'a');
    expect(forA.map((t) => t.name)).toEqual(['audit-1-verify-1', 'audit-1-verify-2', 'audit-1-verify-3']);
    expect(forA.every((t) => t.after.length === 1 && t.after[0] === 'audit-1')).toBe(true);
    expect(forA.every((t) => t.agentType === 'skeptic')).toBe(true);
    expect(forA.every((t) => t.votes === 3 && t.keep_if === 'majority')).toBe(true);
  });

  it('links stage teammates after the producer when a producerName is given', () => {
    const { teammates } = expandForEach(spec, ['a'], { producerName: 'endpoints' });
    const stage = teammates.find((t) => t.role === 'stage')!;
    expect(stage.after).toEqual(['endpoints']);
  });

  it('omits verify teammates when no verify panel is declared', () => {
    const bare: ForEachSpec = { agent: 'x', prompt: 'do {{item}}' };
    const { teammates } = expandForEach(bare, ['a', 'b']);
    expect(teammates).toHaveLength(2);
    expect(teammates.every((t) => t.role === 'stage')).toBe(true);
  });

  it('enforces the runaway-producer hard cap (default and explicit)', () => {
    const many = Array.from({ length: DEFAULT_FOR_EACH_CAP + 25 }, (_, i) => `item-${i}`);
    const dflt = expandForEach({ agent: 'x', prompt: 'p' }, many);
    expect(dflt.usedCount).toBe(DEFAULT_FOR_EACH_CAP);
    expect(dflt.truncated).toBe(25);
    expect(dflt.teammates.filter((t) => t.role === 'stage')).toHaveLength(DEFAULT_FOR_EACH_CAP);

    const capped = expandForEach({ agent: 'x', prompt: 'p', max_items: 4 }, many);
    expect(capped.usedCount).toBe(4);
    expect(capped.producedCount).toBe(DEFAULT_FOR_EACH_CAP + 25);
    expect(capped.truncated).toBe(DEFAULT_FOR_EACH_CAP + 21);
  });
});

describe('parseProducedItems — JSON array OR newline-delimited (issue #343)', () => {
  it('parses a JSON array of strings', () => {
    expect(parseProducedItems('["a","b","c"]')).toEqual(['a', 'b', 'c']);
  });
  it('parses newline-delimited output, trimming and dropping blanks', () => {
    expect(parseProducedItems('a\nb\n\n  c  \n')).toEqual(['a', 'b', 'c']);
  });
  it('coerces non-string JSON array elements to trimmed strings', () => {
    expect(parseProducedItems('[1, 2, "x", null, "  y  "]')).toEqual(['1', '2', 'x', 'y']);
  });
  it('returns [] for empty output or an empty JSON array', () => {
    expect(parseProducedItems('')).toEqual([]);
    expect(parseProducedItems('   \n  ')).toEqual([]);
    expect(parseProducedItems('[]')).toEqual([]);
  });
  it('falls back to a single line when a JSON-looking line does not parse', () => {
    expect(parseProducedItems('[not json')).toEqual(['[not json']);
  });
});

describe('produceItems — real producer command executes and parses (issue #343)', () => {
  it('runs a JSON-array producer and expands to one stage teammate per item', async () => {
    const spec: ForEachSpec = {
      produce: `printf '["a","b","c"]'`,
      agent: 'claude',
      prompt: 'do {{item}}',
    };
    const items = await produceItems(spec);
    expect(items).toEqual(['a', 'b', 'c']);

    const { teammates } = expandForEach(spec, items);
    const stages = teammates.filter((t) => t.role === 'stage');
    expect(stages).toHaveLength(3);
    expect(stages.map((t) => t.item)).toEqual(['a', 'b', 'c']);
  });

  it('runs a newline-delimited producer and expands to one stage teammate per item', async () => {
    const spec: ForEachSpec = {
      produce: `printf 'a\\nb\\nc\\n'`,
      agent: 'claude',
      prompt: 'do {{item}}',
    };
    const items = await produceItems(spec);
    expect(items).toEqual(['a', 'b', 'c']);

    const { teammates } = expandForEach(spec, items);
    expect(teammates.filter((t) => t.role === 'stage')).toHaveLength(3);
  });

  it('resolves an itemsRef via the supplied resolver, skipping the producer', async () => {
    const spec: ForEachSpec = {
      itemsRef: '${endpoints}',
      produce: `printf 'SHOULD-NOT-RUN'`,
      agent: 'claude',
      prompt: 'do {{item}}',
    };
    const items = await produceItems(spec, {
      resolveItemsRef: (ref) => (ref === '${endpoints}' ? ['x', 'y'] : undefined),
    });
    expect(items).toEqual(['x', 'y']);
  });

  it('throws when neither a producer nor a resolvable itemsRef is available', async () => {
    await expect(produceItems({ itemsRef: '${missing}', agent: 'a', prompt: 'p' }, {}))
      .rejects.toThrow(/could not be resolved/);
  });

  it('applies max_items truncation to a real producer list and surfaces the drop count', async () => {
    const spec: ForEachSpec = {
      produce: `printf '["a","b","c","d","e"]'`,
      agent: 'claude',
      prompt: 'do {{item}}',
      max_items: 2,
    };
    const items = await produceItems(spec);
    expect(items).toHaveLength(5);

    const { teammates, producedCount, usedCount, truncated } = expandForEach(spec, items);
    expect(producedCount).toBe(5);
    expect(usedCount).toBe(2);
    expect(truncated).toBe(3);
    expect(teammates.filter((t) => t.role === 'stage')).toHaveLength(2);
    expect(teammates.filter((t) => t.role === 'stage').map((t) => t.item)).toEqual(['a', 'b']);
  });
});

describe('evaluateKeepIf — vote tally gate (issue #343)', () => {
  it('all: every vote must be keep', () => {
    expect(evaluateKeepIf([true, true, true], 'all')).toBe(true);
    expect(evaluateKeepIf([true, false, true], 'all')).toBe(false);
  });
  it('any: at least one keep vote', () => {
    expect(evaluateKeepIf([false, false, true], 'any')).toBe(true);
    expect(evaluateKeepIf([false, false, false], 'any')).toBe(false);
  });
  it('majority: strictly more than half (a tie does not pass)', () => {
    expect(evaluateKeepIf([true, true, false], 'majority')).toBe(true);
    expect(evaluateKeepIf([true, false, false], 'majority')).toBe(false);
    expect(evaluateKeepIf([true, false], 'majority')).toBe(false);
    expect(evaluateKeepIf([true, true], 'majority')).toBe(true);
  });
  it('an empty panel drops the item (nothing affirms it)', () => {
    expect(evaluateKeepIf([], 'any')).toBe(false);
    expect(evaluateKeepIf([], 'all')).toBe(false);
    expect(evaluateKeepIf([], 'majority')).toBe(false);
  });
});

describe('tallyForEach — per-item gate over expanded teammates (issue #343)', () => {
  const spec: ForEachSpec = {
    agent: 'claude',
    name: 'audit',
    prompt: 'audit {{item}}',
    verify: { agent: 'skeptic', votes: 3, keep_if: 'majority' },
  };

  it('keeps the item whose panel reaches the keep_if gate, drops the other', () => {
    const items = ['keepme', 'dropme'];
    const { teammates } = expandForEach(spec, items);
    const verdicts = tallyForEach(teammates, (v) => v.item === 'keepme');
    const byItem = new Map(verdicts.map((v) => [v.item, v]));
    expect(byItem.get('keepme')!.kept).toBe(true);
    expect(byItem.get('keepme')!.votes).toEqual([true, true, true]);
    expect(byItem.get('dropme')!.kept).toBe(false);
    expect(byItem.get('dropme')!.votes).toEqual([false, false, false]);
  });

  it('keeps an item unconditionally when it has no verify panel', () => {
    const bare: ForEachSpec = { agent: 'claude', prompt: 'do {{item}}' };
    const { teammates } = expandForEach(bare, ['a']);
    const verdicts = tallyForEach(teammates, () => false);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].kept).toBe(true);
    expect(verdicts[0].votes).toEqual([]);
  });
});

describe('expandForEach stages a valid teams DAG through real persistence', () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'foreach-dag-'));
  });
  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  async function plant(team: string, t: ForEachTeammate): Promise<void> {
    const agent = new AgentProcess(
      `agent-${t.name}`,
      team,
      t.agentType as AgentType,
      t.prompt,
      null,
      'edit',
      null,
      AgentStatus.PENDING,
      new Date(),
      null,
      tmpBase,
      null, null, null, null, null, null, null,
      t.name,
      t.after,
      'medium', null, null,
      null,
    );
    await agent.saveMeta();
  }

  it('reloads the fanned-out DAG with correct --after linkage', async () => {
    const spec: ForEachSpec = {
      agent: 'auth-checker',
      name: 'audit',
      prompt: 'Audit {{item}}',
      verify: { agent: 'skeptic', votes: 2, keep_if: 'majority' },
    };
    const items = ['src/routes/a.ts', 'src/routes/b.ts'];
    const { teammates } = expandForEach(spec, items, { producerName: 'endpoints' });

    const producer = new AgentProcess(
      'agent-endpoints', 'sweep', 'claude' as AgentType, 'produce list',
      null, 'edit', null, AgentStatus.COMPLETED,
      new Date(Date.now() - 100), new Date(),
      tmpBase, null, null, null, null, null, null, null,
      'endpoints', [], 'medium', null, null, null,
    );
    await producer.saveMeta();
    for (const t of teammates) await plant('sweep', t);

    const mgr = new AgentManager(50, tmpBase);
    const loaded = await mgr.listByTask('sweep');
    const byName = new Map(loaded.map((a) => [a.name, a]));

    expect(loaded).toHaveLength(2 + 4 + 1);

    expect(byName.get('audit-1')!.after).toEqual(['endpoints']);
    expect(byName.get('audit-2')!.after).toEqual(['endpoints']);

    expect(byName.get('audit-1-verify-1')!.after).toEqual(['audit-1']);
    expect(byName.get('audit-1-verify-2')!.after).toEqual(['audit-1']);
    expect(byName.get('audit-2-verify-1')!.after).toEqual(['audit-2']);

    expect(loaded.filter((a) => a.status === AgentStatus.PENDING)).toHaveLength(6);
  });
});
