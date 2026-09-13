/**
 * Pure-logic tests for the AGI Menu UserDefaults → config migration (PHNX-3999).
 * The `defaults` exec and the sentinel are the thin macOS-only shell; the import
 * DECISION (which keys, never overriding a set value) and the type coercion are
 * the parts that must be right, and they are pure.
 */

import { describe, expect, it } from 'vitest';
import { planMenubarPrefMigration, coerceMenubarPrefValue } from './migrate-prefs.js';

describe('planMenubarPrefMigration', () => {
  it('imports only known FULL keys present in UserDefaults and still unset in config', () => {
    const ud = {
      'menubar.menu.workingRowsShown': 4,
      'menubar.menu.showPreviews': false,
      'menubar.menu.defaultProject': 'rush',
      'menubar.menu.groupBy': 'agent',
      workingRowsShown: 99, // a bare leaf key is NOT the stored name — ignored
      unknownLegacyKey: 'ignored',
    };
    // groupBy is already set in config → must NOT be overridden.
    const setKeys = new Set(['menubar.menu.groupBy']);
    const plan = planMenubarPrefMigration(ud, (name) => !setKeys.has(name));
    const names = plan.map((p) => p.name).sort();
    expect(names).toEqual([
      'menubar.menu.defaultProject',
      'menubar.menu.showPreviews',
      'menubar.menu.workingRowsShown',
    ]);
    expect(plan.find((p) => p.name === 'menubar.menu.workingRowsShown')?.value).toBe(4);
    expect(plan.find((p) => p.name === 'menubar.menu.groupBy')).toBeUndefined();
  });

  it('imports nothing when no known key is present (safe no-op)', () => {
    expect(planMenubarPrefMigration({ somethingElse: 1, workingRowsShown: 2 }, () => true)).toEqual([]);
  });
});

describe('coerceMenubarPrefValue', () => {
  it('coerces bools from JSON, 0/1, and YES/NO', () => {
    expect(coerceMenubarPrefValue('menubar.menu.showPreviews', true)).toBe(true);
    expect(coerceMenubarPrefValue('menubar.menu.showPreviews', 0)).toBe(false);
    expect(coerceMenubarPrefValue('menubar.menu.showPreviews', 'YES')).toBe(true);
  });

  it('coerces ints from numbers and numeric strings', () => {
    expect(coerceMenubarPrefValue('menubar.menu.workingRowsShown', 3)).toBe(3);
    expect(coerceMenubarPrefValue('menubar.menu.workingRowsShown', '4')).toBe(4);
  });

  it('passes strings through and rejects an unrepresentable value', () => {
    expect(coerceMenubarPrefValue('menubar.menu.groupBy', 'agent')).toBe('agent');
    expect(coerceMenubarPrefValue('menubar.menu.workingRowsShown', 'nope')).toBeUndefined();
    expect(coerceMenubarPrefValue('menubar.menu.showPreviews', 'maybe')).toBeUndefined();
  });
});
