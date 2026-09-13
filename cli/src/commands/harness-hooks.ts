/**
 * Production {@link WizardHooks} for the harness create/edit wizard.
 *
 * The engine ({@link ./harness-wizard.js}) is pure and hook-driven; this module
 * supplies the three real extension points the sibling subtasks fill:
 *   - `pickModel`      — a catalog pick from the host's own model list
 *                        (`getModelCatalog`), with a free-text escape hatch and a
 *                        free-text FALLBACK when the host exposes no catalog
 *                        (RUSH-2220).
 *   - `connectionTest` — a real pre-save smoke test through `agents run`
 *                        (RUSH-2221), delegated to {@link runHarnessConnectionTest}.
 *   - `editable`       — the resolver-sourced per-host editability matrix
 *                        (RUSH-2222), {@link defaultEditable}.
 *
 * Kept out of the engine so the engine stays testable with a scripted IO and no
 * catalog probe, keychain read, or subprocess.
 */

import chalk from 'chalk';
import type { AgentId } from '../lib/types.js';
import { getModelCatalog, type ModelInfo } from '../lib/models.js';
import { getGlobalDefault, listInstalledVersions } from '../lib/installations/versions.js';
import { runHarnessConnectionTest } from '../lib/harness-connection-test.js';
import {
  defaultEditable,
  type WizardHooks,
  type WizardIO,
  type WizardChoice,
} from './harness-wizard.js';

/** Sentinel select values for the two non-catalog rows in the model pick. */
const CUSTOM_MODEL = '__custom_model__';
const KEEP_MODEL = '__keep_model__';

/**
 * The installed version whose model catalog to read for a host. The wizard has
 * no version in hand for a fresh create, so it reads the host's default (or its
 * sole installed) version — the same version a bare `agents run <host>` uses.
 * Null when the host has no installed version to probe (→ free-text model).
 */
function catalogVersionFor(host: AgentId): string | null {
  return getGlobalDefault(host) || listInstalledVersions(host)[0] || null;
}

/**
 * Build the model `select` choices from a catalog. Pure, so the labelling +
 * escape-hatch rows are unit-tested with no catalog probe. Every list ends with
 * a "type a custom id" row so a model the catalog doesn't list is always
 * reachable; in edit mode a "keep current" row leads.
 */
export function buildModelChoices(models: ModelInfo[], current?: string): WizardChoice<string>[] {
  const choices: WizardChoice<string>[] = [];
  if (current) choices.push({ name: `Keep current (${current})`, value: KEEP_MODEL });
  for (const m of models) {
    const tags: string[] = [];
    if (m.alias) tags.push(m.alias);
    if (m.isDefault) tags.push('default');
    const tail = tags.length ? chalk.gray(`  (${tags.join(', ')})`) : '';
    const label = m.displayName && m.displayName !== m.id ? `${m.id}${chalk.gray('  ' + m.displayName)}` : m.id;
    choices.push({ name: `${label}${tail}`, value: m.id });
  }
  choices.push({ name: 'Type a custom model id…', value: CUSTOM_MODEL });
  return choices;
}

/**
 * Prompt over an already-resolved catalog: a `select` of the models plus the
 * keep-current / custom-id rows, mapping the sentinel choices back to a concrete
 * model id. Split from the catalog probe so the KEEP / CUSTOM / pick branches are
 * unit-tested with a scripted IO and no installed agent.
 */
export async function chooseModelFromCatalog(
  io: WizardIO,
  models: ModelInfo[],
  current: string | undefined,
): Promise<string> {
  const choice = await io.select<string>({
    message: 'Model',
    choices: buildModelChoices(models, current),
  });
  if (choice === KEEP_MODEL) return current ?? '';
  if (choice === CUSTOM_MODEL) return io.input({ message: 'Model id', default: current });
  return choice;
}

/**
 * The catalog-backed model pick (RUSH-2220). Returns the chosen model id, or
 * `null` to fall through to the engine's free-text prompt when the host exposes
 * no probeable catalog — so a host we can't enumerate degrades to today's
 * free-text behaviour rather than blocking.
 */
export async function pickModel(
  io: WizardIO,
  host: AgentId | undefined,
  version: string | undefined,
  current: string | undefined,
): Promise<string | null> {
  if (!host) return null;
  const resolvedVersion = version || catalogVersionFor(host);
  if (!resolvedVersion) return null;
  const catalog = getModelCatalog(host, resolvedVersion);
  if (!catalog || catalog.models.length === 0) return null;
  return chooseModelFromCatalog(io, catalog.models, current);
}

/**
 * Assemble the production hook set the harness commands drive the wizard with.
 * The connection-test hook reads the assembled draft's `name` — the caller writes
 * the profile to disk first, then invokes the test through the real `agents run`
 * path against that name.
 */
export function harnessHooks(): WizardHooks {
  return {
    pickModel,
    connectionTest: (draft) => runHarnessConnectionTest(draft.name!),
    editable: defaultEditable,
  };
}
