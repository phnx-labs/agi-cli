
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

function nativeModes(id: (typeof ALL_AGENT_IDS)[number]): string {
  const modes = AGENTS[id]?.capabilities?.modes ?? [];
  return modes.length ? modes.join('/') : '-';
}

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

export interface ForkOptions {
  toHost?: string;
  model?: string;
  baseUrl?: string;
  authProvider?: string;
  account?: string;
  version?: string;
  description?: string;
  fromSecrets?: string;
  keyStdin?: boolean;
  force?: boolean;
  test?: boolean;
}

export interface EditOptions {
  model?: string;
  baseUrl?: string;
  authProvider?: string;
  account?: string;
  version?: string;
  description?: string;
  fallbackModel?: string;
  fromSecrets?: string;
  keyStdin?: boolean;
  test?: boolean;
}

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

function authEnvKeyForHostOrThrow(host: AgentId): string {
  const key = authEnvKeyForHost(host);
  if (!key) {
    throw new Error(`--auth-provider is set but host '${host}' has no known auth env var; it manages its own login.`);
  }
  return key;
}

function buildEditOverrides(opts: EditOptions): ForkProfileOptions {
  const overrides: ForkProfileOptions = {};
  if (opts.model !== undefined) overrides.model = opts.model;
  if (opts.baseUrl !== undefined) overrides.baseUrl = opts.baseUrl;
  if (opts.authProvider !== undefined) overrides.provider = opts.authProvider;
  if (opts.version) overrides.version = opts.version;
  if (opts.description !== undefined) overrides.description = opts.description;
  return overrides;
}

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

export function forkNeedsWizard(source: string | undefined, name: string | undefined, opts: ForkOptions): boolean {
  if (!source || !name) return true;
  if (!profileExists(source) && resolveAgentName(source) && !opts.model) return true;
  return false;
}

export function addNeedsWizard(name: string | undefined, opts: AddProfileOptions): boolean {
  if (!name) return true;
  if (opts.preset) return false;
  if (opts.host && opts.model) return false;
  if (opts.host || opts.model) return true;
  return !getPreset(name);
}

type ConnectionTestGate = 'on' | 'off' | 'ask';

export function connectionTestGate(testFlag: boolean | undefined, interactive: boolean): ConnectionTestGate {
  if (testFlag === true) return 'on';
  if (testFlag === false) return 'off';
  return interactive ? 'ask' : 'off';
}

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

async function runForkFlow(source: string, name: string, opts: ForkOptions): Promise<void> {
  validateProfileName(name);
  if (profileExists(name) && !opts.force) {
    throw new Error(`Harness '${name}' already exists. Use --force to overwrite.`);
  }
  const forked = buildFork(source, name, opts);
  if (opts.fromSecrets) {
    await applyFromSecrets(forked, opts.fromSecrets, opts.authProvider, { allowInheritedAuth: false });
  } else if (opts.authProvider) {
    await ensureProviderToken(opts.authProvider, undefined, opts.keyStdin);
  }
  writeProfile(forked);
  console.log(chalk.green(`Harness '${name}' forked from ${source}.`));
  console.log(chalk.gray(`Try: agents run ${name} "hello"`));
  await preSaveConnectionTest(name, opts.test);
}

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
