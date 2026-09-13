/**
 * Per-harness spawn configuration for Agent Client Protocol (ACP) mode.
 *
 * Each entry describes how to launch a coding agent CLI as an ACP server
 * (stdio JSON-RPC). Unsupported harnesses (amp, goose-stdio) are omitted;
 * callers should fall back to the legacy direct-exec path for those.
 *
 * Sources: https://agentclientprotocol.com/get-started/agents + vendor docs.
 */

import type { AgentId } from '../types.js';

interface AcpHarnessSpec {
  /** Command + args to spawn the agent in ACP server mode. */
  command: string;
  args: string[];
  /** Human-hint for `teams doctor` when the spawn fails. */
  installHint: string;
  /** Confidence: "verified" = tested in this repo, "documented" = per vendor docs. */
  confidence: 'verified' | 'documented';
  /** Source URL for the invocation. */
  source: string;
}

const ACP_HARNESSES: Partial<Record<AgentId, AcpHarnessSpec>> = {
  claude: {
    command: 'npx',
    args: ['-y', '@zed-industries/claude-agent-acp'],
    installHint: 'npm i -g @zed-industries/claude-agent-acp',
    confidence: 'documented',
    source: 'https://www.npmjs.com/package/@zed-industries/claude-agent-acp',
  },
  codex: {
    command: 'npx',
    args: ['-y', '@zed-industries/codex-acp'],
    installHint: 'npm i -g @zed-industries/codex-acp',
    confidence: 'documented',
    source: 'https://www.npmjs.com/package/@zed-industries/codex-acp',
  },
  cursor: {
    command: 'cursor-agent',
    args: ['acp'],
    installHint: 'curl https://cursor.com/install -fsS | bash',
    confidence: 'documented',
    source: 'https://cursor.com/docs/cli/acp',
  },
  opencode: {
    command: 'opencode',
    args: ['acp'],
    installHint: 'npm i -g opencode-ai',
    confidence: 'documented',
    source: 'https://opencode.ai/docs/acp/',
  },
  openclaw: {
    command: 'openclaw',
    args: ['acp'],
    installHint: 'see https://docs.openclaw.ai',
    confidence: 'documented',
    source: 'https://docs.openclaw.ai/tools/acp-agents',
  },
  grok: {
    command: 'grok',
    args: ['agent', 'stdio'],
    installHint: 'see https://docs.x.ai/build/cli',
    confidence: 'documented',
    source: 'https://docs.x.ai/build/cli/headless-scripting',
  },
  // antigravity: no documented ACP support (May 2026).
  // goose: ACP over HTTP via `goosed`, not a clean stdio subcommand.
  // copilot: excluded for now (not installed in the reference environment,
  //                no local verification possible).
  // amp: not on the ACP agents list.
};

/** Returns the ACP spawn spec for an agent, or undefined if the harness does not speak ACP. */
export function getAcpSpec(agent: AgentId): AcpHarnessSpec | undefined {
  return ACP_HARNESSES[agent];
}

/** True if the harness is known to support ACP (directly or via adapter). */
export function supportsAcp(agent: AgentId): boolean {
  return ACP_HARNESSES[agent] !== undefined;
}
