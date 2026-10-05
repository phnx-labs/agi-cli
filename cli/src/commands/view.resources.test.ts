import { afterEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { descriptionForPrefix, parseResourceSections, summarizeDescription } from './view.js';
import { stringWidth } from '../lib/session/width.js';


const ALL = ['commands', 'skills', 'mcp', 'memory', 'hooks', 'workflows', 'plugins'].sort();

const sections = (opts: Parameters<typeof parseResourceSections>[0], json = true) =>
  [...parseResourceSections(opts, json)].sort();

describe('parseResourceSections', () => {
  test('no resource flags → empty set (default --json stays lean)', () => {
    expect(sections({})).toEqual([]);
  });

  test('--detailed → all sections', () => {
    expect(sections({ detailed: true })).toEqual(ALL);
  });

  test('--resources with no value (true) → all sections', () => {
    expect(sections({ resources: true })).toEqual(ALL);
  });

  test('--resources all → all sections', () => {
    expect(sections({ resources: 'all' })).toEqual(ALL);
  });

  test('--resources skills,plugins → just those two', () => {
    expect(sections({ resources: 'skills,plugins' })).toEqual(['plugins', 'skills']);
  });

  test('--resources rules maps to the memory section', () => {
    expect(sections({ resources: 'rules' })).toEqual(['memory']);
  });

  test('whitespace and casing are tolerated', () => {
    expect(sections({ resources: ' Skills , MCP ' })).toEqual(['mcp', 'skills']);
  });

  test('unknown section names are ignored, valid ones kept', () => {
    expect(sections({ resources: 'skills,bogus,plugins' })).toEqual(['plugins', 'skills']);
  });

  test('silent-ignore fix: in --json mode a bare --skills flag folds in', () => {
    expect(sections({ skills: true }, true)).toEqual(['skills']);
  });

  test('section booleans do NOT fold in outside --json mode', () => {
    expect(sections({ skills: true }, false)).toEqual([]);
  });

  test('--rules boolean folds into memory in --json mode', () => {
    expect(sections({ rules: true }, true)).toEqual(['memory']);
  });

  test('--resources value unions with section booleans', () => {
    expect(sections({ resources: 'skills', plugins: true }, true)).toEqual(['plugins', 'skills']);
  });
});

describe('responsive descriptions', () => {
  test('summarizeDescription collapses whitespace and truncates to display width', () => {
    expect(summarizeDescription('one\n\n two\tthree', 80)).toBe('one two three');
    expect(stringWidth(summarizeDescription('abcdef', 4))).toBeLessThanOrEqual(4);
  });

  test('descriptionForPrefix budgets against the visible row prefix', () => {
    const prev = process.env.COLUMNS;
    process.env.COLUMNS = '60';
    try {
      const prefix = '    long-resource-name [system] [synced]  ';
      const desc = descriptionForPrefix('a long description that should fit the remaining cells only', prefix);
      expect(stringWidth(prefix + desc)).toBeLessThanOrEqual(60);
    } finally {
      if (prev === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = prev;
    }
  });
});


const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

describe('view: no implicit drift-check or sync on bare agent view (issue #2058)', () => {
  let testHome = '';
  let projectDir = '';

  afterEach(() => {
    if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
    if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
    testHome = '';
    projectDir = '';
  });

  test('agents view claude exits 0, emits no sync/drift text, and leaves the version home unchanged', () => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-view-drift-home-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-view-drift-proj-'));

    const userDir = path.join(testHome, '.agents');
    const systemDir = path.join(userDir, '.system');
    fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(systemDir, '.update-check'),
      JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
    );

    fs.writeFileSync(path.join(userDir, 'agents.yaml'), `agents:\n  claude: "2.0.0"\n`);

    const versionBase = path.join(userDir, '.history', 'versions', 'claude', '2.0.0');
    const binDir = path.join(versionBase, 'node_modules', '.bin');
    const versionHome = path.join(versionBase, 'home');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(versionHome, { recursive: true });
    const stub = path.join(binDir, 'claude');
    fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(stub, 0o755);

    const skillDir = path.join(userDir, 'skills', 'my-new-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# my-new-skill\n');

    type SnapEntry = { rel: string; type: 'file' | 'dir'; mode: string; content?: string };
    const treeSnapshot = (): SnapEntry[] => {
      const entries: SnapEntry[] = [];
      const walk = (d: string) => {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          const rel = path.relative(versionBase, full);
          const mode = (fs.statSync(full).mode & 0o7777).toString(8).padStart(4, '0');
          if (e.isDirectory()) {
            entries.push({ rel, type: 'dir', mode });
            walk(full);
          } else {
            entries.push({ rel, type: 'file', mode, content: fs.readFileSync(full, 'utf8') });
          }
        }
      };
      walk(versionBase);
      return entries.sort((a, b) => a.rel.localeCompare(b.rel));
    };
    const before = treeSnapshot();

    const r = spawnSync('bun', [INDEX, 'view', 'claude'], {
      encoding: 'utf-8',
      timeout: 15_000,
      cwd: projectDir,
      env: {
        ...process.env,
        HOME: testHome,
        AGENTS_NO_AUTOPULL: '1',
        AGENTS_NO_UPDATE_CHECK: '1',
      },
    });

    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    expect(out).not.toContain('New resources available');
    expect(out).not.toContain('Sync new resources');
    expect(treeSnapshot()).toEqual(before);
  });
});
