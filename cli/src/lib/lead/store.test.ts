import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appendHistory, appendLog, readHistory, readSessionState, writeSessionState, clearSessionState } from './store.js';
import { ensureLeadDir } from './paths.js';

const turn = (n: number) => ({
  turn: `t_${n}`, at: new Date(0).toISOString(), ask: 'q', text: 'a', summary: 'a', refs: [], session: 's', timing: { boot: 0, model: 1, tools: 0 },
});

describe('Lead store', () => {
  it('round-trips session.json and clears it', () => {
    const p = ensureLeadDir('store-demo');
    expect(readSessionState(p)).toBeNull();
    writeSessionState(p, { sessionId: 's', model: 'sonnet', startedAtMs: 1, turns: 0, briefed: false, brief: [] });
    expect(readSessionState(p)?.sessionId).toBe('s');
    clearSessionState(p);
    expect(readSessionState(p)).toBeNull();
  });

  it('skips a torn history line and honours --limit', () => {
    const p = ensureLeadDir('store-torn');
    appendHistory(p, turn(1));
    fs.appendFileSync(p.history, '{"turn":"t_2","at"');
    fs.appendFileSync(p.history, '\n');
    appendHistory(p, turn(3));
    expect(readHistory(p).map((t) => t.turn)).toEqual(['t_1', 't_3']);
    expect(readHistory(p, 1).map((t) => t.turn)).toEqual(['t_3']);
  });

  it('rotates history and the host log past their size caps', () => {
    const p = ensureLeadDir('store-cap');
    appendHistory(p, turn(1), 10);
    appendHistory(p, turn(2), 10);
    expect(readHistory(p).map((t) => t.turn)).toEqual(['t_2']);
    expect(fs.existsSync(`${p.history}.1`)).toBe(true);
    appendLog(p, 'x'.repeat(20), 10);
    appendLog(p, 'second', 10);
    expect(fs.readFileSync(p.log, 'utf-8')).toBe('second\n');
  });
});
