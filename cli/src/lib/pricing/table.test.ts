import { describe, it, expect } from 'vitest';
import { getModelPricing, listPricedModels, PRICING_VERSION } from './table.js';

describe('PRICING_VERSION', () => {
  it('is a date-stamped string', () => {
    expect(PRICING_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('getModelPricing normalization', () => {
  it('matches an exact canonical key', () => {
    const p = getModelPricing('claude-opus-4');
    expect(p).not.toBeNull();
    expect(p!.inputPerToken).toBe(0.000005);
    expect(p!.outputPerToken).toBe(0.000025);
  });

  it('tolerates version-dash suffixes (claude-opus-4-8)', () => {
    expect(getModelPricing('claude-opus-4-8')).toEqual(getModelPricing('claude-opus-4'));
  });

  it('tolerates date suffixes (claude-sonnet-4-20250514)', () => {
    expect(getModelPricing('claude-sonnet-4-20250514')).toEqual(getModelPricing('claude-sonnet-4'));
  });

  it('strips a Bedrock/vendor prefix (us.anthropic.claude-opus-4-8)', () => {
    expect(getModelPricing('us.anthropic.claude-opus-4-8')).toEqual(getModelPricing('claude-opus-4'));
  });

  it('strips a slash vendor prefix (anthropic/claude-haiku-4-5)', () => {
    expect(getModelPricing('anthropic/claude-haiku-4-5')).toEqual(getModelPricing('claude-haiku-4'));
  });

  it('prices the Claude 5 line, which cannot fall back to Claude 4', () => {
    const opus5 = getModelPricing('claude-opus-5');
    expect(opus5).not.toBeNull();
    expect(opus5!.inputPerToken).toBe(0.000005);
    expect(opus5!.outputPerToken).toBe(0.000025);

    const sonnet5 = getModelPricing('claude-sonnet-5');
    expect(sonnet5).not.toBeNull();
    expect(sonnet5!.inputPerToken).toBe(0.000002);
    expect(sonnet5!.outputPerToken).toBe(0.00001);

    expect(sonnet5!.inputPerToken).not.toBe(getModelPricing('claude-sonnet-4')!.inputPerToken);
  });

  it('keeps every Claude model family shipped to date priced', () => {
    for (const id of [
      'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-mythos-5',
      'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5',
    ]) {
      expect(getModelPricing(id), `${id} must be priced`).not.toBeNull();
    }
  });

  it('prefers the longest matching key (gemini-2.5-flash-lite over gemini-2.5-flash)', () => {
    const lite = getModelPricing('gemini-2.5-flash-lite');
    const flash = getModelPricing('gemini-2.5-flash');
    expect(lite).not.toBeNull();
    expect(flash).not.toBeNull();
    expect(lite!.inputPerToken).not.toBe(flash!.inputPerToken);
    expect(lite!.inputPerToken).toBeLessThan(flash!.inputPerToken);
  });

  it('keeps dotted OpenAI versions intact (gpt-5.4-mini)', () => {
    const mini = getModelPricing('gpt-5.4-mini');
    const base = getModelPricing('gpt-5.4');
    expect(mini).not.toBeNull();
    expect(base).not.toBeNull();
    expect(mini!.inputPerToken).toBeLessThan(base!.inputPerToken);
  });

  it('returns null for an unknown model', () => {
    expect(getModelPricing('totally-made-up-model-9000')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(getModelPricing('')).toBeNull();
  });
});

describe('listPricedModels', () => {
  it('lists the canonical keys including current frontier models', () => {
    const models = listPricedModels();
    expect(models).toContain('claude-opus-4');
    expect(models).toContain('gpt-5.4');
    expect(models).toContain('gemini-2.5-pro');
    expect(models.length).toBeGreaterThan(10);
  });
});
