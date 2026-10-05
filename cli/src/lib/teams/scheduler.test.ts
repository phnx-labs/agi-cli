import { describe, it, expect } from 'vitest';
import {
  resolvePlacement,
  pickLeastLoaded,
  pickBestDevice,
  cappedDevices,
  classifyExclusions,
  NoViableDeviceError,
  isTransientPlacementBlock,
  formatNoViableMessage,
  type RosterEntry,
  type DevicePlacementSignal,
} from './scheduler.js';
import { machineId } from '../machine-id.js';

const running = (hostName: string | null): RosterEntry => ({ hostName, status: 'running' });
const done = (hostName: string | null): RosterEntry => ({ hostName, status: 'completed' });

const sig = (m: Record<string, DevicePlacementSignal>): Map<string, DevicePlacementSignal> =>
  new Map(Object.entries(m));

describe('resolvePlacement cascade', () => {
  it('1. explicit pin wins even with no pool', () => {
    expect(resolvePlacement({}, 'box-a', [])).toEqual({ device: 'box-a' });
  });

  it('1. explicit pin wins over a pool', () => {
    expect(resolvePlacement({ devices: ['box-a', 'box-b'] }, 'box-b', [])).toEqual({ device: 'box-b' });
  });

  it('4. no pin + no pool uses the active worker pool and never falls back local', () => {
    expect(resolvePlacement({}, null, [], { defaultDevices: ['worker-a', 'worker-b'] })).toEqual({ device: 'worker-a' });
    expect(() => resolvePlacement({ devices: [] }, null, [], { defaultDevices: [] })).toThrow(/No viable device/);
  });

  it('2. pool of one → the whole team runs there', () => {
    expect(resolvePlacement({ devices: ['box-a'] }, null, [])).toEqual({ device: 'box-a' });
  });

  it('3. pool of many → least-loaded pick', () => {
    const roster = [running('box-a')];
    expect(resolvePlacement({ devices: ['box-a', 'box-b'] }, null, roster)).toEqual({ device: 'box-b' });
  });
});

describe('pickLeastLoaded', () => {
  it('picks the device with the fewest RUNNING teammates', () => {
    const roster = [running('box-a'), running('box-a'), running('box-b')];
    expect(pickLeastLoaded(['box-a', 'box-b', 'box-c'], roster)).toBe('box-c');
  });

  it('ignores non-running teammates when counting load', () => {
    const roster = [done('box-a'), done('box-a'), running('box-b')];
    expect(pickLeastLoaded(['box-a', 'box-b'], roster)).toBe('box-a');
  });

  it('breaks ties by pool order (first declared wins)', () => {
    expect(pickLeastLoaded(['box-a', 'box-b'], [])).toBe('box-a');
    expect(pickLeastLoaded(['box-b', 'box-a'], [])).toBe('box-b');
  });

  it('ignores roster entries for devices outside the pool', () => {
    const roster = [running('retired-host'), running('box-a')];
    expect(pickLeastLoaded(['box-a', 'box-b'], roster)).toBe('box-b');
  });

  it('throws on an empty pool (caller must guard)', () => {
    expect(() => pickLeastLoaded([], [])).toThrow(/empty device pool/);
  });
});

describe('agents.max-concurrent caps (auto-pick only)', () => {
  it('excludes a device at its cap from the least-loaded pick', () => {
    const roster = [running('box-a'), running('box-a')];
    expect(pickLeastLoaded(['box-a', 'box-b'], roster, { 'box-a': 2 })).toBe('box-b');
  });

  it('keeps a device under its cap eligible', () => {
    const roster = [running('box-a')];
    expect(pickLeastLoaded(['box-a', 'box-b'], roster, { 'box-a': 2 })).toBe('box-b');
    const busier = [running('box-a'), running('box-b'), running('box-b')];
    expect(pickLeastLoaded(['box-a', 'box-b'], busier, { 'box-a': 2 })).toBe('box-a');
  });

  it('throws naming each cap and the fix when every device is capped', () => {
    const roster = [running('box-a'), running('box-a'), running('box-b')];
    expect(() => pickLeastLoaded(['box-a', 'box-b'], roster, { 'box-a': 2, 'box-b': 1 }))
      .toThrow(/agents\.max-concurrent cap: box-a \(2\/2\), box-b \(1\/1\)/);
    expect(() => pickLeastLoaded(['box-a', 'box-b'], roster, { 'box-a': 2, 'box-b': 1 }))
      .toThrow(/agents devices config <name> agents\.max-concurrent N/);
  });

  it('classifies capacity and load blocks as retryable but install failures as durable', () => {
    expect(isTransientPlacementBlock(new NoViableDeviceError([
      { device: 'box-a', reason: 'capped', detail: '1/1' },
      { device: 'box-b', reason: 'not-installed' },
    ]))).toBe(true);
    expect(isTransientPlacementBlock(new NoViableDeviceError([
      { device: 'box-a', reason: 'not-installed' },
    ]))).toBe(false);
  });

  it('cappedDevices reports the exclusion reason with live counts', () => {
    const roster = [running('box-a'), running('box-a'), done('box-b')];
    expect(cappedDevices(['box-a', 'box-b'], roster, { 'box-a': 2, 'box-b': 1 })).toEqual([
      { device: 'box-a', running: 2, cap: 2 },
    ]);
  });

  it('resolvePlacement passes caps through the least-loaded step', () => {
    const roster = [running('box-a')];
    expect(
      resolvePlacement({ devices: ['box-a', 'box-b'] }, null, roster, { maxConcurrent: { 'box-a': 1 } }),
    ).toEqual({ device: 'box-b' });
  });

  it('never second-guesses an explicit pin, even onto a capped device', () => {
    const roster = [running('box-a')];
    expect(
      resolvePlacement({ devices: ['box-a', 'box-b'] }, 'box-a', roster, { maxConcurrent: { 'box-a': 1 } }),
    ).toEqual({ device: 'box-a' });
  });

  it('never second-guesses a pool of one, even when capped', () => {
    const roster = [running('box-a')];
    expect(
      resolvePlacement({ devices: ['box-a'] }, null, roster, { maxConcurrent: { 'box-a': 1 } }),
    ).toEqual({ device: 'box-a' });
  });
});

describe('local teammates count against the local pool member', () => {
  it('a cap on the local device engages once local teammates reach it', () => {
    const self = machineId();
    const roster = [running(null), running(null)];
    expect(pickLeastLoaded([self, 'box-b'], roster, { [self]: 2 })).toBe('box-b');
  });

  it('mixed local + remote pool counts both sides', () => {
    const self = machineId();
    const roster = [running(null), running('box-b'), running('box-b')];
    expect(pickLeastLoaded([self, 'box-b'], roster)).toBe(self);
    expect(cappedDevices([self, 'box-b'], roster, { [self]: 1 })).toEqual([
      { device: self, running: 1, cap: 1 },
    ]);
  });

  it('an empty-string hostName is local too', () => {
    const self = machineId();
    const roster: RosterEntry[] = [{ hostName: '', status: 'running' }];
    expect(pickLeastLoaded([self, 'box-b'], roster, { [self]: 1 })).toBe('box-b');
  });

  it('ignores a local teammate when this machine is not in the pool', () => {
    const roster = [running(null), running('box-b')];
    expect(pickLeastLoaded(['box-a', 'box-b'], roster)).toBe('box-a');
  });
});

describe('classifyExclusions — health/harness filters (RUSH-2002)', () => {
  it('excludes an unreachable device, keeps reachable ones', () => {
    const { eligible, excluded } = classifyExclusions(['box-a', 'box-b'], [], {
      signals: sig({ 'box-a': { reachable: false }, 'box-b': { reachable: true } }),
    });
    expect(eligible).toEqual(['box-b']);
    expect(excluded).toEqual([{ device: 'box-a', reason: 'unreachable' }]);
  });

  it('excludes an overloaded (headroom=loaded) device', () => {
    const { eligible, excluded } = classifyExclusions(['box-a', 'box-b'], [], {
      signals: sig({ 'box-a': { headroom: 'loaded' }, 'box-b': { headroom: 'idle' } }),
    });
    expect(eligible).toEqual(['box-b']);
    expect(excluded).toEqual([{ device: 'box-a', reason: 'overloaded' }]);
  });

  it('excludes a device the agent is not installed on', () => {
    const { eligible, excluded } = classifyExclusions(['box-a', 'box-b'], [], {
      signals: sig({ 'box-a': { installed: false }, 'box-b': { installed: true } }),
    });
    expect(eligible).toEqual(['box-b']);
    expect(excluded).toEqual([{ device: 'box-a', reason: 'not-installed' }]);
  });

  it('folds the cap check in alongside signals, with running/cap detail', () => {
    const roster = [running('box-a'), running('box-a')];
    const { eligible, excluded } = classifyExclusions(['box-a', 'box-b'], roster, {
      maxConcurrent: { 'box-a': 2 },
      signals: sig({ 'box-a': { reachable: true }, 'box-b': { reachable: true } }),
    });
    expect(eligible).toEqual(['box-b']);
    expect(excluded).toEqual([{ device: 'box-a', reason: 'capped', detail: '2/2' }]);
  });

  it('a device with no signal is neither excluded nor filtered', () => {
    const { eligible, excluded } = classifyExclusions(['box-a', 'box-b'], [], {
      signals: sig({ 'box-a': { reachable: false } }),
    });
    expect(eligible).toEqual(['box-b']);
    expect(excluded).toEqual([{ device: 'box-a', reason: 'unreachable' }]);
  });

  it('reports the most fundamental blocker first (unreachable over not-installed)', () => {
    const { excluded } = classifyExclusions(['box-a'], [], {
      signals: sig({ 'box-a': { reachable: false, installed: false } }),
    });
    expect(excluded).toEqual([{ device: 'box-a', reason: 'unreachable' }]);
  });
});

describe('pickBestDevice — health/harness/load ranking (RUSH-2002)', () => {
  it('prefers a signed-in device over a merely installed one', () => {
    const signals = sig({
      'box-a': { installed: true, signedIn: false, headroom: 'idle' },
      'box-b': { installed: true, signedIn: true, headroom: 'idle' },
    });
    expect(pickBestDevice(['box-a', 'box-b'], [], { signals })).toBe('box-b');
  });

  it('prefers a less-loaded device (headroom tier) over a busier one', () => {
    const signals = sig({
      'box-a': { headroom: 'busy' },
      'box-b': { headroom: 'idle' },
    });
    expect(pickBestDevice(['box-a', 'box-b'], [], { signals })).toBe('box-b');
  });

  it('a preferred device outranks a less-loaded non-preferred one', () => {
    const signals = sig({
      'box-a': { headroom: 'busy' },
      'box-b': { headroom: 'idle' },
    });
    expect(pickBestDevice(['box-a', 'box-b'], [], { signals })).toBe('box-b');
    expect(pickBestDevice(['box-a', 'box-b'], [], { signals, preferred: new Set(['box-a']) })).toBe('box-a');
  });

  it('a signed-out preferred device does NOT jump ahead of a signed-in one', () => {
    const signals = sig({
      'box-a': { installed: true, signedIn: false, headroom: 'idle' },
      'box-b': { installed: true, signedIn: true, headroom: 'idle' },
    });
    expect(pickBestDevice(['box-a', 'box-b'], [], { signals, preferred: new Set(['box-a']) })).toBe('box-b');
  });

  it('with two preferred devices the load tiebreak still decides between them', () => {
    const signals = sig({
      'box-a': { headroom: 'busy' },
      'box-b': { headroom: 'idle' },
    });
    expect(pickBestDevice(['box-a', 'box-b'], [], { signals, preferred: new Set(['box-a', 'box-b']) })).toBe('box-b');
  });

  it('load tier outranks teammate count', () => {
    const roster = [running('box-a')];
    const signals = sig({
      'box-a': { headroom: 'idle' },
      'box-b': { headroom: 'busy' },
    });
    expect(pickBestDevice(['box-a', 'box-b'], roster, { signals })).toBe('box-a');
  });

  it('within the same headroom tier, fewer running teammates wins', () => {
    const roster = [running('box-a')];
    const signals = sig({
      'box-a': { headroom: 'idle' },
      'box-b': { headroom: 'idle' },
    });
    expect(pickBestDevice(['box-a', 'box-b'], roster, { signals })).toBe('box-b');
  });

  it('same tier + same teammates → lower raw load cost wins', () => {
    const signals = sig({
      'box-a': { headroom: 'light', loadPercent: 30 },
      'box-b': { headroom: 'light', loadPercent: 20 },
    });
    expect(pickBestDevice(['box-a', 'box-b'], [], { signals })).toBe('box-b');
  });

  it('an unprobed box ranks between light and busy', () => {
    const signals = sig({ 'box-a': { headroom: 'busy' } });
    expect(pickBestDevice(['box-a', 'box-b'], [], { signals })).toBe('box-b');
    const signals2 = sig({ 'box-a': { headroom: 'light' } });
    expect(pickBestDevice(['box-a', 'box-b'], [], { signals: signals2 })).toBe('box-a');
  });

  it('throws NoViableDeviceError naming each reason when nothing survives', () => {
    const signals = sig({
      'box-a': { reachable: false },
      'box-b': { headroom: 'loaded' },
    });
    let caught: unknown;
    try {
      pickBestDevice(['box-a', 'box-b'], [], { signals, agentLabel: 'claude@2.1.112' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NoViableDeviceError);
    const err = caught as NoViableDeviceError;
    expect(err.excluded).toEqual([
      { device: 'box-a', reason: 'unreachable' },
      { device: 'box-b', reason: 'overloaded' },
    ]);
    expect(err.message).toContain('box-a (unreachable)');
    expect(err.message).toContain('box-b (overloaded)');
  });

  it('an ALL-UNREACHABLE pool degrades (does not throw) — a probe miss, not proof', () => {
    const roster = [running('box-a')];
    const signals = sig({ 'box-a': { reachable: false }, 'box-b': { reachable: false } });
    expect(pickBestDevice(['box-a', 'box-b'], roster, { signals, agentLabel: 'claude' })).toBe(
      'box-b',
    );
  });

  it('unreachable MIXED with a hard reason still fails loud', () => {
    const signals = sig({ 'box-a': { reachable: false }, 'box-b': { installed: false } });
    expect(() =>
      pickBestDevice(['box-a', 'box-b'], [], { signals, agentLabel: 'claude@2.1.112' }),
    ).toThrow(NoViableDeviceError);
  });

  it('fail-loud message for an all-not-installed pool names the agent + accounts hint', () => {
    const msg = formatNoViableMessage(
      [
        { device: 'box-a', reason: 'not-installed' },
        { device: 'box-b', reason: 'not-installed' },
      ],
      'claude@2.1.112',
    );
    expect(msg).toContain('No device in the team pool can run claude@2.1.112.');
    expect(msg).toContain('agents devices ping');
  });
});

describe('resolvePlacement with live signals (RUSH-2002)', () => {
  it('many-device pool picks the best viable device', () => {
    const signals = sig({
      'box-a': { reachable: true, headroom: 'busy', installed: true },
      'box-b': { reachable: true, headroom: 'idle', installed: true },
    });
    expect(resolvePlacement({ devices: ['box-a', 'box-b'] }, null, [], { signals })).toEqual({
      device: 'box-b',
    });
  });

  it('many-device pool fails loud (throws) when no device can run the agent', () => {
    const signals = sig({
      'box-a': { installed: false },
      'box-b': { installed: false },
    });
    expect(() =>
      resolvePlacement({ devices: ['box-a', 'box-b'] }, null, [], {
        signals,
        agentLabel: 'claude@2.1.112',
      }),
    ).toThrow(NoViableDeviceError);
  });

  it('pool of one fails loud when the agent is not installed there', () => {
    const signals = sig({ 'box-a': { installed: false } });
    expect(() =>
      resolvePlacement({ devices: ['box-a'] }, null, [], { signals, agentLabel: 'claude@2.1.112' }),
    ).toThrow(/No device in the team pool can run claude@2.1.112/);
  });

  it('pool of one is respected for load/reachability (only harness fails it)', () => {
    const signals = sig({ 'box-a': { installed: true, headroom: 'loaded' } });
    expect(resolvePlacement({ devices: ['box-a'] }, null, [], { signals })).toEqual({
      device: 'box-a',
    });
  });

  it('an explicit pin is never second-guessed, even when signals mark it unusable', () => {
    const signals = sig({ 'box-a': { installed: false, reachable: false } });
    expect(resolvePlacement({ devices: ['box-a', 'box-b'] }, 'box-a', [], { signals })).toEqual({
      device: 'box-a',
    });
  });

  it('an all-unreachable pool does NOT fail loud — it degrades to a placement', () => {
    const signals = sig({ 'box-a': { reachable: false }, 'box-b': { reachable: false } });
    const { device } = resolvePlacement({ devices: ['box-a', 'box-b'] }, null, [], {
      signals,
      agentLabel: 'claude@2.1.112',
    });
    expect(device).not.toBeNull();
    expect(['box-a', 'box-b']).toContain(device);
  });

  it('without signals, a many-device pool stays the pure roster-count pick', () => {
    const roster = [running('box-a')];
    expect(resolvePlacement({ devices: ['box-a', 'box-b'] }, null, roster)).toEqual({
      device: 'box-b',
    });
  });
});


describe('classifyExclusions separates a timeout from an outage (PHNX-3682)', () => {
  it('labels a timed-out probe probe-timed-out, not unreachable', () => {
    const { eligible, excluded } = classifyExclusions(['m1', 'm2'], [], {
      signals: new Map([
        ['m1', { reachable: false, timedOut: true }],
        ['m2', { reachable: false }],
      ]),
    });
    expect(eligible).toEqual([]);
    expect(excluded).toContainEqual({ device: 'm1', reason: 'probe-timed-out' });
    expect(excluded).toContainEqual({ device: 'm2', reason: 'unreachable' });
  });

  it('never places a timed-out device', () => {
    const { eligible } = classifyExclusions(['slow', 'ok'], [], {
      signals: new Map([
        ['slow', { reachable: false, timedOut: true, loadPercent: 0 }],
        ['ok', { reachable: true, headroom: 'idle', loadPercent: 80 }],
      ]),
    });
    expect(eligible).toEqual(['ok']);
  });
});
