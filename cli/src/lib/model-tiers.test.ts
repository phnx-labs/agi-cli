
import { describe, it, expect } from 'vitest';
import { isTierToken, tierizeModels, resolveTierMap, resolveTier, MODEL_TIERS, applyTierOverrides, type TierResolution } from './model-tiers.js';
import { getModelCatalog, dropBareLegacyIds, scanClaudeCatalogIds, type ModelInfo } from './models.js';
import { listInstalledVersions } from './installations/versions.js';
import { buildExecCommand } from './exec.js';

describe('curated Kimi ladder (gated on a Kimi install)', () => {
  const kimi = listInstalledVersions('kimi');
  const v = kimi[kimi.length - 1];
  it.runIf(kimi.length > 0)('best=K3 (plain, folds k3-256k in), cheap=highspeed, ultra clamps, [curated]', () => {
    const m = resolveTierMap('kimi', v);
    expect(m.best.model).toBe('kimi-code/k3');
    expect(m.cheap.model).toMatch(/highspeed/);
    expect(m.ultra.clampedFrom).toBe('best');
    expect(m.best.source).toBe('curated');
  });
});

describe('applyTierOverrides (pure — no config I/O)', () => {
  const base = {
    cheap: { tier: 'cheap', model: 'a', source: 'curated' },
    default: { tier: 'default', model: 'b', source: 'curated' },
    best: { tier: 'best', model: 'c', source: 'curated' },
    ultra: { tier: 'ultra', model: 'c', clampedFrom: 'best', source: 'curated' },
  } as Record<(typeof MODEL_TIERS)[number], TierResolution>;
  const ids = new Set(['a', 'b', 'c', 'x']);

  it('uses an override the catalog ships, marked [override], leaving other tiers untouched', () => {
    const out = applyTierOverrides({ best: 'x' }, 'kimi@1', ids, base);
    expect(out.best.model).toBe('x');
    expect(out.best.source).toBe('override');
    expect(out.cheap.model).toBe('a');
  });

  it('falls back to the base pick when the overridden id is not shipped', () => {
    const out = applyTierOverrides({ best: 'nope' }, 'kimi@1', ids, base);
    expect(out.best.model).toBe('c');
    expect(out.best.source).toBe('curated');
    expect(out.best.note).toMatch(/not shipped/);
  });

  it('trusts an override when there is no catalog to validate against (e.g. Droid)', () => {
    const out = applyTierOverrides({ best: 'anything' }, 'droid@1', null, base);
    expect(out.best.model).toBe('anything');
    expect(out.best.source).toBe('override');
  });
});

describe('dropBareLegacyIds (#1892, #2233)', () => {
  it('drops a bare major with a more-specific sibling, keeps a bare id with none', () => {
    const out = dropBareLegacyIds([
      'claude-opus-4', 'claude-opus-4-1', 'claude-opus-4-8',
      'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4', 'claude-haiku-4-5',
    ]);
    expect(out).not.toContain('claude-opus-4');
    expect(out).not.toContain('claude-haiku-4');
    expect(out).toContain('claude-sonnet-5');
    expect(out).toContain('claude-opus-4-8');
    expect(out).toContain('claude-opus-4-1');
  });

  it('drops a bare-minor per-cloud field value when the dated firstParty sibling is present (#2233)', () => {
    const out = dropBareLegacyIds([
      'claude-opus-4-1-20250805',
      'claude-opus-4-1',
      'claude-sonnet-4-6-20250514',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ]);
    expect(out).not.toContain('claude-opus-4-1');
    expect(out).not.toContain('claude-sonnet-4-6');
    expect(out).toContain('claude-opus-4-1-20250805');
    expect(out).toContain('claude-sonnet-4-6-20250514');
    expect(out).toContain('claude-haiku-4-5');
  });

  it('does not treat claude-opus-4-1 as a prefix of claude-opus-4-10', () => {
    const out = dropBareLegacyIds(['claude-opus-4-1', 'claude-opus-4-10']);
    expect(out).toEqual(['claude-opus-4-1', 'claude-opus-4-10']);
  });
});

describe('scanClaudeCatalogIds (#1892 / #2233 — word-boundary + sibling drop)', () => {
  const text = [
    'if(m.includes("claude-opus-4")||m.includes("claude-haiku-4")){}',
    '"Typo in model ID: claude-opus-9.0 (no dashed form exists yet)"',
    'DEFAULTS={firstParty:"claude-opus-4-8"} "claude-opus-4-6-fast" "claude-opus-4-1-20250805-v1"',
    'HAIKU="claude-haiku-4-5" SONNET5="claude-sonnet-5" FABLE="claude-fable-5.md"',
    'var x=zzclaude-opus-4-9zz;',
  ].join('\n');
  const ids = scanClaudeCatalogIds(text);

  it('does not scrape a bare major out of a sibling-less dotted-typo string (the anchor)', () => {
    expect(ids).not.toContain('claude-opus-9');
  });

  it('drops the standalone .includes() prefix-check artifacts (the sibling drop)', () => {
    expect(ids).not.toContain('claude-opus-4');
    expect(ids).not.toContain('claude-haiku-4');
  });

  it('keeps real ids: dated, -fast, -v1, and a bare current with no sibling', () => {
    expect(ids).toContain('claude-opus-4-8');
    expect(ids).toContain('claude-opus-4-6-fast');
    expect(ids).toContain('claude-opus-4-1-20250805-v1');
    expect(ids).toContain('claude-sonnet-5');
    expect(ids).toContain('claude-fable-5');
  });

  it('does not capture an id glued to surrounding identifier characters', () => {
    expect(ids).not.toContain('claude-opus-4-9');
  });

  it('does not backtrack-emit a bare major from a suffix-glued multi-segment token', () => {
    const glued = scanClaudeCatalogIds('cfg={id:"claude-opus-9-1x"};');
    expect(glued).not.toContain('claude-opus-9');
    expect(glued).toHaveLength(0);
  });

  it('drops a foundry bare-minor next to its dated firstParty sibling (#2233)', () => {
    const cloudText = [
      'noise no structured alias map here so fallback scan runs',
      '{firstParty:"claude-opus-4-1-20250805",bedrock:"anthropic.claude-opus-4-1-v1",vertex:"claude-opus-4-1@20250805",foundry:"claude-opus-4-1"}',
      '{firstParty:"claude-sonnet-4-6-20250514",bedrock:"x",vertex:"claude-sonnet-4-6@20250514",foundry:"claude-sonnet-4-6"}',
      'claude-haiku-4-5',
      'claude-fable-5',
    ].join(' ');
    const scanned = scanClaudeCatalogIds(cloudText);
    expect(scanned).not.toContain('claude-opus-4-1');
    expect(scanned).not.toContain('claude-sonnet-4-6');
    expect(scanned).toContain('claude-opus-4-1-20250805');
    expect(scanned).toContain('claude-sonnet-4-6-20250514');
    expect(scanned).toContain('claude-haiku-4-5');
    expect(scanned).toContain('claude-fable-5');
  });
});

const m = (ids: string[]): ModelInfo[] => ids.map((id) => ({ id }));

describe('isTierToken', () => {
  it('accepts the four tiers, rejects ids and unknown words', () => {
    for (const t of MODEL_TIERS) expect(isTierToken(t)).toBe(true);
    expect(isTierToken('claude-opus-5')).toBe(false);
    expect(isTierToken('sonnet')).toBe(false);
    expect(isTierToken(undefined)).toBe(false);
  });
});

describe('tierizeModels — provider lineup (Claude)', () => {
  it('maps haiku/sonnet/opus and picks the newest opus for the family', () => {
    const map = tierizeModels('claude', m(['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-1', 'claude-opus-4-8']));
    expect(map.cheap.model).toContain('haiku');
    expect(map.default.model).toContain('sonnet');
    expect(map.best.model).toBe('claude-opus-4-8');
  });

  it('clamps ultra down to best when the version has no Fable', () => {
    const map = tierizeModels('claude', m(['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8']));
    expect(map.ultra.clampedFrom).toBe('best');
    expect(map.ultra.model).toBe('claude-opus-4-8');
  });

  it('picks the dash-separated newer id (sonnet-5 beats sonnet-4-6)', () => {
    const map = tierizeModels('claude', m(['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8']));
    expect(map.default.model).toBe('claude-sonnet-5');
  });

  it('resolves ultra to Fable when present, without clamping', () => {
    const map = tierizeModels('claude', m(['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5']));
    expect(map.ultra.model).toBe('claude-fable-5');
    expect(map.ultra.clampedFrom).toBeUndefined();
  });
});

describe('tierizeModels — single-model harness maps tiers to effort', () => {
  it('resolves every tier to the one model with ascending reasoning effort', () => {
    const map = tierizeModels('grok', m(['grok-4.5']));
    for (const t of MODEL_TIERS) expect(map[t].model).toBe('grok-4.5');
    expect(map.cheap.effort).toBe('low');
    expect(map.default.effort).toBe('medium');
    expect(map.best.effort).toBe('high');
    expect(map.ultra.effort).toBe('xhigh');
  });
});

describe('tierizeModels — price path (no lineup) ranks and buckets by $/token', () => {
  it('cheapest priced model is cheap, dearest is ultra', () => {
    const map = tierizeModels('opencode', m(['gpt-5.6-sol', 'gpt-4o-mini', 'gpt-5', 'gpt-4o']));
    expect(map.cheap.model).toBe('gpt-4o-mini');
    expect(map.ultra.model).toBe('gpt-5.6-sol');
    const distinct = new Set(MODEL_TIERS.map((t) => map[t].model));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('does not merge two DIFFERENT models that share the same price', () => {
    const map = tierizeModels('opencode', m(['gpt-4o-mini', 'gpt-5.4', 'gpt-5.5', 'gpt-5.6-sol']));
    const picked = new Set(MODEL_TIERS.map((t) => map[t].model));
    expect(picked.has('gpt-5.5')).toBe(true);
    expect(picked.has('gpt-5.6-sol')).toBe(true);
  });
});

describe('resolveTierMap — Droid curated credit-multiplier map', () => {
  it('is a fixed 2x-capped map regardless of version', () => {
    const map = resolveTierMap('droid', '0.0.0');
    expect(map.cheap.model).toBe('glm-5.2');
    expect(map.default.model).toBe('kimi-k3');
    expect(map.best.model).toBe('claude-opus-5');
    expect(map.ultra.model).toBe('claude-opus-5');
    expect(map.ultra.clampedFrom).toBe('best');
  });
});

describe('buildExecCommand — a tier token reaches the argv (gated on Grok install)', () => {
  const grok = listInstalledVersions('grok');
  it.runIf(grok.length > 0)('single-model tier forwards the model AND steers reasoning effort', () => {
    const argv = buildExecCommand({
      agent: 'grok', version: grok[grok.length - 1], prompt: 'x', mode: 'auto', effort: 'auto', model: 'best', headless: true,
    } as Parameters<typeof buildExecCommand>[0]);
    expect(argv).toContain('grok-4.5');
    expect(argv).not.toContain('best');
    const i = argv.indexOf('--reasoning-effort');
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe('high');
  });
});

describe('resolveTier / extraction — real installed Claude (gated)', () => {
  const versions = listInstalledVersions('claude');
  it.runIf(versions.length > 0)('yields a non-empty catalog and a Fable-or-clamped ultra', () => {
    const v = versions[versions.length - 1];
    const cat = getModelCatalog('claude', v);
    expect(cat && cat.models.length).toBeGreaterThan(0);
    const ultra = resolveTier('claude', v, 'ultra');
    expect(ultra.model).toBeTruthy();
    expect(ultra.model!.startsWith('claude-')).toBe(true);
  });
});
