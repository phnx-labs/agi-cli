import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { resolveImports, compileRulesForProject } from './compile.js';
import { AGENTS } from '../agents.js';
import type { RulesLayer } from './compose.js';

/** Build the layer list used by the project tests below — only the project layer,
 *  so the composed output is deterministic regardless of ~/.agents-system state. */
function projectOnlyLayers(cwd: string): RulesLayer[] {
  return [{ scope: 'project', rulesDir: path.join(cwd, '.agents', 'rules') }];
}

let tmpDir: string;

function writeFile(rel: string, content: string): string {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-compile-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveImports', () => {
  it('inlines a simple relative import', () => {
    writeFile('rules/a.md', 'rule A body');
    const root = 'before\n@rules/a.md\nafter';

    const result = resolveImports(root, tmpDir);

    expect(result.content).toBe('before\nrule A body\nafter');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toBe(path.join(tmpDir, 'rules/a.md'));
  });

  it('resolves imports recursively', () => {
    writeFile('presets/proactive.md', '@../rules/a.md\n@../rules/b.md');
    writeFile('rules/a.md', 'A');
    writeFile('rules/b.md', 'B');
    const root = '@presets/proactive.md';

    const result = resolveImports(root, tmpDir);

    expect(result.content).toBe('A\nB');
    expect(result.sources).toHaveLength(3);
  });

  it('ignores @-imports inside fenced code blocks', () => {
    writeFile('rules/a.md', 'REAL');
    const root = 'live: @rules/a.md\n\n```markdown\n@rules/a.md\n```\n\nend';

    const result = resolveImports(root, tmpDir);

    expect(result.content).toContain('live: REAL');
    // The fenced block must preserve its literal @-import text
    expect(result.content).toContain('```markdown\n@rules/a.md\n```');
    // Only one actual import was resolved
    expect(result.sources).toHaveLength(1);
  });

  it('ignores @-imports inside inline code spans', () => {
    writeFile('rules/a.md', 'REAL');
    const root = 'live: @rules/a.md\nDocs say: `@rules/a.md` — do not re-resolve.';

    const result = resolveImports(root, tmpDir);

    expect(result.content).toContain('live: REAL');
    expect(result.content).toContain('`@rules/a.md`');
    expect(result.sources).toHaveLength(1);
  });

  it('leaves missing imports as literal text', () => {
    const root = '@rules/does-not-exist.md';

    const result = resolveImports(root, tmpDir);

    expect(result.content).toBe('@rules/does-not-exist.md');
    expect(result.sources).toHaveLength(0);
  });

  it('breaks cycles without infinite recursion', () => {
    writeFile('a.md', '@b.md');
    writeFile('b.md', '@a.md');
    const root = '@a.md';

    const result = resolveImports(root, tmpDir);

    // First visit expands a → b, then b → a is cycle-skipped (empty)
    expect(result.content).toBe('');
    expect(result.sources.length).toBeLessThanOrEqual(2);
  });

  it('supports tilde-prefixed absolute paths', () => {
    const homeFile = path.join(os.homedir(), `.agents-compile-test-${process.pid}.md`);
    fs.writeFileSync(homeFile, 'from home');
    try {
      const root = `@~/.agents-compile-test-${process.pid}.md`;
      const result = resolveImports(root, tmpDir);
      expect(result.content).toBe('from home');
      expect(result.sources[0]).toBe(homeFile);
    } finally {
      fs.unlinkSync(homeFile);
    }
  });

  it('respects MAX_DEPTH and does not hang on deep chains', () => {
    // Chain of 10 files; only 5 levels should resolve before depth cutoff.
    for (let i = 0; i < 10; i++) {
      const body = i < 9 ? `@f${i + 1}.md` : 'leaf';
      writeFile(`f${i}.md`, body);
    }
    const result = resolveImports('@f0.md', tmpDir);
    // Once depth exceeds, the inner @-token remains literal — so the final
    // content is some path of expansions followed by a leftover @f{n}.md.
    expect(result.content).toMatch(/@f\d+\.md$|leaf$/);
  });
});

describe('compileRulesForProject', () => {
  /** Set up a minimal project rules tree with a `default` preset and one subrule. */
  function setupProject(opts: { subruleBody?: string } = {}): void {
    writeFile(
      '.agents/rules/rules.yaml',
      'presets:\n  default:\n    subrules: [proj]\n'
    );
    writeFile('.agents/rules/subrules/proj.md', opts.subruleBody ?? 'TOKEN_FRAGMENT');
  }

  it('is a no-op when .agents/rules/ is absent', () => {
    const result = compileRulesForProject(tmpDir, { layers: projectOnlyLayers(tmpDir) });
    expect(result.compiled).toBe(false);
    expect(result.agentsPath).toBe('');
    expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(false);
  });

  it('writes cwd/AGENTS.md with our header and includes the project subrule', () => {
    setupProject();

    const result = compileRulesForProject(tmpDir, { layers: projectOnlyLayers(tmpDir) });

    expect(result.compiled).toBe(true);
    expect(result.agentsPath).toBe(path.join(tmpDir, 'AGENTS.md'));
    const written = fs.readFileSync(result.agentsPath, 'utf-8');
    expect(written).toContain('Auto-compiled by agents-cli');
    expect(written).toContain('TOKEN_FRAGMENT');
    // No raw @-import syntax should leak into the output.
    expect(written).not.toMatch(/^@\.\//m);
  });

  it('creates per-agent symlinks for non-AGENTS.md instruction filenames', () => {
    setupProject();
    const result = compileRulesForProject(tmpDir, { layers: projectOnlyLayers(tmpDir) });

    expect(result.compiled).toBe(true);
    // Every distinct non-AGENTS.md, flat-name instructions file should be symlinked.
    // Nested-path filenames (e.g. workspace/AGENTS.md) are excluded.
    const expected = new Set<string>();
    for (const agent of Object.values(AGENTS)) {
      const f = agent.instructionsFile;
      if (f === 'AGENTS.md') continue;
      if (agent.deprecated?.hard) continue; // hard-deprecated agents get no symlink (e.g. Gemini)
      if (f.includes('/') || f.includes('\\')) continue;
      expected.add(f);
    }
    for (const fname of expected) {
      const linkPath = path.join(tmpDir, fname);
      expect(fs.existsSync(linkPath), `${fname} should exist`).toBe(true);
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        expect(fs.readlinkSync(linkPath)).toBe('AGENTS.md');
      }
    }
    expect(new Set(result.symlinks)).toEqual(expected);
  });

  it('never creates a symlink for a hard-deprecated agent (GEMINI.md)', () => {
    setupProject();
    const result = compileRulesForProject(tmpDir, { layers: projectOnlyLayers(tmpDir) });

    expect(result.compiled).toBe(true);
    expect(result.symlinks).not.toContain('GEMINI.md');
    expect(fs.existsSync(path.join(tmpDir, 'GEMINI.md'))).toBe(false);
  });

  it("doesn't clobber a user-authored cwd/AGENTS.md", () => {
    setupProject();
    const userBody = '# My hand-written project rules\nDo not touch.';
    writeFile('AGENTS.md', userBody);

    const result = compileRulesForProject(tmpDir, { layers: projectOnlyLayers(tmpDir) });

    expect(result.compiled).toBe(false);
    expect(result.skippedClobber).toContain('AGENTS.md');
    expect(fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8')).toBe(userBody);
  });

  it("doesn't clobber a user-authored CLAUDE.md", () => {
    setupProject();
    const userClaude = '# Hand-written claude rules';
    writeFile('CLAUDE.md', userClaude);

    const result = compileRulesForProject(tmpDir, { layers: projectOnlyLayers(tmpDir) });

    expect(result.compiled).toBe(true);
    expect(result.skippedClobber).toContain('CLAUDE.md');
    expect(fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8')).toBe(userClaude);
    expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(true);
  });

  it('is idempotent — second run with same sources reports compiled:false', () => {
    setupProject();
    const first = compileRulesForProject(tmpDir, { layers: projectOnlyLayers(tmpDir) });
    expect(first.compiled).toBe(true);

    const second = compileRulesForProject(tmpDir, { layers: projectOnlyLayers(tmpDir) });
    expect(second.compiled).toBe(false);
    expect(second.symlinks.length).toBeGreaterThan(0);
  });

  it('replaces stale compiled content when sources change', () => {
    setupProject({ subruleBody: 'first version' });
    compileRulesForProject(tmpDir, { layers: projectOnlyLayers(tmpDir) });
    const first = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(first).toContain('first version');

    fs.writeFileSync(path.join(tmpDir, '.agents/rules/subrules/proj.md'), 'second version');
    const result = compileRulesForProject(tmpDir, { layers: projectOnlyLayers(tmpDir) });
    expect(result.compiled).toBe(true);
    const second = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(second).toContain('second version');
    expect(second).not.toContain('first version');
  });

  it('preserves an existing correct symlink without recreating it', () => {
    setupProject();
    compileRulesForProject(tmpDir, { layers: projectOnlyLayers(tmpDir) });

    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const before = fs.lstatSync(claudePath);

    compileRulesForProject(tmpDir, { layers: projectOnlyLayers(tmpDir) });
    const after = fs.lstatSync(claudePath);

    expect(after.ino).toBe(before.ino);
  });
});

describe('compileRulesForProject — reserved roots (RUSH-2725)', () => {
  it('refuses to compile $HOME as a project when ~/.agents is the user layer', async () => {
    // The user layer's own home satisfies the `<cwd>/.agents/rules` existence
    // test, so without the guard $HOME compiled as a "project" — writing
    // ~/AGENTS.md and injecting the whole ruleset twice per session. state.ts
    // captures HOME at import, so re-import the module graph with HOME pointed
    // at the fixture.
    const prevHome = process.env.HOME;
    process.env.HOME = tmpDir;
    vi.resetModules();
    try {
      fs.mkdirSync(path.join(tmpDir, '.agents', 'rules', 'subrules'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.agents', 'rules', 'rules.yaml'),
        'presets:\n  default:\n    subrules: [user]\n'
      );
      fs.writeFileSync(path.join(tmpDir, '.agents', 'rules', 'subrules', 'user.md'), 'USER_LAYER_FRAGMENT');

      const { compileRulesForProject: compileFresh } = await import('./compile.js');
      const result = compileFresh(tmpDir, { layers: projectOnlyLayers(tmpDir) });

      expect(result.compiled).toBe(false);
      expect(result.agentsPath).toBe('');
      expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'CLAUDE.md'))).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      vi.resetModules();
    }
  });
});
