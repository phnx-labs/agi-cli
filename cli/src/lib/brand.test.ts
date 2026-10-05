import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CLI_NAME,
  disabledCommandsForActiveBrand,
  reservedBrandNames,
  resolveBrandName,
  validateBrandName,
} from './brand.js';
import { AGENT_CLI_COMMANDS } from './agent-cli-commands.js';
import { AGENTS, ALL_AGENT_IDS } from './agents.js';

const brandSrcPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'brand.ts');

describe('resolveBrandName', () => {
  afterEach(() => {
    delete process.env.AGENTS_BRAND;
  });

  it('returns agents when AGENTS_BRAND is unset', () => {
    delete process.env.AGENTS_BRAND;
    expect(resolveBrandName()).toBe(DEFAULT_CLI_NAME);
  });

  it('returns the brand when AGENTS_BRAND is a valid name', () => {
    process.env.AGENTS_BRAND = 'jack';
    expect(resolveBrandName()).toBe('jack');
  });

  it('rejects invalid brand tokens and falls back to agents', () => {
    process.env.AGENTS_BRAND = '9bad';
    expect(resolveBrandName()).toBe(DEFAULT_CLI_NAME);
  });
});

describe('disabledCommandsForActiveBrand', () => {
  afterEach(() => {
    delete process.env.AGENTS_BRAND;
  });

  it('returns an empty set when unbranded (no readMeta)', () => {
    delete process.env.AGENTS_BRAND;
    expect(disabledCommandsForActiveBrand().size).toBe(0);
  });
});

describe('eager graph (RUSH-2331)', () => {
  it('brand.ts source does not statically import agents.js', () => {
    const src = fs.readFileSync(brandSrcPath, 'utf-8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/from\s+['"]\.\/agents\.js['"]/);
    expect(code).toMatch(/from\s+['"]\.\/agent-cli-commands\.js['"]/);
  });
});

describe('reservedBrandNames / validateBrandName (RUSH-2331)', () => {
  it('reserves agents, ag, and every harness cliCommand', () => {
    const reserved = reservedBrandNames();
    expect(reserved.has('agents')).toBe(true);
    expect(reserved.has('ag')).toBe(true);
    for (const cmd of AGENT_CLI_COMMANDS) {
      expect(reserved.has(cmd)).toBe(true);
    }
    for (const id of ALL_AGENT_IDS) {
      expect(reserved.has(AGENTS[id].cliCommand)).toBe(true);
    }
  });

  it('rejects reserved harness CLI names', () => {
    expect(validateBrandName('claude')).toMatch(/reserved/);
    expect(validateBrandName('cursor-agent')).toMatch(/reserved/);
    expect(validateBrandName('warp')).toMatch(/reserved/);
    expect(validateBrandName('agents')).toMatch(/reserved/);
    expect(validateBrandName('ag')).toMatch(/reserved/);
  });

  it('accepts a free name', () => {
    expect(validateBrandName('jack')).toBeNull();
    expect(validateBrandName('my-cli')).toBeNull();
  });

  it('rejects invalid shapes', () => {
    expect(validateBrandName('9bad')).toMatch(/Invalid name/);
    expect(validateBrandName('has space')).toMatch(/Invalid name/);
  });
});
