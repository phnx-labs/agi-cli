import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
// Remove only workflow-owned stale agents, retain Task when subagents ship, and preserve user files.
// Antigravity workflows are HOME-global and may overwrite only files bearing our ownership marker.
import {
  parseLoopBlock,
  parseWorkflowFrontmatter,
  resolveAllowedSubagents,
  pruneStaleWorkflowSubagents,
  ensureSubagentDispatchTool,
  transformWorkflowForKimi,
  transformWorkflowForAntigravity,
  transformWorkflowForOpenClaw,
  transformWorkflowForGrok,
  grokWorkflowMarker,
  GROK_WORKFLOW_MARKER,
  resolveWorkflowRef,
  listPluginWorkflowDirs,
  isBareWorkflowName,
  parseWorkflowRef,
} from './workflows.js';
import { listWorkflowsForAgent, syncWorkflowToVersion } from './workflows-registry.js';
import * as state from './state.js';

describe('parseLoopBlock — defensive coercion (issue #332)', () => {
  it('parses a well-formed loop block', () => {
    expect(parseLoopBlock({ until: 'signal', max_iterations: 3, budget: 500000, interval: '30m' }))
      .toEqual({ until: 'signal', max_iterations: 3, budget: 500000, interval: '30m' });
  });

  it('returns undefined when the block is absent or not an object', () => {
    expect(parseLoopBlock(undefined)).toBeUndefined();
    expect(parseLoopBlock(null)).toBeUndefined();
    expect(parseLoopBlock('signal')).toBeUndefined();
    expect(parseLoopBlock([1, 2])).toBeUndefined();
  });

  it('drops an unknown until value (only `signal` is valid)', () => {
    expect(parseLoopBlock({ until: 'whenever', max_iterations: 2 }))
      .toEqual({ max_iterations: 2 });
  });

  it('drops a non-integer / non-positive max_iterations', () => {
    expect(parseLoopBlock({ max_iterations: 2.5 })).toBeUndefined();
    expect(parseLoopBlock({ max_iterations: 0 })).toBeUndefined();
    expect(parseLoopBlock({ max_iterations: -3 })).toBeUndefined();
    expect(parseLoopBlock({ max_iterations: '5' })).toBeUndefined();
  });

  it('drops a non-positive or non-numeric budget', () => {
    expect(parseLoopBlock({ budget: 0 })).toBeUndefined();
    expect(parseLoopBlock({ budget: -1 })).toBeUndefined();
    expect(parseLoopBlock({ budget: 'lots' })).toBeUndefined();
  });

  it('drops a non-string interval', () => {
    expect(parseLoopBlock({ interval: 30 })).toBeUndefined();
    expect(parseLoopBlock({ interval: '0' })).toEqual({ interval: '0' });
  });

  it('returns undefined when an all-garbage block leaves no recognized field', () => {
    expect(parseLoopBlock({ until: 'nope', max_iterations: -1, budget: 'x', interval: 5 }))
      .toBeUndefined();
  });
});

describe('pruneStaleWorkflowSubagents — fail-closed cleanup (issue #401)', () => {
  function makeSharedDir(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shared-agents-'));
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), body, 'utf-8');
    }
    return dir;
  }

  it('removes a stale non-permitted workflow subagent while preserving the user\'s own', () => {
    const shared = makeSharedDir({
      'security.md': 'stale security',
      'danger.md': 'leftover from unrestricted run',
      'myhelper.md': 'user hand-placed subagent',
    });

    const workflowSubagentFiles = ['security.md', 'danger.md'];
    const { allowedStems } = resolveAllowedSubagents(workflowSubagentFiles, ['security']);
    expect(allowedStems).toEqual(['security']);

    const pruned = pruneStaleWorkflowSubagents(shared, workflowSubagentFiles, allowedStems);

    expect(pruned).toEqual(['danger.md']);
    expect(fs.existsSync(path.join(shared, 'danger.md'))).toBe(false);

    expect(fs.existsSync(path.join(shared, 'myhelper.md'))).toBe(true);

    expect(fs.existsSync(path.join(shared, 'security.md'))).toBe(true);

    fs.rmSync(shared, { recursive: true, force: true });
  });

  it('prunes every workflow subagent when allowedAgents is explicitly empty', () => {
    const shared = makeSharedDir({
      'security.md': 'stale',
      'danger.md': 'stale',
      'notes.md': 'user file',
    });
    const workflowSubagentFiles = ['security.md', 'danger.md'];
    const { allowedStems } = resolveAllowedSubagents(workflowSubagentFiles, []);
    expect(allowedStems).toEqual([]);

    const pruned = pruneStaleWorkflowSubagents(shared, workflowSubagentFiles, allowedStems);

    expect(pruned.sort()).toEqual(['danger.md', 'security.md']);
    expect(fs.existsSync(path.join(shared, 'security.md'))).toBe(false);
    expect(fs.existsSync(path.join(shared, 'danger.md'))).toBe(false);
    expect(fs.existsSync(path.join(shared, 'notes.md'))).toBe(true);

    fs.rmSync(shared, { recursive: true, force: true });
  });

  it('prunes nothing on a fresh dir or when all subagents are permitted', () => {
    const shared = makeSharedDir({ 'security.md': 'present' });
    const { allowedStems } = resolveAllowedSubagents(['security.md'], undefined);
    expect(pruneStaleWorkflowSubagents(shared, ['security.md'], allowedStems)).toEqual([]);
    expect(fs.existsSync(path.join(shared, 'security.md'))).toBe(true);
    fs.rmSync(shared, { recursive: true, force: true });

    expect(pruneStaleWorkflowSubagents(path.join(os.tmpdir(), 'agents-missing-xyz-401'), ['a.md'], [])).toEqual([]);
  });
});

describe('ensureSubagentDispatchTool — keep Task for orchestrators', () => {
  const base = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'WebFetch'];

  it('appends Task when the workflow ships subagents and Task is missing', () => {
    expect(ensureSubagentDispatchTool(base, true)).toEqual([...base, 'Task']);
  });

  it('leaves the list unchanged when the workflow has no subagents', () => {
    const out = ensureSubagentDispatchTool(base, false);
    expect(out).toEqual(base);
    expect(out).not.toContain('Task');
  });

  it('does not duplicate Task when it is already listed', () => {
    const withTask = [...base, 'Task'];
    expect(ensureSubagentDispatchTool(withTask, true)).toEqual(withTask);
    expect(ensureSubagentDispatchTool(withTask, true).filter(t => t === 'Task')).toHaveLength(1);
  });

  it('does not mutate the input array', () => {
    const input = [...base];
    ensureSubagentDispatchTool(input, true);
    expect(input).toEqual(base);
  });
});

describe('parseWorkflowFrontmatter — loop block', () => {
  function writeWorkflow(frontmatter: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-wf-loop-test-'));
    fs.writeFileSync(path.join(dir, 'WORKFLOW.md'), `---\n${frontmatter}\n---\nbody\n`, 'utf-8');
    return dir;
  }

  it('parses a declared loop block from real WORKFLOW.md frontmatter', () => {
    const dir = writeWorkflow([
      'name: cluster-feedback',
      'description: cluster mentions',
      'loop:',
      '  until: signal',
      '  max_iterations: 3',
      '  budget: 500000',
      '  interval: "0"',
    ].join('\n'));
    const fm = parseWorkflowFrontmatter(dir)!;
    expect(fm.loop).toEqual({ until: 'signal', max_iterations: 3, budget: 500000, interval: '0' });
  });

  it('leaves loop undefined when no loop block is present', () => {
    const dir = writeWorkflow('name: plain\ndescription: no loop');
    const fm = parseWorkflowFrontmatter(dir)!;
    expect(fm.loop).toBeUndefined();
  });

  it('drops a malformed loop block rather than passing a bad shape to the driver', () => {
    const dir = writeWorkflow([
      'name: bad',
      'description: bad loop',
      'loop:',
      '  until: forever',
      '  max_iterations: -1',
    ].join('\n'));
    const fm = parseWorkflowFrontmatter(dir)!;
    expect(fm.loop).toBeUndefined();
  });
});

describe('workflow native projections', () => {
  function writeWorkflow(body: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-wf-projection-'));
    fs.writeFileSync(path.join(dir, 'WORKFLOW.md'), body, 'utf-8');
    return dir;
  }

  it('converts a workflow into a Kimi flow skill', () => {
    const dir = writeWorkflow('---\nname: Review Flow\ndescription: Review code\n---\n\nCheck the diff and report findings.');

    const skill = transformWorkflowForKimi(dir, 'review-flow');

    expect(skill).toContain('name: review-flow');
    expect(skill).toContain('type: flow');
    expect(skill).toContain('agents_workflow: review-flow');
    expect(skill).toContain('description: Review code');
    expect(skill).toContain('```d2');
    expect(skill).toContain('BEGIN -> step -> END');
    expect(skill).toContain('Check the diff and report findings.');
  });

  it('preserves an existing Mermaid diagram for Kimi flow skills', () => {
    const dir = writeWorkflow('---\nname: Mermaid Flow\ndescription: Has diagram\n---\n\n```mermaid\nflowchart TD\nBEGIN --> END\n```');

    const skill = transformWorkflowForKimi(dir, 'mermaid-flow');

    expect(skill).toContain('type: flow');
    expect(skill).toContain('```mermaid');
    expect(skill).toContain('BEGIN --> END');
  });

  it('syncs and lists only agents-cli managed Kimi workflow destinations', () => {
    const dir = writeWorkflow('---\nname: Native Flow\ndescription: Native projection\n---\n\nDo the work.');
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-kimi-wf-home-'));

    try {
      const nativeSkillDir = path.join(kimiHome, '.kimi-code', 'skills', 'native-flow');
      fs.mkdirSync(nativeSkillDir, { recursive: true });
      fs.writeFileSync(path.join(nativeSkillDir, 'SKILL.md'), '---\nname: Native Flow\ndescription: User-owned\ntype: flow\n---\n\n```d2\nBEGIN -> END\n```\n');
      expect(syncWorkflowToVersion(dir, 'native-flow', 'kimi', kimiHome).success).toBe(false);
      expect(listWorkflowsForAgent('kimi', kimiHome)).toEqual([]);

      fs.rmSync(nativeSkillDir, { recursive: true, force: true });
      expect(syncWorkflowToVersion(dir, 'native-flow', 'kimi', kimiHome).success).toBe(true);
      expect(fs.existsSync(path.join(kimiHome, '.kimi-code', 'skills', 'native-flow', 'SKILL.md'))).toBe(true);
      expect(listWorkflowsForAgent('kimi', kimiHome)).toEqual(['native-flow']);
    } finally {
      fs.rmSync(kimiHome, { recursive: true, force: true });
    }
  });

  it('converts a workflow into an Antigravity workflow markdown file', () => {
    const dir = writeWorkflow('---\nname: Ship Flow\ndescription: Ship safely\n---\n\n1. Test\n2. Release');

    const workflow = transformWorkflowForAntigravity(dir, 'ship-flow');

    expect(workflow).toContain('description: Ship safely');
    expect(workflow).toContain('name: Ship Flow');
    expect(workflow).toContain('agents_workflow: ship-flow');
    expect(workflow).toContain('1. Test');
    expect(workflow).toContain('2. Release');
  });

  it('syncs Antigravity workflows to the shared HOME-global dir, guarding user-owned files', () => {
    const dir = writeWorkflow('---\nname: Global Flow\ndescription: Global projection\n---\n\nRun the steps.');
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-agy-home-'));
    const realHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      const globalDir = path.join(fakeHome, '.gemini', 'config', 'global_workflows');
      fs.mkdirSync(globalDir, { recursive: true });
      fs.writeFileSync(path.join(globalDir, 'global-flow.md'), '---\ndescription: User-owned\n---\n\nHand-written.\n');
      expect(syncWorkflowToVersion(dir, 'global-flow', 'antigravity', '/nonexistent-version-home').success).toBe(false);
      expect(listWorkflowsForAgent('antigravity', '/nonexistent-version-home')).toEqual([]);

      fs.rmSync(path.join(globalDir, 'global-flow.md'), { force: true });
      expect(syncWorkflowToVersion(dir, 'global-flow', 'antigravity', '/nonexistent-version-home').success).toBe(true);
      expect(fs.existsSync(path.join(globalDir, 'global-flow.md'))).toBe(true);
      expect(listWorkflowsForAgent('antigravity', '/nonexistent-version-home')).toEqual(['global-flow']);
      expect(syncWorkflowToVersion(dir, 'global-flow', 'antigravity', '/nonexistent-version-home').success).toBe(true);
    } finally {
      if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('converts a workflow into an OpenClaw Lobster workflow file', () => {
    const dir = writeWorkflow('---\nname: OpenClaw Flow\ndescription: Run through Lobster\n---\n\nInspect the repo and report findings.');

    const workflow = yaml.parse(transformWorkflowForOpenClaw(dir, 'openclaw-flow'));

    expect(workflow).toMatchObject({
      name: 'OpenClaw Flow',
      args: { agent: { default: 'main' }, prompt: { default: '' } },
      env: {
        AGENTS_CLI_WORKFLOW: 'openclaw-flow',
        AGENTS_WORKFLOW_DESCRIPTION: 'Run through Lobster',
        AGENTS_WORKFLOW_BODY: 'Inspect the repo and report findings.',
      },
      steps: [{
        id: 'run_openclaw',
        command: 'openclaw agent --agent "$LOBSTER_ARG_AGENT" --message "$(printf \'%s\\n\\n%s\\n\' "$AGENTS_WORKFLOW_BODY" "$LOBSTER_ARG_PROMPT")"',
      }],
    });
  });

  it('syncs and lists only agents-cli managed OpenClaw Lobster workflow files', () => {
    const dir = writeWorkflow('---\nname: Lobster Flow\ndescription: Native OpenClaw projection\n---\n\nDo the work.');
    const openclawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-openclaw-wf-home-'));

    try {
      const workflowsDir = path.join(openclawHome, '.openclaw', 'workflows');
      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.writeFileSync(path.join(workflowsDir, 'lobster-flow.lobster'), yaml.stringify({
        name: 'User-owned',
        env: { SOMETHING_ELSE: 'yes' },
        steps: [{ id: 'user', command: 'echo user' }],
      }), 'utf-8');
      expect(syncWorkflowToVersion(dir, 'lobster-flow', 'openclaw', openclawHome).success).toBe(false);
      expect(listWorkflowsForAgent('openclaw', openclawHome)).toEqual([]);

      fs.rmSync(path.join(workflowsDir, 'lobster-flow.lobster'), { force: true });
      expect(syncWorkflowToVersion(dir, 'lobster-flow', 'openclaw', openclawHome).success).toBe(true);
      expect(fs.existsSync(path.join(workflowsDir, 'lobster-flow.lobster'))).toBe(true);
      expect(listWorkflowsForAgent('openclaw', openclawHome)).toEqual(['lobster-flow']);
      expect(syncWorkflowToVersion(dir, 'lobster-flow', 'openclaw', openclawHome).success).toBe(true);
    } finally {
      fs.rmSync(openclawHome, { recursive: true, force: true });
    }
  });
});

describe('Goose workflow recipe sync', () => {
  it('writes a recipe YAML and subrecipe YAML files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-goose-workflow-'));
    try {
      const workflowDir = path.join(root, 'wf');
      const subagentsDir = path.join(workflowDir, 'subagents');
      const versionHome = path.join(root, 'home');
      fs.mkdirSync(subagentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(workflowDir, 'WORKFLOW.md'),
        [
          '---',
          'name: Review workflow',
          'description: Review code',
          'model: claude-sonnet-4',
          'allowedAgents:',
          '  - reviewer',
          '---',
          'Coordinate the review.',
          '',
        ].join('\n'),
        'utf-8'
      );
      fs.writeFileSync(
        path.join(subagentsDir, 'reviewer.md'),
        '---\nname: reviewer\ndescription: Reviews code\n---\n\nInspect code changes.',
        'utf-8'
      );
      fs.writeFileSync(
        path.join(subagentsDir, 'ignored.md'),
        '---\nname: ignored\ndescription: Ignored\n---\n\nDo not include.',
        'utf-8'
      );

      const result = syncWorkflowToVersion(workflowDir, 'review-wf', 'goose', versionHome);
      expect(result).toEqual({ success: true });

      const recipePath = path.join(versionHome, '.config', 'goose', 'recipes', 'review-wf.yaml');
      const recipe = yaml.parse(fs.readFileSync(recipePath, 'utf-8'));
      expect(recipe).toMatchObject({
        version: '1.0.0',
        title: 'Review workflow',
        description: 'Review code',
        instructions: 'Coordinate the review.',
        prompt: 'Coordinate the review.',
        settings: { goose_model: 'claude-sonnet-4' },
      });
      expect(recipe.sub_recipes).toEqual([{
        name: 'reviewer',
        path: './review-wf.subrecipes/reviewer.yaml',
        description: 'Workflow subrecipe reviewer',
      }]);

      const subrecipe = yaml.parse(fs.readFileSync(path.join(versionHome, '.config', 'goose', 'recipes', 'review-wf.subrecipes', 'reviewer.yaml'), 'utf-8'));
      expect(subrecipe).toMatchObject({
        version: '1.0.0',
        title: 'reviewer',
        description: 'Reviews code',
        instructions: 'Inspect code changes.',
      });
      expect(fs.existsSync(path.join(versionHome, '.config', 'goose', 'recipes', 'review-wf.subrecipes', 'ignored.yaml'))).toBe(false);
      expect(listWorkflowsForAgent('goose', versionHome)).toEqual(['review-wf']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('workflow native projections (grok)', () => {
  function writeWorkflow(body: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-wf-grok-'));
    fs.writeFileSync(path.join(dir, 'WORKFLOW.md'), body, 'utf-8');
    return dir;
  }

  it('converts a workflow into a Grok Rhai script with agents_workflow marker', () => {
    const dir = writeWorkflow(
      '---\nname: Review Flow\ndescription: Review code\n---\n\nCheck the diff and report findings.',
    );

    const rhai = transformWorkflowForGrok(dir, 'review-flow');

    expect(rhai).toContain(`// ${GROK_WORKFLOW_MARKER}: review-flow`);
    expect(rhai).toContain('name: "review-flow"');
    expect(rhai).toContain('description: "Review code"');
    expect(rhai).toContain('Check the diff and report findings.');
    expect(rhai).toContain('phase("Run")');
    expect(rhai).toContain('agent(prompt');
    expect(rhai).toContain('complete(');
  });

  it('escapes quotes and newlines in the embedded orchestrator body', () => {
    const dir = writeWorkflow(
      '---\nname: Quoted\ndescription: Has "quotes"\n---\n\nSay "hello"\nand goodbye.',
    );

    const rhai = transformWorkflowForGrok(dir, 'quoted');
    expect(rhai).toContain('\\"quotes\\"');
    expect(rhai).toContain('Say \\"hello\\"\\nand goodbye.');
  });

  it('syncs and lists only agents-cli managed Grok workflow destinations', () => {
    const dir = writeWorkflow(
      '---\nname: Native Flow\ndescription: Native projection\n---\n\nDo the work.',
    );
    const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-grok-wf-home-'));

    try {
      const workflowsDir = path.join(grokHome, '.grok', 'workflows');
      fs.mkdirSync(workflowsDir, { recursive: true });
      const userOwned = path.join(workflowsDir, 'native-flow.rhai');
      fs.writeFileSync(
        userOwned,
        'let meta = #{ name: "native-flow", description: "user owned" };\ncomplete(#{ ok: true });\n',
      );
      expect(syncWorkflowToVersion(dir, 'native-flow', 'grok', grokHome).success).toBe(false);
      expect(listWorkflowsForAgent('grok', grokHome)).toEqual([]);
      expect(grokWorkflowMarker(userOwned)).toBeNull();

      fs.unlinkSync(userOwned);
      const result = syncWorkflowToVersion(dir, 'native-flow', 'grok', grokHome);
      expect(result.success).toBe(true);
      const target = path.join(workflowsDir, 'native-flow.rhai');
      expect(fs.existsSync(target)).toBe(true);
      expect(grokWorkflowMarker(target)).toBe('native-flow');
      expect(listWorkflowsForAgent('grok', grokHome)).toEqual(['native-flow']);
      expect(syncWorkflowToVersion(dir, 'native-flow', 'grok', grokHome).success).toBe(true);
    } finally {
      fs.rmSync(grokHome, { recursive: true, force: true });
    }
  });
});


describe('resolveWorkflowRef — plugin packaging (Phase 5)', () => {
  let tmpDir = '';
  let userPluginsDir = '';
  let userWorkflowsDir = '';
  let systemWorkflowsDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-wf-resolve-'));
    userPluginsDir = path.join(tmpDir, 'plugins');
    userWorkflowsDir = path.join(tmpDir, 'user-workflows');
    systemWorkflowsDir = path.join(tmpDir, 'system-workflows');
    fs.mkdirSync(userPluginsDir, { recursive: true });
    fs.mkdirSync(userWorkflowsDir, { recursive: true });
    fs.mkdirSync(systemWorkflowsDir, { recursive: true });

    vi.spyOn(state, 'getProjectAgentsDir').mockReturnValue(null);
    vi.spyOn(state, 'getUserWorkflowsDir').mockReturnValue(userWorkflowsDir);
    vi.spyOn(state, 'getSystemWorkflowsDir').mockReturnValue(systemWorkflowsDir);
    vi.spyOn(state, 'getEnabledExtraRepos').mockReturnValue([]);
    vi.spyOn(state, 'getPluginsDir').mockReturnValue(userPluginsDir);
    vi.spyOn(state, 'getSystemPluginsDir').mockReturnValue(path.join(tmpDir, 'sys-plugins-empty'));
    vi.spyOn(state, 'getProjectPluginsDir').mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeWf(dir: string, name: string, description: string): string {
    const wf = path.join(dir, name);
    fs.mkdirSync(wf, { recursive: true });
    fs.writeFileSync(path.join(wf, 'WORKFLOW.md'), `---\ndescription: ${description}\n---\n`);
    return wf;
  }

  it('listPluginWorkflowDirs finds plugin workflows/ folders', () => {
    fs.mkdirSync(path.join(userPluginsDir, 'tools', 'workflows'), { recursive: true });
    const dirs = listPluginWorkflowDirs(tmpDir);
    expect(dirs).toContain(path.join(userPluginsDir, 'tools', 'workflows'));
  });

  it('resolves a bare name from a plugin workflows/ package', () => {
    const expected = writeWf(path.join(userPluginsDir, 'tools', 'workflows'), 'deploy', 'plugin deploy');
    expect(resolveWorkflowRef('deploy', tmpDir)).toBe(expected);
  });

  it('user central storage beats plugin on name collision', () => {
    const user = writeWf(userWorkflowsDir, 'deploy', 'user');
    writeWf(path.join(userPluginsDir, 'tools', 'workflows'), 'deploy', 'plugin');
    expect(resolveWorkflowRef('deploy', tmpDir)).toBe(user);
  });

  it('plugin beats system on name collision', () => {
    const plugin = writeWf(path.join(userPluginsDir, 'tools', 'workflows'), 'deploy', 'plugin');
    writeWf(systemWorkflowsDir, 'deploy', 'system');
    expect(resolveWorkflowRef('deploy', tmpDir)).toBe(plugin);
  });
});

describe('isBareWorkflowName', () => {
  it('accepts a single segment name', () => {
    expect(isBareWorkflowName('deploy')).toBe(true);
    expect(isBareWorkflowName('ship-it')).toBe(true);
  });

  it('rejects path separators and traversal', () => {
    expect(isBareWorkflowName('../etc')).toBe(false);
    expect(isBareWorkflowName('foo/bar')).toBe(false);
    expect(isBareWorkflowName('foo\\bar')).toBe(false);
    expect(isBareWorkflowName('..')).toBe(false);
    expect(isBareWorkflowName('')).toBe(false);
  });
});

describe('resolveWorkflowRef — project plugin beats system plugin', () => {
  let tmpDir = '';
  let userPluginsDir = '';
  let systemPluginsDir = '';
  let projectPluginsDir = '';
  let projectAgentsDir = '';
  let userWorkflowsDir = '';
  let systemWorkflowsDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-wf-plugin-order-'));
    userPluginsDir = path.join(tmpDir, 'user-plugins');
    systemPluginsDir = path.join(tmpDir, 'system-plugins');
    projectPluginsDir = path.join(tmpDir, 'project-plugins');
    projectAgentsDir = path.join(tmpDir, 'project', '.agents');
    userWorkflowsDir = path.join(tmpDir, 'user-workflows');
    systemWorkflowsDir = path.join(tmpDir, 'system-workflows');
    for (const d of [userPluginsDir, systemPluginsDir, projectPluginsDir, userWorkflowsDir, systemWorkflowsDir]) {
      fs.mkdirSync(d, { recursive: true });
    }
    fs.mkdirSync(path.join(projectAgentsDir, 'workflows'), { recursive: true });

    vi.spyOn(state, 'getProjectAgentsDir').mockReturnValue(projectAgentsDir);
    vi.spyOn(state, 'getUserWorkflowsDir').mockReturnValue(userWorkflowsDir);
    vi.spyOn(state, 'getSystemWorkflowsDir').mockReturnValue(systemWorkflowsDir);
    vi.spyOn(state, 'getEnabledExtraRepos').mockReturnValue([]);
    vi.spyOn(state, 'getPluginsDir').mockReturnValue(userPluginsDir);
    vi.spyOn(state, 'getSystemPluginsDir').mockReturnValue(systemPluginsDir);
    vi.spyOn(state, 'getProjectPluginsDir').mockReturnValue(projectPluginsDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeWf(dir: string, name: string, description: string): string {
    const wf = path.join(dir, name);
    fs.mkdirSync(wf, { recursive: true });
    fs.writeFileSync(path.join(wf, 'WORKFLOW.md'), `---\ndescription: ${description}\n---\n`);
    return wf;
  }

  it('project plugin beats system plugin on name collision', () => {
    const project = writeWf(path.join(projectPluginsDir, 'local', 'workflows'), 'deploy', 'project-plugin');
    writeWf(path.join(systemPluginsDir, 'shipped', 'workflows'), 'deploy', 'system-plugin');
    expect(resolveWorkflowRef('deploy', tmpDir)).toBe(project);
  });

  it('project workflow (central) beats any plugin', () => {
    const project = writeWf(path.join(projectAgentsDir, 'workflows'), 'deploy', 'project-central');
    writeWf(path.join(projectPluginsDir, 'local', 'workflows'), 'deploy', 'project-plugin');
    writeWf(path.join(userPluginsDir, 'tools', 'workflows'), 'deploy', 'user-plugin');
    expect(resolveWorkflowRef('deploy', tmpDir)).toBe(project);
  });

  it('rejects bare-name traversal', () => {
    writeWf(path.join(userPluginsDir, 'tools', 'workflows'), 'deploy', 'plugin');
    expect(resolveWorkflowRef('../deploy', tmpDir)).toBeNull();
    expect(resolveWorkflowRef('tools/workflows/deploy', tmpDir)).toBeNull();
  });
});

describe('parseWorkflowRef + name@source (Phase 5)', () => {
  it('parses bare, type-qualified, and source-qualified forms', () => {
    expect(parseWorkflowRef('deploy')).toEqual({ name: 'deploy' });
    expect(parseWorkflowRef('workflow:deploy')).toEqual({ name: 'deploy' });
    expect(parseWorkflowRef('deploy@ship-tools')).toEqual({ name: 'deploy', source: 'ship-tools' });
    expect(parseWorkflowRef('workflow:deploy@ship-tools')).toEqual({ name: 'deploy', source: 'ship-tools' });
  });

  it('rejects traversal and empty pieces', () => {
    expect(parseWorkflowRef('../deploy')).toBeNull();
    expect(parseWorkflowRef('deploy@../x')).toBeNull();
    expect(parseWorkflowRef('@plugin')).toBeNull();
    expect(parseWorkflowRef('deploy@')).toBeNull();
    expect(parseWorkflowRef('')).toBeNull();
  });

  it('isBareWorkflowName rejects @ (source form is not a bare name)', () => {
    expect(isBareWorkflowName('deploy@ship')).toBe(false);
  });
});

describe('resolveWorkflowRef — name@source pin', () => {
  let tmpDir = '';
  let userPluginsDir = '';
  let systemPluginsDir = '';
  let userWorkflowsDir = '';
  let systemWorkflowsDir = '';
  let extraRoot = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-wf-at-source-'));
    userPluginsDir = path.join(tmpDir, 'user-plugins');
    systemPluginsDir = path.join(tmpDir, 'system-plugins');
    userWorkflowsDir = path.join(tmpDir, 'user-workflows');
    systemWorkflowsDir = path.join(tmpDir, 'system-workflows');
    extraRoot = path.join(tmpDir, 'extra-social');
    for (const d of [userPluginsDir, systemPluginsDir, userWorkflowsDir, systemWorkflowsDir, extraRoot]) {
      fs.mkdirSync(d, { recursive: true });
    }

    vi.spyOn(state, 'getProjectAgentsDir').mockReturnValue(null);
    vi.spyOn(state, 'getUserWorkflowsDir').mockReturnValue(userWorkflowsDir);
    vi.spyOn(state, 'getSystemWorkflowsDir').mockReturnValue(systemWorkflowsDir);
    vi.spyOn(state, 'getEnabledExtraRepos').mockReturnValue([
      { alias: 'social', dir: extraRoot, url: 'https://example.test/social.git' },
    ]);
    vi.spyOn(state, 'getPluginsDir').mockReturnValue(userPluginsDir);
    vi.spyOn(state, 'getSystemPluginsDir').mockReturnValue(systemPluginsDir);
    vi.spyOn(state, 'getProjectPluginsDir').mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeWf(dir: string, name: string, description: string): string {
    const wf = path.join(dir, name);
    fs.mkdirSync(wf, { recursive: true });
    fs.writeFileSync(path.join(wf, 'WORKFLOW.md'), `---\ndescription: ${description}\n---\n`);
    return wf;
  }

  it('name@plugin resolves only that plugin, even when user owns the bare name', () => {
    writeWf(userWorkflowsDir, 'deploy', 'user-wins-bare');
    const plugin = writeWf(path.join(userPluginsDir, 'ship-tools', 'workflows'), 'deploy', 'plugin');
    writeWf(path.join(userPluginsDir, 'other', 'workflows'), 'deploy', 'other-plugin');

    expect(resolveWorkflowRef('deploy', tmpDir)).toBe(path.join(userWorkflowsDir, 'deploy'));
    expect(resolveWorkflowRef('deploy@ship-tools', tmpDir)).toBe(plugin);
    expect(resolveWorkflowRef('workflow:deploy@ship-tools', tmpDir)).toBe(plugin);
    expect(resolveWorkflowRef('deploy@other', tmpDir)).toBe(
      path.join(userPluginsDir, 'other', 'workflows', 'deploy'),
    );
  });

  it('name@missing-plugin returns null (no silent fallback)', () => {
    writeWf(userWorkflowsDir, 'deploy', 'user');
    writeWf(path.join(userPluginsDir, 'ship-tools', 'workflows'), 'deploy', 'plugin');
    expect(resolveWorkflowRef('deploy@no-such-plugin', tmpDir)).toBeNull();
  });

  it('name@extra-alias resolves from that extra repo workflows/', () => {
    const extra = writeWf(path.join(extraRoot, 'workflows'), 'cluster', 'extra');
    writeWf(userWorkflowsDir, 'cluster', 'user');
    expect(resolveWorkflowRef('cluster@social', tmpDir)).toBe(extra);
    expect(resolveWorkflowRef('cluster', tmpDir)).toBe(path.join(userWorkflowsDir, 'cluster'));
  });
});
