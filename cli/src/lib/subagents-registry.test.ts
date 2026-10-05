// Registry shape is complete; Kimi owns only its markdown, while stale legacy sidecars remain enumerable for orphan cleanup.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { capableAgents } from './capabilities.js';
import {
  SUBAGENT_TARGETS,
  writeSubagentToHome,
  listInstalledSubagentNames,
  listInstalledSubagentsRich,
  removeSubagentFromHome,
  trashSubagentFromHome,
} from './subagents-registry.js';
import { installSubagentToAgent, listSubagentsForAgent, removeSubagentFromAgent } from './subagents.js';

const tempDirs: string[] = [];
function mkTemp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-registry-'));
  tempDirs.push(d);
  return d;
}
function makeSubagentDir(name: string): string {
  const base = mkTemp();
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'AGENT.md'),
    `---\nname: ${name}\ndescription: Test ${name}\nmodel: gpt-4o\n---\n\nYou are ${name}.`,
    'utf-8',
  );
  return dir;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('subagent registry completeness', () => {
  it('has a shape for exactly every subagents-capable agent', () => {
    const capable = capableAgents('subagents').sort();
    const shaped = Object.keys(SUBAGENT_TARGETS).sort();
    expect(shaped).toEqual(capable);
  });
});

describe('generic engine round-trips (droid: previously unwired in subagents.ts)', () => {
  it('installs, lists, and removes a droid subagent via the registry', () => {
    const home = mkTemp();
    const src = makeSubagentDir('reviewer');

    const res = installSubagentToAgent(src, 'reviewer', 'droid', home);
    expect(res.success).toBe(true);
    expect(fs.existsSync(path.join(home, '.factory', 'droids', 'reviewer.md'))).toBe(true);

    const listed = listSubagentsForAgent('droid', home);
    expect(listed.map((s) => s.name)).toEqual(['reviewer']);
    expect(listed[0].frontmatter.description).toBe('Test reviewer');

    const rm = removeSubagentFromAgent('reviewer', 'droid', home);
    expect(rm.success).toBe(true);
    expect(fs.existsSync(path.join(home, '.factory', 'droids', 'reviewer.md'))).toBe(false);
  });
});

describe('generic engine round-trips (copilot: previously unwired for install/remove)', () => {
  it('installs and lists a copilot subagent as <name>.agent.md', () => {
    const home = mkTemp();
    const src = makeSubagentDir('auditor');

    const res = installSubagentToAgent(src, 'auditor', 'copilot', home);
    expect(res.success).toBe(true);
    expect(fs.existsSync(path.join(home, '.copilot', 'agents', 'auditor.agent.md'))).toBe(true);

    const names = listInstalledSubagentNames('copilot', home);
    expect(names).toEqual(['auditor']);
  });
});

describe('Codex TOML listing (readMeta must not use markdown frontmatter)', () => {
  it('installs, lists rich metadata, and removes a codex subagent', () => {
    const home = mkTemp();
    const src = makeSubagentDir('code-reviewer');

    const res = installSubagentToAgent(src, 'code-reviewer', 'codex', home);
    expect(res.success).toBe(true);
    const tomlPath = path.join(home, '.codex', 'agents', 'code-reviewer.toml');
    expect(fs.existsSync(tomlPath)).toBe(true);
    const body = fs.readFileSync(tomlPath, 'utf-8');
    expect(body).toContain('name = "code-reviewer"');
    expect(body).toContain('description = "Test code-reviewer"');

    expect(listInstalledSubagentNames('codex', home)).toEqual(['code-reviewer']);

    const rich = listInstalledSubagentsRich('codex', home);
    expect(rich.map((s) => s.name)).toEqual(['code-reviewer']);
    expect(rich[0].frontmatter.description).toBe('Test code-reviewer');
    expect(rich[0].frontmatter.model).toBe('gpt-4o');

    const listed = listSubagentsForAgent('codex', home);
    expect(listed.map((s) => s.name)).toEqual(['code-reviewer']);
    expect(listed[0].frontmatter.description).toBe('Test code-reviewer');

    const rm = removeSubagentFromAgent('code-reviewer', 'codex', home);
    expect(rm.success).toBe(true);
    expect(fs.existsSync(tomlPath)).toBe(false);
  });

  it('lists a hand-written TOML that has no model field', () => {
    const home = mkTemp();
    const dir = path.join(home, '.codex', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'solo.toml'),
      'name = "solo"\ndescription = "Hand-written agent"\ndeveloper_instructions = """\nDo the thing.\n"""\n',
      'utf-8',
    );

    const rich = listInstalledSubagentsRich('codex', home);
    expect(rich.map((s) => s.name)).toEqual(['solo']);
    expect(rich[0].frontmatter.description).toBe('Hand-written agent');
    expect(rich[0].frontmatter.model).toBeUndefined();
  });
});

describe('trashSubagentFromHome (soft-delete semantics per layout)', () => {
  it('trashes a flat-file subagent as <basename>.<stamp>', () => {
    const home = mkTemp();
    writeSubagentToHome('droid', home, { name: 'w', path: makeSubagentDir('w') });
    const trashDir = path.join(mkTemp(), 'trash');

    const r = trashSubagentFromHome('droid', home, 'w', trashDir, 'STAMP');
    expect(r.success).toBe(true);
    expect(fs.existsSync(path.join(home, '.factory', 'droids', 'w.md'))).toBe(false);
    expect(fs.existsSync(path.join(trashDir, 'w.md.STAMP'))).toBe(true);
  });

  it('trashes a directory-layout subagent as <stamp>/ (whole dir)', () => {
    const home = mkTemp();
    writeSubagentToHome('openclaw', home, { name: 'c', path: makeSubagentDir('c') });
    const trashDir = path.join(mkTemp(), 'trash');

    const r = trashSubagentFromHome('openclaw', home, 'c', trashDir, 'STAMP');
    expect(r.success).toBe(true);
    expect(fs.existsSync(path.join(home, '.openclaw', 'c'))).toBe(false);
    expect(fs.existsSync(path.join(trashDir, 'STAMP', 'AGENTS.md'))).toBe(true);
  });

  it('trashes the single Kimi markdown file it emits', () => {
    const home = mkTemp();
    writeSubagentToHome('kimi', home, { name: 'k', path: makeSubagentDir('k') });
    const trashDir = path.join(mkTemp(), 'trash');

    const r = trashSubagentFromHome('kimi', home, 'k', trashDir, 'STAMP');
    expect(r.success).toBe(true);
    expect(fs.existsSync(path.join(trashDir, 'k.md.STAMP'))).toBe(true);
  });
});

describe('Kimi subagents are Claude-shaped agent markdown', () => {
  it('writes <name>.md with frontmatter, not a yaml + system.md pair', () => {
    const home = mkTemp();
    writeSubagentToHome('kimi', home, { name: 'code-reviewer', path: makeSubagentDir('code-reviewer') });

    const dir = path.join(home, '.kimi-code', 'agents');
    expect(fs.existsSync(path.join(dir, 'code-reviewer.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'code-reviewer.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'code-reviewer.system.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '_agents-cli.yaml'))).toBe(false);

    const body = fs.readFileSync(path.join(dir, 'code-reviewer.md'), 'utf-8');
    expect(body.startsWith('---\n')).toBe(true);
    expect(body).toContain('name: code-reviewer');

    expect(listInstalledSubagentNames('kimi', home)).toEqual(['code-reviewer']);
    expect(listInstalledSubagentsRich('kimi', home).map((s) => s.name)).toEqual(['code-reviewer']);
  });

  it('claims only the file it writes', () => {
    const dir = path.join(mkTemp(), '.kimi-code', 'agents');
    expect(SUBAGENT_TARGETS.kimi!.occupied(dir, 'x').map((e) => path.basename(e.path))).toEqual(['x.md']);
  });

  it('enumerates a stale <name>.system.md so the orphan diff can still reach it', () => {
    const home = mkTemp();
    const dir = path.join(home, '.kimi-code', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'x.yaml'), 'version: 1\n');
    fs.writeFileSync(path.join(dir, 'x.system.md'), 'legacy prompt body');

    expect(listInstalledSubagentNames('kimi', home)).toEqual(['x.system']);
  });
});

describe('removeSubagentFromHome / writeSubagentToHome are no-ops for unshaped agents', () => {
  it('returns success without touching disk for an agent with no registry entry', () => {
    const home = mkTemp();
    expect(writeSubagentToHome('amp', home, { name: 'x', path: makeSubagentDir('x') })).toBe(false);
    expect(removeSubagentFromHome('amp', home, 'x').success).toBe(true);
    expect(listInstalledSubagentNames('amp', home)).toEqual([]);
  });
});
