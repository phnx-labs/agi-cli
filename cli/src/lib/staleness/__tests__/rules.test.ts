import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  newFixture, writeFile, removeFile,
  build, isStale,
  type Fixture,
} from './_fixtures.js';

const presets = (defs: Record<string, string[]>): string => {
  const lines = ['presets:'];
  for (const [name, subs] of Object.entries(defs)) {
    lines.push(`  ${name}:`);
    lines.push('    subrules:');
    for (const s of subs) lines.push(`      - ${s}`);
  }
  return lines.join('\n') + '\n';
};

describe('staleness e2e: rules', () => {
  let fx: Fixture;
  beforeEach(() => { fx = newFixture('rules'); });
  afterEach(()  => fx.cleanup());

  it('empty (no rules.yaml anywhere) -> build/isStale survive without throwing', () => {
    build(fx);
    expect(isStale(fx)).toBe(false);
  });

  it('clean preset+subrules: build then check -> not stale', () => {
    writeFile(fx, 'system', 'rules/rules.yaml',       presets({ default: ['core'] }));
    writeFile(fx, 'system', 'rules/subrules/core.md', '# core rules');
    build(fx);
    expect(isStale(fx)).toBe(false);
  });

  it('subrule content changed -> stale (THIS IS THE BUG-FIX TEST for v1)', () => {
    writeFile(fx, 'system', 'rules/rules.yaml',       presets({ default: ['core'] }));
    writeFile(fx, 'system', 'rules/subrules/core.md', 'original');
    build(fx);
    writeFile(fx, 'system', 'rules/subrules/core.md', 'edited');
    expect(isStale(fx)).toBe(true);
  });

  it('rules.yaml definition changed (preset gets a new subrule) -> stale', () => {
    writeFile(fx, 'system', 'rules/rules.yaml',       presets({ default: ['a'] }));
    writeFile(fx, 'system', 'rules/subrules/a.md',    'a');
    writeFile(fx, 'system', 'rules/subrules/b.md',    'b');
    build(fx);
    writeFile(fx, 'system', 'rules/rules.yaml',       presets({ default: ['a', 'b'] }));
    expect(isStale(fx)).toBe(true);
  });

  it('user subrule shadows system subrule -> winning path changes, stale', () => {
    writeFile(fx, 'system', 'rules/rules.yaml',       presets({ default: ['core'] }));
    writeFile(fx, 'system', 'rules/subrules/core.md', 'system version');
    build(fx);
    writeFile(fx, 'user',   'rules/subrules/core.md', 'user override');
    expect(isStale(fx)).toBe(true);
  });

  it('project preset definition shadows system -> stale', () => {
    writeFile(fx, 'system',  'rules/rules.yaml',       presets({ default: ['core'] }));
    writeFile(fx, 'system',  'rules/subrules/core.md', 'core');
    build(fx);
    writeFile(fx, 'project', 'rules/rules.yaml',       presets({ default: ['core', 'project-only'] }));
    writeFile(fx, 'project', 'rules/subrules/project-only.md', 'proj');
    expect(isStale(fx)).toBe(true);
  });

  it('subrule deleted from disk -> stale', () => {
    writeFile(fx, 'system', 'rules/rules.yaml',       presets({ default: ['core'] }));
    writeFile(fx, 'system', 'rules/subrules/core.md', 'core');
    build(fx);
    removeFile(fx, 'system', 'rules/subrules/core.md');
    expect(isStale(fx)).toBe(true);
  });

  it('unrelated subrule changes do NOT trigger stale (only active preset matters)', () => {
    writeFile(fx, 'system', 'rules/rules.yaml',         presets({ default: ['core'] }));
    writeFile(fx, 'system', 'rules/subrules/core.md',   'core');
    writeFile(fx, 'system', 'rules/subrules/unused.md', 'unused-v1');
    build(fx);
    writeFile(fx, 'system', 'rules/subrules/unused.md', 'unused-v2-different-length');
    expect(isStale(fx)).toBe(false);
  });
});
