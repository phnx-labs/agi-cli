/**
 * 1Password CLI (op) integration for importing secrets from vaults.
 */

import { spawnSync } from 'child_process';

interface OpItemSummary {
  id: string;
  title: string;
  category: string;
  vault: { id: string; name: string };
}

export interface OpField {
  id: string;
  label: string;
  type: string;
  value?: string;
  purpose?: string;
}

export interface OpItem extends OpItemSummary {
  fields: OpField[];
}

interface ImportableSecret {
  envKey: string;
  itemTitle: string;
  fieldLabel: string;
  value: string;
  /**
   * The item's free-form notes (1Password's `notesPlain` / any NOTES-purpose
   * field), carried as descriptive metadata for the imported secret. Never the
   * secret value — omitted when the item has no notes.
   */
  description?: string;
}

interface SkippedField {
  itemTitle: string;
  fieldLabel: string;
  reason: string;
}

function runOp(
  args: string[],
  input?: string
): { ok: true; stdout: string } | { ok: false; error: string } {
  const result = spawnSync('op', args, {
    stdio: [input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    input,
  });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, error: '1Password CLI not found. Install: brew install 1password-cli' };
    }
    return { ok: false, error: result.error.message };
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || '';
    if (stderr.includes('not signed in') || stderr.includes('sign in') || stderr.includes('no active session')) {
      return { ok: false, error: 'Not signed in to 1Password. Run: op signin' };
    }
    return { ok: false, error: stderr || `op exited with code ${result.status}` };
  }

  return { ok: true, stdout: result.stdout };
}

export function getItem(itemId: string, vaultName: string): OpItem {
  const result = runOp(['item', 'get', itemId, '--vault', vaultName, '--format=json', '--reveal']);
  if (!result.ok) throw new Error(result.error);
  return JSON.parse(result.stdout) as OpItem;
}

export function toEnvKey(title: string): string {
  return title
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, '_$1');
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const IMPORTABLE_FIELD_TYPES = new Set([
  'CONCEALED', 'concealed',
  'STRING', 'string', 'text', 'TEXT',
  'URL', 'url',
]);
const SKIP_FIELD_LABELS = new Set(['username', 'notesPlain', 'notes']);
const NOTES_FIELD_LABELS = new Set(['notesplain', 'notes']);

function pickBestField(fields: OpField[]): OpField | null {
  const dominated = fields.filter(
    (f) =>
      IMPORTABLE_FIELD_TYPES.has(f.type) &&
      f.value &&
      !SKIP_FIELD_LABELS.has(f.label?.toLowerCase() || '')
  );
  if (dominated.length === 0) return null;

  // Prefer concealed fields (credentials/passwords)
  const concealed = dominated.find((f) => f.type.toLowerCase() === 'concealed');
  if (concealed) return concealed;

  // Then prefer fields labeled credential/password/secret/key/token
  const secretLabels = ['credential', 'password', 'secret', 'key', 'token', 'api_key', 'apikey'];
  const labeled = dominated.find((f) => secretLabels.includes(f.label?.toLowerCase() || ''));
  if (labeled) return labeled;

  // Fall back to first importable field
  return dominated[0];
}

/**
 * The item's notes, if any — a NOTES-purpose field (1Password's `notesPlain`)
 * or a field labelled notes/notesPlain, whichever carries a non-empty value.
 * Returns undefined when the item has no notes. This is descriptive metadata
 * only; it is deliberately independent of value selection and is never picked
 * as the secret value (see SKIP_FIELD_LABELS / pickBestField).
 */
function pickNotes(fields: OpField[]): string | undefined {
  const notes = fields.find(
    (f) =>
      f.value != null &&
      f.value.trim() !== '' &&
      (f.purpose?.toUpperCase() === 'NOTES' ||
        NOTES_FIELD_LABELS.has(f.label?.toLowerCase() || ''))
  );
  const value = notes?.value?.trim();
  return value ? value : undefined;
}

/**
 * Pure transform from a fetched 1Password item to an importable secret (or the
 * reason it was skipped). Split out of extractSecrets so the field-selection
 * and notes-extraction logic is exercised directly by tests without shelling
 * out to `op`.
 */
export function itemToSecret(
  item: OpItem
): { secret: ImportableSecret } | { skipped: SkippedField } {
  const field = pickBestField(item.fields || []);

  if (!field) {
    return { skipped: { itemTitle: item.title, fieldLabel: '*', reason: 'no importable fields' } };
  }

  if (field.value!.includes('\n')) {
    return {
      skipped: {
        itemTitle: item.title,
        fieldLabel: field.label,
        reason: 'contains newlines (keychain limitation)',
      },
    };
  }

  const secret: ImportableSecret = {
    envKey: toEnvKey(item.title),
    itemTitle: item.title,
    fieldLabel: field.label,
    value: field.value!,
  };
  const description = pickNotes(item.fields || []);
  if (description) secret.description = description;

  return { secret };
}

export function extractSecrets(
  items: OpItemSummary[],
  vaultName: string
): { secrets: ImportableSecret[]; skipped: SkippedField[] } {
  const secrets: ImportableSecret[] = [];
  const skipped: SkippedField[] = [];

  for (const summary of items) {
    let item: OpItem;
    try {
      item = getItem(summary.id, vaultName);
    } catch (err) {
      skipped.push({
        itemTitle: summary.title,
        fieldLabel: '*',
        reason: (err as Error).message,
      });
      continue;
    }

    const result = itemToSecret(item);
    if ('skipped' in result) {
      skipped.push(result.skipped);
    } else {
      secrets.push(result.secret);
    }
  }

  return { secrets, skipped };
}

interface PasswordItemTemplate {
  title: string;
  category: 'PASSWORD';
  tags: string[];
  fields: Array<{
    id: string;
    type: 'CONCEALED';
    purpose: 'PASSWORD';
    label: string;
    value: string;
  }>;
}

export function buildPasswordItemTemplate(title: string, value: string): PasswordItemTemplate {
  return {
    title,
    category: 'PASSWORD',
    tags: ['agents-cli'],
    fields: [
      { id: 'password', type: 'CONCEALED', purpose: 'PASSWORD', label: 'password', value },
    ],
  };
}
