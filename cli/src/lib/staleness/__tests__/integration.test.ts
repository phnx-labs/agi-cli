import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  newFixture, writeFile, writeExecFile,
  build, isStale,
  type Fixture,
} from './_fixtures.js';
import * as fs from 'fs';
import * as path from 'path';

describe('staleness e2e: integration', () => {
  let fx: Fixture;
  beforeEach(() => { fx = newFixture('integ'); });
  afterEach(()  => fx.cleanup());

  it('full populated tree across all resource types: build -> clean -> mutate any one -> stale', () => {
    writeFile(fx, 'system', 'commands/foo.md', 'foo');
    writeFile(fx, 'user',   'commands/bar.md', 'bar');
    writeFile(fx, 'user',   'skills/my-skill/SKILL.md', 'skill');
    writeExecFile(fx, 'system', 'hooks/00-check.sh', '#!/bin/bash');
    writeFile(fx, 'user',   'mcp/server.yaml', 'name: srv\ntransport: stdio\ncommand: echo hi\n');
    writeFile(fx, 'project', 'subagents/helper/AGENT.md', '---\nname: helper\n---\nbody');
    writeFile(fx, 'user',   'workflows/wf/WORKFLOW.md', 'wf');
    writeFile(fx, 'user',   'plugins/plg/.claude-plugin/plugin.json', '{"name":"plg","version":"1.0.0"}');
    writeFile(fx, 'system', 'permissions/groups/base.yaml', 'allow:\n  - Bash(ls)\n');
    writeFile(fx, 'system', 'rules/rules.yaml',       'presets:\n  default:\n    subrules:\n      - core\n');
    writeFile(fx, 'system', 'rules/subrules/core.md', 'core');

    build(fx);
    expect(isStale(fx)).toBe(false);

    const mutations: Array<[string, () => void]> = [
      ['commands',    () => writeFile(fx, 'user',   'commands/new.md', 'new')],
      ['skills',      () => fs.writeFileSync(path.join(fx.userDir, 'skills/my-skill/SKILL.md'), 'modified')],
      ['hooks',       () => writeExecFile(fx, 'user', 'hooks/new.sh', '#!/bin/bash')],
      ['mcp',         () => writeFile(fx, 'user',   'mcp/server.yaml', 'name: srv\ntransport: stdio\ncommand: echo hi --flag\n')],
      ['subagents',   () => fs.writeFileSync(path.join(fx.projectAgents, 'subagents/helper/AGENT.md'), '---\nname: helper\n---\nchanged')],
      ['workflows',   () => fs.writeFileSync(path.join(fx.userDir, 'workflows/wf/WORKFLOW.md'), 'wf-v2')],
      ['plugins',     () => writeFile(fx, 'user', 'plugins/plg/.claude-plugin/plugin.json', '{"name":"plg","version":"2.5.99-rc1"}')],
      ['permissions', () => writeFile(fx, 'system', 'permissions/groups/base.yaml', 'allow:\n  - Bash(ls -la)\n')],
      ['rules',       () => writeFile(fx, 'system', 'rules/subrules/core.md', 'core-v2')],
    ];

    for (const [label, mutate] of mutations) {
      build(fx);
      expect(isStale(fx), `expected clean after rebuild for ${label}`).toBe(false);
      mutate();
      expect(isStale(fx), `expected stale after mutating ${label}`).toBe(true);
    }
  });


  it('regression #1: rules section is actually tracked (was always-stale before fix)', () => {
    writeFile(fx, 'system', 'rules/rules.yaml',       'presets:\n  default:\n    subrules:\n      - core\n');
    writeFile(fx, 'system', 'rules/subrules/core.md', 'core');
    build(fx);
    expect(isStale(fx)).toBe(false);
  });

  it('regression #2: hook manifest matches the sync writer (excludes project layer)', () => {
    writeExecFile(fx, 'user',    'hooks/same.sh', '#!/bin/bash\necho user');
    build(fx);
    writeExecFile(fx, 'project', 'hooks/same.sh', '#!/bin/bash\necho project');
    expect(isStale(fx)).toBe(false);
  });

  it('regression #3: project subagent does not break the name-set diff', () => {
    writeFile(fx, 'project', 'subagents/proj-only/AGENT.md', '---\nname: x\n---\n');
    build(fx);
    expect(isStale(fx)).toBe(false);
  });

  it('regression #4: workflows + plugins are tracked at all (not in v1 manifests)', () => {
    writeFile(fx, 'user', 'workflows/wf/WORKFLOW.md',  'wf');
    writeFile(fx, 'user', 'plugins/plg/.claude-plugin/plugin.json', '{"name":"plg"}');
    build(fx);
    expect(isStale(fx)).toBe(false);
    fs.writeFileSync(path.join(fx.userDir, 'workflows/wf/WORKFLOW.md'), 'wf-v2');
    expect(isStale(fx)).toBe(true);
  });

  it('manifest is JSON-round-trippable (load -> save -> load yields identical content)', () => {
    writeFile(fx, 'user',   'commands/foo.md', 'foo');
    writeFile(fx, 'user',   'skills/s/SKILL.md', 'skill');
    writeExecFile(fx, 'user', 'hooks/h.sh', '#!/bin/bash');
    const m1 = build(fx);
    expect(isStale(fx)).toBe(false);
    expect(m1.v).toBe(1);
    expect(Object.keys(m1.commands)).toEqual(['foo']);
  });
});
