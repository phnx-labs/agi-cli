import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import * as state from './state.js';
import {
  routersDir,
  routerExists,
  readRouter,
  writeRouter,
  deleteRouter,
  listRouters,
  validateRouterName,
  validateRouter,
  type Router,
} from './routers.js';

let TEST_ROOT: string;
let USER_DIR: string;
let PROJECT_DIR: string;
let SYSTEM_DIR: string;

beforeEach(() => {
  TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'routers-test-'));
  USER_DIR = path.join(TEST_ROOT, 'user', '.agents');
  PROJECT_DIR = path.join(TEST_ROOT, 'project', '.agents');
  SYSTEM_DIR = path.join(TEST_ROOT, 'system', '.agents');
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.mkdirSync(SYSTEM_DIR, { recursive: true });
  vi.spyOn(state, 'getUserAgentsDir').mockReturnValue(USER_DIR);
  vi.spyOn(state, 'getSystemAgentsDir').mockReturnValue(SYSTEM_DIR);
  vi.spyOn(state, 'getProjectAgentsDir').mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function sampleRouter(name = 'research'): Router {
  return {
    name,
    task: 'research',
    harnesses: {
      grok: { models: ['cheap', 'default'], accounts: ['personal'] },
      kimi: { models: ['kimi-k2'], accounts: ['work'] },
    },
    weights: { cost: 0.5, success: 0.3, headroom: 0.2 },
    hijack: false,
  };
}

describe('routersDir', () => {
  it('points at the user layer', () => {
    expect(routersDir()).toBe(path.join(USER_DIR, 'routers'));
  });
});

describe('validateRouterName', () => {
  it('accepts lowercase alphanumeric + dash/underscore', () => {
    expect(() => validateRouterName('prod-refactor_2')).not.toThrow();
  });

  it('rejects a name with spaces or other punctuation', () => {
    expect(() => validateRouterName('has spaces')).toThrow(/Invalid router name/);
  });
});

describe('create -> read round-trip', () => {
  it('writes to the user layer and reads back the same shape', () => {
    expect(routerExists('research')).toBe(false);
    writeRouter(sampleRouter());
    expect(routerExists('research')).toBe(true);
    expect(fs.existsSync(path.join(USER_DIR, 'routers', 'research.yml'))).toBe(true);
    expect(readRouter('research')).toEqual(sampleRouter());
  });

  it('readRouter throws for a router that does not exist', () => {
    expect(() => readRouter('nope')).toThrow(/not found/);
  });

  it('deleteRouter removes the user-layer file and is idempotent-false on a second call', () => {
    writeRouter(sampleRouter());
    expect(deleteRouter('research')).toBe(true);
    expect(routerExists('research')).toBe(false);
    expect(deleteRouter('research')).toBe(false);
  });
});

describe('listRouters', () => {
  it('lists every router sorted by name', () => {
    writeRouter(sampleRouter('zeta'));
    writeRouter(sampleRouter('alpha'));
    expect(listRouters().map((r) => r.name)).toEqual(['alpha', 'zeta']);
  });

  it('skips a malformed router file rather than throwing', () => {
    fs.mkdirSync(path.join(USER_DIR, 'routers'), { recursive: true });
    fs.writeFileSync(path.join(USER_DIR, 'routers', 'broken.yml'), ': not: valid: yaml: [');
    writeRouter(sampleRouter('good'));
    expect(listRouters().map((r) => r.name)).toEqual(['good']);
  });
});

describe('validateRouter', () => {
  it('accepts tier tokens on any known harness with no install required', () => {
    const router: Router = {
      name: 'research',
      harnesses: { grok: { models: ['cheap', 'default'] }, kimi: { models: ['best'] } },
    };
    expect(() => validateRouter(router)).not.toThrow();
  });

  it('rejects an unknown harness id', () => {
    const router: Router = { name: 'research', harnesses: { 'not-a-real-harness': { models: ['best'] } } };
    expect(() => validateRouter(router)).toThrow(/unknown harness 'not-a-real-harness'/);
  });

  it('rejects an unverifiable concrete model id for a harness with no installed catalog', () => {
    // No claude version is installed in this sandboxed test HOME, so a concrete
    // (non-tier) model id for it cannot be verified and must fail loud.
    const router: Router = { name: 'research', harnesses: { claude: { models: ['made-up-model-xyz'] } } };
    expect(() => validateRouter(router)).toThrow(/unknown model 'made-up-model-xyz' for harness 'claude'/);
  });

  it('accepts a concrete id that matches a curated tier rung with zero install (Droid)', () => {
    // Droid's tier map is a fixed, install-independent curated ladder
    // (model-tiers.ts DROID_TIERS) -- 'claude-opus-5' is its best/ultra rung.
    const router: Router = { name: 'research', harnesses: { droid: { models: ['claude-opus-5'] } } };
    expect(() => validateRouter(router)).not.toThrow();
  });

  it('rejects a concrete id that is not one of Droid\'s curated rungs', () => {
    const router: Router = { name: 'research', harnesses: { droid: { models: ['not-a-real-model'] } } };
    expect(() => validateRouter(router)).toThrow(/unknown model 'not-a-real-model' for harness 'droid'/);
  });
});

describe('layered resolution', () => {
  it('a project-layer router shadows a user-layer router of the same name', () => {
    vi.spyOn(state, 'getProjectAgentsDir').mockReturnValue(PROJECT_DIR);
    fs.mkdirSync(path.join(PROJECT_DIR, 'routers'), { recursive: true });

    writeRouter({ ...sampleRouter(), task: 'user-layer' });
    fs.writeFileSync(
      path.join(PROJECT_DIR, 'routers', 'research.yml'),
      yaml.stringify({ ...sampleRouter(), task: 'project-layer' }),
    );

    expect(readRouter('research', TEST_ROOT).task).toBe('project-layer');

    const listed = listRouters(TEST_ROOT);
    expect(listed).toHaveLength(1);
    expect(listed[0].task).toBe('project-layer');
  });

  it('unions routers that exist only at one layer', () => {
    vi.spyOn(state, 'getProjectAgentsDir').mockReturnValue(PROJECT_DIR);
    fs.mkdirSync(path.join(PROJECT_DIR, 'routers'), { recursive: true });

    writeRouter(sampleRouter('user-only'));
    fs.writeFileSync(
      path.join(PROJECT_DIR, 'routers', 'project-only.yml'),
      yaml.stringify(sampleRouter('project-only')),
    );

    expect(listRouters(TEST_ROOT).map((r) => r.name)).toEqual(['project-only', 'user-only']);
  });
});
