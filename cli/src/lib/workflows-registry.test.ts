import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { capableAgents } from './capabilities.js';
import { workflowsDetectors } from './staleness/detectors/workflows.js';
import {
  WORKFLOW_TARGETS,
  listWorkflowsForAgent,
  syncWorkflowToVersion,
  workflowContentMatches,
  workflowTarget,
} from './workflows-registry.js';
import type { AgentId } from './types.js';

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writeWorkflow(body: string): string {
  const dir = tmp('agents-wf-registry-src-');
  fs.writeFileSync(path.join(dir, 'WORKFLOW.md'), body, 'utf-8');
  return dir;
}

function withHome<T>(home: string, fn: () => T): T {
  const real = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (real === undefined) delete process.env.HOME; else process.env.HOME = real;
  }
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('workflow registry completeness', () => {
  it('has a shape for exactly every workflows-capable agent', () => {
    const capable = capableAgents('workflows').sort();
    const shaped = Object.keys(WORKFLOW_TARGETS).sort();
    expect(shaped).toEqual(capable);
  });

  it('fails loud for a harness with no workflow shape', () => {
    const uncapable = (['codex', 'cursor', 'gemini'] as AgentId[]).find((a) => !(a in WORKFLOW_TARGETS));
    expect(uncapable).toBeDefined();
    expect(() => workflowTarget(uncapable!)).toThrow(/no workflow target/);
  });
});

describe('writer, lister, detector, and doctor drift agree per harness', () => {
  const source = '---\nname: Registry Flow\ndescription: Round-trip through the registry\n---\n\nDo the work.\n';

  for (const agent of capableAgents('workflows')) {
    it(`${agent}: sync → list → detect → drift → remove round-trips through one table`, () => {
      const home = tmp(`agents-wf-registry-${agent}-home-`);
      withHome(home, () => {
        const workflowDir = writeWorkflow(source);
        const detector = workflowsDetectors[agent]!;
        const detect = () => detector.list({ version: '0.0.0', versionHome: home, cwd: home });

        expect(listWorkflowsForAgent(agent, home)).toEqual([]);
        expect(detect()).toEqual([]);

        const synced = syncWorkflowToVersion(workflowDir, 'registry-flow', agent, home);
        expect(synced).toEqual({ success: true });

        expect(listWorkflowsForAgent(agent, home)).toEqual(['registry-flow']);
        expect(detect()).toEqual(['registry-flow']);
        expect(workflowContentMatches(agent, home, 'registry-flow', workflowDir)).toBe(true);

        fs.writeFileSync(path.join(workflowDir, 'WORKFLOW.md'), source.replace('Do the work.', 'Do different work.'), 'utf-8');
        expect(workflowContentMatches(agent, home, 'registry-flow', workflowDir)).toBe(false);

        expect(syncWorkflowToVersion(workflowDir, 'registry-flow', agent, home)).toEqual({ success: true });
        expect(workflowContentMatches(agent, home, 'registry-flow', workflowDir)).toBe(true);

        const target = workflowTarget(agent);
        const dir = target.dir(home);
        for (const entry of target.occupied(dir, 'registry-flow')) fs.rmSync(entry, { recursive: true, force: true });
        expect(target.occupied(dir, 'registry-flow')).toEqual([]);
        expect(listWorkflowsForAgent(agent, home)).toEqual([]);
        expect(detect()).toEqual([]);
        expect(workflowContentMatches(agent, home, 'registry-flow', workflowDir)).toBe(false);
      });
    });
  }
});

describe('ownership markers refuse to clobber user-authored files', () => {
  it('kimi: a foreign <name>/ skill dir blocks sync with the harness label in the error', () => {
    const home = tmp('agents-wf-registry-kimi-foreign-');
    const workflowDir = writeWorkflow('---\nname: F\ndescription: d\n---\n\nbody\n');
    const foreign = path.join(home, '.kimi-code', 'skills', 'flow');
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, 'SKILL.md'), '---\nname: flow\ndescription: mine\n---\n\nhand-written\n', 'utf-8');

    expect(syncWorkflowToVersion(workflowDir, 'flow', 'kimi', home)).toEqual({
      success: false,
      error: "Kimi skill 'flow' already exists and is not managed by agents-cli",
    });
    expect(fs.readFileSync(path.join(foreign, 'SKILL.md'), 'utf-8')).toContain('hand-written');
    expect(listWorkflowsForAgent('kimi', home)).toEqual([]);
  });

  it('kimi: a foreign <name>/ dir with no SKILL.md is refused too, never written into', () => {
    const home = tmp('agents-wf-registry-kimi-bare-dir-');
    const workflowDir = writeWorkflow('---\nname: F\ndescription: d\n---\n\nbody\n');
    const foreign = path.join(home, '.kimi-code', 'skills', 'flow');
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, 'notes.txt'), 'user files live here', 'utf-8');

    expect(syncWorkflowToVersion(workflowDir, 'flow', 'kimi', home)).toEqual({
      success: false,
      error: "Kimi skill 'flow' already exists and is not managed by agents-cli",
    });
    expect(fs.existsSync(path.join(foreign, 'SKILL.md'))).toBe(false);
    expect(fs.readdirSync(foreign)).toEqual(['notes.txt']);
  });

  it('grok: the rendered file carries the marker the lister and detector key on', () => {
    const home = tmp('agents-wf-registry-grok-');
    const workflowDir = writeWorkflow('---\nname: G\ndescription: d\n---\n\nbody\n');
    expect(syncWorkflowToVersion(workflowDir, 'g-flow', 'grok', home).success).toBe(true);
    const rendered = fs.readFileSync(path.join(home, '.grok', 'workflows', 'g-flow.rhai'), 'utf-8');
    expect(rendered.split('\n')[0]).toBe('// agents_workflow: g-flow');
    fs.writeFileSync(path.join(home, '.grok', 'workflows', 'g-flow.rhai'), rendered.split('\n').slice(1).join('\n'), 'utf-8');
    expect(listWorkflowsForAgent('grok', home)).toEqual([]);
    expect(workflowsDetectors.grok!.list({ version: '0.0.0', versionHome: home, cwd: home })).toEqual([]);
    expect(syncWorkflowToVersion(workflowDir, 'g-flow', 'grok', home)).toEqual({
      success: false,
      error: "Grok workflow 'g-flow' already exists and is not managed by agents-cli",
    });
  });
});
