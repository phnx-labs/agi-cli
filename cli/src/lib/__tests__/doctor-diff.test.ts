import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildCommandSkillContent, commandSkillName } from '../command-skills.js';
import { transformSubagentForClaude } from '../subagents.js';
import { DOCTOR_ALL_KINDS } from '../doctor-diff.js';
import { ALL_RESOURCE_KINDS } from '../staleness/writers/kinds.js';

let testHome: string;
let systemDir: string;
let userDir: string;
let projectDir: string;

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-diff-test-'));
  userDir = path.join(testHome, '.agents');
  systemDir = path.join(userDir, '.system');
  projectDir = path.join(testHome, 'work');
  fs.mkdirSync(userDir, { recursive: true });
  fs.mkdirSync(systemDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  // Avoid the migrator running and failing on a missing legacy state.
  fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'agents:\n  claude: "2.0.0"\n');
});

afterEach(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

interface RunReport {
  agent: string;
  version: string;
  cwd: string;
  layers: { project: string | null; user: string; system: string; extras: unknown[] };
  kinds: Record<string, Array<{ name: string; status: string; source?: string; detail?: string }>>;
  summary: { ok: number; diff: number; missing: number; extra: number };
}

function runDiff(cwd: string, agent: string, version: string, kinds?: string[]): RunReport {
  const modulePath = path.resolve(process.cwd(), 'src/lib/doctor-diff.ts');
  const script = `
    import { diffVersionResources } from ${JSON.stringify(modulePath)};
    const r = diffVersionResources(${JSON.stringify(agent)}, ${JSON.stringify(version)}, {
      cwd: ${JSON.stringify(cwd)},
      kinds: ${kinds ? JSON.stringify(kinds) : 'undefined'},
    });
    console.log(JSON.stringify(r));
  `;
  const out = execFileSync('bun', ['-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: testHome },
    stdio: ['ignore', 'pipe', 'inherit'],
  }).toString('utf-8');
  return JSON.parse(out);
}

function makeVersionHome(agent: string, version: string): string {
  const home = path.join(userDir, '.history', 'versions', agent, version, 'home');
  const configDir = path.join(home, `.${agent}`);
  fs.mkdirSync(path.join(configDir, 'commands'), { recursive: true });
  fs.mkdirSync(path.join(configDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(configDir, 'hooks'), { recursive: true });
  return home;
}

describe('diffVersionResources — commands', () => {
  it('reports ok / diff / missing / extra against the resolved source', () => {
    const home = makeVersionHome('claude', '2.0.0');
    const cmdsHome = path.join(home, '.claude', 'commands');

    fs.mkdirSync(path.join(userDir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'commands', 'recap.md'), 'recap body\n');
    fs.writeFileSync(path.join(userDir, 'commands', 'plan.md'), 'plan body\n');
    fs.writeFileSync(path.join(userDir, 'commands', 'design.md'), 'fresh design\n');

    fs.writeFileSync(path.join(cmdsHome, 'recap.md'), 'recap body\n'); // ok
    fs.writeFileSync(path.join(cmdsHome, 'design.md'), 'stale design\n'); // diff
    fs.writeFileSync(path.join(cmdsHome, 'orphan.md'), 'no source\n'); // extra
    // plan.md missing in home

    const report = runDiff(projectDir, 'claude', '2.0.0', ['commands']);
    const byName = Object.fromEntries(report.kinds.commands.map((r) => [r.name, r]));

    expect(byName.recap).toMatchObject({ status: 'ok', source: 'user' });
    expect(byName.design).toMatchObject({ status: 'diff', source: 'user' });
    expect(byName.plan).toMatchObject({ status: 'missing', source: 'user' });
    expect(byName.orphan).toMatchObject({ status: 'extra' });
    expect(byName.orphan.source).toBeUndefined();
  });

  it('project-layer source overrides user-layer for the same name', () => {
    const home = makeVersionHome('claude', '2.0.0');
    const cmdsHome = path.join(home, '.claude', 'commands');

    fs.mkdirSync(path.join(userDir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'commands', 'recap.md'), 'user body\n');
    fs.mkdirSync(path.join(projectDir, '.agents', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.agents', 'commands', 'recap.md'), 'project body\n');
    fs.writeFileSync(path.join(cmdsHome, 'recap.md'), 'project body\n');

    const report = runDiff(projectDir, 'claude', '2.0.0', ['commands']);
    const recap = report.kinds.commands.find((r) => r.name === 'recap');
    expect(recap).toMatchObject({ status: 'ok', source: 'project' });
  });
});

describe('diffVersionResources — hooks ignore project layer', () => {
  it('does not consider project/.agents/hooks as a source (mirrors sync)', () => {
    const home = makeVersionHome('claude', '2.0.0');
    fs.mkdirSync(path.join(projectDir, '.agents', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.agents', 'hooks', 'evil.sh'), '#!/bin/sh\necho boom\n');

    const report = runDiff(projectDir, 'claude', '2.0.0', ['hooks']);
    // 'evil' should not appear as a missing-source from the project layer.
    const evil = report.kinds.hooks.find((r) => r.name === 'evil');
    expect(evil).toBeUndefined();
  });
});

describe('diffVersionResources — rules', () => {
  // The instruction file (CLAUDE.md/GEMINI.md/AGENTS.md) is COMPOSED from
  // `subrules/` for the active preset — the same rendering the rules writer
  // emits. The diff must compare against that composition, not the raw
  // `rules/AGENTS.md` whole-repo doc (which a preset composition deliberately
  // never equals), or a correctly-synced home file is held as drift forever.
  function seedRules(body: string, extra = 'the whole-repo AGENTS doc, deliberately different\n'): void {
    const rulesDir = path.join(userDir, 'rules');
    fs.mkdirSync(path.join(rulesDir, 'subrules'), { recursive: true });
    // Presence of AGENTS.md makes the row exist and fixes its source layer; its
    // content is intentionally NOT what the home file is compared against.
    fs.writeFileSync(path.join(rulesDir, 'AGENTS.md'), extra);
    fs.writeFileSync(path.join(rulesDir, 'rules.yaml'), 'presets:\n  default:\n    subrules: [core]\n');
    fs.writeFileSync(path.join(rulesDir, 'subrules', 'core.md'), body);
  }

  it('reconciles the instruction file against the composed active-preset rules, not raw AGENTS.md (claude)', () => {
    const home = makeVersionHome('claude', '2.0.0');
    const configDir = path.join(home, '.claude');
    seedRules('rules body\n');
    // Home matches the COMPOSED preset (what the writer emits) → ok, even though
    // it differs from the longer raw AGENTS.md.
    fs.writeFileSync(path.join(configDir, 'CLAUDE.md'), 'rules body\n');

    const report = runDiff(projectDir, 'claude', '2.0.0', ['rules']);
    const agents = report.kinds.rules.find((r) => r.name === 'AGENTS');
    expect(agents).toMatchObject({ status: 'ok', source: 'user' });
  });

  it('flags the instruction file as diff when it does not match the composed preset (claude)', () => {
    const home = makeVersionHome('claude', '2.0.0');
    const configDir = path.join(home, '.claude');
    seedRules('composed body\n');
    // Stale content matching neither the raw AGENTS.md nor the composition.
    fs.writeFileSync(path.join(configDir, 'CLAUDE.md'), 'stale body\n');

    const report = runDiff(projectDir, 'claude', '2.0.0', ['rules']);
    expect(report.kinds.rules.find((r) => r.name === 'AGENTS')?.status).toBe('diff');
  });

  it('compares against the composed preset for non-import agents too — no compiled header (codex)', () => {
    const home = makeVersionHome('codex', '0.100.0');
    const configDir = path.join(home, '.codex');
    seedRules('plain rules\n');
    // codex's instruction file is AGENTS.md; the writer composes the SAME bytes
    // (no compiled header), so a plain composed copy reconciles as ok.
    fs.writeFileSync(path.join(configDir, 'AGENTS.md'), 'plain rules\n');

    const report = runDiff(projectDir, 'codex', '0.100.0', ['rules']);
    expect(report.kinds.rules.find((r) => r.name === 'AGENTS')?.status).toBe('ok');
  });
});

describe('diffVersionResources — native ~/.agents/skills agents', () => {
  // Goose reads central skills directly; the orchestrator deletes its
  // version-home skills dir and registers no skills writer. diffSkills must
  // return no rows, or every central skill is false-reported `missing` and held
  // as unreconcilable forever (drift never clears).
  it('reports no skill rows for a nativeAgentsSkillsDir agent even with a central source skill', () => {
    makeVersionHome('goose', '1.0.0');
    // A central source skill that a non-native agent WOULD report as missing.
    const skillDir = path.join(systemDir, 'skills', 'demo');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\ndescription: demo\n---\nbody\n');

    const report = runDiff(projectDir, 'goose', '1.0.0', ['skills']);
    expect(report.kinds.skills).toEqual([]);
  });
});

describe('diffVersionResources — command-as-skill agents', () => {
  // Kimi (and Codex >= 0.117, Grok) install commands as SKILL wrappers, not
  // native command files. The diff must compare against the wrapper or it
  // false-reports every command as drifted forever.
  function installKimiCommandSkill(version: string, name: string, srcPath: string): void {
    const agentDir = path.join(userDir, '.history', 'versions', 'kimi', version, 'home', '.kimi-code');
    const skillDir = path.join(agentDir, 'skills', commandSkillName(name));
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), buildCommandSkillContent(name, srcPath));
  }

  it('reports ok when the installed command-skill matches source (not a false diff)', () => {
    const srcCmds = path.join(userDir, 'commands');
    fs.mkdirSync(srcCmds, { recursive: true });
    const srcPath = path.join(srcCmds, 'foo.md');
    fs.writeFileSync(srcPath, '# Foo\nrun foo\n');
    installKimiCommandSkill('0.19.0', 'foo', srcPath);

    const report = runDiff(projectDir, 'kimi', '0.19.0', ['commands']);
    expect(report.kinds.commands.find((c) => c.name === 'foo')?.status).toBe('ok');
  });

  it('reports diff when the source changes after the command-skill was installed', () => {
    const srcCmds = path.join(userDir, 'commands');
    fs.mkdirSync(srcCmds, { recursive: true });
    const srcPath = path.join(srcCmds, 'foo.md');
    fs.writeFileSync(srcPath, '# Foo\nrun foo\n');
    installKimiCommandSkill('0.19.0', 'foo', srcPath);
    // Source changed after install — the wrapper no longer matches.
    fs.writeFileSync(srcPath, '# Foo v2\nrun foo differently\n');

    const report = runDiff(projectDir, 'kimi', '0.19.0', ['commands']);
    expect(report.kinds.commands.find((c) => c.name === 'foo')?.status).toBe('diff');
  });

  it('reports a source command as missing for goose (now a recipe-backed command agent)', () => {
    // Goose gained commands support (RUSH-1572): a slash command is a recipe YAML
    // registered in config.yaml. With commands:true a source command that is not
    // yet installed reports as missing (previously goose held commands neither
    // natively nor as skills, so nothing was reported).
    fs.mkdirSync(path.join(userDir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'commands', 'foo.md'), '# Foo\n');
    fs.mkdirSync(path.join(userDir, '.history', 'versions', 'goose', '1.0.0', 'home'), { recursive: true });

    const report = runDiff(projectDir, 'goose', '1.0.0', ['commands']);
    expect(report.kinds.commands.find((c) => c.name === 'foo')?.status).toBe('missing');
  });
});

// PHNX-3187: rules/CLAUDE.md and rules/GEMINI.md are symlinks to AGENTS.md in
// the DotAgents repos. On Windows without symlink support git checks them out
// as PLAIN TEXT FILES whose whole content is the target path ("AGENTS.md"), so
// lstat().isSymbolicLink() is false and they were mistaken for independent
// rule sources no sync could ever produce — a permanent doctor "hold".
// isCheckedOutSymlink is the platform-agnostic detector that closes it.
describe('isCheckedOutSymlink (PHNX-3187)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checked-out-symlink-'));
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Rules\n\nThe canonical rules.\n');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('flags a git-checked-out symlink text file that resolves to a sibling', async () => {
    const { isCheckedOutSymlink } = await import('../doctor-diff.js');
    // A git symlink blob is the bare target with no trailing newline.
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'AGENTS.md');
    expect(isCheckedOutSymlink(path.join(dir, 'CLAUDE.md'))).toBe(true);
  });

  it('does NOT flag a real multi-line markdown rules file', async () => {
    const { isCheckedOutSymlink } = await import('../doctor-diff.js');
    fs.writeFileSync(path.join(dir, 'extra.md'), '# Extra\n\nA real rule file.\n');
    expect(isCheckedOutSymlink(path.join(dir, 'extra.md'))).toBe(false);
  });

  it('does NOT flag a single-line file whose content is not a real sibling path', async () => {
    const { isCheckedOutSymlink } = await import('../doctor-diff.js');
    fs.writeFileSync(path.join(dir, 'note.md'), 'just a one-line note');
    expect(isCheckedOutSymlink(path.join(dir, 'note.md'))).toBe(false);
  });

  it('does NOT flag a real posix symlink (its content is the multi-line target)', async () => {
    const { isCheckedOutSymlink } = await import('../doctor-diff.js');
    try {
      fs.symlinkSync('AGENTS.md', path.join(dir, 'GEMINI.md'));
    } catch {
      return; // filesystem without symlink support — the checked-out-text case covers it
    }
    expect(isCheckedOutSymlink(path.join(dir, 'GEMINI.md'))).toBe(false);
  });
});

// ── PHNX-3504: content-aware coverage for the previously presence-only /
//    untracked kinds. Each edits the SOURCE (name unchanged) and asserts the
//    home copy flips to `diff`, matching the live-driver acceptance runs.

function seedGroup(name: string, allow: string[]): void {
  const dir = path.join(userDir, 'permissions', 'groups');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yaml`), `allow:\n${allow.map((r) => `  - "${r}"`).join('\n')}\n`);
}

describe('diffVersionResources — mcp content-aware (PHNX-3504)', () => {
  function seedMcp(command: string, args: string[]): void {
    fs.mkdirSync(path.join(userDir, 'mcp'), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'mcp', 'foo.yaml'), `name: foo\ntransport: stdio\ncommand: ${command}\nargs:\n${args.map((a) => `  - ${a}`).join('\n')}\n`);
  }
  function writeHomeMcp(home: string, command: string, args: string[]): void {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { foo: { command, args } } }));
  }

  it('reports ok when the home server matches source, diff when the source command/args change', () => {
    const home = makeVersionHome('claude', '2.0.0');
    seedMcp('node', ['old.js']);
    writeHomeMcp(home, 'node', ['old.js']);
    expect(runDiff(projectDir, 'claude', '2.0.0', ['mcp']).kinds.mcp.find((r) => r.name === 'foo')?.status).toBe('ok');

    // Same server name, changed command + args → invisible before PHNX-3504.
    seedMcp('python', ['NEW.js']);
    expect(runDiff(projectDir, 'claude', '2.0.0', ['mcp']).kinds.mcp.find((r) => r.name === 'foo')?.status).toBe('diff');
  });

  it('reports missing (source only) and extra (home only)', () => {
    const home = makeVersionHome('claude', '2.0.0');
    seedMcp('node', ['a.js']);
    writeHomeMcp(home, 'node', ['b.js']); // wrong name below; overwrite with a different server
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { orphan: { command: 'node', args: ['x'] } } }));
    const rows = runDiff(projectDir, 'claude', '2.0.0', ['mcp']).kinds.mcp;
    expect(rows.find((r) => r.name === 'foo')?.status).toBe('missing');
    expect(rows.find((r) => r.name === 'orphan')?.status).toBe('extra');
  });
});

describe('diffVersionResources — permissions content-aware (PHNX-3504)', () => {
  it('claude (representable): ok when every group rule is present, diff when a rule is swapped in source', () => {
    const home = makeVersionHome('claude', '2.0.0');
    seedGroup('mygroup', ['Bash(git *)', 'Bash(ls *)']);
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(git *)', 'Bash(ls *)'], deny: [] } }));
    expect(runDiff(projectDir, 'claude', '2.0.0', ['permissions']).kinds.permissions.find((r) => r.name === 'mygroup')?.status).toBe('ok');

    // Swap ls → rm: the detector still calls the group applied (git * matches),
    // but the new rule never reached the home → diff (was a false `ok` before).
    seedGroup('mygroup', ['Bash(git *)', 'Bash(rm -rf *)']);
    expect(runDiff(projectDir, 'claude', '2.0.0', ['permissions']).kinds.permissions.find((r) => r.name === 'mygroup')?.status).toBe('diff');
  });

  it('grok (lossy): stays presence-only with an honest detail rather than a faked verified ok', () => {
    const home = makeVersionHome('grok', '0.2.200');
    seedGroup('mygroup', ['Bash(git *)']);
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    fs.writeFileSync(path.join(home, '.grok', 'config.toml'), '[permission]\nrules = [{ action = "allow", tool = "bash", pattern = "git *" }]\n');
    const row = runDiff(projectDir, 'grok', '0.2.200', ['permissions']).kinds.permissions.find((r) => r.name === 'mygroup');
    expect(row?.status).toBe('ok');
    expect(row?.detail).toBe('format cannot verify content');
  });
});

describe('diffVersionResources — subagents content-aware (PHNX-3504)', () => {
  function seedSubagent(body: string): string {
    const src = path.join(userDir, 'subagents', 'rev');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'AGENT.md'), `---\nname: rev\ndescription: reviewer\n---\n${body}`);
    return src;
  }

  it('ok when the installed prompt matches source, diff when the source body changes', () => {
    const home = makeVersionHome('claude', '2.0.0');
    const src = seedSubagent('old prompt body\n');
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'agents', 'rev.md'), transformSubagentForClaude(src));
    expect(runDiff(projectDir, 'claude', '2.0.0', ['subagents']).kinds.subagents.find((r) => r.name === 'rev')?.status).toBe('ok');

    // Prompt-body edit, filename unchanged → invisible before PHNX-3504.
    seedSubagent('EDITED prompt body\n');
    expect(runDiff(projectDir, 'claude', '2.0.0', ['subagents']).kinds.subagents.find((r) => r.name === 'rev')?.status).toBe('diff');
  });
});

describe('diffVersionResources — workflows content-aware (PHNX-3504)', () => {
  function seedWorkflow(body: string): void {
    const src = path.join(userDir, 'workflows', 'ship');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'WORKFLOW.md'), `---\nname: ship\ndescription: ship it\n---\n${body}`);
  }

  it('is a real DoctorKind now and reports ok / diff on the copied WORKFLOW.md tree (claude)', () => {
    const home = makeVersionHome('claude', '2.0.0');
    seedWorkflow('old steps\n');
    const wfHome = path.join(home, 'workflows', 'ship');
    fs.mkdirSync(wfHome, { recursive: true });
    fs.writeFileSync(path.join(wfHome, 'WORKFLOW.md'), `---\nname: ship\ndescription: ship it\n---\nold steps\n`);

    const report = runDiff(projectDir, 'claude', '2.0.0', ['workflows']);
    expect(report.kinds.workflows).toBeDefined();
    expect(report.kinds.workflows.find((r) => r.name === 'ship')?.status).toBe('ok');

    seedWorkflow('EDITED steps\n');
    expect(runDiff(projectDir, 'claude', '2.0.0', ['workflows']).kinds.workflows.find((r) => r.name === 'ship')?.status).toBe('diff');
  });
});

describe('diffVersionResources — memory (knowledge facts) content-aware (PHNX-3504)', () => {
  function seedFact(body: string): void {
    fs.mkdirSync(path.join(userDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'memory', 'fact.md'), body);
  }
  function seedHomeMemory(home: string, factBody: string, managed: string[]): void {
    const dir = path.join(home, '.claude', 'memory');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fact.md'), factBody);
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Memory index\n');
    fs.writeFileSync(path.join(dir, '.agents-cli-memory.json'), JSON.stringify({ facts: [...managed] }));
  }

  it('is a real DoctorKind now (NOT the rules-preset trap) and reports ok / diff on a fact edit', () => {
    const home = makeVersionHome('claude', '2.0.0');
    seedFact('# fact\nold knowledge\n');
    seedHomeMemory(home, '# fact\nold knowledge\n', ['MEMORY', 'fact']);
    expect(runDiff(projectDir, 'claude', '2.0.0', ['memory']).kinds.memory.find((r) => r.name === 'fact')?.status).toBe('ok');

    seedFact('# fact\nEDITED knowledge\n');
    expect(runDiff(projectDir, 'claude', '2.0.0', ['memory']).kinds.memory.find((r) => r.name === 'fact')?.status).toBe('diff');
  });

  it('reports a managed fact removed from source as extra, never a stray native file', () => {
    const home = makeVersionHome('claude', '2.0.0');
    // No source fact of this name, but the manifest says we wrote it → orphan.
    seedHomeMemory(home, '# fact\nstale\n', ['MEMORY', 'fact']);
    const rows = runDiff(projectDir, 'claude', '2.0.0', ['memory']).kinds.memory;
    expect(rows.find((r) => r.name === 'fact')?.status).toBe('extra');
  });
});

describe('diffVersionResources — rules sub-rule drift regression (PHNX-3504)', () => {
  it('flags the composed instruction file as diff when a subrules/ fragment is edited after a matching sync', () => {
    const home = makeVersionHome('claude', '2.0.0');
    const rulesDir = path.join(userDir, 'rules');
    fs.mkdirSync(path.join(rulesDir, 'subrules'), { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'AGENTS.md'), 'whole-repo doc\n');
    fs.writeFileSync(path.join(rulesDir, 'rules.yaml'), 'presets:\n  default:\n    subrules: [core]\n');
    fs.writeFileSync(path.join(rulesDir, 'subrules', 'core.md'), 'composed body\n');
    // Home matches the composition of the fragment.
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'composed body\n');
    expect(runDiff(projectDir, 'claude', '2.0.0', ['rules']).kinds.rules.find((r) => r.name === 'AGENTS')?.status).toBe('ok');

    // Edit only the FRAGMENT (the whole-repo AGENTS.md never changes) → the
    // recomposed expectation changes → diff.
    fs.writeFileSync(path.join(rulesDir, 'subrules', 'core.md'), 'EDITED fragment body\n');
    expect(runDiff(projectDir, 'claude', '2.0.0', ['rules']).kinds.rules.find((r) => r.name === 'AGENTS')?.status).toBe('diff');
  });
});

describe('DOCTOR_ALL_KINDS completeness (PHNX-3504)', () => {
  // Bound to the REAL writer registry (`ALL_RESOURCE_KINDS`, the source of truth
  // for what `syncResourcesToVersion` writes) — NOT a second hand-typed literal
  // that would go stale in lockstep with `DOCTOR_ALL_KINDS` and defeat the guard.
  // Doctor covers exactly that registry PLUS `memory` (the knowledge-fact fan-out
  // via `syncMemoryToVersionHome`, which is a separate sync call, not a writer-
  // registry kind). Excluded on purpose: `promptcuts` (a single version-unscoped
  // file, not per-home) and Claude's NATIVE per-project auto-memory (unmanaged).
  // A future synced kind added to the registry but forgotten in DOCTOR_ALL_KINDS
  // fails this test rather than silently becoming a doctor blind spot.
  const SYNCED_KINDS = [...ALL_RESOURCE_KINDS, 'memory'].sort();

  it('covers exactly the version-synced kinds (no promptcuts, includes workflows + memory)', () => {
    expect([...DOCTOR_ALL_KINDS].sort()).toEqual(SYNCED_KINDS);
    expect(DOCTOR_ALL_KINDS).not.toContain('promptcuts');
    expect(DOCTOR_ALL_KINDS).toContain('workflows');
    expect(DOCTOR_ALL_KINDS).toContain('memory');
  });

  it('diffVersionResources emits exactly those kind buckets', () => {
    makeVersionHome('claude', '2.0.0');
    const report = runDiff(projectDir, 'claude', '2.0.0');
    expect(Object.keys(report.kinds).sort()).toEqual(SYNCED_KINDS);
  });
});
