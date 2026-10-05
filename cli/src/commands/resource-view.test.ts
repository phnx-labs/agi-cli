import { describe, it, expect } from 'vitest';
import { resourceLayout } from './resource-view.js';

// resourceLayout is the pure column arithmetic behind the piped `skills/commands/plugins/mcp list`
// tables. The old fixed columns, uncapped Sync column and hardcoded separator overflowed terminals
// under ~130 cols. These pin that the description flexes and a narrow terminal drops to cards.

describe('resourceLayout', () => {
  const base = { hasExtra: false, hasExtra2: false, nameW: 22, syncW: 12 };

  it('flexes the description column to fill the terminal width', () => {
    const narrow = resourceLayout(90, base);
    const wide = resourceLayout(140, base);
    expect(wide.descW).toBeGreaterThan(narrow.descW);
    // descW is exactly what is left after name + gap + gap + capped sync.
    expect(wide.descW).toBe(140 - (22 + 1 + 1 + wide.syncW));
  });

  it('falls back to cards when the description would be too thin to read', () => {
    // Plenty of fixed columns + a small terminal leaves < MIN_DESC_W for description.
    const layout = resourceLayout(70, { hasExtra: true, hasExtra2: true, nameW: 22, syncW: 30 });
    expect(layout.mode).toBe('cards');
  });

  it('stays a table when there is real room for a description', () => {
    const layout = resourceLayout(140, { hasExtra: true, hasExtra2: true, nameW: 22, syncW: 20 });
    expect(layout.mode).toBe('table');
    expect(layout.descW).toBeGreaterThanOrEqual(24);
  });

  it('reserves the extra / extra2 columns only when their labels exist', () => {
    const none = resourceLayout(140, base);
    const both = resourceLayout(140, { ...base, hasExtra: true, hasExtra2: true });
    expect(none.extraW).toBe(0);
    expect(none.extra2W).toBe(0);
    expect(both.extraW).toBe(10);
    expect(both.extra2W).toBe(16);
    // Extra columns eat into the description budget, never overflow the row.
    expect(both.descW).toBe(none.descW - (10 + 1) - (16 + 1));
  });

  it('caps the sync column so a long "missing on …" tail cannot starve description', () => {
    const layout = resourceLayout(120, { ...base, syncW: 200 });
    expect(layout.syncW).toBeLessThanOrEqual(Math.floor(120 * 0.32));
  });
});
