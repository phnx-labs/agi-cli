/** Production WizardHooks for the harness wizard: `pickModel` (catalog pick, RUSH-2220),
 * `connectionTest` (RUSH-2221), `editable` (RUSH-2222). Kept out of the engine so it stays
 * testable with scripted IO and no catalog probe, keychain read, or subprocess. */

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

/** The installed version whose model catalog to read: the host's default or sole installed version,
 * as a bare `agents run <host>` uses. Null when none is installed (free-text model). */
function catalogVersionFor(host: AgentId): string | null {
  return getGlobalDefault(host) || listInstalledVersions(host)[0] || null;
}

/** Build the model `select` choices from a catalog; pure so labelling is tested without a probe.
 * Every list ends with a custom-id row; edit mode leads with a keep-current row. */
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

/** Prompt over an already-resolved catalog and map the keep-current/custom sentinels back to a
 * model id. Split from the probe so those branches are tested with scripted IO. */
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

/** Catalog-backed model pick (RUSH-2220): returns the model id, or `null` to fall through to the
 * engine's free-text prompt when the host exposes no probeable catalog. */
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

/** Assemble the production hook set for the harness commands. The connection test reads the draft's
 * `name`: the caller writes the profile first, then tests it through the real `agents run` path. */
export function harnessHooks(): WizardHooks {
  return {
    pickModel,
    connectionTest: (draft) => runHarnessConnectionTest(draft.name!),
    editable: defaultEditable,
  };
}
