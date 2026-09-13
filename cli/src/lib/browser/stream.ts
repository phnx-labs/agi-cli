import { createInterface } from 'readline';
import type { Readable, Writable } from 'stream';
import { connectBrowserIPC } from './ipc.js';
import { assertRemoteControlAllowed } from './remote-control.js';
import type { IPCRequest, IPCResponse } from './types.js';

interface BrowserIPCStreamOptions {
  input: Readable;
  output: Writable;
  task?: string;
  actor: string;
  launchId?: string;
  /** Calling agent session, forwarded onto `start` requests (RUSH-2549). */
  sessionId?: string;
  autoStartDaemon?: boolean;
}

function parseRequest(line: string): IPCRequest {
  const parsed = JSON.parse(line) as unknown;
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof (parsed as { action?: unknown }).action !== 'string'
  ) {
    throw new Error('Each input line must be a JSON object with an action');
  }
  return parsed as IPCRequest;
}

function writeResponse(output: Writable, response: IPCResponse): void {
  output.write(`${JSON.stringify(response)}\n`);
}

function writeErrorResponse(output: Writable, error: unknown): void {
  writeResponse(output, {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Read browser IPC requests as NDJSON and write one NDJSON response per line.
 * The Node process and daemon connection stay alive until input closes.
 */
export async function runBrowserIPCStream(options: BrowserIPCStreamOptions): Promise<void> {
  const client = await connectBrowserIPC({ autoStartDaemon: options.autoStartDaemon });
  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  let defaultTask = options.task;

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;

      let request: IPCRequest;
      try {
        request = parseRequest(line);
      } catch (error) {
        writeErrorResponse(options.output, error);
        continue;
      }

      if (request.action === 'start') {
        try {
          assertRemoteControlAllowed();
        } catch (error) {
          writeErrorResponse(options.output, error);
          continue;
        }
        request = {
          ...request,
          taskName: request.taskName ?? defaultTask,
          actor: request.actor ?? options.actor,
          launchId: request.launchId ?? options.launchId,
          sessionId: request.sessionId ?? options.sessionId,
        };
      } else if (!request.task && defaultTask) {
        request = { ...request, task: defaultTask };
      }

      const response = await client.request(request);
      if (response.task) defaultTask = response.task;
      writeResponse(options.output, response);
    }
  } finally {
    lines.close();
    await client.close();
  }
}
