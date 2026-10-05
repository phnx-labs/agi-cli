
import type { AgentId } from '../types.js';

interface AcpHarnessSpec {
  command: string;
  args: string[];
  installHint: string;
  confidence: 'verified' | 'documented';
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
};

export function getAcpSpec(agent: AgentId): AcpHarnessSpec | undefined {
  return ACP_HARNESSES[agent];
}

export function supportsAcp(agent: AgentId): boolean {
  return ACP_HARNESSES[agent] !== undefined;
}
