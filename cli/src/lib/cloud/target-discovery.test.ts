import { describe, it, expect } from 'vitest';
import { MissingTargetError } from './types.js';
import { CodexCloudProvider } from './codex.js';
import { FactoryCloudProvider } from './factory.js';
import { RushCloudProvider } from './rush.js';
import { AntigravityCloudProvider } from './antigravity.js';

describe('MissingTargetError', () => {
  it('is an Error carrying the missing kind and guidance', () => {
    const e = new MissingTargetError('env', 'need env', 'do this');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('MissingTargetError');
    expect(e.kind).toBe('env');
    expect(e.guidance).toBe('do this');
  });
});

describe('targetKind matrix', () => {
  it('only Codex (env) and Factory (computer) run inside a pre-provisioned target', () => {
    expect(new CodexCloudProvider().targetKind).toBe('env');
    expect(new FactoryCloudProvider().targetKind).toBe('computer');
    expect(new RushCloudProvider().targetKind).toBeUndefined();
    expect(new AntigravityCloudProvider().targetKind).toBeUndefined();
  });

  it('Codex exposes no listTargets (no list-environments CLI); Factory does', () => {
    expect(new CodexCloudProvider().listTargets).toBeUndefined();
    expect(typeof new FactoryCloudProvider().listTargets).toBe('function');
  });
});

describe('Codex dispatch without an env', () => {
  it('throws a MissingTargetError(env) with codex-cloud guidance', async () => {
    const p = new CodexCloudProvider();
    await expect(p.dispatch({ prompt: 'do a thing' })).rejects.toMatchObject({
      name: 'MissingTargetError',
      kind: 'env',
    });
    await p.dispatch({ prompt: 'x' }).catch((e: MissingTargetError) => {
      expect(e.guidance).toMatch(/codex cloud/i);
    });
  });
});
