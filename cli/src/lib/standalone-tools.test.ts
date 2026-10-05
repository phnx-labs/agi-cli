import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureToolPins, meetsFloor, pinnedSpec, readToolPins, STANDALONE_TOOL_PINS } from './standalone-tools.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

function writeExecutable(file: string, body: string): void {
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

describe('standalone tool floors', () => {
  it('pins the published releases R1 of PHNX-4227 depends on', () => {
    expect(pinnedSpec('sessions')).toBe('@phnx-labs/sessions-cli@0.5.0');
    expect(pinnedSpec('browser')).toBe('@phnx-labs/browser-cli@0.1.15');
    expect(pinnedSpec('secrets')).toBe('@phnx-labs/secrets-cli@0.1.8');
    expect(pinnedSpec('computer')).toBe('@phnx-labs/computer-cli@0.1.5');
  });

  it('compares numerically, not as strings', () => {
    expect(meetsFloor('0.1.15', '0.1.8')).toBe(true);
    expect(meetsFloor('0.4.9', '0.5.0')).toBe(false);
    expect(meetsFloor(null, '0.1.0')).toBe(false);
  });
});

describePosix('ensureToolPins — real executables on PATH', () => {
  let bin: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-tool-pins-'));
    originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(bin, { recursive: true, force: true });
  });

  it('reads each tool from `<tool> --version` and grades it against its floor', async () => {
    writeExecutable(path.join(bin, 'sessions'), 'echo "sessions 0.4.2"');
    writeExecutable(path.join(bin, 'browser'), 'echo "0.1.20"');
    const rows = await readToolPins(['sessions', 'browser', 'computer']);
    expect(rows.map((r) => [r.tool, r.installed, r.state])).toEqual([
      ['sessions', '0.4.2', 'outdated'],
      ['browser', '0.1.20', 'ok'],
      ['computer', null, 'missing'],
    ]);
  });

  it('upgrades an outdated tool through npm install -g <pkg>@<floor> and re-reads it', async () => {
    writeExecutable(path.join(bin, 'sessions'), 'echo "0.4.2"');
    writeExecutable(
      path.join(bin, 'npm'),
      `echo "$@" >> "${bin}/npm.log"\nprintf '#!/bin/sh\\necho 0.5.0\\n' > "${bin}/sessions"\nchmod 755 "${bin}/sessions"`,
    );
    const rows = await ensureToolPins({ tools: ['sessions'], logToStderr: true });
    expect(rows).toEqual([expect.objectContaining({ tool: 'sessions', installed: '0.5.0', state: 'upgraded' })]);
    expect(fs.readFileSync(path.join(bin, 'npm.log'), 'utf8').trim()).toBe(`install -g ${pinnedSpec('sessions')}`);
  });

  it('reports failed when the binary on PATH still reads below the floor after npm', async () => {
    writeExecutable(path.join(bin, 'secrets'), 'echo "0.1.2"');
    writeExecutable(path.join(bin, 'npm'), 'exit 0');
    const [row] = await ensureToolPins({ tools: ['secrets'], logToStderr: true });
    expect(row.state).toBe('failed');
    expect(row.error).toContain(`reads 0.1.2 after installing ${pinnedSpec('secrets')}`);
  });

  it('never touches npm for a dry run or a tool already at its floor', async () => {
    writeExecutable(path.join(bin, 'term'), `echo "${STANDALONE_TOOL_PINS.term.floor}"`);
    writeExecutable(path.join(bin, 'npm'), `echo called >> "${bin}/npm.log"; exit 1`);
    const rows = await ensureToolPins({ tools: ['term', 'computer'], dryRun: true });
    expect(rows.map((r) => r.state)).toEqual(['ok', 'missing']);
    expect(fs.existsSync(path.join(bin, 'npm.log'))).toBe(false);
  });
});
