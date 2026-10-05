
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildComputerContext } from './computer/context.js';
import { isStandaloneComputer, runComputer, type ComputerActionEvent } from './computer-client.js';
import { findInPath } from './agent-spec/agents.js';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function resolveRealEngine(): { bin: string } | { skip: string } {
  const explicit = process.env.AGENTS_TEST_COMPUTER_BIN?.trim();
  if (explicit) {
    if (!fs.existsSync(explicit)) return { skip: `AGENTS_TEST_COMPUTER_BIN=${explicit} does not exist` };
    return { bin: explicit };
  }

  const staged = path.join(CLI_ROOT, 'bin', 'computer');
  if (fs.existsSync(staged)) return { bin: staged };

  const onPath = process.env.COMPUTER_BIN?.trim() || findInPath('computer');
  if (!onPath) return { skip: 'no standalone `computer` engine found (npm i -g @phnx-labs/computer-cli)' };
  if (!isStandaloneComputer(onPath)) {
    return { skip: `\`computer\` on PATH is the agents-cli shim (${onPath}), not the standalone engine` };
  }
  return { bin: onPath };
}

const resolved = resolveRealEngine();
const engine = 'bin' in resolved ? resolved.bin : '';
const suite = engine ? describe : describe.skip;
if (!engine) {
  console.warn(`[computer-client.e2e] skipped: ${(resolved as { skip: string }).skip}`);
}

async function withRealEngine(
  argv: string[],
  opts: { capture?: boolean; onEvent?: (e: ComputerActionEvent) => void } = {},
) {
  const prev = process.env.COMPUTER_BIN;
  process.env.COMPUTER_BIN = engine;
  try {
    const { _resetComputerClientForTest } = await import('./computer-client.js');
    _resetComputerClientForTest();
    const context = await buildComputerContext({ computerBin: engine });
    return await runComputer({ argv, context, capture: opts.capture, onEvent: opts.onEvent });
  } finally {
    if (prev === undefined) delete process.env.COMPUTER_BIN;
    else process.env.COMPUTER_BIN = prev;
    const { _resetComputerClientForTest } = await import('./computer-client.js');
    _resetComputerClientForTest();
  }
}

suite('the real `computer` engine over fd 3 / fd 4', () => {
  it('accepts the consumer context and reports its version', async () => {
    const { exitCode, stdout } = await withRealEngine(['--version'], { capture: true });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
  });

  it('propagates a failing exit code so a bad invocation fails the command', async () => {
    const { exitCode } = await withRealEngine(['definitely-not-a-verb']);
    expect(exitCode).not.toBe(0);
  });

  it('captures --json output intact — the path `agents setup computer` reads trust from', async () => {
    const { stdout } = await withRealEngine(['status', '--json'], { capture: true });
    const start = stdout.indexOf('{');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(() => JSON.parse(stdout.slice(start))).not.toThrow();
  });

});
