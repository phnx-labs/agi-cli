import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyPhenotype,
  classifyPhenotypeDetailed,
  deriveOutcome,
  deriveOutcomeDetailed,
  type SessionDetail,
} from './phenotype.js';

const FIXTURES_DIR = path.join(import.meta.dirname, 'testdata/sessions');
const TRACES_REAL_DIR = '/tmp/traces-real/sessions';

function loadFixture(id: string): SessionDetail {
  const filePath = path.join(FIXTURES_DIR, `${id}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as SessionDetail;
}

function listRealSessionFiles(): string[] {
  if (!fs.existsSync(TRACES_REAL_DIR)) return [];
  return fs.readdirSync(TRACES_REAL_DIR).filter((f) => f.endsWith('.json'));
}

function loadRealSessions(): SessionDetail[] {
  return listRealSessionFiles().map((f) =>
    JSON.parse(fs.readFileSync(path.join(TRACES_REAL_DIR, f), 'utf8')) as SessionDetail,
  );
}

function deriveFixture(base: SessionDetail, mutate: (s: SessionDetail) => void): SessionDetail {
  const clone = JSON.parse(JSON.stringify(base)) as SessionDetail;
  mutate(clone);
  return clone;
}

describe('classifyPhenotype', () => {
  it('flags no-tool short sessions as failure-to-act', () => {
    const session = loadFixture('00d7eed6-9ef3-4826-9780-6f0833b6a843');
    expect(classifyPhenotype(session)).toBe('failure-to-act');
    const detailed = classifyPhenotypeDetailed(session);
    expect(detailed.reason).toContain('no tool use');
  });

  it('flags write-before-read as out-of-order', () => {
    const session = loadFixture('01a004a4-7b1b-7d33-b47b-5a7a32a945a1');
    expect(classifyPhenotype(session)).toBe('out-of-order');
    expect(classifyPhenotypeDetailed(session).reason).toContain('preceded any read/plan');
  });

  it('flags completed engineering work without verification as premature-completion', () => {
    const session = loadFixture('01a0306a-7811-7543-8fb0-2ee0ce952dd6');
    expect(classifyPhenotype(session)).toBe('premature-completion');
    expect(classifyPhenotypeDetailed(session).reason).toContain('without a test/build/lint verification step');
  });

  it('flags errored sessions ending in error as false-termination', () => {
    const session = loadFixture('03c6dd37-089f-42ce-8f6f-8c40c5d6f798');
    expect(classifyPhenotype(session)).toBe('false-termination');
    expect(classifyPhenotypeDetailed(session).reason).toContain('ended in error');
  });

  it('returns null for clean, ordered, verified sessions', () => {
    const session = loadFixture('019fc247-6220-7d50-a11c-975d58f1e2e1');
    expect(classifyPhenotype(session)).toBeNull();
    expect(classifyPhenotypeDetailed(session).reason).toBe('no failure phenotype matched');
  });

  it('produces a sensible distribution across the real corpus', () => {
    const sessions = loadRealSessions();
    if (sessions.length === 0) return;
    const counts: Record<string, number> = {};
    for (const session of sessions) {
      const p = classifyPhenotype(session) ?? 'null';
      counts[p] = (counts[p] ?? 0) + 1;
    }
    expect(counts['failure-to-act']).toBeGreaterThan(0);
    expect(counts['out-of-order']).toBeGreaterThan(0);
    expect(counts['premature-completion']).toBeGreaterThan(0);
    expect(counts['false-termination']).toBeGreaterThan(0);
    expect(counts['null']).toBeGreaterThan(0);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(sessions.length);
  });
});

describe('deriveOutcome', () => {
  it('returns partial for completed sessions with no landing or test signal', () => {
    const session = loadFixture('00d7eed6-9ef3-4826-9780-6f0833b6a843');
    expect(deriveOutcome(session)).toBe('partial');
    const detailed = deriveOutcomeDetailed(session);
    expect(detailed.confidence).toBe('low');
    expect(detailed.reason).toContain('without a landing or test signal');
  });

  it('returns merged when a shell step actually runs a merge command', () => {
    const session = loadFixture('01a03a4f-cd04-7970-9294-ecef5e6d58b9');
    expect(deriveOutcome(session)).toBe('merged');
    const detailed = deriveOutcomeDetailed(session);
    expect(detailed.confidence).toBe('high');
    expect(detailed.reason).toContain('explicit merge signal');
  });

  it('returns tests-green when a shell step actually runs a test binary', () => {
    const session = loadFixture('019fd5d1-64fa-70c3-a443-d816ac386c1f');
    expect(deriveOutcome(session)).toBe('tests-green');
    const detailed = deriveOutcomeDetailed(session);
    expect(detailed.outcome).toBe('tests-green');
    expect(detailed.confidence).toBe('medium');
  });

  it('returns abandoned for errored sessions with long stalls and no recovery', () => {
    const session = loadFixture('03c6dd37-089f-42ce-8f6f-8c40c5d6f798');
    expect(deriveOutcome(session)).toBe('abandoned');
    const detailed = deriveOutcomeDetailed(session);
    expect(detailed.confidence).toBe('medium');
    expect(detailed.reason).toContain('long stall');
  });

  it('returns human-takeover when the final substantive step asks the human', () => {
    const base = loadFixture('019fc247-6220-7d50-a11c-975d58f1e2e1');
    const session = deriveFixture(base, (s) => {
      const last = s.steps.filter((step) => step.kind === 'tool').pop();
      if (last) {
        last.tool = 'AskUserQuestion';
        last.lane = 'AskUserQuestion';
      }
    });
    expect(deriveOutcome(session)).toBe('human-takeover');
    expect(deriveOutcomeDetailed(session).reason).toContain('AskUserQuestion');
  });

  it('returns invalid-env when environment errors dominate', () => {
    const base = loadFixture('03c6dd37-089f-42ce-8f6f-8c40c5d6f798');
    const session = deriveFixture(base, (s) => {
      s.meta.outcome = 'errored';
      s.meta.errorCount = 4;
      s.steps = [
        { ordinal: 1, kind: 'tool', tool: 'Bash', lane: 'Bash', startMs: 0, durationMs: 1000, durationEstimated: false, outcome: 'error', label: 'bun install 2>&1 | tail -6' },
        { ordinal: 2, kind: 'tool', tool: 'Bash', lane: 'Bash', startMs: 1000, durationMs: 1000, durationEstimated: false, outcome: 'error', label: 'npm install 2>&1 | tail -6' },
        { ordinal: 3, kind: 'tool', tool: 'Bash', lane: 'Bash', startMs: 2000, durationMs: 1000, durationEstimated: false, outcome: 'error', label: 'git clone ... 2>&1 | tail -6' },
        { ordinal: 4, kind: 'tool', tool: 'Read', lane: 'Read', startMs: 3000, durationMs: 100, durationEstimated: false, outcome: 'ok', label: 'read package.json' },
      ];
    });
    expect(deriveOutcome(session)).toBe('invalid-env');
    const detailed = deriveOutcomeDetailed(session);
    expect(detailed.confidence).toBe('medium');
    expect(detailed.reason).toContain('environment/setup');
  });

  it('produces a sensible distribution across the real corpus', () => {
    const sessions = loadRealSessions();
    if (sessions.length === 0) return;
    const counts: Record<string, number> = {};
    for (const session of sessions) {
      const o = deriveOutcome(session);
      counts[o] = (counts[o] ?? 0) + 1;
    }
    expect(counts['partial']).toBeGreaterThan(0);
    expect(counts['merged']).toBeGreaterThan(0);
    expect(counts['tests-green']).toBeGreaterThan(0);
    expect(counts['abandoned']).toBeGreaterThan(0);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(sessions.length);
  });
});
