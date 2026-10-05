import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { MCP_TARGETS, mcpTarget, mcpWriteUnsupportedReason } from './mcp-registry.js';
import { capableAgents } from './capabilities.js';
import { getMcpConfigPathForHome, getProjectMcpConfigPath, getUserMcpConfigPath } from './agents.js';
import type { AgentId } from './types.js';

describe('MCP_TARGETS completeness', () => {
  // Pins the bug: `capabilities.mcp` is true for every harness, so a new one resolved a path and
  // fell through the dispatch chains with `success: true` and no write. A harness must declare a
  // format or `format: null` + `unsupportedReason`.
  it('has exactly one entry per mcp-capable agent', () => {
    const capable = [...capableAgents('mcp')].sort();
    const registered = (Object.keys(MCP_TARGETS) as AgentId[]).sort();
    expect(registered).toEqual(capable);
  });

  it('gives every unwritable target a stated reason', () => {
    for (const [agent, target] of Object.entries(MCP_TARGETS)) {
      if (target!.format === null) {
        expect(target!.unsupportedReason, `${agent} declares format: null with no reason`).toBeTruthy();
      } else {
        expect(target!.unsupportedReason, `${agent} states a reason but declares a format`).toBeUndefined();
      }
    }
  });

  it('reports a write refusal only for the unwritable targets', () => {
    for (const agent of capableAgents('mcp')) {
      const reason = mcpWriteUnsupportedReason(agent);
      if (MCP_TARGETS[agent]!.format === null) {
        expect(reason, `${agent} should refuse writes`).toContain(agent);
      } else {
        expect(reason, `${agent} should accept writes`).toBeNull();
      }
    }
  });

  it('refuses an agent with no target at all', () => {
    // gemini is hard-deprecated, so it is not mcp-capable and has no entry.
    expect(mcpTarget('gemini' as AgentId)).toBeUndefined();
    expect(mcpWriteUnsupportedReason('gemini' as AgentId)).toContain('no MCP target');
  });
});

describe('MCP path resolvers agree with the registry', () => {
  // Writer, parser and staleness detector once resolved paths through different switches, so a
  // harness could be written to one file and read from another (kimi wrote mcp.json, detector read
  // settings.json).
  const home = path.join(os.tmpdir(), 'agents-mcp-registry-home');
  const cwd = path.join(os.tmpdir(), 'agents-mcp-registry-repo');

  it('resolves the version-home path from the registry', () => {
    for (const agent of capableAgents('mcp')) {
      expect(getMcpConfigPathForHome(agent, home)).toBe(MCP_TARGETS[agent]!.home(home));
    }
  });

  it('keeps a HOME-global target pinned to the real home under any root', () => {
    for (const agent of capableAgents('mcp')) {
      if (!MCP_TARGETS[agent]!.homeGlobal) continue;
      expect(getMcpConfigPathForHome(agent, home)).toBe(getMcpConfigPathForHome(agent, '/other/root'));
    }
  });

  it('resolves the project path from the registry', () => {
    for (const agent of capableAgents('mcp')) {
      expect(getProjectMcpConfigPath(agent, cwd)).toBe(MCP_TARGETS[agent]!.project(cwd));
    }
  });

  it('resolves the user path as the version-home path rooted at HOME', () => {
    for (const agent of capableAgents('mcp')) {
      expect(getUserMcpConfigPath(agent)).toBe(MCP_TARGETS[agent]!.home(os.homedir()));
    }
  });
});

describe('registry paths verified against the harnesses', () => {
  it('points antigravity at the REAL home, ignoring the version home', () => {
    // ~/.gemini/antigravity-cli is symlinked into a version home; ~/.gemini/config
    // is a plain directory agy opens directly, so a version-home path lands where
    // agy never reads (same reason antigravityWorkflowsDir ignores versionHome).
    const expected = path.join(process.env.HOME ?? os.homedir(), '.gemini', 'config', 'mcp_config.json');
    expect(MCP_TARGETS.antigravity!.home('/some/version/home')).toBe(expected);
    expect(MCP_TARGETS.antigravity!.homeGlobal).toBe(true);
  });

  it('marks only the HOME-global targets as such', () => {
    for (const [agent, target] of Object.entries(MCP_TARGETS)) {
      if (agent === 'antigravity') continue;
      expect(target!.homeGlobal, `${agent} should be version-scoped`).toBeFalsy();
      // A version-scoped target must actually vary with its argument.
      expect(target!.home('/a')).not.toBe(target!.home('/b'));
    }
  });

  it('points grok at config.toml, where [mcp_servers.<name>] lives', () => {
    expect(MCP_TARGETS.grok!.home('/h')).toBe(path.join('/h', '.grok', 'config.toml'));
    expect(MCP_TARGETS.grok!.format).toBe('toml');
  });

  it('points kimi at the mcp.json the installer actually writes', () => {
    expect(MCP_TARGETS.kimi!.home('/h')).toBe(path.join('/h', '.kimi-code', 'mcp.json'));
  });
});
