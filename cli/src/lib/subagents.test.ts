import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installSubagentToAgent,
  listSubagentsForAgent,
  parseSubagentFrontmatter,
  getSubagentBody,
  transformSubagentForClaude,
  transformSubagentForCodex,
  transformSubagentForAntigravity,
  transformSubagentForCopilot,
  transformSubagentForCursor,
  transformSubagentForGoose,
} from './subagents.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-subagents-'));
  tempDirs.push(dir);
  return dir;
}

function makeTempHome(): string {
  return makeTempDir();
}

function makeSubagentDir(parent: string, name: string): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'AGENT.md'),
    `---\nname: ${name}\ndescription: Test ${name} agent\nmodel: gpt-4o\n---\n\nYou are the ${name} agent.\n`,
    'utf-8'
  );
  return dir;
}

function writeAgentMd(dir: string, body: string, extra?: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'AGENT.md'), body, 'utf-8');
  if (extra) {
    for (const [name, content] of Object.entries(extra)) {
      fs.writeFileSync(path.join(dir, `${name}.md`), content, 'utf-8');
    }
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('transformSubagentForCopilot', () => {
  it('emits a Copilot CLI custom agent profile (.agent.md)', () => {
    const dir = makeSubagentDir(makeTempDir(), 'security-auditor');
    const output = transformSubagentForCopilot(dir);

    expect(output).toContain('name: security-auditor');
    expect(output).toContain('description: Test security-auditor agent');
    expect(output).toContain('model: gpt-4o');
    expect(output).toContain('You are the security-auditor agent.');
  });

  it('appends additional .md files as sections', () => {
    const parent = makeTempDir();
    const dir = makeSubagentDir(parent, 'reviewer');
    fs.writeFileSync(path.join(dir, 'NOTES.md'), 'Extra notes.', 'utf-8');

    const output = transformSubagentForCopilot(dir);
    expect(output).toContain('## Notes');
    expect(output).toContain('Extra notes.');
  });
});

describe('transformSubagentForCodex', () => {
  it('escapes backslashes in the multi-line TOML body, not only the closing quotes (CodeQL js/incomplete-sanitization)', () => {
    const dir = path.join(makeTempDir(), 'winpath');
    writeAgentMd(dir, '---\nname: winpath\ndescription: Paths\n---\n\nOpen C:\\Users\\me and match /a\\.b/ then say """done"""\n');
    const toml = transformSubagentForCodex(dir);
    expect(toml).toContain('Open C:\\\\Users\\\\me and match /a\\\\.b/ then say \\"""done\\"""');
    expect(toml).toContain('name = "winpath"');
  });
});

describe('transformSubagentForCursor', () => {
  it('emits a Cursor CLI custom subagent profile (.cursor/agents/<name>.md)', () => {
    const dir = makeSubagentDir(makeTempDir(), 'security-auditor');
    const output = transformSubagentForCursor(dir);

    expect(output).toContain('name: security-auditor');
    expect(output).toContain('description: Test security-auditor agent');
    expect(output).toContain('model: gpt-4o');
    expect(output).toContain('You are the security-auditor agent.');
    expect(output).not.toContain('color:');
  });

  it('appends additional .md files as sections', () => {
    const parent = makeTempDir();
    const dir = makeSubagentDir(parent, 'reviewer');
    fs.writeFileSync(path.join(dir, 'NOTES.md'), 'Extra notes.', 'utf-8');

    const output = transformSubagentForCursor(dir);
    expect(output).toContain('## Notes');
    expect(output).toContain('Extra notes.');
  });
});

describe('installSubagentToAgent for Cursor', () => {
  it('writes a flattened .md custom subagent to ~/.cursor/agents/', () => {
    const sourceHome = makeTempHome();
    const agentHome = makeTempHome();
    const dir = path.join(sourceHome, 'subagent');
    writeAgentMd(dir, '---\nname: tester\ndescription: Runs tests\nmodel: gpt-5\n---\n\nYou run tests.');

    const result = installSubagentToAgent(dir, 'tester', 'cursor', agentHome);
    expect(result.success).toBe(true);

    const targetPath = path.join(agentHome, '.cursor', 'agents', 'tester.md');
    expect(fs.existsSync(targetPath)).toBe(true);

    const content = fs.readFileSync(targetPath, 'utf-8');
    expect(content).toContain('name: tester');
    expect(content).toContain('model: gpt-5');
    expect(content).toContain('You run tests.');

    const installed = listSubagentsForAgent('cursor', agentHome);
    expect(installed.map(s => s.name)).toEqual(['tester']);
    expect(installed[0].frontmatter.description).toBe('Runs tests');
  });
});

describe('transformSubagentForGoose', () => {
  it('emits a Goose recipe YAML with version/title/description/instructions/prompt', () => {
    const dir = makeSubagentDir(makeTempDir(), 'security-auditor');
    const output = transformSubagentForGoose(dir);
    const recipe = yaml.parse(output) as { version: string; title: string; description: string; instructions: string; prompt: string; settings?: { goose_model?: string } };

    expect(recipe.version).toBe('1.0.0');
    expect(recipe.title).toBe('security-auditor');
    expect(recipe.description).toBe('Test security-auditor agent');
    expect(recipe.instructions).toContain('You are the security-auditor agent.');
    expect(recipe.prompt).toContain('You are the security-auditor agent.');
    expect(recipe.settings?.goose_model).toBe('gpt-4o');
  });
});

describe('installSubagentToAgent for Goose', () => {
  it('writes a recipe YAML to ~/.config/goose/agents/ and round-trips', () => {
    const sourceHome = makeTempHome();
    const agentHome = makeTempHome();
    const dir = path.join(sourceHome, 'subagent');
    writeAgentMd(dir, '---\nname: tester\ndescription: Runs tests\n---\n\nYou run tests.');

    const result = installSubagentToAgent(dir, 'tester', 'goose', agentHome);
    expect(result.success).toBe(true);

    const targetPath = path.join(agentHome, '.config', 'goose', 'agents', 'tester.yaml');
    expect(fs.existsSync(targetPath)).toBe(true);
    const recipe = yaml.parse(fs.readFileSync(targetPath, 'utf-8')) as { title: string; prompt: string };
    expect(recipe.title).toBe('tester');
    expect(recipe.prompt).toContain('You run tests.');

    const installed = listSubagentsForAgent('goose', agentHome);
    expect(installed.map(s => s.name)).toEqual(['tester']);
    expect(installed[0].frontmatter.description).toBe('Runs tests');
  });
});

describe('transformSubagentForAntigravity', () => {
  it('emits a markdown custom-agent profile with local kind', () => {
    const home = makeTempHome();
    const dir = path.join(home, 'subagent');
    writeAgentMd(
      dir,
      '---\nname: planner\ndescription: Plans changes\nmodel: gemini-3-pro\n---\n\nYou plan implementation work.',
      { notes: 'Use file evidence.' }
    );

    const output = transformSubagentForAntigravity(dir);
    expect(output).toContain('name: planner');
    expect(output).toContain('description: Plans changes');
    expect(output).toContain('kind: local');
    expect(output).toContain('model: gemini-3-pro');
    expect(output).toContain('You plan implementation work.');
    expect(output).toContain('## Notes');
    expect(output).toContain('Use file evidence.');
  });
});

describe('installSubagentToAgent for Antigravity', () => {
  it('writes markdown custom-agent files under ~/.gemini/config/agents/<name>/agent.md', () => {
    const sourceHome = makeTempHome();
    const agentHome = makeTempHome();
    const dir = path.join(sourceHome, 'subagent');
    writeAgentMd(dir, '---\nname: verifier\ndescription: Verifies work\n---\n\nYou verify work.');

    const result = installSubagentToAgent(dir, 'verifier', 'antigravity', agentHome);
    expect(result.success).toBe(true);

    const targetPath = path.join(agentHome, '.gemini', 'config', 'agents', 'verifier', 'agent.md');
    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.readFileSync(targetPath, 'utf-8')).toContain('kind: local');

    const installed = listSubagentsForAgent('antigravity', agentHome);
    expect(installed.map(s => s.name)).toEqual(['verifier']);
    expect(installed[0].frontmatter.description).toBe('Verifies work');
  });
});

// PHNX-3187: git checks text files out with CRLF on Windows (core.autocrlf), so
// an AGENT.md whose fences read `---\r\n` must still parse. Before the fix,
// `content.split('\n')` left a trailing '\r' and `'---\r' !== '---'` dropped the
// subagent from discovery — so `agents doctor --fix` on win-mini could never
// install or reconcile it (reported an unactionable "hold").
describe('subagent AGENT.md parsing is CRLF-robust (PHNX-3187)', () => {
  function writeAgentMdRaw(parent: string, name: string, contents: string): string {
    const dir = path.join(parent, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'AGENT.md'), contents, 'utf-8');
    return path.join(dir, 'AGENT.md');
  }

  const frontmatter = '---\nname: code-reviewer\ndescription: Reviews the diff\nmodel: opus\n---\n\nYou review code.\n';

  it('parses frontmatter from a CRLF-checked-out AGENT.md', () => {
    const home = makeTempHome();
    const crlf = frontmatter.replace(/\n/g, '\r\n');
    const file = writeAgentMdRaw(home, 'code-reviewer', crlf);

    const parsed = parseSubagentFrontmatter(file);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('code-reviewer');
    expect(parsed!.description).toBe('Reviews the diff');
    expect(parsed!.model).toBe('opus');
  });

  it('extracts the body from a CRLF-checked-out AGENT.md', () => {
    const home = makeTempHome();
    const file = writeAgentMdRaw(home, 'code-reviewer', frontmatter.replace(/\n/g, '\r\n'));
    expect(getSubagentBody(file)).toBe('You review code.');
  });

  it('transformSubagentForClaude succeeds on a CRLF subagent dir (does not throw "Invalid AGENT.md")', () => {
    const home = makeTempHome();
    writeAgentMdRaw(home, 'code-reviewer', frontmatter.replace(/\n/g, '\r\n'));
    const out = transformSubagentForClaude(path.join(home, 'code-reviewer'));
    expect(out).toContain('name: code-reviewer');
    expect(out).toContain('You review code.');
  });

  it('still parses ordinary LF AGENT.md (no regression)', () => {
    const home = makeTempHome();
    const file = writeAgentMdRaw(home, 'code-reviewer', frontmatter);
    const parsed = parseSubagentFrontmatter(file);
    expect(parsed!.name).toBe('code-reviewer');
    expect(getSubagentBody(file)).toBe('You review code.');
  });
});

describe('installSubagentToAgent for hard-deprecated Gemini', () => {
  it('does not write a markdown subagent file to ~/.gemini/agents/', () => {
    const sourceHome = makeTempHome();
    const agentHome = makeTempHome();
    const dir = path.join(sourceHome, 'subagent');
    writeAgentMd(dir, '---\nname: reviewer\ndescription: Reviews changes\n---\n\nReview the diff.');

    const result = installSubagentToAgent(dir, 'reviewer', 'gemini', agentHome);
    expect(result.success).toBe(false);

    const targetPath = path.join(agentHome, '.gemini', 'agents', 'reviewer.md');
    expect(fs.existsSync(targetPath)).toBe(false);

    const installed = listSubagentsForAgent('gemini', agentHome);
    expect(installed).toEqual([]);
  });
});
