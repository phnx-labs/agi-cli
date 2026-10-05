/** Registry coverage test, the assertion that would have caught the grok silent-skip class: every
 * (agent, kind) the capability matrix supports needs a writer and detector, or an `isExempt` entry
 * in registry.ts. */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { AGENTS } from '../agents.js';
import { supports } from '../capabilities.js';
import type { AgentId } from '../types.js';
import {
  ALL_RESOURCE_KINDS,
  WRITERS,
  DETECTORS,
  kindToCapability,
  assertRegistryComplete,
  type ResourceKind,
} from './registry.js';

function isExempt(agent: AgentId, kind: ResourceKind): boolean {
  if (kind === 'skills' && AGENTS[agent].nativeAgentsSkillsDir) return true;
  return false;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

describe('staleness/registry', () => {
  it('boots without throwing', () => {
    expect(() => assertRegistryComplete()).not.toThrow();
  });

  it('every supported (agent, kind) has both a writer and a detector', () => {
    const gaps: string[] = [];
    for (const kind of ALL_RESOURCE_KINDS) {
      const cap = kindToCapability(kind);
      for (const agent of Object.keys(AGENTS) as AgentId[]) {
        if (!supports(agent, cap).ok) continue;
        if (isExempt(agent, kind)) continue;
        if (!WRITERS[kind][agent]) gaps.push(`writer ${kind}/${agent}`);
        if (!DETECTORS[kind][agent]) gaps.push(`detector ${kind}/${agent}`);
      }
    }
    expect(gaps).toEqual([]);
  });

  it('grok has a rules writer (covers the silent-skip bug)', () => {
    expect(WRITERS.rules.grok).toBeDefined();
    expect(DETECTORS.rules.grok).toBeDefined();
  });

  it('grok has a commands writer for native command files', () => {
    // grok.capabilities.commands === true and commandsSubdir points at the
    // cross-agent ~/.agents/commands/ dir, so the writer/detector register for
    // native command files, not the commands-as-skills fallback.
    expect(AGENTS.grok.capabilities.commands).toBe(true);
    expect(AGENTS.grok.commandsSubdir).toBe(path.join('..', '.agents', 'commands'));
    expect(WRITERS.commands.grok).toBeDefined();
    expect(DETECTORS.commands.grok).toBeDefined();
  });

  it('kimi has a commands writer + detector for commands-as-skills', () => {
    // kimi has `capabilities.commands === false` and no native command runtime, so commands must
    // convert to skills; registration follows nativeCommandRuntime, not an id allowlist. The
    // generic check skips kimi because supports('kimi','commands') is false.
    expect(WRITERS.commands.kimi).toBeDefined();
    expect(DETECTORS.commands.kimi).toBeDefined();
  });

  it('cursor remains covered by the commands writer + detector for dual-write sync', () => {
    expect(AGENTS.cursor.capabilities.commands).toBe(true);
    expect(WRITERS.commands.cursor).toBeDefined();
    expect(DETECTORS.commands.cursor).toBeDefined();
  });

  it('openclaw opts OUT of commands-as-skills (native command runtime)', () => {
    // openclaw resolves slash commands through its Gateway runtime, so it
    // declares nativeCommandRuntime and must NOT be registered for commands.
    expect(AGENTS.openclaw.nativeCommandRuntime).toBe(true);
    expect(WRITERS.commands.openclaw).toBeUndefined();
    expect(DETECTORS.commands.openclaw).toBeUndefined();
  });

  it('grok has a permissions writer + detector', () => {
    expect(WRITERS.permissions.grok).toBeDefined();
    expect(DETECTORS.permissions.grok).toBeDefined();
  });

  it('grok has a workflows writer + detector (native .rhai projection)', () => {
    expect(WRITERS.workflows.grok).toBeDefined();
    expect(DETECTORS.workflows.grok).toBeDefined();
  });

  it('antigravity has a permissions writer + detector', () => {
    expect(WRITERS.permissions.antigravity).toBeDefined();
    expect(DETECTORS.permissions.antigravity).toBeDefined();
  });

  it('gemini is hard-deprecated and has no sync writers or detectors', () => {
    for (const kind of ALL_RESOURCE_KINDS) {
      expect(WRITERS[kind].gemini).toBeUndefined();
      expect(DETECTORS[kind].gemini).toBeUndefined();
    }
  });

  it('openclaw has a permissions writer + detector', () => {
    expect(WRITERS.permissions.openclaw).toBeDefined();
    expect(DETECTORS.permissions.openclaw).toBeDefined();
  });

  it('openclaw has a workflows writer + detector', () => {
    expect(WRITERS.workflows.openclaw).toBeDefined();
    expect(DETECTORS.workflows.openclaw).toBeDefined();
  });

  it('hermes has a permissions writer + detector', () => {
    expect(WRITERS.permissions.hermes).toBeDefined();
    expect(DETECTORS.permissions.hermes).toBeDefined();
  });

  it('antigravity has subagents + workflows writers + detectors', () => {
    expect(WRITERS.subagents.antigravity).toBeDefined();
    expect(DETECTORS.subagents.antigravity).toBeDefined();
    expect(WRITERS.workflows.antigravity).toBeDefined();
    expect(DETECTORS.workflows.antigravity).toBeDefined();
  });

  it('kimi has a workflows writer + detector', () => {
    expect(WRITERS.workflows.kimi).toBeDefined();
    expect(DETECTORS.workflows.kimi).toBeDefined();
  });

  it('goose has workflows writers + detectors, and no permissions ones', () => {
    expect(WRITERS.workflows.goose).toBeDefined();
    expect(DETECTORS.workflows.goose).toBeDefined();
    // Permissions support was removed — the registry must not offer a writer
    // for a capability the table reports as unsupported.
    expect(WRITERS.permissions.goose).toBeUndefined();
    expect(DETECTORS.permissions.goose).toBeUndefined();
  });

  it('droid has a generic skills writer + detector', () => {
    expect(WRITERS.skills.droid).toBeDefined();
    expect(DETECTORS.skills.droid).toBeDefined();
  });

  it('droid has a permissions writer + detector', () => {
    expect(WRITERS.permissions.droid).toBeDefined();
    expect(DETECTORS.permissions.droid).toBeDefined();
  });

  it('writer registry full-sync roundtrip leaves manifests non-stale', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'staleness-registry-roundtrip-'));
    try {
      const script = String.raw`
        import * as fs from 'fs';
        import * as path from 'path';
        import { AGENTS } from './src/lib/agents.ts';
        import { supports } from './src/lib/capabilities.ts';
        import { getVersionHomePath, syncResourcesToVersion } from './src/lib/installations/versions.ts';
        import { buildManifest, isStale } from './src/lib/staleness/index.ts';
        import {
          ALL_RESOURCE_KINDS,
          WRITERS,
          DETECTORS,
          kindToCapability,
        } from './src/lib/staleness/registry.ts';

        const home = process.env.HOME;
        if (!home) throw new Error('HOME missing');

        const userDir = path.join(home, '.agents');
        const systemDir = path.join(userDir, '.system');
        const projectRoot = path.join(home, 'project');
        const write = (rel, content, mode) => {
          const p = path.join(userDir, rel);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, content);
          if (mode) fs.chmodSync(p, mode);
        };
        const writeSystem = (rel, content) => {
          const p = path.join(systemDir, rel);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, content);
        };

        fs.mkdirSync(projectRoot, { recursive: true });
        write('commands/roundtrip-command.md', '# Roundtrip\n');
        write('skills/roundtrip-skill/SKILL.md', '---\nname: roundtrip-skill\ndescription: fixture\n---\n');
        write('hooks/roundtrip-hook', '#!/usr/bin/env sh\nexit 0\n', 0o755);
        write('mcp/roundtrip-mcp.yaml', 'name: roundtrip-mcp\ntransport: stdio\ncommand: echo\nargs: ["ok"]\n');
        write('permissions/groups/roundtrip-permission.yaml', 'name: roundtrip-permission\nallow:\n  - Bash(echo:*)\n');
        write('subagents/roundtrip-subagent/AGENT.md', '---\nname: roundtrip-subagent\ndescription: fixture\n---\nBody\n');
        write('plugins/roundtrip-plugin/.claude-plugin/plugin.json', JSON.stringify({
          name: 'roundtrip-plugin',
          version: '0.0.0',
          description: 'fixture',
        }, null, 2));
        write('workflows/roundtrip-workflow/WORKFLOW.md', '---\nname: roundtrip-workflow\ndescription: fixture\n---\n');
        writeSystem('rules/rules.yaml', 'presets:\n  default:\n    subrules:\n      - roundtrip-rule\n');
        writeSystem('rules/subrules/roundtrip-rule.md', 'Roundtrip rule\n');

        const version = '0.0.0-test';
        const failures = [];
        for (const agent of Object.keys(AGENTS)) {
          const coveredKinds = ALL_RESOURCE_KINDS.filter((kind) => {
            const cap = kindToCapability(kind);
            if (!supports(agent, cap).ok) return false;
            if (kind === 'skills' && AGENTS[agent].nativeAgentsSkillsDir) return false;
            return Boolean(WRITERS[kind][agent] && DETECTORS[kind][agent]);
          });
          if (coveredKinds.length === 0) continue;

          const versionHome = getVersionHomePath(agent, version);
          const fakeBin = path.join(home, '.agents', '.history', 'versions', agent, version, 'node_modules', '.bin', AGENTS[agent].cliCommand);
          fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
          fs.writeFileSync(fakeBin, '#!/usr/bin/env sh\nexit 0\n');
          fs.chmodSync(fakeBin, 0o755);

          syncResourcesToVersion(agent, version, undefined, { cwd: projectRoot, force: true });
          const manifest = buildManifest(agent, version, projectRoot);
          if (isStale(manifest, agent, version, projectRoot)) {
            failures.push(agent + ': stale after full sync');
          }
          for (const kind of coveredKinds) {
            try {
              DETECTORS[kind][agent].list({ version, versionHome, cwd: projectRoot });
            } catch (err) {
              failures.push(agent + '/' + kind + ': detector threw ' + ((err && err.message) || err));
            }
          }
        }

        if (failures.length > 0) {
          throw new Error(failures.join('\n'));
        }
      `;

      execFileSync('bun', ['--eval', script], {
        cwd: repoRoot,
        env: { ...process.env, HOME: home },
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

});
