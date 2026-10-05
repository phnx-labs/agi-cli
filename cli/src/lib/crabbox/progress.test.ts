import { describe, it, expect, vi } from 'vitest';
import {
  createLeaseOutputRouter,
  createSpinner,
  LEASE_AGENT_MARKER,
  leasePhaseSentinel,
  renderStepLine,
  type LeaseStep,
} from './progress.js';

function fakeStream(isTTY: boolean) {
  const writes: string[] = [];
  return { isTTY, write: (s: string) => { writes.push(s); return true; }, writes };
}

describe('createSpinner', () => {
  it('writes exactly one line per tick and nowhere else — cannot storm on update()', () => {
    vi.useFakeTimers();
    try {
      const s = fakeStream(true);
      const spin = createSpinner({ stream: s, intervalMs: 100 });
      spin.start('warming');
      const afterStart = s.writes.length;
      for (let i = 0; i < 100_000; i++) spin.update(`line ${i}`);
      expect(s.writes.length).toBe(afterStart);
      vi.advanceTimersByTime(350);
      expect(s.writes.length - afterStart).toBe(3);
      spin.stopAndPersist('✔', 'done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('on a non-TTY prints each phase label once and stays silent on update (no flood)', () => {
    const s = fakeStream(false);
    const spin = createSpinner({ stream: s });
    spin.start('warming');
    for (let i = 0; i < 1000; i++) spin.update(`x ${i}`);
    spin.stopAndPersist('✔', 'ready');
    expect(s.writes.join('')).toBe('warming\n✔ ready\n');
  });

  it('stop() clears the timer so no writes happen afterward', () => {
    vi.useFakeTimers();
    try {
      const s = fakeStream(true);
      const spin = createSpinner({ stream: s, intervalMs: 50 });
      spin.start('x');
      spin.stop();
      const n = s.writes.length;
      vi.advanceTimersByTime(500);
      expect(s.writes.length).toBe(n);
      expect(spin.active).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

function run(chunks: string[]) {
  const setup: string[] = [];
  let agent = '';
  const r = createLeaseOutputRouter({
    onSetupLine: (l) => setup.push(l),
    onAgentChunk: (c) => (agent += c),
  });
  for (const c of chunks) r.push(c);
  r.end();
  return { setup, agent, sawAgent: r.sawAgent(), captured: r.setupLines() };
}

describe('createLeaseOutputRouter', () => {
  it('routes lines before the marker to setup, and text after it to the agent', () => {
    const { setup, agent, sawAgent } = run([
      'syncing...\n',
      'still syncing after 15s...\n',
      `${LEASE_AGENT_MARKER}\n`,
      'LOGIN_OK\n',
    ]);
    expect(setup).toEqual(['syncing...', 'still syncing after 15s...']);
    expect(agent).toBe('LOGIN_OK\n');
    expect(sawAgent).toBe(true);
  });

  it('never prints the marker line itself', () => {
    const { setup, agent } = run([`before\n${LEASE_AGENT_MARKER}\nafter\n`]);
    expect(setup).toEqual(['before']);
    expect(agent).toBe('after\n');
    expect(agent).not.toContain(LEASE_AGENT_MARKER);
    expect(setup.join('\n')).not.toContain(LEASE_AGENT_MARKER);
  });

  it('handles the marker split across chunk boundaries', () => {
    const half = LEASE_AGENT_MARKER.slice(0, 10);
    const rest = LEASE_AGENT_MARKER.slice(10);
    const { setup, agent } = run(['setup line\n', half, `${rest}\n`, 'agent out']);
    expect(setup).toEqual(['setup line']);
    expect(agent).toBe('agent out');
  });

  it('flushes agent text that arrives on the same line-buffer as the marker', () => {
    const { agent } = run([`${LEASE_AGENT_MARKER}\ninstant reply\n`]);
    expect(agent).toBe('instant reply\n');
  });

  it('streams every post-marker chunk raw (not line-buffered)', () => {
    const { agent } = run([`${LEASE_AGENT_MARKER}\n`, 'partial', ' more', '\ndone']);
    expect(agent).toBe('partial more\ndone');
  });

  it('captures setup lines and reports no agent when the marker never arrives (setup failure)', () => {
    const { setup, agent, sawAgent, captured } = run([
      'installing node...\n',
      'lease bootstrap: agents-cli install failed\n',
    ]);
    expect(sawAgent).toBe(false);
    expect(agent).toBe('');
    expect(captured).toEqual(setup);
    expect(captured).toContain('lease bootstrap: agents-cli install failed');
  });

  it('drops blank/whitespace-only setup lines but keeps real ones', () => {
    const { setup } = run(['\n', '  \n', 'real\n', '\r\n']);
    expect(setup).toEqual(['real']);
  });
});

function runSteps(chunks: string[], now?: () => number) {
  const setup: string[] = [];
  const steps: LeaseStep[] = [];
  let agent = '';
  const r = createLeaseOutputRouter({
    onSetupLine: (l) => setup.push(l),
    onAgentChunk: (c) => (agent += c),
    onStep: (s) => steps.push(s),
    now,
  });
  for (const c of chunks) r.push(c);
  r.end();
  return { setup, steps, agent, captured: r.steps() };
}

describe('createLeaseOutputRouter phase steps', () => {
  it('parses phase sentinels into structured steps and swallows the sentinel lines', () => {
    const { setup, steps, captured } = runSteps([
      `${leasePhaseSentinel('sync')}\n`,
      'installing node...\n',
      `${leasePhaseSentinel('install')}\n`,
      `${leasePhaseSentinel('runtime')}\n`,
    ]);
    expect(steps.map((s) => s.name)).toEqual(['sync', 'install', 'runtime']);
    expect(captured).toEqual(steps);
    expect(setup).toEqual(['installing node...']);
    expect(setup.join('\n')).not.toContain('___PHASE_');
  });

  it('handles a phase sentinel split across chunk boundaries', () => {
    const s = leasePhaseSentinel('creds');
    const { steps } = runSteps([s.slice(0, 6), `${s.slice(6)}\n`]);
    expect(steps.map((x) => x.name)).toEqual(['creds']);
  });

  it('does not misfire on the agent marker (shares ___ but not ___PHASE_)', () => {
    const { steps, agent } = runSteps([`${leasePhaseSentinel('creds')}\n`, `${LEASE_AGENT_MARKER}\n`, 'out\n']);
    expect(steps.map((s) => s.name)).toEqual(['creds']);
    expect(agent).toBe('out\n');
  });

  it('attaches elapsedMs from an injected clock, and omits it without one', () => {
    const ticks = [1000, 1200, 1700];
    let i = 0;
    const { steps } = runSteps(
      [`${leasePhaseSentinel('sync')}\n`, `${leasePhaseSentinel('install')}\n`],
      () => ticks[i++],
    );
    expect(steps.map((s) => s.elapsedMs)).toEqual([200, 500]);

    const { steps: noClock } = runSteps([`${leasePhaseSentinel('sync')}\n`]);
    expect(noClock[0].elapsedMs).toBeUndefined();
  });
});

describe('renderStepLine', () => {
  it('renders a human label for known phases', () => {
    expect(renderStepLine({ name: 'sync' })).toBe('Syncing workspace');
    expect(renderStepLine({ name: 'copy-setup' })).toBe('Copying your setup');
    expect(renderStepLine({ name: 'joined-tailnet' })).toBe('Joined tailnet');
  });

  it('falls back to the raw name for unknown phases', () => {
    expect(renderStepLine({ name: 'mystery' })).toBe('mystery');
  });

  it('appends detail and human-readable elapsed', () => {
    expect(renderStepLine({ name: 'install', detail: 'node v22', elapsedMs: 3400 })).toBe(
      'Installing agents-cli — node v22 (3.4s)',
    );
    expect(renderStepLine({ name: 'sync', elapsedMs: 65_000 })).toBe('Syncing workspace (1m 5s)');
  });
});
