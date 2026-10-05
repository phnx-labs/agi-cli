import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildAggregate, generate } from './gen-changelog';

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('buildAggregate', () => {
  it('orders versions newest-first via the CLI compareVersions', () => {
    const out = buildAggregate([
      { version: '1.20.9', body: '- nine' },
      { version: '1.20.63', body: '- sixty-three' },
      { version: '1.20.10', body: '- ten' },
      { version: '0.1.0-alpha.44', body: '- alpha' },
    ]);
    const order = [...out.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(order).toEqual(['1.20.63', '1.20.10', '1.20.9', '0.1.0-alpha.44']);
  });

  it('sorts same-base prereleases by their trailing numeric segment (alpha.10 > alpha.9)', () => {
    const out = buildAggregate([
      { version: '2.0.0-alpha.9', body: '- a9' },
      { version: '2.0.0-alpha.10', body: '- a10' },
    ]);
    const order = [...out.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(order).toEqual(['2.0.0-alpha.10', '2.0.0-alpha.9']);
  });

  it('emits the canonical shape: header, blank line, per-version blocks, single trailing newline', () => {
    const out = buildAggregate([
      { version: '1.1.0', body: '- b' },
      { version: '1.0.0', body: '- a' },
    ]);
    expect(out).toBe('# Changelog\n\n## 1.1.0\n\n- b\n\n## 1.0.0\n\n- a\n');
  });

  it('never renders an Unreleased section (queue is folded only at release)', () => {
    const out = buildAggregate([{ version: '1.0.0', body: '- a' }]);
    expect(out).not.toContain('Unreleased');
  });
});

describe('committed CHANGELOG.md', () => {
  it('is up to date with .changelog/ (regenerate with `npm run changelog`)', () => {
    const regenerated = generate(join(cliRoot, '.changelog'));
    const committed = readFileSync(join(cliRoot, 'CHANGELOG.md'), 'utf-8');
    const normalize = (s: string) => s.replace(/\r\n/g, '\n');
    expect(normalize(committed)).toBe(normalize(regenerated));
  });
});
