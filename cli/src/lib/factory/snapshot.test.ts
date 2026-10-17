import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildFactorySnapshot,
  FACTORY_PROJECTS,
  parseDevices,
  parsePullRequests,
  queueCounts,
  readFactoryConfig,
} from './snapshot.js';

const dirs: string[] = [];
function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-snapshot-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('factory snapshot', () => {
  it('uses documented defaults without creating factory.yml', () => {
    const dir = home();
    expect(readFactoryConfig(dir)).toMatchObject({ source: 'default', ceiling: 4, max_dispatch_per_tick: 2 });
    expect(fs.existsSync(path.join(dir, '.agents', 'factory.yml'))).toBe(false);
  });

  it('reads the documented factory.yml shape', () => {
    const dir = home();
    fs.mkdirSync(path.join(dir, '.agents'));
    fs.writeFileSync(path.join(dir, '.agents', 'factory.yml'), [
      'ceiling: 8',
      'max_dispatch_per_tick: 3',
      'per_project:',
      '  Agents CLI: { weight: 2, cap: 4 }',
      'idle_boxes: [worker-1]',
      'digest: { times: ["09:00"], tz: UTC }',
    ].join('\n'));
    expect(readFactoryConfig(dir)).toEqual({
      source: 'file', ceiling: 8, max_dispatch_per_tick: 3,
      per_project: { 'Agents CLI': { weight: 2, cap: 4 } },
      idle_boxes: ['worker-1'], digest: { times: ['09:00'], tz: 'UTC' },
    });
  });

  it('normalizes queue, pull-request, and device read models', () => {
    expect(queueCounts(
      { count: 2 },
      { issues: [
        { state: { name: 'Doing', type: 'started' } },
        { state: { name: 'Blocked', type: 'started' } },
      ] },
    )).toEqual({ todo: 2, inProgress: 1, blocked: 1 });
    expect(parsePullRequests('phnx-labs/agi-cli', [{
      number: 7, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE',
      statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    }])).toEqual([{ repo: 'phnx-labs/agi-cli', number: 7, ci: 'passing', review: 'approved', mergeable: 'mergeable' }]);
    expect(parseDevices([{ name: 'box', loadPercent: 12 }])).toEqual([{ name: 'box', load: 12, idle: true }]);
  });

  it('returns every stable section without writing to the home directory', async () => {
    const dir = home();
    const calls: string[] = [];
    const before = fs.readdirSync(dir);
    const snapshot = await buildFactorySnapshot({
      home: dir,
      now: () => new Date('2026-08-02T12:00:00.000Z'),
      activeSessions: async () => [],
      readAuth: () => ({ 'box:claude:1.0.0': { verdict: 'live', checkedAt: 1 } }),
      readDeviceStats: () => ({ box: { host: 'box', reachable: true, loadPercent: 10, fetchedAt: 1 } }),
      run: async (file, args) => {
        calls.push([file, ...args].join(' '));
        if (file === 'gh') return '[]';
        if (file === 'agents') return '[{"name":"box"}]';
        return args.includes('todo') ? '{"count":1,"issues":[]}' : '{"count":0,"issues":[]}';
      },
    });
    expect(Object.keys(snapshot)).toEqual(['generatedAt', 'sessions', 'queues', 'prs', 'devices', 'auth', 'config']);
    expect(Object.keys(snapshot.queues)).toEqual(FACTORY_PROJECTS.map((project) => project.name));
    expect(snapshot.auth).toEqual({ claude: 'live' });
    expect(snapshot.devices).toEqual([{ name: 'box', load: 10, idle: true }]);
    expect(calls).toContain('agents devices list --json');
    expect(fs.readdirSync(dir)).toEqual(before);
  });
});
