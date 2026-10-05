import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import type { JobConfig, RunMeta } from '../scheduling/routines.js';
import { assertShellSubstitutionSupported, substituteWebhookPrompt } from '../scheduling/routines.js';
import type { IncomingWebhook } from './webhook.js';

describe('handler config layer', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let eventsFile: string;
  let handlerMod: typeof import('./handlers.js');

  async function loadModule() {
    handlerMod = await import('./handlers.js');
  }

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-handlers-'));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    process.env.AGENTS_WEBHOOKS_DIR = path.join(tmpHome, '.agents', 'webhooks');
    process.env.AGENTS_SYSTEM_WEBHOOKS_DIR = path.join(tmpHome, '.agents', '.system', 'webhooks');
    process.env.AGENTS_DEVICES_DIR = path.join(tmpHome, '.agents', '.history', 'devices');
    process.env.AGENTS_ROUTINES_DIR = path.join(tmpHome, '.agents', 'routines');
    process.env.AGENTS_SYSTEM_ROUTINES_DIR = path.join(tmpHome, '.agents', '.system', 'routines');
    eventsFile = path.join(tmpHome, 'events.jsonl');
    process.env.AGENTS_EVENTS_PATH = eventsFile;
    const events = await import('../feed/events.js');
    events._resetForTest(eventsFile);
    handlerMod = await import('./handlers.js');
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    delete process.env.AGENTS_WEBHOOKS_DIR;
    delete process.env.AGENTS_SYSTEM_WEBHOOKS_DIR;
    delete process.env.AGENTS_DEVICES_DIR;
    delete process.env.AGENTS_ROUTINES_DIR;
    delete process.env.AGENTS_SYSTEM_ROUTINES_DIR;
    delete process.env.AGENTS_EVENTS_PATH;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeHandler(scope: 'user' | 'system' | 'project', name: string, content: Record<string, unknown>, projectRoot?: string) {
    let dir: string;
    if (scope === 'project') {
      if (!projectRoot) throw new Error('projectRoot required');
      dir = path.join(projectRoot, '.agents', 'webhooks');
    } else if (scope === 'system') {
      dir = process.env.AGENTS_SYSTEM_WEBHOOKS_DIR!;
    } else {
      dir = process.env.AGENTS_WEBHOOKS_DIR!;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.yml`), yaml.stringify(content), 'utf-8');
  }

  function writeRoutine(name: string, content: Record<string, unknown>) {
    const dir = process.env.AGENTS_ROUTINES_DIR!;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.yml`), yaml.stringify(content), 'utf-8');
  }

  function writeDeviceRegistry(devices: Record<string, unknown>) {
    const dir = process.env.AGENTS_DEVICES_DIR!;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify(devices), 'utf-8');
  }

  function linearWebhook(overrides: Record<string, unknown> = {}): IncomingWebhook {
    return {
      source: 'linear',
      event: 'Issue',
      payload: {
        type: 'Issue',
        action: 'update',
        webhookTimestamp: Date.now(),
        data: {
          identifier: 'RUSH-1459',
          title: 'Plan the thing',
          description: 'Details here',
          state: { name: 'Plan' },
          labels: [{ name: 'agent' }],
        },
        updatedFrom: {
          state: { name: 'Triage' },
        },
        ...overrides,
      },
    };
  }

  describe('listHandlers', () => {
    it('layers project > user > system with same-name shadowing', () => {
      writeHandler('system', 'shared', { source: 'linear', run: { agent: 'claude', prompt: 'system' } });
      writeHandler('user', 'shared', { source: 'linear', run: { agent: 'claude', prompt: 'user' } });
      const projectRoot = path.join(tmpHome, 'project');
      writeHandler('project', 'shared', { source: 'linear', run: { agent: 'claude', prompt: 'project' } }, projectRoot);

      const handlers = handlerMod.listHandlers(projectRoot);
      const shared = handlers.find((h) => h.name === 'shared');
      expect(shared).toBeDefined();
      expect(shared!.run!.prompt).toBe('project');
    });

    it('unions handlers of different names across layers', () => {
      writeHandler('user', 'user-only', { source: 'linear', run: { agent: 'claude' } });
      writeHandler('system', 'system-only', { source: 'github', run: { workflow: 'ci' } });

      const names = handlerMod.listHandlers().map((h) => h.name).sort();
      expect(names).toEqual(['system-only', 'user-only']);
    });

    it('defaults enabled to true when omitted', () => {
      writeHandler('user', 'always-on', { source: 'linear', run: { agent: 'claude' } });
      const handler = handlerMod.listHandlers().find((h) => h.name === 'always-on');
      expect(handler!.enabled).toBe(true);
    });

    it('omits disabled handlers from matches', () => {
      writeHandler('user', 'off', { source: 'linear', enabled: false, run: { agent: 'claude' } });
      const handler = handlerMod.listHandlers().find((h) => h.name === 'off');
      expect(handler).toBeDefined();
      expect(handlerMod.handlerMatchesWebhook(handler!, linearWebhook())).toBe(false);
    });
  });

  describe('handlerMatchesWebhook', () => {
    it('matches by source, event, and action', () => {
      const handler: import('./handlers.js').WebhookHandler = {
        name: 'issue-update',
        source: 'linear',
        event: 'Issue',
        action: 'update',
        run: { agent: 'claude' },
      };
      expect(handlerMod.handlerMatchesWebhook(handler, linearWebhook())).toBe(true);
      expect(handlerMod.handlerMatchesWebhook(handler, { ...linearWebhook(), event: 'Comment' })).toBe(false);
      expect(handlerMod.handlerMatchesWebhook(handler, { ...linearWebhook(), payload: { ...linearWebhook().payload, action: 'create' } })).toBe(false);
    });

    it('matches Linear stateTo and stateFrom filters', () => {
      const handler: import('./handlers.js').WebhookHandler = {
        name: 'plan-handler',
        source: 'linear',
        event: 'Issue',
        action: 'update',
        stateTo: 'Plan',
        stateFrom: 'Triage',
        run: { agent: 'claude' },
      };
      expect(handlerMod.handlerMatchesWebhook(handler, linearWebhook())).toBe(true);

      const wrongTo = linearWebhook();
      (wrongTo.payload.data as Record<string, unknown>).state = { name: 'Done' };
      expect(handlerMod.handlerMatchesWebhook(handler, wrongTo)).toBe(false);

      const wrongFrom = linearWebhook();
      wrongFrom.payload.updatedFrom = { state: { name: 'Backlog' } };
      expect(handlerMod.handlerMatchesWebhook(handler, wrongFrom)).toBe(false);
    });

    it('does not re-fire a stateTo handler on a later non-state update (RUSH-2539)', () => {
      const handler: import('./handlers.js').WebhookHandler = {
        name: 'plan-handler',
        source: 'linear',
        event: 'Issue',
        action: 'update',
        stateTo: 'Plan',
        run: { agent: 'claude' },
      };
      expect(handlerMod.handlerMatchesWebhook(handler, linearWebhook())).toBe(true);
      expect(handlerMod.handlerMatchesWebhook(handler, linearWebhook({ updatedFrom: { stateId: 'old-state-id' } }))).toBe(true);
      expect(handlerMod.handlerMatchesWebhook(handler, linearWebhook({ updatedFrom: { labelIds: ['x'] } }))).toBe(false);
      expect(handlerMod.handlerMatchesWebhook(handler, linearWebhook({ updatedFrom: undefined }))).toBe(false);
    });

    it('matches Linear teamKey and label filters', () => {
      const handler: import('./handlers.js').WebhookHandler = {
        name: 'rush-agent',
        source: 'linear',
        event: 'Issue',
        teamKey: 'RUSH',
        label: 'agent',
        run: { agent: 'claude' },
      };
      expect(handlerMod.handlerMatchesWebhook(handler, linearWebhook())).toBe(true);

      const noLabel = linearWebhook();
      (noLabel.payload.data as Record<string, unknown>).labels = [];
      expect(handlerMod.handlerMatchesWebhook(handler, noLabel)).toBe(false);
    });

    it('matches GitHub repo, branch, and label filters', () => {
      const handler: import('./handlers.js').WebhookHandler = {
        name: 'pr-handler',
        source: 'github',
        event: 'pull_request',
        repo: 'phnx-labs/agents-cli',
        branch: 'main',
        label: 'ux-approved',
        run: { agent: 'claude' },
      };
      const webhook: IncomingWebhook = {
        source: 'github',
        event: 'pull_request',
        payload: {
          action: 'labeled',
          repository: { full_name: 'phnx-labs/agents-cli' },
          label: { name: 'ux-approved' },
          pull_request: {
            base: { ref: 'main' },
            head: { ref: 'feature' },
            labels: [{ name: 'ux-approved' }],
          },
        },
      };
      expect(handlerMod.handlerMatchesWebhook(handler, webhook)).toBe(true);

      const wrongRepo: IncomingWebhook = {
        ...webhook,
        payload: { ...webhook.payload, repository: { full_name: 'other/repo' } },
      };
      expect(handlerMod.handlerMatchesWebhook(handler, wrongRepo)).toBe(false);
    });

    it('honors the devices allowlist', () => {
      const saved = process.env.AGENTS_SYNC_MACHINE_ID;
      process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
      try {
        const local: import('./handlers.js').WebhookHandler = {
          name: 'local',
          source: 'linear',
          devices: ['zion'],
          run: { agent: 'claude' },
        };
        const foreign: import('./handlers.js').WebhookHandler = {
          name: 'foreign',
          source: 'linear',
          devices: ['mac-mini'],
          run: { agent: 'claude' },
        };
        expect(handlerMod.handlerMatchesWebhook(local, linearWebhook())).toBe(true);
        expect(handlerMod.handlerMatchesWebhook(foreign, linearWebhook())).toBe(false);
      } finally {
        if (saved === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
        else process.env.AGENTS_SYNC_MACHINE_ID = saved;
      }
    });
  });

  describe('executeHandler', () => {
    it('runs an agent action with prompt substitution', async () => {
      const handler: import('./handlers.js').WebhookHandler = {
        name: 'agent-handler',
        source: 'linear',
        run: { agent: 'claude', prompt: 'Fix {{issue.identifier}}' },
      };
      const dispatched: JobConfig[] = [];
      const meta: RunMeta = {
        jobName: handler.name,
        runId: 'run-1',
        agent: 'claude',
        pid: 1,
        status: 'running',
        startedAt: new Date().toISOString(),
        completedAt: null,
        exitCode: null,
      };
      const result = await handlerMod.executeHandler(handler, linearWebhook(), {
        dispatchAgent: async (config) => {
          dispatched.push(config);
          return meta;
        },
      });
      expect(result.runId).toBe('run-1');
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0].agent).toBe('claude');
      expect(dispatched[0].prompt).toBe('Fix RUSH-1459');
    });

    it('runs a workflow action', async () => {
      const handler: import('./handlers.js').WebhookHandler = {
        name: 'wf-handler',
        source: 'linear',
        run: { workflow: 'autodev', prompt: '{{issue.title}}' },
      };
      const dispatched: JobConfig[] = [];
      await handlerMod.executeHandler(handler, linearWebhook(), {
        dispatchWorkflow: async (config) => {
          dispatched.push(config);
          return {
            jobName: handler.name,
            runId: 'run-wf',
            agent: 'claude',
            pid: 1,
            status: 'running',
            startedAt: new Date().toISOString(),
            completedAt: null,
            exitCode: null,
          };
        },
      });
      expect(dispatched[0].workflow).toBe('autodev');
      expect(dispatched[0].prompt).toBe('Plan the thing');
    });

    it('passes host placement into the dispatched job config', async () => {
      const saved = process.env.AGENTS_SYNC_MACHINE_ID;
      process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
      try {
        const handler: import('./handlers.js').WebhookHandler = {
          name: 'remote-handler',
          source: 'linear',
          host: 'mac-mini',
          run: { agent: 'claude', prompt: 'go' },
        };
        const dispatched: JobConfig[] = [];
        await handlerMod.executeHandler(handler, linearWebhook(), {
          dispatchAgent: async (config) => {
            dispatched.push(config);
            return {
              jobName: handler.name, runId: 'run-remote', agent: 'claude', pid: 1,
              status: 'running', startedAt: new Date().toISOString(),
              completedAt: null, exitCode: null,
            };
          },
        });
        expect(dispatched[0].host).toBe('mac-mini');
        expect(dispatched[0].hostStrategy).toBe('host');
      } finally {
        if (saved === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
        else process.env.AGENTS_SYNC_MACHINE_ID = saved;
      }
    });

    it('marks an agent handler webhook-dispatched so the routine activation gate cannot skip it', async () => {
      const handler: import('./handlers.js').WebhookHandler = {
        name: 'slack-agent',
        source: 'slack',
        run: { agent: 'claude', prompt: 'go' },
      };
      const dispatched: JobConfig[] = [];
      await handlerMod.executeHandler(handler, linearWebhook(), {
        dispatchAgent: async (config) => {
          dispatched.push(config);
          return {
            jobName: handler.name, runId: 'run-dispatchedby', agent: 'claude', pid: 1,
            status: 'running', startedAt: new Date().toISOString(),
            completedAt: null, exitCode: null,
          };
        },
      });
      expect(dispatched[0].dispatchedBy).toBe('webhook');

      const { replaceEnabledRoutines } = await import('../routine-activation.js');
      const { jobRunsOnThisDevice } = await import('../scheduling/routines.js');
      replaceEnabledRoutines(['some-other-routine']);
      expect(jobRunsOnThisDevice({ name: 'slack-agent' })).toBe(false);
      expect(jobRunsOnThisDevice(dispatched[0])).toBe(true);
    });

    it('passes run.env through to the dispatched job config', async () => {
      const handler: import('./handlers.js').WebhookHandler = {
        name: 'env-handler',
        source: 'linear',
        run: { agent: 'claude', prompt: 'go', env: { DEPLOY_TARGET: 'staging' } },
      };
      const dispatched: JobConfig[] = [];
      await handlerMod.executeHandler(handler, linearWebhook(), {
        dispatchAgent: async (config) => {
          dispatched.push(config);
          return {
            jobName: handler.name, runId: 'run-env', agent: 'claude', pid: 1,
            status: 'running', startedAt: new Date().toISOString(),
            completedAt: null, exitCode: null,
          };
        },
      });
      expect(dispatched[0].env).toEqual({ DEPLOY_TARGET: 'staging' });
    });

    it('anchors the dispatched agent in a project with cwd and mode', async () => {
      const handler: import('./handlers.js').WebhookHandler = {
        name: 'anchored-handler',
        source: 'linear',
        project: 'agents-cli',
        cwd: 'cli',
        mode: 'skip',
        run: { agent: 'claude', prompt: 'go' },
      };
      const dispatched: JobConfig[] = [];
      await handlerMod.executeHandler(handler, linearWebhook(), {
        dispatchAgent: async (config) => {
          dispatched.push(config);
          return {
            jobName: handler.name, runId: 'run-anchored', agent: 'claude', pid: 1,
            status: 'running', startedAt: new Date().toISOString(),
            completedAt: null, exitCode: null,
          };
        },
      });
      expect(dispatched[0].project).toBe('agents-cli');
      expect(dispatched[0].cwd).toBe('cli');
      expect(dispatched[0].mode).toBe('skip');
    });

    it('defaults dispatched mode to auto when unset', async () => {
      const handler: import('./handlers.js').WebhookHandler = {
        name: 'default-mode-handler',
        source: 'linear',
        run: { agent: 'claude', prompt: 'go' },
      };
      const dispatched: JobConfig[] = [];
      await handlerMod.executeHandler(handler, linearWebhook(), {
        dispatchAgent: async (config) => {
          dispatched.push(config);
          return {
            jobName: handler.name, runId: 'run-default', agent: 'claude', pid: 1,
            status: 'running', startedAt: new Date().toISOString(),
            completedAt: null, exitCode: null,
          };
        },
      });
      expect(dispatched[0].mode).toBe('auto');
    });

    it.skipIf(process.platform === 'win32')('runs a shell command action with substitution', async () => {
      const handler: import('./handlers.js').WebhookHandler = {
        name: 'cmd-handler',
        source: 'linear',
        run: { command: 'echo {{issue.identifier}}' },
      };
      const result = await handlerMod.executeHandler(handler, linearWebhook(), {
        execCommand: async (command) => {
          expect(command).toBe("echo 'RUSH-1459'");
          return { exitCode: 0, output: 'RUSH-1459\n' };
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe('RUSH-1459\n');
    });

    it.skipIf(process.platform === 'win32')('neutralizes shell metacharacters coming from the webhook payload', async () => {
      const hostile = "x'; touch /tmp/pwned; echo '";
      const handler: import('./handlers.js').WebhookHandler = {
        name: 'cmd-handler',
        source: 'linear',
        run: { command: 'echo {{issue.title}}' },
      };
      let seen = '';
      await handlerMod.executeHandler(
        handler,
        linearWebhook({ data: { identifier: 'RUSH-1', title: hostile, state: { name: 'Plan' } } }),
        {
          execCommand: async (command) => {
            seen = command;
            return { exitCode: 0, output: '' };
          },
        },
      );
      expect(seen).toBe(`echo 'x'\\''; touch /tmp/pwned; echo '\\'''`);
      expect(seen.startsWith('echo ')).toBe(true);
      const { execFileSync } = await import('child_process');
      const printed = execFileSync('/bin/sh', ['-c', seen], { encoding: 'utf-8' });
      expect(printed.trim()).toBe(hostile);
      expect(fs.existsSync('/tmp/pwned')).toBe(false);
    });

    it('refuses placeholder substitution into a command on Windows', () => {
      expect(() => assertShellSubstitutionSupported('echo {{issue.title}}', 'win32')).toThrow(
        /not supported on Windows/,
      );
      expect(() => assertShellSubstitutionSupported('echo hello', 'win32')).not.toThrow();
      expect(() => assertShellSubstitutionSupported('echo {{issue.title}}', 'darwin')).not.toThrow();
    });

    it('delegates to a routine and substitutes its prompt', async () => {
      writeRoutine('plan-routine', {
        name: 'plan-routine',
        schedule: '0 9 * * *',
        agent: 'claude',
        prompt: 'Plan {{issue.identifier}}',
      });
      const handler: import('./handlers.js').WebhookHandler = {
        name: 'routine-handler',
        source: 'linear',
        routine: 'plan-routine',
      };
      const dispatched: JobConfig[] = [];
      await handlerMod.executeHandler(handler, linearWebhook(), {
        dispatchRoutine: async (config) => {
          dispatched.push(config);
          return {
            jobName: config.name,
            runId: 'run-routine',
            agent: 'claude',
            pid: 1,
            status: 'running',
            startedAt: new Date().toISOString(),
            completedAt: null,
            exitCode: null,
          };
        },
      });
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0].prompt).toBe('Plan RUSH-1459');
      expect(dispatched[0].name).toBe('plan-routine');
    });

    it('overrides a delegated routine project/cwd/mode with the handler values', async () => {
      writeRoutine('anchored-routine', {
        name: 'anchored-routine',
        schedule: '0 9 * * *',
        agent: 'claude',
        prompt: 'go',
        project: 'other-project',
        cwd: 'pkg/a',
        mode: 'plan',
      });
      const handler: import('./handlers.js').WebhookHandler = {
        name: 'override-handler',
        source: 'linear',
        routine: 'anchored-routine',
        project: 'agents-cli',
        cwd: 'cli',
        mode: 'skip',
      };
      const dispatched: JobConfig[] = [];
      await handlerMod.executeHandler(handler, linearWebhook(), {
        dispatchRoutine: async (config) => {
          dispatched.push(config);
          return {
            jobName: config.name, runId: 'run-override', agent: 'claude', pid: 1,
            status: 'running', startedAt: new Date().toISOString(),
            completedAt: null, exitCode: null,
          };
        },
      });
      expect(dispatched[0].project).toBe('agents-cli');
      expect(dispatched[0].cwd).toBe('cli');
      expect(dispatched[0].mode).toBe('skip');
    });

    it('emits webhook.handler.start and webhook.handler.end events', async () => {
      const handler: import('./handlers.js').WebhookHandler = {
        name: 'event-handler',
        source: 'linear',
        run: { agent: 'claude', prompt: 'go' },
      };
      await handlerMod.executeHandler(handler, linearWebhook(), {
        dispatchAgent: async () => ({
          jobName: handler.name,
          runId: 'run-evt',
          agent: 'claude',
          pid: 1,
          status: 'running',
          startedAt: new Date().toISOString(),
          completedAt: null,
          exitCode: null,
        }),
      });
      const lines = fs.readFileSync(eventsFile, 'utf-8').trim().split('\n').filter(Boolean);
      const events = lines.map((l) => JSON.parse(l).event);
      expect(events).toContain('webhook.handler.start');
      expect(events).toContain('webhook.handler.end');
      const end = lines.map((l) => JSON.parse(l)).find((r) => r.event === 'webhook.handler.end');
      expect(end.status).toBe('success');
      expect(end.runId).toBe('run-evt');
    });
  });

  describe('prompt variable substitution', () => {
    it('substitutes {{dotted.path}} placeholders from a webhook context', () => {
      const context = {
        source: 'linear',
        event: 'Issue',
        action: 'update',
        issue: { identifier: 'RUSH-1', state: { name: 'Plan' } },
        updatedFrom: { state: { name: 'Triage' } },
      };
      const prompt = 'Issue {{issue.identifier}} moved from {{updatedFrom.state.name}} to {{issue.state.name}}.';
      expect(substituteWebhookPrompt(prompt, context)).toBe('Issue RUSH-1 moved from Triage to Plan.');
    });

    it('replaces missing values with empty strings', () => {
      const context = { source: 'linear', event: 'Issue', issue: {} };
      expect(substituteWebhookPrompt('{{issue.missing}}', context)).toBe('');
    });

    it('does not affect single-brace variables like {day}', () => {
      const context = { source: 'linear', event: 'Issue', issue: { identifier: 'RUSH-1' } };
      expect(substituteWebhookPrompt('{day} {{issue.identifier}}', context)).toBe('{day} RUSH-1');
    });
  });

  describe('resolveHandlerHost', () => {
    it('returns local for empty or missing host', () => {
      expect(handlerMod.resolveHandlerHost(undefined)).toEqual({});
      expect(handlerMod.resolveHandlerHost('')).toEqual({});
      expect(handlerMod.resolveHandlerHost('   ')).toEqual({});
    });

    it('returns local when host names this machine', () => {
      const saved = process.env.AGENTS_SYNC_MACHINE_ID;
      process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
      try {
        expect(handlerMod.resolveHandlerHost('zion')).toEqual({});
      } finally {
        if (saved === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
        else process.env.AGENTS_SYNC_MACHINE_ID = saved;
      }
    });

    it('resolves a specific peer host to host strategy', () => {
      const saved = process.env.AGENTS_SYNC_MACHINE_ID;
      process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
      try {
        expect(handlerMod.resolveHandlerHost('mac-mini')).toEqual({
          host: 'mac-mini',
          hostStrategy: 'host',
        });
      } finally {
        if (saved === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
        else process.env.AGENTS_SYNC_MACHINE_ID = saved;
      }
    });

    it('picks any online worker for fleet host', () => {
      const saved = process.env.AGENTS_SYNC_MACHINE_ID;
      process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
      writeDeviceRegistry({
        'mac-mini': {
          name: 'mac-mini',
          platform: 'macos',
          shell: 'posix',
          address: { via: 'tailscale', dnsName: 'mac-mini.tail1a85a1.ts.net' },
          auth: { method: 'key' },
          tailscale: { online: true },
        },
      });
      try {
        expect(handlerMod.resolveHandlerHost('fleet')).toEqual({
          host: 'mac-mini',
          hostStrategy: 'host',
        });
      } finally {
        if (saved === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
        else process.env.AGENTS_SYNC_MACHINE_ID = saved;
      }
    });

    it('picks an online worker matching the platform for fleet/linux', () => {
      const saved = process.env.AGENTS_SYNC_MACHINE_ID;
      process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
      writeDeviceRegistry({
        'mac-mini': {
          name: 'mac-mini',
          platform: 'macos',
          shell: 'posix',
          address: { via: 'tailscale', dnsName: 'mac-mini.tail1a85a1.ts.net' },
          auth: { method: 'key' },
          tailscale: { online: true },
        },
        'yosemite-s0': {
          name: 'yosemite-s0',
          platform: 'linux',
          shell: 'posix',
          address: { via: 'tailscale', dnsName: 'yosemite-s0.tail1a85a1.ts.net' },
          auth: { method: 'key' },
          tailscale: { online: true },
        },
      });
      try {
        expect(handlerMod.resolveHandlerHost('fleet/linux')).toEqual({
          host: 'yosemite-s0',
          hostStrategy: 'host',
        });
        expect(handlerMod.resolveHandlerHost('linux/fleet')).toEqual({
          host: 'yosemite-s0',
          hostStrategy: 'host',
        });
        expect(handlerMod.resolveHandlerHost('linux')).toEqual({
          host: 'yosemite-s0',
          hostStrategy: 'host',
        });
      } finally {
        if (saved === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
        else process.env.AGENTS_SYNC_MACHINE_ID = saved;
      }
    });

    it('throws when fleet has no eligible device', () => {
      const saved = process.env.AGENTS_SYNC_MACHINE_ID;
      process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
      writeDeviceRegistry({});
      try {
        expect(handlerMod.resolveHandlerHost('fleet')).toEqual({});
        expect(() => handlerMod.resolveHandlerHost('fleet/linux')).toThrow(/no eligible online fleet device/);
      } finally {
        if (saved === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
        else process.env.AGENTS_SYNC_MACHINE_ID = saved;
      }
    });
  });

  describe('slack handlers', () => {
    function slackWebhook(overrides: Record<string, unknown> = {}): IncomingWebhook {
      return {
        source: 'slack',
        event: 'app_mention',
        payload: {
          type: 'event_callback',
          event_id: 'Ev123',
          event_type: 'app_mention',
          text: '<@U0BOT> AGI: rebase my open PR and check CI',
          channel: 'C0AGI',
          thread_ts: '1712345678.000100',
          user: 'U9',
          ...overrides,
        },
      };
    }

    it('parses PROJECT: prefix, stripping a leading bot mention', () => {
      const ctx = handlerMod.buildWebhookContext(slackWebhook()) as { slack: import('./handlers.js').SlackMessageContext };
      expect(ctx.slack).toMatchObject({
        project: 'AGI',
        prompt: 'rebase my open PR and check CI',
        text: 'AGI: rebase my open PR and check CI',
        channel: 'C0AGI',
        thread_ts: '1712345678.000100',
        user: 'U9',
      });
    });

    it('exposes {{slack.response_url}} so a slash-command reply needs no token or channel membership', () => {
      const webhook: IncomingWebhook = {
        source: 'slack', event: '/agents',
        payload: {
          type: 'slash_command', command: '/agents', channel: 'C0AGI', user: 'U9',
          text: 'AGI: go', response_url: 'https://hooks.slack.com/commands/T1/123/abc',
        },
      };
      const ctx = handlerMod.buildWebhookContext(webhook) as { slack: import('./handlers.js').SlackMessageContext };
      expect(ctx.slack.response_url).toBe('https://hooks.slack.com/commands/T1/123/abc');
      const mention = handlerMod.buildWebhookContext(slackWebhook()) as { slack: import('./handlers.js').SlackMessageContext };
      expect(mention.slack.response_url).toBe('');
    });

    it('leaves project empty and keeps the whole text when there is no PROJECT: prefix', () => {
      const ctx = handlerMod.buildWebhookContext(slackWebhook({ text: 'just do it please' })) as { slack: import('./handlers.js').SlackMessageContext };
      expect(ctx.slack).toMatchObject({ project: '', prompt: 'just do it please' });
    });

    it('matches a slack handler by command and channel; rejects a mismatch', () => {
      const handler: import('./handlers.js').WebhookHandler = {
        name: 'slack-agents', source: 'slack', event: '/agents', command: '/agents', channel: 'C0AGI',
        run: { agent: 'claude', prompt: '{{slack.prompt}}' },
      };
      const slash: IncomingWebhook = {
        source: 'slack', event: '/agents',
        payload: { type: 'slash_command', command: '/agents', channel: 'C0AGI', text: 'AGI: go' },
      };
      expect(handlerMod.handlerMatchesWebhook(handler, slash)).toBe(true);
      expect(handlerMod.handlerMatchesWebhook(handler, { ...slash, payload: { ...slash.payload, command: '/other' } })).toBe(false);
      expect(handlerMod.handlerMatchesWebhook(handler, { ...slash, payload: { ...slash.payload, channel: 'C0OTHER' } })).toBe(false);
      expect(handlerMod.handlerMatchesWebhook({ ...handler, source: 'github' }, slash)).toBe(false);
    });

    it('resolves a dynamic {{slack.project}} into the dispatched job config', async () => {
      const handler: import('./handlers.js').WebhookHandler = {
        name: 'slack-agent', source: 'slack',
        project: '{{slack.project}}',
        run: {
          agent: 'claude',
          prompt: 'Request from <@{{slack.user}}>: {{slack.prompt}}. Reply with agents send --channel slack --to {{slack.channel}} --thread {{slack.thread_ts}}.',
        },
      };
      const dispatched: JobConfig[] = [];
      const meta: RunMeta = {
        jobName: handler.name, runId: 'run-slack', agent: 'claude', pid: 1,
        status: 'running', startedAt: new Date().toISOString(), completedAt: null, exitCode: null,
      };
      const result = await handlerMod.executeHandler(handler, slackWebhook(), {
        dispatchAgent: async (config) => { dispatched.push(config); return meta; },
      });
      expect(result.runId).toBe('run-slack');
      expect(dispatched[0].project).toBe('AGI');
      expect(dispatched[0].prompt).toContain('rebase my open PR and check CI');
      expect(dispatched[0].prompt).toContain('--to C0AGI --thread 1712345678.000100');
    });

    it('omits project when the message carries no PROJECT: token', async () => {
      const handler: import('./handlers.js').WebhookHandler = {
        name: 'slack-agent', source: 'slack', project: '{{slack.project}}',
        run: { agent: 'claude', prompt: '{{slack.prompt}}' },
      };
      const dispatched: JobConfig[] = [];
      await handlerMod.executeHandler(handler, slackWebhook({ text: 'no project here' }), {
        dispatchAgent: async (config) => {
          dispatched.push(config);
          return { jobName: handler.name, runId: 'r', agent: 'claude', pid: 1, status: 'running', startedAt: new Date().toISOString(), completedAt: null, exitCode: null };
        },
      });
      expect(dispatched[0].project).toBeUndefined();
    });
  });
});
