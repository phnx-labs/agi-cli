/**
 * PHNX-3072: the vitest suite must be structurally unable to launch the
 * developer's desktop opener (`open` / `xdg-open` / `gnome-open`).
 *
 * `tests/setup.ts` already sandboxes HOME so a test cannot write the real
 * `~/.agents`. PATH was left alone, so a unit test that reached a real
 * `spawn('open' | 'xdg-open')` resolved the developer's binary. That shipped:
 * `open-url.test.ts` drove the non-injected viewer path, every Mac `bun run test`
 * opened example.com, and Linux CI stayed green because `xdg-open` was absent
 * (ENOENT in ~4ms). The specific test was fixed in agents-cli#2937; this
 * module closes the class.
 *
 * Installed once per fork from tests/setup.ts: stub binaries are prepended to
 * PATH so a PATH-resolved spawn cannot reach `/usr/bin/open`. Child processes
 * that inherit `env: {...process.env}` get the stubs for free, the same way
 * they inherit the sandboxed HOME. This is a prefix, not a cage — git/node/the
 * CLI still resolve from the rest of PATH.
 *
 * An unauthorized spawn still fails the file via the afterAll tripwire
 * (`assertNoUnauthorizedOpenerSpawn`). Set `AGENTS_TEST_ALLOW_OPENER=1` to
 * declare intent (the probe tests in opener-sandbox.test.ts do this). The
 * stubs still run — a test can never launch the real handler.
 *
 * Absolute paths (`/usr/bin/open`) skip PATH by construction; those call
 * sites (today: `setup-computer.ts`) are a different class. The incident
 * this closes is PATH-resolved spawn, which is how `open-url.ts` launches.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Platform opener names a test must never resolve to a real desktop handler. */
export const DESKTOP_OPENER_BASENAMES = ['open', 'xdg-open', 'gnome-open'] as const;

const ALLOW_ENV = 'AGENTS_TEST_ALLOW_OPENER';
const STUB_DIR_ENV = 'AGENTS_TEST_OPENER_STUB_DIR';
const TRIPWIRE_DIR_ENV = 'AGENTS_TEST_OPENER_TRIPWIRE_DIR';
const TRIPWIRE_FILE = 'invoked';

function basenameOf(command: string): string {
  const normalized = command.replace(/\\/g, '/');
  const i = normalized.lastIndexOf('/');
  return (i === -1 ? command : normalized.slice(i + 1)).toLowerCase();
}

/**
 * True when `command` is a known desktop opener basename or path to one.
 * `open` here is the macOS Launch Services tool, not an agents subcommand —
 * those go through `node dist/index.js open …` and never match.
 */
export function isDesktopOpenerCommand(command: string): boolean {
  const base = basenameOf(command);
  return (DESKTOP_OPENER_BASENAMES as readonly string[]).includes(base);
}

function openerAllowed(): boolean {
  return process.env[ALLOW_ENV] === '1';
}

function writeStub(stubDir: string, name: string): void {
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(stubDir, `${name}.cmd`),
      [
        '@echo off',
        'if defined AGENTS_TEST_OPENER_TRIPWIRE_DIR (',
        '  echo %~n0 %*>>"%AGENTS_TEST_OPENER_TRIPWIRE_DIR%\\invoked"',
        ')',
        'echo hermeticity leak (PHNX-3072): test spawned desktop opener %~n0 %* 1>&2',
        'exit /b 1',
        '',
      ].join('\r\n'),
    );
    return;
  }
  fs.writeFileSync(
    path.join(stubDir, name),
    [
      '#!/bin/sh',
      'if [ -n "$AGENTS_TEST_OPENER_TRIPWIRE_DIR" ]; then',
      '  mkdir -p "$AGENTS_TEST_OPENER_TRIPWIRE_DIR"',
      '  printf "%s\\n" "$(basename "$0") $*" >> "$AGENTS_TEST_OPENER_TRIPWIRE_DIR/invoked"',
      'fi',
      'echo "hermeticity leak (PHNX-3072): test spawned desktop opener $(basename "$0") $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}

interface InstallOpenerSandboxOpts {
  /** Fork-private temp dir from tests/setup.ts. Stubs + tripwire live under it. */
  tmp: string;
}

/**
 * Install the opener sandbox into this process: stub dir on PATH, env pins.
 * Idempotent enough to call once per fork from setup.ts.
 */
export function installOpenerSandbox(opts: InstallOpenerSandboxOpts): { stubDir: string; tripwireDir: string } {
  const stubDir = path.join(opts.tmp, 'opener-stubs');
  const tripwireDir = path.join(opts.tmp, 'opener-tripwire');
  fs.mkdirSync(stubDir, { recursive: true });
  fs.mkdirSync(tripwireDir, { recursive: true });
  for (const name of DESKTOP_OPENER_BASENAMES) writeStub(stubDir, name);

  process.env[STUB_DIR_ENV] = stubDir;
  process.env[TRIPWIRE_DIR_ENV] = tripwireDir;
  process.env.PATH = `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`;

  return { stubDir, tripwireDir };
}

export function openerSandboxTripped(): string | null {
  const dir = process.env[TRIPWIRE_DIR_ENV];
  if (!dir) return null;
  const file = path.join(dir, TRIPWIRE_FILE);
  if (!fs.existsSync(file)) return null;
  const body = fs.readFileSync(file, 'utf-8').trim();
  return body.length > 0 ? body : null;
}

/**
 * Fail the test file if any desktop opener was spawned without
 * `AGENTS_TEST_ALLOW_OPENER=1`. Wired from tests/setup.ts afterAll — same
 * shape as the HOME leak tripwires, but local (not CI-only): the original
 * bug was invisible on Linux CI and only hurt developers running the suite.
 */
export function assertNoUnauthorizedOpenerSpawn(): void {
  if (openerAllowed()) return;
  const log = openerSandboxTripped();
  if (!log) return;
  throw new Error(
    `hermeticity leak (PHNX-3072): a test spawned a desktop opener ` +
      `(open / xdg-open / gnome-open) and would have launched the ` +
      `developer's browser. Inject spawnOpen (see src/lib/open-url.ts) or set ` +
      `${ALLOW_ENV}=1 if the spawn is intentional. Invocations:\n${log}`,
  );
}
