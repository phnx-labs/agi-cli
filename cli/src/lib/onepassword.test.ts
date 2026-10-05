import { describe, it, expect } from 'vitest';
import { itemToSecret, type OpItem } from './onepassword.js';

function apiCredentialItem(overrides: Partial<OpItem> = {}): OpItem {
  return {
    id: 'abc123',
    title: 'npm-phnx-labs',
    category: 'API_CREDENTIAL',
    vault: { id: 'v1', name: 'Private' },
    fields: [
      {
        id: 'credential',
        type: 'CONCEALED',
        purpose: '',
        label: 'credential',
        value: 'npm_secretTokenValue',
      },
      {
        id: 'notesPlain',
        type: 'STRING',
        purpose: 'NOTES',
        label: 'notesPlain',
        value: 'Publish token for @phnx-labs scope',
      },
    ],
    ...overrides,
  };
}

describe('itemToSecret notesPlain handling (RUSH-2348)', () => {
  it('carries notesPlain as description AND still selects the concealed credential value', () => {
    const result = itemToSecret(apiCredentialItem());
    expect('secret' in result).toBe(true);
    if (!('secret' in result)) throw new Error('expected a secret');

    expect(result.secret.value).toBe('npm_secretTokenValue');
    expect(result.secret.fieldLabel).toBe('credential');
    expect(result.secret.envKey).toBe('NPM_PHNX_LABS');
    expect(result.secret.description).toBe('Publish token for @phnx-labs scope');
  });

  it('omits description when the item has no notes', () => {
    const item = apiCredentialItem({
      fields: [
        { id: 'credential', type: 'CONCEALED', purpose: '', label: 'credential', value: 'tok' },
      ],
    });
    const result = itemToSecret(item);
    if (!('secret' in result)) throw new Error('expected a secret');
    expect(result.secret.value).toBe('tok');
    expect(result.secret.description).toBeUndefined();
  });

  it('omits description when notesPlain is empty/whitespace', () => {
    const item = apiCredentialItem({
      fields: [
        { id: 'credential', type: 'CONCEALED', purpose: '', label: 'credential', value: 'tok' },
        { id: 'notesPlain', type: 'STRING', purpose: 'NOTES', label: 'notesPlain', value: '   ' },
      ],
    });
    const result = itemToSecret(item);
    if (!('secret' in result)) throw new Error('expected a secret');
    expect(result.secret.description).toBeUndefined();
  });

  it('trims surrounding whitespace from the notes value', () => {
    const item = apiCredentialItem({
      fields: [
        { id: 'credential', type: 'CONCEALED', purpose: '', label: 'credential', value: 'tok' },
        { id: 'notesPlain', type: 'STRING', purpose: 'NOTES', label: 'notesPlain', value: '  hello notes  ' },
      ],
    });
    const result = itemToSecret(item);
    if (!('secret' in result)) throw new Error('expected a secret');
    expect(result.secret.description).toBe('hello notes');
  });

  it('extracts notes from a field labelled "notes" (no NOTES purpose)', () => {
    const item = apiCredentialItem({
      fields: [
        { id: 'credential', type: 'CONCEALED', purpose: '', label: 'credential', value: 'tok' },
        { id: 'notes', type: 'STRING', purpose: '', label: 'notes', value: 'labelled note' },
      ],
    });
    const result = itemToSecret(item);
    if (!('secret' in result)) throw new Error('expected a secret');
    expect(result.secret.description).toBe('labelled note');
  });
});
