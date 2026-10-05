import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  classifyAsk,
  classifyBlock,
  filterBlocksForFeed,
  suppressStallBlock,
  suppressionDigest,
} from './ask-classifier.js';
import { blockIdForSession, listBlocks, publishBlock, type OpenBlock } from './feed/feed.js';
import { drain, mailboxDir } from './mailbox.js';

function makeBlock(sessionId: string, text: string, over?: Partial<OpenBlock>): OpenBlock {
  return {
    blockId: blockIdForSession(sessionId),
    sessionId,
    mailboxId: sessionId,
    host: 'zion',
    runtime: 'claude',
    ts: new Date().toISOString(),
    questions: [{ text }],
    ...over,
  };
}

describe('classifyAsk', () => {
  it('classifies stalls: should I / what next / looks good', () => {
    expect(classifyAsk('Should I keep going?').class).toBe('stall');
    expect(classifyAsk("What's next?").class).toBe('stall');
    expect(classifyAsk('Looks good?').class).toBe('stall');
    expect(classifyAsk('want me to continue?').suppress).toBe(true);
  });

  it('classifies approvals for merge/release', () => {
    expect(classifyAsk('Merge now?').class).toBe('approval');
    expect(classifyAsk('Ship it?').class).toBe('approval');
    expect(classifyAsk('Merge now?').suppress).toBe(false);
  });

  it('classifies clarifications for which-X facts', () => {
    expect(classifyAsk('Which repo should this land in?').class).toBe('clarification');
  });

  it('classifies decisions for scope/approach and never suppresses agent-tagged decisions', () => {
    expect(classifyAsk('Which approach for the auth rewrite?').class).toBe('decision');
    const c = classifyAsk('Should I keep going?', { blockClass: 'decision' });
    expect(c.class).toBe('decision');
    expect(c.suppress).toBe(false);
  });

  it('defaults unknown text to decision (no silent drop)', () => {
    expect(classifyAsk('How do we feel about this brand voice?').class).toBe('decision');
  });
});

describe('filterBlocksForFeed', () => {
  it('attributes every block to exactly one class and surfaces non-stalls', () => {
    const blocks = [
      makeBlock('a', 'Should I continue?'),
      makeBlock('b', 'Which approach for the rewrite?'),
      makeBlock('c', 'Merge now?'),
      makeBlock('d', 'Which repo?'),
    ];
    const r = filterBlocksForFeed(blocks, { apply: false });
    expect(r.counts.stall).toBe(1);
    expect(r.counts.decision).toBe(1);
    expect(r.counts.approval).toBe(1);
    expect(r.counts.clarification).toBe(1);
    expect(r.surfaced.map((b) => b.sessionId).sort()).toEqual(['b', 'c', 'd']);
    expect(r.suppressed).toHaveLength(1);
  });

  it('applies suppression: removes stall from the feed store', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-class-'));
    const mailboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-class-mailbox-'));
    const stall = makeBlock('stall-1', 'Should I keep going on this?');
    publishBlock(stall, dir);
    expect(listBlocks(dir)).toHaveLength(1);

    const r = suppressStallBlock(stall, dir, mailboxRoot);
    expect(r.suppressed).toBe(true);
    expect(r.autoAnswer).toMatch(/continue/i);
    expect(listBlocks(dir)).toHaveLength(0);
    expect(drain(mailboxDir('stall-1', mailboxRoot)).map((m) => m.text)).toEqual(['Yes, continue.']);
  });

  it('suppressionDigest summarizes auto-resolved stalls', () => {
    const r = filterBlocksForFeed([
      makeBlock('a', 'Should I?'),
      makeBlock('b', 'What next?'),
    ], { apply: false });
    expect(suppressionDigest(r)).toMatch(/2 stalls eligible/);
  });
});

describe('classifyBlock', () => {
  it('uses the first question text + header', () => {
    const b = makeBlock('x', 'Proceed?', {
      questions: [{ header: 'Next', text: "What's next?" }],
    });
    expect(classifyBlock(b).class).toBe('stall');
  });
});
