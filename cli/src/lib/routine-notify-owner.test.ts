import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Meta } from './types.js';
import type { JobConfig, RunMeta } from './scheduling/routines.js';
import { registerChannelProvider, type ChannelProvider, type SendOptions } from './channels/registry.js';
import {
  routineFinishOwnerText,
  routineStartFailedOwnerText,
  ownerFailureDeliveryPlan,
  deliverOwnerFailure,
  notifyOwnerRoutineFinish,
  notifyOwnerRoutineStartFailed,
  __resetOwnerFailureDedup,
} from './routine-notify-owner.js';

const sent: Array<{ provider: string; text: string; opts: SendOptions }> = [];
function makeProvider(name: string, ok: boolean): ChannelProvider {
  return {
    name,
    async send(text: string, opts: SendOptions) {
      sent.push({ provider: name, text, opts });
      return { ok, channel: name, id: opts.target, error: ok ? undefined : `${name} refused` };
    },
  };
}
registerChannelProvider(makeProvider('owntest-ok', true));
registerChannelProvider(makeProvider('owntest-ok2', true));
registerChannelProvider(makeProvider('owntest-fail', false));

function meta(p: Partial<RunMeta> = {}): RunMeta {
  return {
    jobName: 'nightly',
    runId: 'r1',
    agent: 'claude',
    pid: 123,
    status: 'failed',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    exitCode: 1,
    ...p,
  };
}

function jobConfig(p: Partial<JobConfig> = {}): JobConfig {
  return { name: 'nightly', agent: 'claude', mode: 'auto', prompt: 'do it', enabled: true, ...p } as JobConfig;
}

const HOST = 'test-box';

describe('routineFinishOwnerText — failures only', () => {
  it('builds a phone-sized text for a failed run', () => {
    const t = routineFinishOwnerText(meta({ errorMessage: 'auth_failed: 401' }), HOST);
    expect(t).toBe('Routine failed: nightly\nauth_failed: 401\nagent claude · test-box');
  });

  it('reports a timeout distinctly', () => {
    const t = routineFinishOwnerText(meta({ status: 'timeout', exitCode: null }), HOST);
    expect(t).toBe('Routine failed: nightly\nTimed out\nagent claude · test-box');
  });

  it('falls back to the exit code when a failure has no message', () => {
    const t = routineFinishOwnerText(meta({ status: 'failed', exitCode: 3 }), HOST);
    expect(t).toBe('Routine failed: nightly\nExited with code 3\nagent claude · test-box');
  });

  it('labels a workflow and a command routine', () => {
    expect(routineFinishOwnerText(meta({ agent: undefined, workflow: 'deploy' }), HOST)).toContain(
      'workflow deploy · test-box',
    );
    expect(
      routineFinishOwnerText(meta({ agent: undefined, command: 'git pull' }), HOST),
    ).toContain('command · test-box');
  });

  it('stays silent (null) for a green or non-terminal run', () => {
    expect(routineFinishOwnerText(meta({ status: 'completed', exitCode: 0 }), HOST)).toBeNull();
    expect(routineFinishOwnerText(meta({ status: 'running' }), HOST)).toBeNull();
    expect(routineFinishOwnerText(meta({ status: 'missed' }), HOST)).toBeNull();
    expect(
      routineFinishOwnerText(meta({ agent: undefined, command: 'git pull', status: 'completed', exitCode: 0 }), HOST),
    ).toBeNull();
  });

  it('stays within the user-message length ceiling (<600 chars, <6 lines)', () => {
    const t = routineFinishOwnerText(meta({ errorMessage: 'x'.repeat(200) }), HOST)!;
    expect(t.length).toBeLessThan(600);
    expect(t.split('\n').length).toBeLessThan(6);
  });
});

describe('routineStartFailedOwnerText — always a failure', () => {
  it('carries the spawn error and label', () => {
    expect(routineStartFailedOwnerText(jobConfig(), 'auth_failed: revoked', HOST)).toBe(
      'Routine failed to start: nightly\nauth_failed: revoked\nagent claude · test-box',
    );
  });
});


describe('ownerFailureDeliveryPlan — primary + fallbacks, no Telegram', () => {
  let humansFile: string;
  beforeEach(() => {
    humansFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'own-plan-')), 'humans.yaml');
    process.env.AGENTS_HUMANS_FILE = humansFile;
  });
  afterEach(() => {
    delete process.env.AGENTS_HUMANS_FILE;
    fs.rmSync(path.dirname(humansFile), { recursive: true, force: true });
  });

  function writeHumans(body: string): void {
    fs.writeFileSync(humansFile, `version: 1\nowner:\n${body}`);
  }

  it('orders the policy-primary first, then the remaining channels, deduped', () => {
    writeHumans(
      `  channels:\n` +
        `    - id: owntest-ok\n      transport: rush\n      to: '+1555'\n` +
        `    - id: owntest-ok2\n      transport: openclaw\n      to: 'oc-id'\n` +
        `  policy:\n    normal: [owntest-ok]\n`,
    );
    const plan = ownerFailureDeliveryPlan({} as Meta);
    expect(plan).toEqual([
      { channel: 'owntest-ok', to: '+1555' },
      { channel: 'owntest-ok2', to: 'oc-id' },
    ]);
  });

  it('drops a Telegram channel by id and by transports mapping', () => {
    writeHumans(
      `  channels:\n` +
        `    - id: telegram\n      transport: telegram\n      to: 'tg1'\n` +
        `    - id: buzz\n      transport: x\n      to: 'buzz1'\n` +
        `    - id: owntest-ok\n      transport: rush\n      to: '+1555'\n`,
    );
    const plan = ownerFailureDeliveryPlan({ notify: { transports: { buzz: 'openclaw-telegram' } } } as Meta);
    expect(plan).toEqual([{ channel: 'owntest-ok', to: '+1555' }]);
  });

  it('excludes intrusive (voice) channels from the auto-fallback', () => {
    writeHumans(
      `  channels:\n` +
        `    - id: owntest-ok\n      transport: rush\n      to: '+1555'\n` +
        `    - id: call\n      transport: twilio\n      to: '+1911'\n      intrusive: true\n`,
    );
    const plan = ownerFailureDeliveryPlan({} as Meta);
    expect(plan).toEqual([{ channel: 'owntest-ok', to: '+1555' }]);
  });

  it('excludes an intrusive primary when policy points normal at a voice channel', () => {
    writeHumans(
      `  channels:\n` +
        `    - id: call\n      transport: twilio\n      to: '+1911'\n      intrusive: true\n` +
        `    - id: owntest-ok\n      transport: rush\n      to: '+1555'\n` +
        `  policy:\n    normal: [call]\n`,
    );
    const plan = ownerFailureDeliveryPlan({} as Meta);
    expect(plan).toEqual([{ channel: 'owntest-ok', to: '+1555' }]);
  });

  it('excludes a neutral id whose humans.yaml transport field is telegram', () => {
    writeHumans(
      `  channels:\n` +
        `    - id: buzz\n      transport: telegram\n      to: 'tg-chat'\n` +
        `    - id: owntest-ok\n      transport: rush\n      to: '+1555'\n`,
    );
    const plan = ownerFailureDeliveryPlan({} as Meta);
    expect(plan).toEqual([{ channel: 'owntest-ok', to: '+1555' }]);
  });

  it('is empty when the owner has no non-Telegram channel (silence beats Telegram)', () => {
    writeHumans(`  channels:\n    - id: telegram\n      transport: telegram\n      to: 'tg1'\n`);
    expect(ownerFailureDeliveryPlan({} as Meta)).toEqual([]);
  });

  it('is empty when no owner is configured at all', () => {
    expect(ownerFailureDeliveryPlan({} as Meta)).toEqual([]);
  });
});

describe('deliverOwnerFailure — real registry, fallback on primary failure', () => {
  let humansFile: string;
  beforeEach(() => {
    sent.length = 0;
    humansFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'own-deliver-')), 'humans.yaml');
    process.env.AGENTS_HUMANS_FILE = humansFile;
  });
  afterEach(() => {
    delete process.env.AGENTS_HUMANS_FILE;
    fs.rmSync(path.dirname(humansFile), { recursive: true, force: true });
  });

  function writeHumans(body: string): void {
    fs.writeFileSync(humansFile, `version: 1\nowner:\n${body}`);
  }

  it('delivers over the primary channel, owner-scoped', async () => {
    writeHumans(
      `  channels:\n    - id: owntest-ok\n      transport: rush\n      to: '+1555'\n  policy:\n    normal: [owntest-ok]\n`,
    );
    const r = await deliverOwnerFailure('boom', {} as Meta);
    expect(r.delivered).toBe(true);
    expect(r.channel).toBe('owntest-ok');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ provider: 'owntest-ok', text: 'boom' });
    expect(sent[0].opts).toMatchObject({ target: '+1555', ownerScoped: true });
  });

  it('falls back to the next channel when the primary refuses', async () => {
    writeHumans(
      `  channels:\n` +
        `    - id: owntest-fail\n      transport: rush\n      to: '+1555'\n` +
        `    - id: owntest-ok2\n      transport: openclaw\n      to: 'oc-id'\n` +
        `  policy:\n    normal: [owntest-fail]\n`,
    );
    const r = await deliverOwnerFailure('boom', {} as Meta);
    expect(r.delivered).toBe(true);
    expect(r.channel).toBe('owntest-ok2');
    expect(sent.map((s) => s.provider)).toEqual(['owntest-fail', 'owntest-ok2']);
    expect(r.attempts).toEqual([
      { channel: 'owntest-fail', ok: false, error: 'owntest-fail refused' },
      { channel: 'owntest-ok2', ok: true, error: undefined },
    ]);
  });

  it('reports not-delivered and sends nothing when no channel is configured', async () => {
    writeHumans(`  channels:\n    - id: telegram\n      transport: telegram\n      to: 'tg1'\n`);
    const r = await deliverOwnerFailure('boom', {} as Meta);
    expect(r.delivered).toBe(false);
    expect(r.attempts).toEqual([]);
    expect(sent).toHaveLength(0);
  });
});


describe('notifyOwnerRoutineFinish — dedup per job+runId, green stays silent', () => {
  let humansFile: string;
  beforeEach(() => {
    sent.length = 0;
    __resetOwnerFailureDedup();
    humansFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'own-finish-')), 'humans.yaml');
    process.env.AGENTS_HUMANS_FILE = humansFile;
    fs.writeFileSync(
      humansFile,
      `version: 1\nowner:\n  channels:\n    - id: owntest-ok\n      transport: rush\n      to: '+1555'\n  policy:\n    normal: [owntest-ok]\n`,
    );
  });
  afterEach(() => {
    delete process.env.AGENTS_HUMANS_FILE;
    fs.rmSync(path.dirname(humansFile), { recursive: true, force: true });
  });

  it('sends once for a failed run and dedups a repeat of the same job+runId', async () => {
    await notifyOwnerRoutineFinish(meta({ runId: 'run-A', errorMessage: 'auth_failed: 401' }));
    await notifyOwnerRoutineFinish(meta({ runId: 'run-A', errorMessage: 'auth_failed: 401' }));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Routine failed: nightly');
    expect(sent[0].text).toContain('auth_failed: 401');
  });

  it('sends again for a different runId', async () => {
    await notifyOwnerRoutineFinish(meta({ runId: 'run-A' }));
    await notifyOwnerRoutineFinish(meta({ runId: 'run-B' }));
    expect(sent).toHaveLength(2);
  });

  it('stays silent for a green run and reports no attempts', async () => {
    const r = await notifyOwnerRoutineFinish(meta({ status: 'completed', exitCode: 0 }));
    expect(sent).toHaveLength(0);
    expect(r).toEqual({ delivered: false, attempts: [] });
  });

  it('returns the delivery result so the daemon can log a total failure', async () => {
    fs.writeFileSync(
      humansFile,
      `version: 1\nowner:\n  channels:\n    - id: owntest-fail\n      transport: rush\n      to: '+1555'\n  policy:\n    normal: [owntest-fail]\n`,
    );
    const r = await notifyOwnerRoutineFinish(meta({ runId: 'run-Z', status: 'failed', exitCode: 1 }));
    expect(r.delivered).toBe(false);
    expect(r.attempts).toEqual([{ channel: 'owntest-fail', ok: false, error: 'owntest-fail refused' }]);
  });

  it('retries the same job+runId after a total delivery failure (claim released)', async () => {
    fs.writeFileSync(
      humansFile,
      `version: 1\nowner:\n  channels:\n    - id: owntest-fail\n      transport: rush\n      to: '+1555'\n  policy:\n    normal: [owntest-fail]\n`,
    );
    const first = await notifyOwnerRoutineFinish(
      meta({ runId: 'run-retry', status: 'failed', exitCode: 1, errorMessage: 'auth_failed: 401' }),
    );
    expect(first.delivered).toBe(false);
    expect(sent).toHaveLength(1);

    fs.writeFileSync(
      humansFile,
      `version: 1\nowner:\n  channels:\n    - id: owntest-ok\n      transport: rush\n      to: '+1555'\n  policy:\n    normal: [owntest-ok]\n`,
    );
    const second = await notifyOwnerRoutineFinish(
      meta({ runId: 'run-retry', status: 'failed', exitCode: 1, errorMessage: 'auth_failed: 401' }),
    );
    expect(second.delivered).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1].provider).toBe('owntest-ok');

    const third = await notifyOwnerRoutineFinish(
      meta({ runId: 'run-retry', status: 'failed', exitCode: 1, errorMessage: 'auth_failed: 401' }),
    );
    expect(third.delivered).toBe(false);
    expect(third.attempts).toEqual([]);
    expect(sent).toHaveLength(2);
  });
});

describe('notifyOwnerRoutineStartFailed — reaches the owner on a pre-spawn failure', () => {
  let humansFile: string;
  beforeEach(() => {
    sent.length = 0;
    humansFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'own-start-')), 'humans.yaml');
    process.env.AGENTS_HUMANS_FILE = humansFile;
    fs.writeFileSync(
      humansFile,
      `version: 1\nowner:\n  channels:\n    - id: owntest-ok\n      transport: rush\n      to: '+1555'\n  policy:\n    normal: [owntest-ok]\n`,
    );
  });
  afterEach(() => {
    delete process.env.AGENTS_HUMANS_FILE;
    fs.rmSync(path.dirname(humansFile), { recursive: true, force: true });
  });

  it('delivers the failed-to-start text', async () => {
    await notifyOwnerRoutineStartFailed(jobConfig(), 'auth_failed: revoked');
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Routine failed to start: nightly');
    expect(sent[0].text).toContain('auth_failed: revoked');
  });
});
