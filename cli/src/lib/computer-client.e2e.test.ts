/**
 * The fd-3 / fd-4 contract against the REAL compiled `computer` engine.
 *
 * This is the only test that proves agents-cli and the standalone actually
 * agree. Everything up to here is the consumer talking to itself: the framing
 * unit tests in `computer-client.test.ts` prove the parser handles the shape we
 * believe the engine writes, and a stand-in engine fixture would only prove the
 * client matches the protocol we assumed while writing the fixture. The engine
 * ships from its own repo on its own cadence (PHNX-4075), so the assumption is
 * exactly the thing that can drift.
 *
 * So this suite spawns the real binary, hands it a real
 * `buildComputerContext()` payload on fd 3, and asserts the properties every
 * `agents computer` invocation depends on: the engine accepts the context
 * without rejecting it, its exit code reaches the caller, `--json` output
 * survives capture, and whatever it writes on fd 4 parses as action events.
 *
 * ENGINE RESOLUTION, and why it is not just `findInPath('computer')`:
 *   1. `AGENTS_TEST_COMPUTER_BIN` — an explicit build to test against.
 *   2. `cli/bin/computer` — the compiled engine staged in this tree.
 *   3. `COMPUTER_BIN` / PATH, but ONLY when the resolved file is not this CLI's
 *      own `computer` shim. That shim execs `agents computer`, which would
 *      recurse back into this process (the 1.22.85 secrets fork bomb shape) and
 *      "pass" while testing nothing.
 *
 * SKIPS cleanly, with a printed reason, when no engine is present — the suite
 * runs on CI boxes that have no standalone installed. It is not gated on an
 * opt-in env var, so it starts running the moment a real engine is on the box.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildComputerContext } from './computer/context.js';
import { parseEventLines, runComputer, type ComputerActionEvent } from './computer-client.js';
import { findInPath } from './agent-spec/agents.js';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Is this path the agents-cli `computer` shim rather than the standalone?
 *
 * The shim is `dist/computer.js` in an agents-cli install (or a symlink to it),
 * so it re-enters this very CLI. Resolving the symlink is what catches the
 * common `~/.local/bin/computer -> …/@phnx-labs/agents-cli/dist/computer.js`
 * install.
 */
function isAgentsCliShim(bin: string): boolean {
  let real = bin;
  try {
    real = fs.realpathSync(bin);
  } catch {
    // Unresolvable: judge the path we were given.
  }
  return /agents-cli[/\\]dist[/\\]computer\.js$/.test(real) || real.endsWith(path.join('dist', 'computer.js'));
}

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
  if (isAgentsCliShim(onPath)) {
    return { skip: `\`computer\` on PATH is the agents-cli shim (${onPath}), not the standalone engine` };
  }
  return { bin: onPath };
}

const resolved = resolveRealEngine();
const engine = 'bin' in resolved ? resolved.bin : '';
const suite = engine ? describe : describe.skip;
if (!engine) {
  // A silently skipped integration suite reads as coverage that does not exist.
  console.warn(`[computer-client.e2e] skipped: ${(resolved as { skip: string }).skip}`);
}

/** Run the real engine with the real consumer context on fd 3. */
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
    // `--version` is the cheapest whole-path exercise: spawn, context written
    // and closed on fd 3, engine reads to EOF, exits 0. An engine that rejected
    // our context shape would fail here, which is the drift this suite exists
    // to catch.
    const { exitCode, stdout } = await withRealEngine(['--version'], { capture: true });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
  });

  it('propagates a failing exit code so a bad invocation fails the command', async () => {
    const { exitCode } = await withRealEngine(['definitely-not-a-verb']);
    expect(exitCode).not.toBe(0);
  });

  it('captures --json output intact — the path `agents setup computer` reads trust from', async () => {
    // `status` answers off-daemon too (it REPORTS the daemon state), so this
    // works on a box with no helper running. The engine may exit non-zero to
    // signal "not installed"; what must hold is that its JSON reached us.
    const { stdout } = await withRealEngine(['status', '--json'], { capture: true });
    const start = stdout.indexOf('{');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(() => JSON.parse(stdout.slice(start))).not.toThrow();
  });

  it('emits only parseable, command-shaped records on the events fd', async () => {
    // A local verb on a box with no helper legitimately produces no action, so
    // an empty stream is a pass. What must never happen is a record the ledger
    // reader would drop (`sessions-list.ts` requires a string `command`).
    const seen: ComputerActionEvent[] = [];
    await withRealEngine(['apps', '--json'], { capture: true, onEvent: (e) => seen.push(e) });
    for (const event of seen) {
      expect(typeof event.command).toBe('string');
      expect(parseEventLines(JSON.stringify(event) + '\n').events).toHaveLength(1);
    }
  });
});
