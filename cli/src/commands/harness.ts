/**
 * Custom harness commands (`agents harness`).
 *
 * A "custom harness" is a named (host CLI + model) combo — e.g. OpenCode pinned
 * to meta/muse-spark-1.1, called `spark`. It runs like a native agent type
 * (`agents run spark`) and syncs across devices via `agents repo push user`.
 *
 * Mechanism: harnesses ARE profiles (same ~/.agents/profiles/*.yml, same run
 * resolution). This command group is the surface over that layer + a discovery
 * `list` spanning custom harnesses, addable presets, and the native harness
 * registry. The former top-level `agents profiles` tree was removed — use harness.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { addProfile, ensureProviderToken, applyFromSecrets, type AddProfileOptions } from './profiles.js';
import { isInteractiveTerminal } from './utils.js';
import {
  listProfiles,
  readProfile,
  writeProfile,
  deleteProfile,
  profileExists,
  profileHostLabel,
  profileProviderLabel,
  profileModelLabel,
  profileAuthLabel,
  profileLabel,
  forkProfile,
  editProfile,
  renameProfile,
  profileFromHostModel,
  authEnvKeyForHost,
  modelEnvKeyForHost,
  baseUrlEnvKeyForHost,
  getProfilePath,
  validateProfileName,
  type Profile,
  type ForkProfileOptions,
} from '../lib/profiles.js';
import { listPresets, getPreset } from '../lib/profiles-presets.js';
import { AGENTS, ALL_AGENT_IDS, resolveAgentName } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { findAccount } from '../lib/account-registry.js';

import {
  runWizardSteps,
  createSteps,
  editSteps,
  defaultWizardIO,
  runConnectionTest,
  type HarnessDraft,
} from './harness-wizard.js';
import { harnessHooks } from './harness-hooks.js';
import { CONNECTION_TEST_PROMPT } from '../lib/harness-connection-test.js';

/** Short capability summary for a native harness — its supported run modes. */
function nativeModes(id: (typeof ALL_AGENT_IDS)[number]): string {
  const modes = AGENTS[id]?.capabilities?.modes ?? [];
  return modes.length ? modes.join('/') : '-';
}

/**
 * Print one custom harness. Shared by `agents harness view <name>` and by
 * `agents view <name>` — a custom harness resolves as an agent type there, so
 * both entry points must describe it identically.
 */
export function renderHarnessDetail(name: string): void {
  const p = readProfile(name);
  console.log(chalk.bold(profileLabel(p)) + chalk.gray('  (custom harness)'));
  if (p.description) console.log(chalk.gray(p.description));
  console.log('');
  console.log(`Host:     ${profileHostLabel(p)}`);
  console.log(`Model:    ${profileModelLabel(p)}`);
  if (p.fallback_model) console.log(`Fallback: ${p.fallback_model}`);
  console.log(`Provider: ${profileProviderLabel(p)}`);
  console.log(`Auth:     ${profileAuthLabel(p)}`);
  if (p.account) console.log(`Account:  ${findAccount(p.account)?.name ?? p.account}`);
  if (p.forkedFrom) console.log(`Forked:   from ${p.forkedFrom}`);
  console.log(chalk.gray(getProfilePath(p.name)));
  console.log('');
  console.log(chalk.gray(`Run: agents run ${p.name} "hello"`));
}

/** Options accepted by `agents harness fork`. */
export interface ForkOptions {
  toHost?: string;
  model?: string;
  baseUrl?: string;
  authProvider?: string;
  account?: string;
  version?: string;
  description?: string;
  /** `<bundle>` or `<bundle>:<key>` — see {@link applyFromSecrets} in ./profiles.js. */
  fromSecrets?: string;
  keyStdin?: boolean;
  force?: boolean;
  /** Tri-state pre-save connection test: true = force, false = skip, undefined = ask on a TTY. */
  test?: boolean;
}

/** Options accepted by `agents harness edit`. */
export interface EditOptions {
  model?: string;
  baseUrl?: string;
  authProvider?: string;
  account?: string;
  /** Empty string ('') unpins the host CLI version. */
  version?: string;
  description?: string;
  /** Empty string ('') clears the fallback model. */
  fallbackModel?: string;
  /** `<bundle>` or `<bundle>:<key>` — see {@link applyFromSecrets} in ./profiles.js. */
  fromSecrets?: string;
  keyStdin?: boolean;
  /** Tri-state pre-save connection test: true = force, false = skip, undefined = ask on a TTY. */
  test?: boolean;
}

/**
 * Build the new harness for `agents harness fork <source> <name>`.
 *
 * Two sources, one verb: an existing custom harness is copied and overridden;
 * a native agent id is turned into a harness pinned to `--model` on that host.
 * Forking a native harness therefore requires `--model` — there is nothing to
 * copy a model from.
 */
export function buildFork(source: string, name: string, opts: ForkOptions): Profile {
  if (opts.authProvider || opts.fromSecrets) throw new Error("Harnesses no longer own credentials. Add one with 'agents accounts add <name> --provider <provider> --auth <type>', then pass --account <name>.");
  if (profileExists(source)) {
    const targetHost = opts.toHost ? (resolveAgentName(opts.toHost) ?? undefined) : undefined;
    if (opts.toHost && !targetHost) throw new Error(`Unknown target host '${opts.toHost}'.`);
    const profile = forkProfile(readProfile(source), name, {
      host: targetHost,
      model: opts.model,
      baseUrl: opts.baseUrl,
      provider: opts.authProvider,
      version: opts.version,
      description: opts.description,
    });
    if (opts.account) {
      const account = findAccount(opts.account);
      if (!account) throw new Error(`Unknown account '${opts.account}'.`);
      profile.account = account.name;
      profile.provider = account.provider;
    }
    return profile;
  }

  const sourceHost = resolveAgentName(source);
  if (!sourceHost) {
    throw new Error(
      `No harness or agent named '${source}'.\n` +
        `Fork from a custom harness (agents harness list) or a native one: ${ALL_AGENT_IDS.join(', ')}.`,
    );
  }
  if (!opts.model) {
    throw new Error(`--model <id> is required when forking the native '${sourceHost}' harness (there is no model to inherit).`);
  }
  const host = opts.toHost ? resolveAgentName(opts.toHost) : sourceHost;
  if (!host) throw new Error(`Unknown target host '${opts.toHost}'.`);
  const profile = profileFromHostModel(name, host, opts.model, {
    version: opts.version,
    baseUrl: opts.baseUrl,
    provider: opts.authProvider,
    authEnvVar: opts.authProvider ? authEnvKeyForHostOrThrow(host) : undefined,
    description: opts.description ?? `Forked from ${host}: ${opts.model}`,
  });
  if (opts.account) {
    const account = findAccount(opts.account);
    if (!account) throw new Error(`Unknown account '${opts.account}'.`);
    profile.account = account.name;
    profile.provider = account.provider;
  }
  return profile;
}

/** Auth env var for a host, as a hard error when the host declares none. */
function authEnvKeyForHostOrThrow(host: AgentId): string {
  const key = authEnvKeyForHost(host);
  if (!key) {
    throw new Error(`--auth-provider is set but host '${host}' has no known auth env var; it manages its own login.`);
  }
  return key;
}

/** Map `agents harness edit` flags onto {@link ForkProfileOptions} — the same
 * override shape `editProfile`/`forkProfile` apply. `--version ''` (unpin) is
 * handled by the caller ({@link buildEdit}), not here: `forkProfile`'s own
 * ternary treats an empty string as "no override" and would otherwise inherit
 * the source's version instead of clearing it. */
function buildEditOverrides(opts: EditOptions): ForkProfileOptions {
  const overrides: ForkProfileOptions = {};
  if (opts.model !== undefined) overrides.model = opts.model;
  if (opts.baseUrl !== undefined) overrides.baseUrl = opts.baseUrl;
  if (opts.authProvider !== undefined) overrides.provider = opts.authProvider;
  if (opts.version) overrides.version = opts.version;
  if (opts.description !== undefined) overrides.description = opts.description;
  return overrides;
}

/** True when at least one recognized edit flag was given. */
export function hasEditFlags(opts: EditOptions): boolean {
  return (
    opts.model !== undefined ||
    opts.baseUrl !== undefined ||
    opts.authProvider !== undefined ||
    opts.account !== undefined ||
    opts.version !== undefined ||
    opts.description !== undefined ||
    opts.fallbackModel !== undefined ||
    opts.fromSecrets !== undefined
  );
}

const EDIT_FLAGS_HELP =
  'No changes given. Available flags: --model, --base-url, --auth-provider, --version, --description, --fallback-model, --from-secrets.';

/**
 * Build the edited harness for `agents harness edit <name>` — the profile-shape
 * transform only; the caller applies `--from-secrets`/`--auth-provider` (async
 * keychain side effects) and persists with `writeProfile`. Mirrors
 * {@link buildFork}'s split between a pure builder and the action's IO.
 */
export function buildEdit(name: string, opts: EditOptions): Profile {
  if (!profileExists(name)) {
    throw new Error(`Harness '${name}' not found. Create it first: agents harness add ${name} ...`);
  }
  if (!hasEditFlags(opts)) {
    throw new Error(EDIT_FLAGS_HELP);
  }
  const source = readProfile(name);
  const edited = editProfile(source, buildEditOverrides(opts));
  if (opts.authProvider || opts.fromSecrets) throw new Error("Harnesses no longer own credentials. Add one with 'agents accounts add <name> --provider <provider> --auth <type>', then pass --account <name>.");
  if (opts.account !== undefined) {
    const account = findAccount(opts.account);
    if (!account) throw new Error(`Unknown account '${opts.account}'.`);
    edited.account = account.name;
    edited.provider = account.provider;
  }
  if (opts.version === '') delete edited.host.version;
  if (opts.fallbackModel !== undefined) {
    if (opts.fallbackModel === '') delete edited.fallback_model;
    else edited.fallback_model = opts.fallbackModel;
  }
  return edited;
}

/** True when `agents harness fork` was given too little to proceed without the wizard. */
export function forkNeedsWizard(source: string | undefined, name: string | undefined, opts: ForkOptions): boolean {
  if (!source || !name) return true;
  if (!profileExists(source) && resolveAgentName(source) && !opts.model) return true;
  return false;
}

/** True when `agents harness add` was given too little to proceed without the wizard.
 * Mirrors {@link addProfile}'s own error condition in ./profiles.js so a bare
 * `agents harness add <preset-name>` (no flags) still resolves via the preset
 * fallback instead of being routed into the wizard. */
export function addNeedsWizard(name: string | undefined, opts: AddProfileOptions): boolean {
  if (!name) return true;
  if (opts.preset) return false;
  if (opts.host && opts.model) return false;
  if (opts.host || opts.model) return true;
  return !getPreset(name);
}

/** Whether the pre-save connection test runs, or must be asked for on a TTY. */
type ConnectionTestGate = 'on' | 'off' | 'ask';

/**
 * Resolve the tri-state connection-test gate (RUSH-2221), pure so the branching
 * is unit-tested with no prompt or spawn. `--test` forces it on, `--no-test`
 * forces it off, and with neither flag a TTY is asked (default yes) while a
 * non-interactive caller (`--key-stdin`, piped, CI) skips it — so scripting stays
 * non-interactive unless it opts in with `--test`.
 */
export function connectionTestGate(testFlag: boolean | undefined, interactive: boolean): ConnectionTestGate {
  if (testFlag === true) return 'on';
  if (testFlag === false) return 'off';
  return interactive ? 'ask' : 'off';
}

/**
 * Pre-save connection test (RUSH-2221). The harness is already on disk (the test
 * drives the real `agents run <name>` path, so it must be), so this runs a
 * classified smoke test and — on a TTY, when it fails — offers to keep it, edit
 * it, or delete-and-cancel. A test is never blocking on its own: a save is only
 * discarded when the user explicitly chooses to, so a `--test` failure in a
 * non-interactive shell warns and keeps rather than exiting non-zero.
 */
async function preSaveConnectionTest(name: string, testFlag: boolean | undefined): Promise<void> {
  const interactive = isInteractiveTerminal();
  const gate = connectionTestGate(testFlag, interactive);
  let shouldTest: boolean;
  if (gate === 'on') shouldTest = true;
  else if (gate === 'off') shouldTest = false;
  else {
    const { confirm } = await import('@inquirer/prompts');
    shouldTest = await confirm({ message: `Test the connection for '${name}' now?`, default: true });
  }
  if (!shouldTest) return;

  console.log(chalk.gray(`Testing '${name}' — sending "${CONNECTION_TEST_PROMPT}" through agents run…`));
  const result = await runConnectionTest({ mode: 'create', name }, harnessHooks());
  if (!result) return;
  if (result.ok) {
    console.log(chalk.green(`✓ ${result.message}`));
    return;
  }
  console.log(chalk.yellow(`✗ ${result.message}`));
  if (!interactive) {
    console.log(chalk.gray(`Kept anyway. Fix and retest with: agents harness edit ${name}`));
    return;
  }
  const { select } = await import('@inquirer/prompts');
  const action = await select<string>({
    message: 'The connection test failed. What would you like to do?',
    choices: [
      { name: 'Keep it (the endpoint may just be down right now)', value: 'keep' },
      { name: 'Edit it now', value: 'edit' },
      { name: 'Delete it and cancel', value: 'delete' },
    ],
  });
  if (action === 'edit') {
    await runEditWizard(name, {});
    return;
  }
  if (action === 'delete') {
    deleteProfile(name);
    throw new Error(`Harness '${name}' deleted after a failed connection test.`);
  }
}

/**
 * Shared build+persist flow for a fork — used by `agents harness fork`'s
 * flag-driven path AND by the wizard (both for `fork` and, when it falls back
 * to the wizard, `add`), so a wizard run and a hand-written `fork` call build an
 * identical profile.
 */
async function runForkFlow(source: string, name: string, opts: ForkOptions): Promise<void> {
  validateProfileName(name);
  if (profileExists(name) && !opts.force) {
    throw new Error(`Harness '${name}' already exists. Use --force to overwrite.`);
  }
  // Build first so a bad source/flag combination fails before prompting for a
  // key (or copying one from a bundle) the user would then have stored for
  // nothing.
  const forked = buildFork(source, name, opts);
  if (opts.fromSecrets) {
    // A fork's `auth` (when present) may just be inherited by reference from
    // its source, not established for this harness itself -- never trust it
    // as "safe to rotate" without an explicit --auth-provider.
    await applyFromSecrets(forked, opts.fromSecrets, opts.authProvider, { allowInheritedAuth: false });
  } else if (opts.authProvider) {
    await ensureProviderToken(opts.authProvider, undefined, opts.keyStdin);
  }
  writeProfile(forked);
  console.log(chalk.green(`Harness '${name}' forked from ${source}.`));
  console.log(chalk.gray(`Try: agents run ${name} "hello"`));
  await preSaveConnectionTest(name, opts.test);
}

/**
 * Interactive `agents harness add`/`fork` wizard — runs when required info is
 * missing and stdin+stdout are a TTY (see {@link forkNeedsWizard}, {@link addNeedsWizard}).
 * Drives the shared step engine ({@link createSteps}) and maps its finished draft
 * back to the same `(source, name, opts)` shape {@link buildFork} accepts via
 * {@link runForkFlow}, so a wizard run and a hand-written fork call build an
 * identical profile.
 */
async function runCreateWizard(): Promise<{ source: string; name: string; opts: ForkOptions }> {
  const io = await defaultWizardIO();
  const draft = await runWizardSteps(createSteps(), { mode: 'create' }, io, harnessHooks());
  return {
    source: draft.source!,
    name: draft.name!,
    opts: {
      model: draft.model,
      baseUrl: draft.baseUrl,
      account: draft.account,
    },
  };
}

/**
 * Map a finished edit-wizard draft onto {@link EditOptions}, keeping only the
 * fields the user actually changed from the profile's current values. Unchanged
 * accepts (the wizard pre-fills each prompt with the current value) drop out, so
 * the resulting {@link buildEdit} touches nothing the user left alone — and the
 * "no changes" case is detectable via {@link hasEditFlags}. Base-URL clearing is
 * intentionally not expressed here: the flag path can't clear it either (an empty
 * `--base-url` is a no-op in `forkProfile`), so the wizard matches that until a
 * later subtask adds explicit clearing.
 */
export function draftToEditOptions(draft: HarnessDraft, original: Profile): EditOptions {
  const host = original.host.agent;
  const curModel = original.env[modelEnvKeyForHost(host)];
  const baseKey = baseUrlEnvKeyForHost(host);
  const curBaseUrl = baseKey ? original.env[baseKey] : undefined;
  const curVersion = original.host.version ?? '';
  const curFallback = original.fallback_model ?? '';
  const curDescription = original.description ?? '';

  const opts: EditOptions = {};
  if (draft.model !== undefined && draft.model !== curModel) opts.model = draft.model;
  if (draft.baseUrl && draft.baseUrl !== curBaseUrl) opts.baseUrl = draft.baseUrl;
  if (draft.account !== undefined) opts.account = draft.account;
  if (draft.version !== undefined && draft.version !== curVersion) opts.version = draft.version;
  if (draft.fallbackModel !== undefined && draft.fallbackModel !== curFallback) opts.fallbackModel = draft.fallbackModel;
  if (draft.description !== undefined && draft.description !== curDescription) opts.description = draft.description;
  return opts;
}

/**
 * Interactive `agents harness edit <name>` wizard — runs when no edit flags were
 * given and stdin+stdout are a TTY. Loads the profile, drives the shared step
 * engine ({@link editSteps}) pre-filled with current values, then persists via the
 * same build+write path as the flag-driven edit. `--key-stdin` is honored for the
 * auth step's key entry. When the user changes nothing, it says so and writes
 * nothing.
 */
async function runEditWizard(name: string, cliOpts: EditOptions): Promise<void> {
  if (!profileExists(name)) {
    throw new Error(`Harness '${name}' not found. Create it first: agents harness add ${name} ...`);
  }
  const original = readProfile(name);
  const io = await defaultWizardIO();
  const draft = await runWizardSteps(
    editSteps(original),
    { mode: 'edit', original, host: original.host.agent, name },
    io,
    harnessHooks(),
  );
  const opts: EditOptions = { ...draftToEditOptions(draft, original), keyStdin: cliOpts.keyStdin };
  if (!hasEditFlags(opts)) {
    console.log(chalk.gray(`No changes made to '${name}'.`));
    return;
  }
  const edited = buildEdit(name, opts);
  if (opts.fromSecrets) {
    await applyFromSecrets(edited, opts.fromSecrets, opts.authProvider);
  } else if (opts.authProvider) {
    await ensureProviderToken(opts.authProvider, undefined, opts.keyStdin);
  }
  writeProfile(edited);
  console.log(chalk.green(`Harness '${name}' updated.`));
  console.log(chalk.gray(`Model:  ${profileModelLabel(edited)}`));
  // An edit that touched host/model/endpoint/auth is exactly what can break the
  // harness, so re-test after saving (RUSH-2221). cliOpts carries the --test flag.
  await preSaveConnectionTest(name, cliOpts.test);
}

export function registerHarnessCommands(program: Command): void {
  const cmd = program
    .command('harness')
    .alias('harnesses')
    .description('Custom harnesses — name a (host CLI + model) combo and run it like a native agent type.')
    .addHelpText(
      'after',
      `
A custom harness pins a host CLI (opencode, claude, codex, grok, antigravity, ...) to a
model and gives it a name. 'agents run <name>' then behaves like a native agent
type, and 'agents repo push user' syncs it to every device.

A custom harness is its own agent type in 'agents view' — its own block beside Claude
and Codex, not a row indented under the host CLI that executes it.

Examples:
  # Meta Muse Spark 1.1 through OpenCode, called 'spark'
  agents harness add spark --host opencode --model meta/muse-spark-1.1
  agents run spark "refactor api/handlers/checkout.py"

  # Fork a native harness, or copy one of your own and swap the model
  agents harness fork opencode deepseek --model deepseek/deepseek-v4-flash-0731 --account openrouter-work
  agents harness fork deepseek deepseek-chat --model deepseek/deepseek-chat-v3

  # Per-run model override still wins
  agents run spark --model opencode/big-pickle "quick pass"

  # Edit a harness in place, or give it a new name
  agents harness edit deepseek --fallback-model deepseek/deepseek-chat-v3
  agents harness rename deepseek deepseek-classic

  # No args, in an interactive terminal: a wizard walks you through host, model, and account
  agents harness add

  # See custom harnesses, addable presets, and native harnesses
  agents harness list

  # Private OpenAI/Anthropic-compatible endpoint using an existing account
  agents harness add corp --host claude --model gpt-x --base-url https://gw.corp/v1 --account corp

  # Custom harnesses are named host+model pins — manage them with agents harness
`,
    );

  cmd
    .command('add [name]')
    .description('Create a custom harness from a host + model (or apply a built-in preset). Omit flags in a terminal for the interactive wizard.')
    .option('--host <agent>', 'Host CLI to run under (opencode, claude, codex, grok, antigravity, ...) — pair with --model')
    .option('--model <id>', 'Model id to pin on the host (e.g., meta/muse-spark-1.1) — pair with --host')
    .option('--base-url <url>', 'Custom endpoint base URL (claude/codex hosts)')
    .option('--account <name>', 'Default durable credential account')
    .option('--auth-provider <provider>', 'Removed: use agents accounts add, then --account')
    .option('--preset <preset>', 'Apply a built-in preset instead of --host/--model')
    .option('--version <version>', 'Pin the host CLI version (e.g., 1.16.0)')
    .option('--from-secrets <bundle>[:<key>]', 'Removed: import the value with agents accounts add, then use --account')
    .option('--key-stdin', 'Read API key from stdin instead of prompting (for scripts/CI)')
    .option('--force', 'Overwrite an existing harness with the same name')
    .option('--test', 'Run a connection test before saving (default: ask on a terminal)')
    .option('--no-test', 'Skip the pre-save connection test')
    .action(async (name: string | undefined, opts: AddProfileOptions & ForkOptions) => {
      try {
        if (opts.authProvider || opts.fromSecrets) throw new Error("Harnesses no longer own credentials. Add one with 'agents accounts add <name> --provider <provider> --auth <type>', then pass --account <name>.");
        if (addNeedsWizard(name, opts)) {
          if (!isInteractiveTerminal()) {
            throw new Error(
              "'agents harness add' needs --preset or --host + --model (or a name and an interactive terminal for the wizard).",
            );
          }
          const wiz = await runCreateWizard();
          await runForkFlow(wiz.source, wiz.name, { ...wiz.opts, force: opts.force, keyStdin: opts.keyStdin, test: opts.test });
          return;
        }
        await addProfile(name!, opts, 'Harness');
        await preSaveConnectionTest(name!, opts.test);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('fork [source] [name]')
    .description('Fork a native harness (claude, opencode, ...) or an existing custom one into a new named harness. Omit args in a terminal for the interactive wizard.')
    .option('--model <id>', 'Model to pin on the fork (required when forking a native harness)')
    .option('--to-host <agent>', 'Translate the fork onto another native harness host (for example claude to codex)')
    .option('--base-url <url>', 'Custom endpoint base URL (claude/codex hosts)')
    .option('--account <name>', 'Default durable credential account')
    .option('--auth-provider <provider>', 'Removed: use agents accounts add, then --account')
    .option('--version <version>', 'Pin the host CLI version (e.g., 1.16.0)')
    .option('--description <text>', 'One-line description')
    .option('--from-secrets <bundle>[:<key>]', 'Removed: import the value with agents accounts add, then use --account')
    .option('--key-stdin', 'Read the API key from stdin instead of prompting (for scripts/CI)')
    .option('--force', 'Overwrite an existing harness with the same name')
    .option('--test', 'Run a connection test before saving (default: ask on a terminal)')
    .option('--no-test', 'Skip the pre-save connection test')
    .addHelpText(
      'after',
      `
Examples:
  # Fork OpenCode into a harness pinned to a DeepSeek model on OpenRouter
  agents harness fork opencode deepseek --model deepseek/deepseek-v4-flash-0731 --account openrouter-work

  # Fork Claude Code onto a private gateway
  agents harness fork claude corp --model gpt-x --base-url https://gw.corp/v1 --account corp

  # Copy an existing harness and swap only the model
  agents harness fork deepseek deepseek-chat --model deepseek/deepseek-chat-v3

  # Attach an account whose credential came from agents secrets
  agents harness fork claude corp --model gpt-x --account corp

  # No args, in an interactive terminal: walks through source, preset/model, name, key
  agents harness fork
`,
    )
    .action(async (source: string | undefined, name: string | undefined, opts: ForkOptions) => {
      try {
        if (forkNeedsWizard(source, name, opts)) {
          if (!isInteractiveTerminal()) {
            throw new Error("'agents harness fork' needs <source> and <name> (or an interactive terminal for the wizard).");
          }
          const wiz = await runCreateWizard();
          await runForkFlow(wiz.source, wiz.name, { ...wiz.opts, force: opts.force, keyStdin: opts.keyStdin, test: opts.test });
          return;
        }
        await runForkFlow(source!, name!, opts);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('edit <name>')
    .description('Edit an existing custom harness in place — model, endpoint, auth, version, description, fallback. Omit flags in a terminal for the interactive wizard.')
    .option('--model <id>', 'Swap the pinned model')
    .option('--base-url <url>', 'Swap the custom endpoint base URL')
    .option('--account <name>', 'Change the default durable credential account')
    .option('--auth-provider <provider>', 'Removed: use agents accounts add, then --account')
    .option('--version <version>', 'Re-pin the host CLI version (pass an empty string to unpin)')
    .option('--description <text>', 'Update the one-line description')
    .option('--fallback-model <id>', 'Secondary model retried on the same host on a rate limit (pass an empty string to clear it)')
    .option('--from-secrets <bundle>[:<key>]', 'Removed: import the value with agents accounts add, then use --account')
    .option('--key-stdin', 'Read the API key from stdin instead of prompting (for scripts/CI)')
    .option('--test', 'Run a connection test after saving (default: ask on a terminal)')
    .option('--no-test', 'Skip the connection test')
    .addHelpText(
      'after',
      `
Examples:
  # Swap the pinned model
  agents harness edit deepseek --model deepseek/deepseek-v3.2

  # Repoint auth at a different durable account
  agents harness edit corp --account corp2

  # Unpin the host CLI version
  agents harness edit spark --version ""

  # Add a same-host fallback model for rate-limit retries
  agents harness edit deepseek --fallback-model deepseek/deepseek-chat-v3

  # Rotate the attached credential without editing the harness
  agents accounts set-key corp2 --from-secrets prod:OPENROUTER_KEY

  # No flags, in an interactive terminal: a wizard walks each field pre-filled
  agents harness edit deepseek
`,
    )
    .action(async (name: string, opts: EditOptions) => {
      try {
        // No edit flags + a real terminal → the interactive wizard, pre-filled
        // with current values. Any flag (or a non-interactive caller) takes the
        // flag path unchanged; a flagless non-interactive call still errors via
        // buildEdit's EDIT_FLAGS_HELP.
        if (!hasEditFlags(opts) && isInteractiveTerminal()) {
          await runEditWizard(name, opts);
          return;
        }
        const edited = buildEdit(name, opts);
        if (opts.fromSecrets) {
          await applyFromSecrets(edited, opts.fromSecrets, opts.authProvider);
        } else if (opts.authProvider) {
          await ensureProviderToken(opts.authProvider, undefined, opts.keyStdin);
        }
        writeProfile(edited);
        console.log(chalk.green(`Harness '${name}' updated.`));
        console.log(chalk.gray(`Model:  ${profileModelLabel(edited)}`));
        await preSaveConnectionTest(name, opts.test);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('rename <old-name> <new-name>')
    .description('Rename a custom harness (updates forkedFrom lineage on any harness forked from it). Errors on a name collision.')
    .addHelpText(
      'after',
      `
Examples:
  # Rename 'spark' to 'muse'
  agents harness rename spark muse

  # Rename then run under the new name
  agents harness rename deepseek ds && agents run ds "hello"
`,
    )
    .action((oldName: string, newName: string) => {
      try {
        renameProfile(oldName, newName);
        console.log(chalk.green(`Harness '${oldName}' renamed to '${newName}'.`));
        console.log(chalk.gray(`Try: agents run ${newName} "hello"`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('list')
    .alias('ls')
    .description('List custom harnesses, addable presets, and native harnesses.')
    .option('--json', 'Emit JSON instead of a table')
    .action((opts: { json?: boolean }) => {
      const custom = listProfiles();
      const presets = listPresets();
      const native = ALL_AGENT_IDS.map((id) => ({ id, name: AGENTS[id].name, modes: nativeModes(id) }));

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              custom: custom.map((p) => ({
                name: p.name,
                host: p.host.agent,
                model: profileModelLabel(p),
                provider: profileProviderLabel(p),
              })),
              presets: presets.map((p) => ({ name: p.name, provider: p.provider, description: p.description })),
              native,
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(chalk.bold('Custom harnesses') + chalk.gray('  (yours — agents run <name>)'));
      if (custom.length === 0) {
        console.log(chalk.gray('  none yet — try: agents harness add spark --host opencode --model meta/muse-spark-1.1'));
      } else {
        for (const p of custom) {
          console.log(
            `  ${chalk.cyan(p.name.padEnd(16))} ${profileHostLabel(p).padEnd(14)} ${chalk.gray(profileModelLabel(p))}`,
          );
        }
      }

      console.log('');
      console.log(chalk.bold('Presets') + chalk.gray('  (addable — agents harness add <name>)'));
      for (const p of presets) {
        console.log(`  ${chalk.cyan(p.name.padEnd(16))} ${p.provider.padEnd(12)} ${chalk.gray(p.description.slice(0, 70))}`);
      }

      console.log('');
      console.log(chalk.bold('Native harnesses') + chalk.gray('  (built-in — agents run <id>)'));
      for (const n of native) {
        console.log(`  ${chalk.cyan(n.id.padEnd(16))} ${n.name.padEnd(14)} ${chalk.gray('modes: ' + n.modes)}`);
      }
    });

  cmd
    .command('view <name>')
    .alias('show')
    .description('Show one custom harness (host, model, provider, auth, path).')
    .action((name: string) => {
      try {
        renderHarnessDetail(name);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('remove <name>')
    .alias('rm')
    .description('Delete a custom harness (credentials stay on `agents accounts`; this only drops the named pin).')
    .action((name: string) => {
      const existed = deleteProfile(name);
      if (!existed) {
        console.error(chalk.red(`Harness '${name}' not found.`));
        process.exit(1);
      }
      console.log(chalk.green(`Harness '${name}' removed.`));
    });

}
