import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  locateModelSource,
  getModelCatalog,
  resolveModel,
  buildReasoningFlags,
  parseGrokModelsStdout,
  resolveConfiguredModel,
} from '../models.js';
import { getVersionDir, listInstalledVersions } from '../installations/versions.js';

function pickInstalledVersion(agent: 'claude' | 'codex' | 'gemini' | 'opencode' | 'openclaw', preference: (vs: string[]) => string | undefined): string | null {
  const versions = listInstalledVersions(agent);
  if (versions.length === 0) return null;
  const chosen = preference(versions);
  return chosen || versions[0] || null;
}

const claudeBundleVer = listInstalledVersions('claude').find((v) =>
  fs.existsSync(path.join(getVersionDir('claude', v), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'))
) ?? null;
const claudeBinaryVer = listInstalledVersions('claude').find((v) =>
  fs.existsSync(path.join(getVersionDir('claude', v), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')) &&
  !fs.existsSync(path.join(getVersionDir('claude', v), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'))
) ?? null;
const firstLocatable = (agent: 'codex' | 'opencode' | 'openclaw' | 'antigravity' | 'kimi' | 'grok'): string | null =>
  listInstalledVersions(agent).find((v) => locateModelSource(agent, v) !== null) ?? null;

const codexVer = firstLocatable('codex');
const opencodeVer = firstLocatable('opencode');
const openclawVer = firstLocatable('openclaw');
const antigravityVer = firstLocatable('antigravity');
const kimiVer = firstLocatable('kimi');
const grokVer = firstLocatable('grok');

describe('locateModelSource', () => {
  it('finds the JS bundle for Claude versions that ship one', () => {
    if (!claudeBundleVer) return;
    const src = locateModelSource('claude', claudeBundleVer);
    expect(src).not.toBeNull();
    expect(src!.kind).toBe('bundle');
    expect(src!.path).toContain('cli.js');
  });

  it('finds the native binary for Claude versions that ship one', () => {
    if (!claudeBinaryVer) return;
    const src = locateModelSource('claude', claudeBinaryVer);
    expect(src).not.toBeNull();
    expect(src!.kind).toBe('binary');
    expect(src!.path).toContain('claude.exe');
  });

  it('finds the codex binary across vendor layouts', () => {
    if (!codexVer) return;
    const src = locateModelSource('codex', codexVer);
    expect(src).not.toBeNull();
    expect(src!.kind).toBe('binary');
    expect(src!.path).toMatch(/\/(?:codex|bin)\/codex$/);
  });

  it('returns null for an unknown version', () => {
    expect(locateModelSource('claude', '0.0.0-not-installed')).toBeNull();
  });
});

describe('getModelCatalog (claude)', () => {
  it('extracts an alias map and at least one model', () => {
    const ver = claudeBundleVer || claudeBinaryVer;
    if (!ver) return;
    const catalog = getModelCatalog('claude', ver);
    expect(catalog).not.toBeNull();
    expect(catalog!.models.length).toBeGreaterThan(0);
    if (Object.keys(catalog!.aliases).length > 0) {
      expect(catalog!.aliases.opus).toMatch(/^claude-opus-/);
      expect(catalog!.aliases.sonnet).toMatch(/^claude-sonnet-/);
      expect(catalog!.aliases.haiku).toMatch(/^claude-haiku-/);
    }
  });

  it('attaches per-cloud routing for at least one model', () => {
    const ver = claudeBundleVer || claudeBinaryVer;
    if (!ver) return;
    const catalog = getModelCatalog('claude', ver)!;
    const withCloud = catalog.models.filter((m) => m.perCloud);
    if (withCloud.length === 0) return;
    const sample = withCloud[0];
    expect(sample.perCloud!.firstParty).toBe(sample.id);
    expect(sample.perCloud!.bedrock).toMatch(/anthropic/);
  });

  it('marks the alias-targeted models as defaults', () => {
    const ver = claudeBundleVer || claudeBinaryVer;
    if (!ver) return;
    const catalog = getModelCatalog('claude', ver)!;
    if (Object.keys(catalog.aliases).length === 0) return;
    const defaults = catalog.models.filter((m) => m.isDefault);
    expect(defaults.length).toBeGreaterThanOrEqual(1);
    for (const d of defaults) {
      expect(Object.values(catalog.aliases)).toContain(d.id);
    }
  });
});

describe('getModelCatalog (codex)', () => {
  it('extracts slugs and reasoning levels', () => {
    if (!codexVer) return;
    const catalog = getModelCatalog('codex', codexVer);
    expect(catalog).not.toBeNull();
    expect(catalog!.models.length).toBeGreaterThan(0);
    const withReasoning = catalog!.models.filter((m) => m.reasoningLevels && m.reasoningLevels.length > 0);
    expect(withReasoning.length).toBeGreaterThan(0);
    const sample = withReasoning[0];
    const efforts = sample.reasoningLevels!.map((l) => l.effort);
    expect(efforts).toContain('low');
    expect(efforts).toContain('medium');
    expect(efforts).toContain('high');
  });

  it('records a default reasoning level on at least one model', () => {
    if (!codexVer) return;
    const catalog = getModelCatalog('codex', codexVer)!;
    const withDefault = catalog.models.filter((m) => m.defaultReasoningLevel);
    expect(withDefault.length).toBeGreaterThan(0);
  });
});

describe('resolveModel', () => {
  it('passes through unknown models with a warning instead of blocking', () => {
    const ver = claudeBundleVer || claudeBinaryVer;
    if (!ver) return;
    const r = resolveModel('claude', ver, 'totally-fake-model-xyz');
    expect(r.forwarded).toBe('totally-fake-model-xyz');
    expect(r.warning).toBeTruthy();
    expect(r.warning).toMatch(/not in known catalog/);
  });

  it('reports the canonical id for an alias', () => {
    const ver = claudeBundleVer || claudeBinaryVer;
    if (!ver) return;
    const catalog = getModelCatalog('claude', ver)!;
    if (!catalog.aliases.opus) return;
    const r = resolveModel('claude', ver, 'opus');
    expect(r.forwarded).toBe('opus');
    expect(r.canonical).toBe(catalog.aliases.opus);
    expect(r.warning).toBeUndefined();
  });

  it('accepts a known canonical id without warning', () => {
    const ver = claudeBundleVer || claudeBinaryVer;
    if (!ver) return;
    const catalog = getModelCatalog('claude', ver)!;
    const known = catalog.models[0]?.id;
    if (!known) return;
    const r = resolveModel('claude', ver, known);
    expect(r.warning).toBeUndefined();
    expect(r.canonical).toBe(known);
  });

  it('strips the [1m] context-window suffix when matching', () => {
    const ver = claudeBundleVer || claudeBinaryVer;
    if (!ver) return;
    const catalog = getModelCatalog('claude', ver)!;
    const known = catalog.models.find((m) => /^claude-opus-/.test(m.id))?.id;
    if (!known) return;
    const r = resolveModel('claude', ver, `${known}[1m]`);
    expect(r.warning).toBeUndefined();
    expect(r.forwarded).toBe(`${known}[1m]`);
  });

  it('forwards as-is and skips warning when version has no extractable catalog', () => {
    const r = resolveModel('claude', '0.0.0-not-installed', 'whatever');
    expect(r.forwarded).toBe('whatever');
    expect(r.warning).toBeUndefined();
  });
});


describe('getModelCatalog (opencode)', () => {
  it('delegates to `opencode models --verbose` and returns provider/id keys', () => {
    if (!opencodeVer) return;
    const src = locateModelSource('opencode', opencodeVer);
    expect(src).not.toBeNull();
    expect(src!.kind).toBe('cli');

    const catalog = getModelCatalog('opencode', opencodeVer);
    if (!catalog || catalog.models.length === 0) return;
    expect(catalog!.models.length).toBeGreaterThanOrEqual(5);
    for (const m of catalog!.models) {
      expect(m.id).toMatch(/^[a-z0-9][a-z0-9.-]*\/.+$/i);
    }
  });
});

describe('getModelCatalog (openclaw)', () => {
  it('parses `openclaw models list --all --json` output', () => {
    if (!openclawVer) return;
    const src = locateModelSource('openclaw', openclawVer);
    expect(src).not.toBeNull();
    expect(src!.kind).toBe('cli');

    const catalog = getModelCatalog('openclaw', openclawVer);
    if (!catalog || catalog.models.length === 0) return;
    expect(catalog.models.length).toBeGreaterThan(50);
    for (const m of catalog.models) {
      expect(m.id).toContain('/');
    }
  });
});

describe('getModelCatalog (antigravity)', () => {
  it('parses `agy models` display-name-only rows and flags the first as default', () => {
    if (!antigravityVer) return;
    const src = locateModelSource('antigravity', antigravityVer);
    expect(src).not.toBeNull();
    expect(src!.kind).toBe('cli');

    const catalog = getModelCatalog('antigravity', antigravityVer);
    if (!catalog || catalog.models.length === 0) return;
    for (const m of catalog.models) {
      expect(m.id).toBe(m.displayName);
      expect(m.id).toMatch(/\([^)]+\)\s*$/);
    }
    const defaults = catalog.models.filter((m) => m.isDefault);
    expect(defaults.length).toBe(1);
    expect(catalog.models[0].isDefault).toBe(true);
  });
});

describe('getModelCatalog (kimi)', () => {
  it('parses `kimi provider list --json` model keys and marks the default', () => {
    if (!kimiVer) return;
    const src = locateModelSource('kimi', kimiVer);
    expect(src).not.toBeNull();
    expect(src!.kind).toBe('cli');

    const catalog = getModelCatalog('kimi', kimiVer);
    if (!catalog || catalog.models.length === 0) return;
    for (const m of catalog.models) {
      expect(m.id).toContain('/');
    }
    expect(catalog.models.filter((m) => m.isDefault).length).toBeLessThanOrEqual(1);
  });
});

describe('parseGrokModelsStdout', () => {
  it('reads Default model: and * id (default) rows', () => {
    const stdout = [
      'You are logged in with grok.com.',
      '',
      'Default model: grok-4.5',
      '',
      'Available models:',
      '  * grok-4.5 (default)',
      '  grok-code-fast-1',
      '',
    ].join('\n');
    const { models } = parseGrokModelsStdout(stdout);
    expect(models.map((m) => m.id)).toEqual(['grok-4.5', 'grok-code-fast-1']);
    expect(models.filter((m) => m.isDefault).map((m) => m.id)).toEqual(['grok-4.5']);
  });

  it('surfaces Default model: when it is missing from the row list', () => {
    const { models } = parseGrokModelsStdout('Default model: grok-4.5\n\nAvailable models:\n');
    expect(models).toEqual([{ id: 'grok-4.5', isDefault: true }]);
  });

  it('ignores banner lines that are not model ids', () => {
    const { models } = parseGrokModelsStdout('You are logged in with grok.com.\nAvailable models:\n');
    expect(models).toEqual([]);
  });
});

describe('getModelCatalog (grok)', () => {
  it('locates the version-home downloads binary and marks the default model', () => {
    if (!grokVer) return;
    const src = locateModelSource('grok', grokVer);
    expect(src).not.toBeNull();
    expect(src!.kind).toBe('cli');
    expect(src!.path).toMatch(/[/\\]\.grok[/\\]downloads[/\\]grok-/);

    const catalog = getModelCatalog('grok', grokVer);
    if (!catalog || catalog.models.length === 0) return;
    for (const m of catalog.models) {
      expect(m.id).toMatch(/^grok[-_]/i);
    }
    const defaults = catalog.models.filter((m) => m.isDefault);
    expect(defaults.length).toBe(1);

    const configured = resolveConfiguredModel('grok', grokVer);
    expect(configured).not.toBeNull();
    expect(configured!.model).toBe(defaults[0].id);
    expect(configured!.source).toBe('cli-default');
  });
});

describe('buildReasoningFlags', () => {
  it('maps Claude levels to --effort', () => {
    expect(buildReasoningFlags('claude', 'high')).toEqual(['--effort', 'high']);
    expect(buildReasoningFlags('claude', 'XHIGH')).toEqual(['--effort', 'xhigh']);
    expect(buildReasoningFlags('claude', 'max')).toEqual(['--effort', 'max']);
  });

  it('maps Codex levels to -c model_reasoning_effort=...', () => {
    expect(buildReasoningFlags('codex', 'low')).toEqual(['-c', 'model_reasoning_effort=low']);
    expect(buildReasoningFlags('codex', 'medium')).toEqual(['-c', 'model_reasoning_effort=medium']);
    expect(buildReasoningFlags('codex', 'high')).toEqual(['-c', 'model_reasoning_effort=high']);
  });

  it('clamps Codex xhigh and max down to high (Codex only supports low/medium/high)', () => {
    expect(buildReasoningFlags('codex', 'xhigh')).toEqual(['-c', 'model_reasoning_effort=high']);
    expect(buildReasoningFlags('codex', 'max')).toEqual(['-c', 'model_reasoning_effort=high']);
  });

  it('returns empty for agents with no known mapping', () => {
    expect(buildReasoningFlags('gemini', 'high')).toEqual([]);
  });
});

describe('getModelCatalog caches a 0-model extraction, bounded by a retry TTL', () => {
  let TMP = '';

  function claudeBundlePath(version: string): string {
    return path.join(
      TMP,
      '.agents',
      '.history',
      'versions',
      'claude',
      version,
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'cli.js'
    );
  }

  function writeFakeBundle(version: string, contents: string) {
    const p = claudeBundlePath(version);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents);
  }

  function cachePath(): string {
    return path.join(TMP, '.agents', '.cache', '.models-cache.json');
  }

  function attemptedAtOnDisk(key: string): number {
    const raw = JSON.parse(fs.readFileSync(cachePath(), 'utf-8'));
    return raw.entries[key].attemptedAt;
  }

  async function freshModels() {
    vi.resetModules();
    return import('../models.js');
  }

  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-models-test-'));
    process.env.HOME = TMP;
  });
  afterEach(() => {
    vi.useRealTimers();
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
    }
  });

  it('persists a 0-model catalog with attemptedAt and does not re-extract on the next call', async () => {
    writeFakeBundle('2.1.207', 'this bundle has no recognizable model constants in it');

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const { getModelCatalog: getCatalog } = await freshModels();
    const key = 'claude@2.1.207';

    const first = getCatalog('claude', '2.1.207');
    expect(first?.models).toHaveLength(0);
    expect(attemptedAtOnDisk(key)).toBe(new Date('2026-01-01T00:00:00Z').getTime());

    vi.setSystemTime(new Date('2026-01-01T00:00:01Z'));
    const second = getCatalog('claude', '2.1.207');

    expect(second?.models).toHaveLength(0);
    expect(second).toEqual(first);
    expect(attemptedAtOnDisk(key)).toBe(new Date('2026-01-01T00:00:00Z').getTime());
  });

  it('re-extracts a stale 0-model entry once the retry TTL elapses, even with mtime unchanged', async () => {
    writeFakeBundle('2.1.208', 'no model constants here either');

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const { getModelCatalog: getCatalog } = await freshModels();
    const key = 'claude@2.1.208';

    const first = getCatalog('claude', '2.1.208');
    expect(first?.models).toHaveLength(0);
    const attemptedAtT0 = attemptedAtOnDisk(key);

    vi.setSystemTime(new Date('2026-01-01T23:59:00Z'));
    const stillCached = getCatalog('claude', '2.1.208');
    expect(stillCached?.models).toHaveLength(0);
    expect(attemptedAtOnDisk(key)).toBe(attemptedAtT0);

    vi.setSystemTime(new Date('2026-01-02T00:00:01Z'));
    const reExtracted = getCatalog('claude', '2.1.208');
    expect(reExtracted?.models).toHaveLength(0);
    expect(attemptedAtOnDisk(key)).toBe(new Date('2026-01-02T00:00:01Z').getTime());
    expect(attemptedAtOnDisk(key)).toBeGreaterThan(attemptedAtT0);
  });

  it('re-extracts immediately when the source mtime changes, regardless of TTL', async () => {
    writeFakeBundle('2.1.209', 'no model constants here');

    const { getModelCatalog: getCatalog } = await freshModels();
    const first = getCatalog('claude', '2.1.209');
    expect(first?.models).toHaveLength(0);

    writeFakeBundle(
      '2.1.209',
      '{OPUS_ID:"claude-opus-5",OPUS_NAME:"Opus",SONNET_ID:"claude-sonnet-5",SONNET_NAME:"Sonnet",HAIKU_ID:"claude-haiku-5",HAIKU_NAME:"Haiku"'
    );

    const second = getCatalog('claude', '2.1.209');
    expect(second?.models.length).toBeGreaterThan(0);
  });
});

describe('getModelCatalog falls back to a raw id scan (issue #1820)', () => {
  let TMP = '';

  function claudeBundlePath(version: string): string {
    return path.join(
      TMP,
      '.agents',
      '.history',
      'versions',
      'claude',
      version,
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'cli.js'
    );
  }

  function writeFakeBundle(version: string, contents: string) {
    const p = claudeBundlePath(version);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents);
  }

  async function freshModels() {
    vi.resetModules();
    return import('../models.js');
  }

  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-models-fallback-test-'));
    process.env.HOME = TMP;
  });
  afterEach(() => {
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
    }
  });

  it('recovers a real catalog when the structured alias/const/perCloud maps are absent', async () => {
    const bundle = [
      'some unrelated minified JS noise, no structured model maps in here',
      'claude-opus-4',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'claude-fable-5',
      'more unrelated noise',
    ].join(' ');
    writeFakeBundle('2.1.207', bundle);

    const { getModelCatalog: getCatalog } = await freshModels();
    const catalog = getCatalog('claude', '2.1.207');

    expect(catalog).not.toBeNull();
    const ids = catalog!.models.map((m) => m.id).sort();
    expect(ids).toEqual(['claude-fable-5', 'claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-5']);
    expect(ids).not.toContain('claude-opus-4');
  });

  it('does not promote a foundry bare-minor to models[].id when its dated firstParty sibling is present (#2233)', async () => {
    const bundle = [
      'no structured {opus:...,sonnet:...,haiku:...} alias map',
      '{firstParty:"claude-haiku-4-5-20251001",bedrock:"x",vertex:"y",foundry:"claude-haiku-4-5"}',
      'firstParty claude-opus-4-1-20250805 foundry claude-opus-4-1',
      'firstParty claude-sonnet-4-6-20250514 foundry claude-sonnet-4-6',
      'claude-fable-5',
    ].join(' ');
    writeFakeBundle('2.1.219', bundle);

    const { getModelCatalog: getCatalog } = await freshModels();
    const catalog = getCatalog('claude', '2.1.219');

    expect(catalog).not.toBeNull();
    const ids = catalog!.models.map((m) => m.id).sort();
    expect(ids).toEqual([
      'claude-fable-5',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-1-20250805',
      'claude-sonnet-4-6-20250514',
    ]);
    expect(ids).not.toContain('claude-opus-4-1');
    expect(ids).not.toContain('claude-sonnet-4-6');
    expect(ids).not.toContain('claude-haiku-4-5');
  });

  it('does not fall back when the structured maps already yield >=2 models', async () => {
    const bundle =
      '{opus:"claude-opus-4-1",sonnet:"claude-sonnet-4-5",haiku:"claude-haiku-4-1"} ' +
      'claude-fable-5';
    writeFakeBundle('2.1.186', bundle);

    const { getModelCatalog: getCatalog } = await freshModels();
    const catalog = getCatalog('claude', '2.1.186')!;

    const ids = catalog.models.map((m) => m.id).sort();
    expect(ids).toEqual(['claude-haiku-4-1', 'claude-opus-4-1', 'claude-sonnet-4-5']);
    expect(ids).not.toContain('claude-fable-5');
  });
});
