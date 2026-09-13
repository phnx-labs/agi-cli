/**
 * Agent Client Protocol (ACP) client wrapper for agents-cli.
 *
 * Spawns an ACP-capable agent CLI as a stdio subprocess and drives it through
 * initialize -> newSession -> prompt, streaming `session/update` notifications
 * back to the caller as async iterables.
 *
 * Also implements the Client interface (fs read/write, terminal exec) so the
 * agent can request filesystem and shell operations through us. `--mode plan`
 * rejects all write/terminal requests; `edit`/`full` allow them.
 */

import { spawn, type ChildProcess } from 'child_process';
import { Readable, Writable } from 'stream';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type Agent,
  type InitializeResponse,
  type NewSessionResponse,
  type PromptResponse,
  type SessionNotification,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
} from '@zed-industries/agent-client-protocol';
import { getAcpSpec, supportsAcp } from './harnesses.js';
import type { AgentId } from '../types.js';
import { buildExecEnv, type ExecMode } from '../exec.js';

const PROTOCOL_VERSION = 1;

interface AcpRunOptions {
  agent: AgentId;
  prompt: string;
  cwd: string;
  mode: ExecMode;
  /** Optional: callback invoked for every session/update notification. */
  onUpdate?: (n: SessionNotification) => void;
}

interface AcpRunResult {
  stopReason: string;
  sessionId: string;
}

/**
 * Runs a single prompt turn against an ACP-capable agent and streams updates
 * to `onUpdate`. Resolves when the turn completes (StopReason is returned).
 */
export async function runAcp(opts: AcpRunOptions): Promise<AcpRunResult> {
  if (!supportsAcp(opts.agent)) {
    throw new Error(`Agent '${opts.agent}' does not support ACP. Use direct exec instead.`);
  }
  const spec = getAcpSpec(opts.agent)!;

  // Build the harness's exec env the SAME way `agents run` does, instead of
  // handing it a raw process.env. buildExecEnv is what injects the per-account
  // `CLAUDE_CODE_OAUTH_TOKEN` on a worker device (gated by device role: a
  // headed/personal box still defers to its native login). Without this, an ACP
  // launch inherited no setup-token and fell through to the version home's
  // copied native `.credentials.json` — which expires in ~15h and 401s once its
  // refresh chain dies, exactly the "logged out on a worker" report (PHNX-3681).
  // A verified precedence test shows the env token wins over a present
  // `.credentials.json`, so injecting here is sufficient — the stale file no
  // longer decides the session.
  const child: ChildProcess = spawn(spec.command, spec.args, {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: buildExecEnv({ agent: opts.agent, cwd: opts.cwd, mode: opts.mode, effort: 'auto', interactive: true }),
  });

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
  );

  const client: Client = buildClient(opts);

  const connection: Agent = new ClientSideConnection(() => client, stream);

  const initResp: InitializeResponse = await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
  });

  if (initResp.protocolVersion < PROTOCOL_VERSION) {
    throw new Error(
      `Agent '${opts.agent}' speaks ACP protocol v${initResp.protocolVersion}, need v${PROTOCOL_VERSION}.`,
    );
  }

  const session: NewSessionResponse = await connection.newSession({
    cwd: opts.cwd,
    mcpServers: [],
  });

  try {
    const resp: PromptResponse = await connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: opts.prompt }],
    });
    return { stopReason: resp.stopReason, sessionId: session.sessionId };
  } finally {
    child.kill('SIGTERM');
  }
}

function buildClient(opts: AcpRunOptions): Client {
  const { mode, onUpdate, cwd } = opts;
  const canWrite = mode !== 'plan';

  return {
    async sessionUpdate(params: SessionNotification): Promise<void> {
      if (onUpdate) onUpdate(params);
    },

    async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
      const abs = resolveInCwd(cwd, params.path);
      const content = await fs.readFile(abs, 'utf8');
      const sliced = sliceByLines(content, params.line, params.limit);
      return { content: sliced };
    },

    async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
      if (!canWrite) {
        throw new Error(`File writes are denied in plan mode: ${params.path}`);
      }
      const abs = resolveInCwd(cwd, params.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, params.content, 'utf8');
      return {};
    },

    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      // `skip` (formerly `full`) and `auto` blanket-approve; in `auto` the
      // upstream model has its own classifier so we just say "allow once" and
      // let it decide. `edit` says allow_once. `plan` should never reach here
      // (canWrite gates writes earlier), but if it does we cancel.
      const skipAll = mode === 'skip';
      const optionId = skipAll
        ? (params.options.find(o => o.kind === 'allow_always')?.optionId
            ?? params.options[0]?.optionId)
        : params.options.find(o => o.kind === 'allow_once')?.optionId;
      if (!optionId) {
        return { outcome: { outcome: 'cancelled' } };
      }
      return { outcome: { outcome: 'selected', optionId } };
    },

    async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
      if (!canWrite) {
        throw new Error(`Terminal commands are denied in plan mode: ${params.command}`);
      }
      throw new Error('Terminal support not yet implemented in agents-cli ACP client.');
    },
  };
}

function resolveInCwd(cwd: string, target: string): string {
  const abs = path.resolve(cwd, target);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith('..')) {
    throw new Error(`Path '${target}' escapes session cwd '${cwd}'`);
  }
  return abs;
}

function sliceByLines(content: string, startLine?: number | null, limit?: number | null): string {
  if (startLine == null && limit == null) return content;
  const lines = content.split('\n');
  const from = Math.max(0, (startLine ?? 1) - 1);
  const to = limit != null ? from + limit : lines.length;
  return lines.slice(from, to).join('\n');
}
