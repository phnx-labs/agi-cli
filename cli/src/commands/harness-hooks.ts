
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

const CUSTOM_MODEL = '__custom_model__';
const KEEP_MODEL = '__keep_model__';

function catalogVersionFor(host: AgentId): string | null {
  return getGlobalDefault(host) || listInstalledVersions(host)[0] || null;
}

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

export function harnessHooks(): WizardHooks {
  return {
    pickModel,
    connectionTest: (draft) => runHarnessConnectionTest(draft.name!),
    editable: defaultEditable,
  };
}
