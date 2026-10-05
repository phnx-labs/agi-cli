/** Headless ACP runner: glue between `agents run <agent> "prompt" --acp` and the ACP client,
 * emitting a human-readable message stream or newline-delimited JSON events with `--json`. */

import type { SessionNotification } from '@zed-industries/agent-client-protocol';
import { runAcp } from './client.js';
import type { AgentId } from '../types.js';
import type { ExecMode } from '../exec.js';

interface HeadlessAcpOptions {
  agent: AgentId;
  prompt: string;
  cwd: string;
  mode: ExecMode;
  json: boolean;
}

/** Runs a prompt turn over ACP, streaming output to stdout per `json` mode. */
export async function runAcpHeadless(opts: HeadlessAcpOptions): Promise<number> {
  const onUpdate = opts.json ? emitJsonLine : emitTextChunk;
  const result = await runAcp({
    agent: opts.agent,
    prompt: opts.prompt,
    cwd: opts.cwd,
    mode: opts.mode,
    onUpdate,
  });

  if (opts.json) {
    emitJsonLine({
      sessionId: result.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } },
      _meta: { stopReason: result.stopReason },
    } as SessionNotification);
  } else {
    process.stdout.write('\n');
  }

  return result.stopReason === 'end_turn' ? 0 : 1;
}

function emitJsonLine(n: SessionNotification): void {
  process.stdout.write(JSON.stringify(n) + '\n');
}

function emitTextChunk(n: SessionNotification): void {
  const upd = n.update;
  if (upd.sessionUpdate === 'agent_message_chunk' && upd.content.type === 'text') {
    process.stdout.write(upd.content.text);
  }
}
