import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as state from '../lib/state.js';
import {
  createSteps,
  editSteps,
  defaultEditable,
  harnessEditable,
  runWizardSteps,
  hostForSource,
  type WizardIO,
  type WizardChoice,
  type HarnessDraft,
  type WizardStep,
} from './harness-wizard.js';
import { buildFork, buildEdit, draftToEditOptions } from './harness.js';
import {
  writeProfile,
  readProfile,
  resolveProfileForRun,
  baseUrlEnvKeyForHost,
  authEnvKeyForHost,
  type Profile,
} from '../lib/profiles.js';
import { MANAGED_AGENT_IDS, isSelfUpdatingAgent } from '../lib/agents.js';

/** A scripted WizardIO that drives the engine without a TTY and records every prompt, answering by
 * matcher so tests never depend on the private sentinel values of a `select`. */
type Prompt = {
  kind: 'select' | 'input' | 'password' | 'confirm';
  message: string;
  choices?: WizardChoice<unknown>[];
  default?: unknown;
};

class FakeIO implements WizardIO {
  calls: Prompt[] = [];
  notes: string[] = [];
  constructor(private respond: (p: Prompt) => unknown) {}
  private ask(p: Prompt): unknown {
    this.calls.push(p);
    return this.respond(p);
  }
  async select<T>(opts: { message: string; choices: WizardChoice<T>[]; default?: T }): Promise<T> {
    return this.ask({ kind: 'select', message: opts.message, choices: opts.choices as WizardChoice<unknown>[] }) as T;
  }
  async input(opts: { message: string; default?: string }): Promise<string> {
    return this.ask({ kind: 'input', message: opts.message, default: opts.default }) as string;
  }
  async password(opts: { message: string }): Promise<string> {
    return this.ask({ kind: 'password', message: opts.message }) as string;
  }
  async confirm(opts: { message: string; default?: boolean }): Promise<boolean> {
    return this.ask({ kind: 'confirm', message: opts.message, default: opts.default }) as boolean;
  }
  note(m: string): void {
    this.notes.push(m);
  }
  /** Messages of the prompts that actually fired, in order. */
  messages(): string[] {
    return this.calls.map((c) => c.message);
  }
}

let TEST_ROOT: string;
let USER_DIR: string;

beforeEach(() => {
  TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-wizard-test-'));
  USER_DIR = path.join(TEST_ROOT, '.agents');
  fs.mkdirSync(path.join(USER_DIR, 'profiles'), { recursive: true });
  vi.spyOn(state, 'getUserAgentsDir').mockReturnValue(USER_DIR);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

/** Index a step list by id for direct `decide()` assertions. */
function byId(steps: WizardStep[]): Record<string, WizardStep> {
  return Object.fromEntries(steps.map((s) => [s.id, s]));
}

describe('createSteps — step gating (decide) is a function of the draft', () => {
  const steps = byId(createSteps());

  it('source runs when unset and is skipped once a flag pre-filled it', () => {
    expect(steps.source.decide({ mode: 'create' })).toBe('run');
    expect(steps.source.decide({ mode: 'create', source: 'claude' })).toBe('skip');
  });

  it('model is asked only on the custom path and skipped once a model is present', () => {
    expect(steps.model.decide({ mode: 'create', custom: true })).toBe('run');
    expect(steps.model.decide({ mode: 'create', custom: true, model: 'gpt-x' })).toBe('skip');
    expect(steps.model.decide({ mode: 'create' })).toBe('skip'); // preset path fills it
  });

  it('baseUrl is disabled with a reason on a host that carries no endpoint slot', () => {
    const claude = steps.baseUrl.decide({ mode: 'create', custom: true, host: 'claude' });
    expect(claude).toBe('run');
    const opencode = steps.baseUrl.decide({ mode: 'create', custom: true, host: 'opencode' });
    expect(opencode).toEqual({ disabled: expect.stringContaining('opencode') });
  });

  it('name is skipped when a positional pre-filled it', () => {
    expect(steps.name.decide({ mode: 'create', name: 'spark' })).toBe('skip');
    expect(steps.name.decide({ mode: 'create' })).toBe('run');
  });

  it('account runs only when a provider needs a credential and no account was already chosen', () => {
    expect(steps.account.decide({ mode: 'create', authProvider: 'openrouter' })).toBe('run');
    expect(steps.account.decide({ mode: 'create', authProvider: 'openrouter', account: 'work' })).toBe('skip');
    expect(steps.account.decide({ mode: 'create' })).toBe('skip');
  });
});

describe('createSteps — a full custom run drives the right prompts and skips the rest', () => {
  it('builds a no-auth opencode harness, disabling the base-URL step for the host', async () => {
    const io = new FakeIO((p) => {
      if (p.message === 'Fork from') return 'opencode';
      if (p.message === 'Preset') return p.choices!.find((c) => c.name.includes('Build custom'))!.value;
      if (p.message === 'Model id') return 'meta/muse-spark-1.1';
      if (p.message === 'Provider') return p.choices!.find((c) => c.name.includes('no auth'))!.value;
      if (p.message === 'Harness name') return 'spark';
      throw new Error(`unexpected prompt: ${p.kind} '${p.message}'`);
    });

    const draft = await runWizardSteps(createSteps(), { mode: 'create' }, io);

    // The base-URL prompt never fired — it was disabled with a reason instead.
    expect(io.messages()).not.toContain('Base URL (optional)');
    expect(io.notes.join('\n')).toMatch(/opencode.*no custom-endpoint slot/);

    expect(draft.source).toBe('opencode');
    expect(draft.custom).toBe(true);
    expect(draft.model).toBe('meta/muse-spark-1.1');
    expect(draft.authProvider).toBeUndefined();
    expect(draft.baseUrl).toBeUndefined();
    expect(draft.name).toBe('spark');

    // Round-trips through buildFork → writeProfile → readProfile → resolveProfileForRun.
    const profile = buildFork(draft.source!, draft.name!, {
      model: draft.model,
      baseUrl: draft.baseUrl,
      authProvider: draft.authProvider,
      fromSecrets: draft.fromSecrets,
    });
    writeProfile(profile);
    expect(readProfile('spark').env.OPENCODE_MODEL).toBe('meta/muse-spark-1.1');
    const resolved = resolveProfileForRun('spark');
    expect(resolved.agent).toBe('opencode');
    expect(resolved.env.OPENCODE_MODEL).toBe('meta/muse-spark-1.1');
  });

  it('asks nothing when every step is pre-filled by a flag (scripting stays non-interactive)', async () => {
    const io = new FakeIO((p) => {
      throw new Error(`should not prompt, but got '${p.message}'`);
    });
    const prefilled: HarnessDraft = {
      mode: 'create',
      source: 'claude',
      name: 'corp',
      custom: true,
      model: 'gpt-x',
      baseUrl: 'https://gw.corp/v1',
      authProvider: 'corp',
      providerAsked: true,
      account: 'corp',
    };
    await runWizardSteps(createSteps(), prefilled, io);
    expect(io.calls).toHaveLength(0);
  });
});

describe('editSteps — matrix gating is sourced from the resolver, per host', () => {
  const editProfile = (host: Profile['host']['agent'], env: Record<string, string> = {}): Profile => ({
    name: `${host}-harness`,
    host: { agent: host },
    env,
  });

  it('enables every param on claude (Anthropic-compatible, pinnable)', () => {
    const steps = byId(editSteps(editProfile('claude', { ANTHROPIC_MODEL: 'm' })));
    const draft: HarnessDraft = { mode: 'edit' };
    expect(steps.model.decide(draft)).toBe('run');
    expect(steps.baseUrl.decide(draft)).toBe('run');
    expect(steps.account.decide(draft)).toBe('run');
    expect(steps.version.decide(draft)).toBe('run');
    expect(steps.fallback.decide(draft)).toBe('run');
  });

  it('disables the endpoint AND the version pin on a self-updating, no-endpoint host (grok)', () => {
    const steps = byId(editSteps(editProfile('grok', { GROK_MODEL: 'm' })));
    const draft: HarnessDraft = { mode: 'edit' };
    expect(steps.baseUrl.decide(draft)).toEqual({ disabled: expect.stringContaining('grok') });
    expect(steps.version.decide(draft)).toEqual({ disabled: expect.stringContaining('self-updates') });
    expect(steps.account.decide(draft)).toBe('run'); // grok reads XAI_API_KEY
    expect(steps.model.decide(draft)).toBe('run');
  });

  it('disables only the endpoint on opencode (no slot, but pinnable + auth-capable)', () => {
    const steps = byId(editSteps(editProfile('opencode', { OPENCODE_MODEL: 'm' })));
    const draft: HarnessDraft = { mode: 'edit' };
    expect(steps.baseUrl.decide(draft)).toEqual({ disabled: expect.stringContaining('endpoint') });
    expect(steps.version.decide(draft)).toBe('run');
    expect(steps.account.decide(draft)).toBe('run');
  });
});

describe('defaultEditable — never drifts from the resolver maps (no hardcoded table)', () => {
  it('matches baseUrlEnvKeyForHost / authEnvKeyForHost / isSelfUpdatingAgent for every managed host', () => {
    for (const host of MANAGED_AGENT_IDS) {
      const e = defaultEditable(host);
      expect(e.model).toBe(true);
      expect(e.fallback).toBe(true);
      expect(e.baseUrl).toBe(baseUrlEnvKeyForHost(host) !== null);
      expect(e.auth).toBe(authEnvKeyForHost(host) !== null);
      expect(e.version).toBe(!isSelfUpdatingAgent(host));
    }
  });
});

describe('harnessEditable — the RUSH-2222 matrix, sourced from the resolver with reasons', () => {
  it('every managed host tracks the resolver maps, disabled fields carrying a reason', () => {
    for (const host of MANAGED_AGENT_IDS) {
      const e = harnessEditable(host);
      // model + fallback are always editable (a same-host model swap).
      expect(e.model.enabled).toBe(true);
      expect(e.fallback.enabled).toBe(true);
      // endpoint / auth / version enablement mirrors the resolver, never a table.
      expect(e.baseUrl.enabled).toBe(baseUrlEnvKeyForHost(host) !== null);
      expect(e.auth.enabled).toBe(authEnvKeyForHost(host) !== null);
      expect(e.version.enabled).toBe(!isSelfUpdatingAgent(host));
      // A disabled field always states why; an enabled one never carries a stale reason.
      for (const field of [e.baseUrl, e.auth, e.version] as const) {
        if (field.enabled) expect(field.reason).toBeUndefined();
        else expect(field.reason && field.reason.length).toBeTruthy();
      }
    }
  });

  it('names the host in each disabled reason (claude fully editable; grok has no endpoint or version pin)', () => {
    const claude = harnessEditable('claude');
    expect(claude.baseUrl.enabled).toBe(true);
    expect(claude.version.enabled).toBe(true);

    const grok = harnessEditable('grok');
    expect(grok.baseUrl.reason).toMatch(/grok.*custom-endpoint/);
    expect(grok.version.reason).toMatch(/self-updates/);
    expect(grok.auth.enabled).toBe(true); // grok reads XAI_API_KEY

    const opencode = harnessEditable('opencode');
    expect(opencode.baseUrl.reason).toMatch(/endpoint/);
    expect(opencode.version.enabled).toBe(true);
  });

  it('is the single source defaultEditable projects to booleans (they never disagree)', () => {
    for (const host of MANAGED_AGENT_IDS) {
      const full = harnessEditable(host);
      const bool = defaultEditable(host);
      expect(bool).toEqual({
        model: full.model.enabled,
        baseUrl: full.baseUrl.enabled,
        auth: full.auth.enabled,
        version: full.version.enabled,
        fallback: full.fallback.enabled,
      });
    }
  });
});

describe('editSteps — a full edit run keeps only what changed and round-trips', () => {
  it('changes only the model when the user accepts every other current value', async () => {
    writeProfile({
      name: 'deepseek',
      host: { agent: 'claude', version: '2.1.170' },
      env: { ANTHROPIC_MODEL: 'deepseek/deepseek-v4-flash-0731' },
      description: 'DeepSeek via OpenRouter',
    });
    const original = readProfile('deepseek');

    const io = new FakeIO((p) => {
      if (p.message === 'Model id') return 'deepseek/deepseek-v3.2'; // the one real change
      if (p.message === 'Account') return p.choices!.find((c) => c.name.includes('unchanged'))!.value;
      if (p.kind === 'input') return p.default ?? ''; // accept the pre-filled current value
      throw new Error(`unexpected prompt: ${p.kind} '${p.message}'`);
    });

    const draft = await runWizardSteps(
      editSteps(original),
      { mode: 'edit', original, host: original.host.agent, name: 'deepseek' },
      io,
    );
    const opts = draftToEditOptions(draft, original);
    expect(opts).toEqual({ model: 'deepseek/deepseek-v3.2' });

    const edited = buildEdit('deepseek', opts);
    writeProfile(edited);
    // Only the model moved; the version pin and description are intact.
    expect(readProfile('deepseek').env.ANTHROPIC_MODEL).toBe('deepseek/deepseek-v3.2');
    expect(readProfile('deepseek').host.version).toBe('2.1.170');
    const resolved = resolveProfileForRun('deepseek');
    expect(resolved.env.ANTHROPIC_MODEL).toBe('deepseek/deepseek-v3.2');
  });

  it('unpins the version when the user blanks it, an explicit clear the flag path also supports', async () => {
    writeProfile({
      name: 'pinned',
      host: { agent: 'claude', version: '2.1.170' },
      env: { ANTHROPIC_MODEL: 'm' },
    });
    const original = readProfile('pinned');
    const io = new FakeIO((p) => {
      if (p.message === 'Account') return p.choices!.find((c) => c.name.includes('unchanged'))!.value;
      if (p.kind === 'input' && p.message.startsWith('Host CLI version')) return ''; // blank → unpin
      if (p.kind === 'input') return p.default ?? '';
      throw new Error(`unexpected prompt: ${p.kind} '${p.message}'`);
    });
    const draft = await runWizardSteps(
      editSteps(original),
      { mode: 'edit', original, host: original.host.agent, name: 'pinned' },
      io,
    );
    const opts = draftToEditOptions(draft, original);
    expect(opts.version).toBe('');
    const edited = buildEdit('pinned', opts);
    expect(edited.host.version).toBeUndefined();
  });
});

describe('hostForSource — resolves the host a fork target runs under', () => {
  it('maps a native id (through aliases) to itself', () => {
    expect(hostForSource('opencode')).toBe('opencode');
    expect(hostForSource('claude-code')).toBe('claude');
  });

  it('maps an existing custom harness to its own host', () => {
    writeProfile({ name: 'mine', host: { agent: 'codex' }, env: { OPENAI_MODEL: 'm' } });
    expect(hostForSource('mine')).toBe('codex');
  });

  it('is undefined for an unknown source', () => {
    expect(hostForSource('nope')).toBeUndefined();
    expect(hostForSource(undefined)).toBeUndefined();
  });
});
