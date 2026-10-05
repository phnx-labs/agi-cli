/** Shared interactive step engine for `agents harness` create and edit (RUSH-2219): one runner, two
 * modes, differing only in step list. Each step is skippable (flags prefill the draft) and talks
 * to the user through the injected WizardIO; extension points are WizardHooks. */

import chalk from 'chalk';
import type { AgentId } from '../lib/types.js';
import {
  type Profile,
  baseUrlEnvKeyForHost,
  authEnvKeyForHost,
  modelEnvKeyForHost,
  validateProfileName,
  listProfiles,
} from '../lib/profiles.js';
import { listPresets, getPreset, type Preset } from '../lib/profiles-presets.js';
import { listBundles } from '../lib/secrets-client.js';
import { AGENTS, ALL_AGENT_IDS, isSelfUpdatingAgent, resolveAgentName } from '../lib/agents.js';
import { readAccountRegistry } from '../lib/account-registry.js';
import type { ConnectionTestResult } from '../lib/harness-connection-test.js';

export type { ConnectionTestResult } from '../lib/harness-connection-test.js';

/** Whether the wizard is creating a new harness or editing an existing one. */
export type WizardMode = 'create' | 'edit';

/** A single `select` choice. `disabled` greys the row (used by the edit matrix). */
export interface WizardChoice<T> {
  name: string;
  value: T;
  disabled?: boolean | string;
}

/** The prompt seam the engine drives, injected so tests need no TTY: production wraps
 * `@inquirer/prompts`, tests pass a scripted fake. */
export interface WizardIO {
  select<T>(opts: { message: string; choices: WizardChoice<T>[]; default?: T }): Promise<T>;
  input(opts: { message: string; default?: string; validate?: (v: string) => true | string }): Promise<string>;
  password(opts: { message: string }): Promise<string>;
  confirm(opts: { message: string; default?: boolean }): Promise<boolean>;
  /** Emit an informational line — a disabled field's reason, or a preset note. */
  note(message: string): void;
}

/** The mutable draft threaded through every step, a superset of both modes' fields. `create` maps
 * it to `runForkFlow` input, `edit` to `EditOptions`, so wizard-built and hand-written harnesses
 * are byte-identical. */
export interface HarnessDraft {
  readonly mode: WizardMode;
  /** create: the fork source (a native agent id or an existing harness name). */
  source?: string;
  /** The resolved host CLI — drives the editability seams. edit: the profile host. */
  host?: AgentId;
  name?: string;
  model?: string;
  baseUrl?: string;
  authProvider?: string;
  account?: string;
  /** `<bundle>` or `<bundle>:<key>` — a value copied out of an agents secrets bundle. */
  fromSecrets?: string;
  version?: string;
  description?: string;
  fallbackModel?: string;
  /** edit: the profile being edited, providing current values. Read-only. */
  readonly original?: Profile;
  /** RUSH-2223 seam: target host to re-key a cloned harness onto (`fork --to-host`).
   * Not set by the scaffold; kept so the draft shape stays stable. */
  toHost?: AgentId;

  // --- transient wizard state (never persisted) ---
  /** The user chose "build custom" over a preset (create only). */
  custom?: boolean;
  /** The preset a create run selected, if any. */
  preset?: string;
  /** Pre-computed default for the name prompt (source or preset name). */
  defaultName?: string;
  /** The provider step has run (distinguishes "no auth chosen" from "not asked"). */
  providerAsked?: boolean;
}

/** What the engine does with a step: `'run'` prompts, `'skip'` is silent (flag supplied or N/A),
 * and `{ disabled }` shows the reason without prompting (the edit matrix, RUSH-2222). */
export type StepDecision = 'run' | 'skip' | { disabled: string };

/** One wizard step: decide, then (only when decided `'run'`) prompt + apply. */
export interface WizardStep {
  readonly id: string;
  decide(draft: HarnessDraft): StepDecision;
  run(io: WizardIO, draft: HarnessDraft, hooks: WizardHooks): Promise<void>;
}

/** Per-host editability — which params this host's API format lets you change. */
export interface HarnessEditable {
  model: boolean;
  baseUrl: boolean;
  auth: boolean;
  version: boolean;
  fallback: boolean;
}

/** One field's editability plus, when disabled, the one-line reason to surface. */
interface EditableField {
  enabled: boolean;
  /** Set only when `enabled` is false — the greyed field's stated reason. */
  reason?: string;
}

/** Per-host editability with a reason attached to every disabled field. */
interface HarnessEditability {
  model: EditableField;
  baseUrl: EditableField;
  auth: EditableField;
  version: EditableField;
  fallback: EditableField;
}

/** Per-harness editability matrix (RUSH-2222): which params the host's API format lets you change,
 * with the reason for each disabled one. Derived from the run-time resolver's maps so it cannot
 * drift from what a run honors. A disabled param never no-ops silently: the flag path fails loud. */
export function harnessEditable(host: AgentId): HarnessEditability {
  const hasEndpoint = baseUrlEnvKeyForHost(host) !== null;
  const hasAuth = authEnvKeyForHost(host) !== null;
  const selfUpdating = isSelfUpdatingAgent(host);
  return {
    model: { enabled: true },
    baseUrl: hasEndpoint
      ? { enabled: true }
      : { enabled: false, reason: `host '${host}' has no custom-endpoint slot — base URL not applicable` },
    auth: hasAuth
      ? { enabled: true }
      : { enabled: false, reason: `host '${host}' manages its own login — no auth to edit` },
    version: selfUpdating
      ? { enabled: false, reason: `host '${host}' self-updates — its version can't be pinned` }
      : { enabled: true },
    fallback: { enabled: true },
  };
}

/** Boolean projection of `harnessEditable`, the default behind the `WizardHooks.editable` seam;
 * derived so the two cannot disagree. */
export function defaultEditable(host: AgentId): HarnessEditable {
  const e = harnessEditable(host);
  return {
    model: e.model.enabled,
    baseUrl: e.baseUrl.enabled,
    auth: e.auth.enabled,
    version: e.version.enabled,
    fallback: e.fallback.enabled,
  };
}

/** Extension points filled without touching the engine. Each is a no-op by default and none
 * fabricates a result. */
export interface WizardHooks {
  /** RUSH-2220 model catalog pick: return a model id, or `null` to fall through to free text.
   * Absent means always free text. */
  pickModel?: (
    io: WizardIO,
    host: AgentId | undefined,
    version: string | undefined,
    current: string | undefined,
  ) => Promise<string | null>;
  /** RUSH-2221 connection test after configure, before save. Absent means no test. */
  connectionTest?: (draft: HarnessDraft) => Promise<ConnectionTestResult>;
  /**
   * RUSH-2222 — per-host editability matrix. Absent → {@link defaultEditable}.
   */
  editable?: (host: AgentId) => HarnessEditable;
}

/** Resolve the host CLI a fork `source` runs under (the host `buildFork` will use). */
export function hostForSource(source: string | undefined): AgentId | undefined {
  if (!source) return undefined;
  const native = resolveAgentName(source);
  if (native) return native;
  // An existing custom harness: its own host.
  const custom = listProfiles().find((p) => p.name === source);
  return custom?.host.agent;
}

/** The engine: walk the steps in order, asking `decide` what to do; prompt on `'run'`, show the
 * reason on `{ disabled }`, stay silent on `'skip'`. */
export async function runWizardSteps(
  steps: WizardStep[],
  draft: HarnessDraft,
  io: WizardIO,
  hooks: WizardHooks = {},
): Promise<HarnessDraft> {
  for (const step of steps) {
    const decision = step.decide(draft);
    if (decision === 'run') {
      await step.run(io, draft, hooks);
    } else if (decision !== 'skip') {
      io.note(chalk.gray(`${step.id}: ${decision.disabled}`));
    }
  }
  return draft;
}

// --- shared prompt fragments ------------------------------------------------

const NO_AUTH = '__none__';
const CUSTOM = '__custom__';
const TYPE_NOW = 'type';
const FROM_SECRETS = 'secrets';
const KEEP = '__keep__';

/** The first `_MODEL`-suffixed env var in a preset's static env block, if any. */
function presetModel(preset: Preset): string | undefined {
  return Object.entries(preset.env).find(([k]) => k.endsWith('_MODEL'))?.[1];
}

/** Providers offered in the custom-auth select, deduped from the preset catalog. */
function knownProviders(): string[] {
  return [...new Set(listPresets().map((p) => p.provider))];
}

/** Prompt for a key source when a provider needs one: type it now (handled downstream by
 * ensureProviderToken) or copy from an agents secrets bundle, setting `draft.fromSecrets`. Lifted
 * verbatim from prior behavior; RUSH-2220 enriches the bundle browse. */
async function askKeySource(io: WizardIO, draft: HarnessDraft, provider: string): Promise<void> {
  const bundles = await listBundles();
  const source =
    bundles.length > 0
      ? await io.select<string>({
          message: `How should '${provider}' get its key?`,
          choices: [
            { name: 'Type a key now', value: TYPE_NOW },
            { name: 'Use an existing agents secrets bundle', value: FROM_SECRETS },
          ],
        })
      : TYPE_NOW;
  if (source !== FROM_SECRETS) return;
  const bundleName = await io.select<string>({
    message: 'Bundle',
    choices: bundles.map((b) => ({
      name: b.description ? `${b.name}  ${chalk.gray(b.description)}` : b.name,
      value: b.name,
    })),
  });
  const bundle = bundles.find((b) => b.name === bundleName)!;
  const keys = Object.keys(bundle.vars);
  const key =
    keys.length === 1
      ? keys[0]
      : await io.select<string>({ message: 'Key', choices: keys.map((k) => ({ name: k, value: k })) });
  draft.fromSecrets = `${bundleName}:${key}`;
}

/** Free-text model prompt, unless RUSH-2220's catalog hook picks one first. */
async function askModel(io: WizardIO, draft: HarnessDraft, hooks: WizardHooks, current?: string): Promise<string> {
  if (hooks.pickModel) {
    const picked = await hooks.pickModel(io, draft.host, draft.version ?? draft.original?.host.version, current);
    if (picked !== null) return picked;
  }
  return io.input({ message: 'Model id', default: current });
}

// --- create steps -----------------------------------------------------------

/** The create step list for `agents harness add`/`fork`, the same sequence as the old
 * `runHarnessWizard` expressed as engine steps. Produces the same `{ source, name, opts }` draft
 * the fork flow persists. */
export function createSteps(): WizardStep[] {
  return [
    {
      id: 'source',
      decide: (d) => (d.source ? 'skip' : 'run'),
      async run(io, d) {
        const customNames = listProfiles().map((p) => p.name);
        d.source = await io.select<string>({
          message: 'Fork from',
          choices: [
            ...ALL_AGENT_IDS.map((id) => ({ name: `${AGENTS[id].name}  ${chalk.gray('(native)')}`, value: id as string })),
            ...customNames.map((n) => ({ name: `${n}  ${chalk.gray('(custom harness)')}`, value: n })),
          ],
        });
        d.host = hostForSource(d.source) ?? d.host;
        d.defaultName = d.source;
      },
    },
    {
      id: 'preset',
      decide: (d) => (d.custom || d.preset !== undefined || d.model !== undefined ? 'skip' : 'run'),
      async run(io, d) {
        const presets = listPresets();
        const choice = await io.select<string>({
          message: 'Preset',
          choices: [
            ...presets.map((p) => ({ name: `${p.name}  ${chalk.gray(p.description.slice(0, 60))}`, value: p.name })),
            { name: 'Build custom (host + model + provider)', value: CUSTOM },
          ],
        });
        if (choice === CUSTOM) {
          d.custom = true;
          return;
        }
        const preset = getPreset(choice)!;
        d.preset = preset.name;
        d.model = presetModel(preset);
        d.baseUrl = preset.env.ANTHROPIC_BASE_URL || preset.env.OPENAI_BASE_URL || undefined;
        d.authProvider = preset.authOptional ? undefined : preset.provider;
        d.providerAsked = true;
        // Pre-fill the name with the preset's own name (e.g. 'deepseek'), not a
        // model detail, so users aren't nudged toward baking one into the identity.
        d.defaultName = preset.name;
      },
    },
    {
      id: 'model',
      decide: (d) => (d.custom && d.model === undefined ? 'run' : 'skip'),
      async run(io, d, hooks) {
        d.model = await askModel(io, d, hooks);
      },
    },
    {
      id: 'provider',
      decide: (d) => (d.custom && !d.providerAsked ? 'run' : 'skip'),
      async run(io, d) {
        const choice = await io.select<string>({
          message: 'Provider',
          choices: [
            ...knownProviders().map((p) => ({ name: p, value: p })),
            { name: 'no auth / host manages its own login', value: NO_AUTH },
          ],
        });
        d.authProvider = choice === NO_AUTH ? undefined : choice;
        d.providerAsked = true;
      },
    },
    {
      id: 'baseUrl',
      decide: (d) => {
        if (!d.custom || d.baseUrl !== undefined) return 'skip';
        // Endpoint slot depends on the host's API format (§3.4): only Anthropic/OpenAI-compatible
        // hosts carry one. Skipping replaces the old silent drop in `profileFromHostModel` with an
        // explicit reason.
        const host = d.host ?? hostForSource(d.source);
        if (host) {
          const cap = harnessEditable(host).baseUrl;
          if (!cap.enabled) return { disabled: cap.reason! };
        }
        return 'run';
      },
      async run(io, d) {
        const url = await io.input({ message: 'Base URL (optional)', default: '' });
        d.baseUrl = url || undefined;
      },
    },
    {
      id: 'name',
      decide: (d) => (d.name ? 'skip' : 'run'),
      async run(io, d) {
        d.name = await io.input({
          message: 'Harness name',
          default: d.defaultName,
          validate: (v) => {
            try {
              validateProfileName(v);
              return true;
            } catch (err) {
              return (err as Error).message;
            }
          },
        });
      },
    },
    {
      id: 'account',
      decide: (d) => (d.authProvider && d.account === undefined ? 'run' : 'skip'),
      async run(io, d) {
        const accounts = Object.values(readAccountRegistry().accounts).filter(account => account.provider === d.authProvider);
        if (accounts.length === 0) {
          throw new Error(`No '${d.authProvider}' account exists. Add one first with 'agents accounts add <name> --provider ${d.authProvider} --auth api-key'.`);
        }
        d.account = await io.select<string>({
          message: 'Account',
          choices: accounts.map(account => ({ name: account.name, value: account.name })),
        });
      },
    },
    connectionTestStep(),
  ];
}

// --- edit steps -------------------------------------------------------------

/** The raw model id currently pinned on a profile (not the display label). */
function currentModel(p: Profile): string | undefined {
  return p.env[modelEnvKeyForHost(p.host.agent)];
}

/** The raw base URL currently pinned on a profile, if the host carries one. */
function currentBaseUrl(p: Profile): string | undefined {
  const key = baseUrlEnvKeyForHost(p.host.agent);
  return key ? p.env[key] : undefined;
}

/** The edit step list for `agents harness edit <name>` on a TTY: each step is prefilled and gated
 * by the editability matrix (RUSH-2222), so an unsupported param reads as disabled with a reason,
 * not silently accepted. */
export function editSteps(original: Profile): WizardStep[] {
  const host = original.host.agent;
  const editableFor = (hooks: WizardHooks) => (hooks.editable ?? defaultEditable)(host);
  // decide() has no access to hooks, so gate on the resolver-sourced matrix; a
  // hook that narrows editability further is applied inside run(). The matrix is
  // the resolver truth (RUSH-2222), reasons and all.
  const cap = harnessEditable(host);
  return [
    {
      id: 'model',
      decide: () => (cap.model.enabled ? 'run' : { disabled: cap.model.reason! }),
      async run(io, d, hooks) {
        if (!editableFor(hooks).model) return;
        d.model = await askModel(io, d, hooks, currentModel(original));
      },
    },
    {
      id: 'baseUrl',
      decide: () => (cap.baseUrl.enabled ? 'run' : { disabled: cap.baseUrl.reason! }),
      async run(io, d, hooks) {
        if (!editableFor(hooks).baseUrl) return;
        const url = await io.input({ message: 'Base URL', default: currentBaseUrl(original) ?? '' });
        d.baseUrl = url || '';
      },
    },
    {
      id: 'account',
      decide: () => (cap.auth.enabled ? 'run' : { disabled: cap.auth.reason! }),
      async run(io, d, hooks) {
        if (!editableFor(hooks).auth) return;
        const accounts = Object.values(readAccountRegistry().accounts);
        const choice = await io.select<string>({
          message: 'Account',
          choices: [{ name: 'Leave account unchanged', value: KEEP }, ...accounts.map(account => ({ name: `${account.name} (${account.provider})`, value: account.name }))],
        });
        if (choice === KEEP) return;
        d.account = choice;
      },
    },
    {
      id: 'version',
      decide: () => (cap.version.enabled ? 'run' : { disabled: cap.version.reason! }),
      async run(io, d, hooks) {
        if (!editableFor(hooks).version) return;
        d.version = await io.input({
          message: 'Host CLI version (blank to unpin)',
          default: original.host.version ?? '',
        });
      },
    },
    {
      id: 'fallback',
      decide: () => (cap.fallback.enabled ? 'run' : 'skip'),
      async run(io, d) {
        d.fallbackModel = await io.input({
          message: 'Fallback model (same-host rate-limit retry; blank for none)',
          default: original.fallback_model ?? '',
        });
      },
    },
    {
      id: 'description',
      decide: () => 'run',
      async run(io, d) {
        d.description = await io.input({ message: 'Description', default: original.description ?? '' });
      },
    },
    connectionTestStep(),
  ];
}

/** Connection-test step (RUSH-2221): kept in both lists so the id is stable, but the test needs the
 * assembled profile, so it runs separately via `runConnectionTest`; the step itself always skips. */
function connectionTestStep(): WizardStep {
  return {
    id: 'connectionTest',
    decide: () => 'skip',
    async run() {
      /* no-op: superseded by runConnectionTest, kept so the step id is stable */
    },
  };
}

/** Run the connection-test hook against a finished draft (RUSH-2221). Returns `null` when no hook
 * is wired, so callers can tell 'not tested' from 'passed'. */
export async function runConnectionTest(
  draft: HarnessDraft,
  hooks: WizardHooks,
): Promise<ConnectionTestResult | null> {
  if (!hooks.connectionTest) return null;
  return hooks.connectionTest(draft);
}

/** Production WizardIO over `@inquirer/prompts`, lazy-imported. `note` writes to stderr so it never
 * pollutes `--json` or piped stdout. */
export async function defaultWizardIO(): Promise<WizardIO> {
  const { select, input, password, confirm } = await import('@inquirer/prompts');
  return {
    select: (opts) => select(opts as Parameters<typeof select>[0]) as Promise<never>,
    input: (opts) => input(opts),
    password: (opts) => password({ message: opts.message, mask: true }),
    confirm: (opts) => confirm(opts),
    note: (message) => console.error(message),
  };
}
