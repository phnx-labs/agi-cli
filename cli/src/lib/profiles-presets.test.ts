import { describe, expect, it } from 'vitest';
import { PRESETS, expandPreset, getPreset, listProviders } from './profiles-presets.js';

describe('profiles-presets', () => {
  it('truefoundry preset carries Bedrock-strict-validation env vars', () => {
    const p = getPreset('truefoundry');
    expect(p).toBeDefined();
    expect(p!.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1');
    expect(p!.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
    expect(p!.env.DISABLE_PROMPT_CACHING).toBe('1');
  });

  it('foundry preset is Microsoft Azure AI Foundry on claude host', () => {
    const p = getPreset('foundry');
    expect(p).toBeDefined();
    expect(p!.host).toBe('claude');
    expect(p!.provider).toBe('foundry');
  });

  it('ollama preset uses codex host (not claude)', () => {
    const p = getPreset('ollama');
    expect(p).toBeDefined();
    expect(p!.host).toBe('codex');
  });

  it('expandPreset(truefoundry) returns two prompts', () => {
    const p = getPreset('truefoundry')!;
    expect(expandPreset(p).prompts).toHaveLength(2);
  });

  it('expandPreset(kimi) returns zero prompts (existing presets unchanged)', () => {
    const p = getPreset('kimi')!;
    expect(expandPreset(p).prompts).toHaveLength(0);
  });

  it('listProviders() includes all new gateway providers', () => {
    const providers = listProviders();
    for (const name of [
      'truefoundry',
      'bedrock',
      'vertex',
      'foundry',
      'litellm',
      'vllm',
      'ollama',
      'anthropic',
      'deepinfra',
      'proxy',
    ]) {
      expect(providers).toContain(name);
    }
  });

  it('deepinfra preset uses its OpenAI-compatible endpoint through Codex', () => {
    const preset = getPreset('deepinfra');
    expect(preset?.host).toBe('codex');
    expect(preset?.authEnvVar).toBe('OPENAI_API_KEY');
    expect(preset?.env.OPENAI_BASE_URL).toBe('https://api.deepinfra.com/v1/openai');
    expect(preset?.env.OPENAI_MODEL).toBe('deepseek-ai/DeepSeek-V3');
  });

  // Literal mirrors of preset fields were dropped: they restated profiles-presets.ts, so no wrong
  // implementation could fail them while a model bump broke them all. The negative guard below
  // catches a real bug (a never-served id must not return).

  it('no preset references the never-served meta/claude-spark-1.1 id', () => {
    const stale = PRESETS.filter((p) =>
      Object.values(p.env).some((v) => v.includes('claude-spark-1.1')) ||
      p.description.includes('claude-spark-1.1'),
    );
    expect(stale.map((p) => p.name)).toEqual([]);
  });

  it('proxy preset is on claude host with two prompts', () => {
    const p = getPreset('proxy')!;
    expect(p.host).toBe('claude');
    expect(expandPreset(p).prompts).toHaveLength(2);
  });
});
