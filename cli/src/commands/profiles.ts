/**
 * Custom-harness profile helpers (shared by `agents harness`).
 *
 * Named bundles of (host CLI, endpoint, model, keychain auth) live under
 * ~/.agents/profiles/*.yml. The user-facing surface is `agents harness`
 * (add/fork/edit/list/view/remove). This module keeps the shared write helpers
 * (`addProfile`, `ensureProviderToken`, …) that harness and the run path use.
 */

import chalk from 'chalk';
import { readStdinSync } from '../lib/format.js';
import {
  writeProfile,
  profileFromPreset,
  profileFromHostModel,
  baseUrlEnvKeyForHost,
  authEnvKeyForHost,
  validateProfileName,
  profileExists,
  type Profile,
} from '../lib/profiles.js';

import { getPreset, listPresets, type Preset } from '../lib/profiles-presets.js';
import type { AgentId } from '../lib/types.js';
import {
  getKeychainToken,
  hasKeychainToken,
  isSecretsClientError,
  parseBundleValue,
  profileKeychainItem,
  readBundle,
  secretsKeychainItem,
  setKeychainToken,
} from '../lib/secrets-client.js';
import type { SecretsBundle } from '../lib/secrets-types.js';
import { isInteractiveTerminal } from './utils.js';
import { ALL_AGENT_IDS } from '../lib/agents.js';
import { findAccount } from '../lib/account-registry.js';

/**
 * Pure helper: builds a Profile from collected wizard inputs. Extracted so the
 * shape of preset->profile mapping for the `create` wizard is unit-testable
 * without mocking @inquirer/prompts.
 */
export function buildProfileFromCollection(
  name: string,
  preset: Preset,
  collected: Record<string, string>,
  version?: string,
): Profile {
  return {
    name,
    host: { agent: preset.host, version },
    env: { ...preset.env, ...collected },
    auth: {
      envVar: preset.authEnvVar,
      keychainItem: profileKeychainItem(preset.provider),
    },
    authOptional: preset.authOptional,
    description: preset.description,
    preset: preset.name,
    provider: preset.provider,
  };
}

/** Prompt the user for a secret value with masked input. Requires an interactive TTY. */
async function promptForSecret(message: string): Promise<string> {
  if (!isInteractiveTerminal()) {
    throw new Error('A secret is required but the shell is not interactive. Pipe the key via stdin (--key-stdin).');
  }
  const { password } = await import('@inquirer/prompts');
  return await password({ message, mask: true });
}

/** Read all available data from stdin synchronously, trimmed. */

/** Ensure a provider API key exists in keychain, prompting or reading stdin if missing. */
export async function ensureProviderToken(provider: string, signupUrl?: string, fromStdin?: boolean): Promise<void> {
  const item = profileKeychainItem(provider);
  if (await hasKeychainToken(item)) {
    return;
  }
  let token: string;
  if (fromStdin) {
    token = readStdinSync();
    if (!token) {
      throw new Error('No key received on stdin.');
    }
  } else {
    const hint = signupUrl ? ` (get one at ${signupUrl})` : '';
    token = await promptForSecret(`Enter API key for ${provider}${hint}`);
  }
  await setKeychainToken(item, token);
  console.log(chalk.green(`Stored in keychain: ${item}`));
}

/** Options accepted by {@link addProfile} — shared by `agents harness add` and `agents harness add`. */
export interface AddProfileOptions {
  preset?: string;
  host?: string;
  model?: string;
  baseUrl?: string;
  authProvider?: string;
  account?: string;
  version?: string;
  keyStdin?: boolean;
  force?: boolean;
  /** `<bundle>` or `<bundle>:<key>` — see {@link applyFromSecrets}. */
  fromSecrets?: string;
}

/**
 * Copy a value from an `agents secrets` bundle into a profile's own keychain
 * item — a one-time copy, not a live link. `spec` is `<bundle>` or
 * `<bundle>:<key>`; the key is required only when the bundle has more than one.
 *
 * Reads the bundle value via {@link getKeychainToken} — this pops Touch ID on
 * macOS once, for that bundle-namespaced item (`agents-cli.secrets.*`, gated by
 * the standalone's user-presence rule for `agents-cli.secrets.*` items) — then writes
 * it to `profileKeychainItem(provider)`, a plain `agents-cli.<provider>.token`
 * item. That item matches neither the `agents-cli.secrets.` nor
 * `agents-cli.bundles.` prefix, so every later read of the harness's own key is
 * silent — no repeat Touch ID prompt.
 *
 * Provider precedence: an explicit `--auth-provider` on the same call always
 * wins (freshest intent); otherwise, only when the profile already has a real
 * auth binding (`profile.auth` is set), its own `provider` (so editing an
 * already-provisioned harness rotates its existing key without repeating
 * `--auth-provider`); otherwise the bundle's own name. The `profile.auth`
 * gate matters because `profileFromHostModel`/`forkProfile` default
 * `profile.provider` to the *host* id (e.g. `claude`) even when no auth is
 * attached yet — trusting that default here would silently overwrite the
 * host's own keychain item (`agents-cli.claude.token`) on a bare `--host
 * --model --from-secrets` add with no `--auth-provider`.
 *
 * Attaches `profile.auth` when the profile has none yet (a bare `--host
 * --model` harness, or a native-host fork with no prior auth binding).
 *
 * `allowInheritedAuth` (default `true`) gates the "reuse `profile.auth`'s own
 * provider" branch above. It must be `false` when `profile` came from
 * **forking** an already-provisioned harness: `forkProfile` copies `auth` by
 * reference from the source when no `--auth-provider` override is given, so
 * `profile.auth` being set there means "the SOURCE harness's binding", not
 * "this harness's own" — trusting it would silently overwrite the source's
 * shared keychain item. Editing a harness's own already-established auth is
 * the one case where reuse is genuinely correct, so callers on that path keep
 * the default.
 */
export async function applyFromSecrets(
  profile: Profile,
  spec: string,
  explicitAuthProvider?: string,
  opts?: { allowInheritedAuth?: boolean },
): Promise<void> {
  const sep = spec.indexOf(':');
  const bundleName = sep === -1 ? spec : spec.slice(0, sep);
  const requestedKey = sep === -1 ? undefined : spec.slice(sep + 1);
  let bundle: SecretsBundle;
  try {
    bundle = await readBundle(bundleName);
  } catch (err) {
    // The standalone reports only a code; name the bundle the user asked for.
    if (!isSecretsClientError(err, 'NOT_FOUND')) throw err;
    throw new Error(`Secrets bundle '${bundleName}' not found. List bundles with 'agents secrets list'.`);
  }
  const keys = Object.keys(bundle.vars);
  const key = requestedKey ?? (keys.length === 1 ? keys[0] : undefined);
  if (!key) {
    throw new Error(
      keys.length === 0
        ? `Bundle '${bundleName}' has no keys.`
        : `Bundle '${bundleName}' has ${keys.length} keys (${keys.join(', ')}); pick one with --from-secrets ${bundleName}:<key>.`,
    );
  }
  if (!(key in bundle.vars)) {
    throw new Error(`Bundle '${bundleName}' has no key '${key}'. Available: ${keys.join(', ') || '(none)'}.`);
  }

  const parsed = parseBundleValue(bundle.vars[key]);
  let value: string;
  if ('literal' in parsed) {
    value = parsed.literal;
  } else if (parsed.ref.provider === 'keychain') {
    value = await getKeychainToken(secretsKeychainItem(bundle.name, parsed.ref.value));
  } else {
    throw new Error(
      `Bundle '${bundleName}' key '${key}' is a '${parsed.ref.provider}:' reference, not a keychain-backed secret — --from-secrets only copies keychain-backed values.`,
    );
  }

  if (profile.auth && !explicitAuthProvider && opts?.allowInheritedAuth === false) {
    throw new Error(
      `Harness '${profile.name}' inherited its auth binding from the harness it was forked from ` +
        `(provider '${profile.provider}') — pass --auth-provider <name> explicitly with --from-secrets ` +
        `on a fork, so it never silently overwrites the source harness's shared keychain item.`,
    );
  }
  const provider = explicitAuthProvider || (profile.auth ? profile.provider : undefined) || bundleName;
  const item = profileKeychainItem(provider);
  await setKeychainToken(item, value);

  if (!profile.auth) {
    const envVar = authEnvKeyForHost(profile.host.agent);
    if (!envVar) {
      throw new Error(`Host '${profile.host.agent}' has no known auth env var; --from-secrets cannot attach auth to this harness.`);
    }
    profile.provider = provider;
    profile.auth = { envVar, keychainItem: item };
    profile.authOptional = false;
  }
}

/**
 * Create a profile ("custom harness"). Two paths:
 *  - `--host <agent> --model <id>`: one-shot custom harness from a host + model
 *    (no preset needed). This is what makes a model like Muse Spark a named,
 *    runnable harness.
 *  - otherwise: apply a built-in preset (existing behavior).
 * `label` only tunes the success wording (Profile vs Harness). Throws on error.
 */
export async function addProfile(name: string, opts: AddProfileOptions, label: 'Profile' | 'Harness' = 'Profile'): Promise<void> {
  validateProfileName(name);
  const account = opts.account ? findAccount(opts.account) : null;
  if (opts.account && !account) throw new Error(`Unknown account '${opts.account}'.`);
  if (profileExists(name) && !opts.force) {
    throw new Error(`${label} '${name}' already exists. Use --force to overwrite.`);
  }

  // One-shot host + model → custom harness, no preset required.
  if (opts.host || opts.model) {
    if (!opts.host || !opts.model) {
      throw new Error('Both --host <agent> and --model <id> are required to build a harness from a host + model.');
    }
    if (!ALL_AGENT_IDS.includes(opts.host as AgentId)) {
      throw new Error(`Unknown host '${opts.host}'. Valid hosts: ${ALL_AGENT_IDS.join(', ')}`);
    }
    const host = opts.host as AgentId;
    if (opts.baseUrl && !baseUrlEnvKeyForHost(host)) {
      console.error(chalk.yellow(`Note: --base-url has no known env var for host '${host}'; ignoring it.`));
    }

    let authEnvVar: string | undefined;
    if (opts.authProvider) {
      const key = authEnvKeyForHost(host);
      if (!key) {
        throw new Error(`--auth-provider is set but host '${host}' has no known auth env var. Use a preset or a hand-written profile YAML.`);
      }
      authEnvVar = key;
      if (!opts.fromSecrets) await ensureProviderToken(opts.authProvider, undefined, opts.keyStdin);
    }

    const profile = profileFromHostModel(name, host, opts.model, {
      version: opts.version,
      baseUrl: opts.baseUrl,
      provider: opts.authProvider,
      authEnvVar,
    });
    if (account) {
      profile.account = account.name;
      profile.provider = account.provider;
    }
    if (opts.fromSecrets) await applyFromSecrets(profile, opts.fromSecrets, opts.authProvider);
    writeProfile(profile);
    console.log(chalk.green(`${label} '${name}' added — ${host} + ${opts.model}.`));
    console.log(chalk.gray(`Try: agents run ${name} "hello"`));
    return;
  }

  // Preset path.
  const presetName = opts.preset || name;
  const preset = getPreset(presetName);
  if (!preset) {
    throw new Error(
      `No preset '${presetName}'.\nAvailable presets: ${listPresets().map((p) => p.name).join(', ')}\n` +
        'Or build a custom harness: --host <agent> --model <id>.',
    );
  }
  if (!account && !opts.fromSecrets && !preset.authOptional) {
    await ensureProviderToken(preset.provider, preset.signupUrl, opts.keyStdin);
  }
  const profile = profileFromPreset(name, preset, opts.version);
  if (account) {
    profile.account = account.name;
    profile.provider = account.provider;
  }
  if (opts.fromSecrets) await applyFromSecrets(profile, opts.fromSecrets, opts.authProvider);
  writeProfile(profile);
  console.log(chalk.green(`${label} '${name}' added.`));
  console.log(chalk.gray(`Try: agents run ${name} "hello"`));
}
