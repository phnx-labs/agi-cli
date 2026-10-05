import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { AgentProcess, AgentStatus } from './agents.js';

function fixture(name: string): string {
  return fs.readFileSync(
    fileURLToPath(new URL(`./__tests__/testdata/${name}`, import.meta.url)),
    'utf-8',
  );
}

describe('kimi teammate status from a real stream', () => {
  it('resolves COMPLETED and captures session_id from session.resume_hint', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-kimi-status-'));
    const id = 'k1';
    fs.mkdirSync(path.join(base, id), { recursive: true });

    const agent = new AgentProcess(
      id, 'test-team', 'kimi', 'do a thing', null, 'plan',
      null, AgentStatus.RUNNING, new Date(), null, base,
    );

    fs.writeFileSync(path.join(base, id, 'stdout.log'), fixture('kimi-stream-tool.jsonl'));

    await agent.readNewEvents();

    expect(agent.status).toBe(AgentStatus.COMPLETED);
    expect(agent.remoteSessionId).toBe('session_9f2c');
  });
});
