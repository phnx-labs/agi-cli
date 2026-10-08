import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe.skipIf(process.platform === 'win32')('forwarded --help', () => {
  let home: string;

  function stub(name: string): string {
    const file = path.join(home, `${name}-stub`);
    fs.writeFileSync(file, `#!/bin/sh\nprintf '${name}-stub argv: %s\\n' "$*"\n`, { mode: 0o755 });
    return file;
  }

  function run(args: string[], env: Record<string, string>): string {
    const r = spawnSync('bun', [path.resolve(process.cwd(), 'src/index.ts'), ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env, HOME: home, AGENTS_REAL_HOME: home, AGENTS_NO_NUDGE: '1',
        AGENTS_CLI_DISABLE_AUTO_UPDATE: '1', FORCE_COLOR: '0', ...env,
      },
      encoding: 'utf8',
    });
    return `${r.stdout}${r.stderr}`;
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'forwarded-help-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('agents browser <verb> --help is answered by the browser CLI', () => {
    const out = run(['browser', 'screenshot', '--help'], { BROWSER_BIN: stub('browser') });
    expect(out).toContain('browser-stub argv: screenshot --help');
    expect(out).not.toContain('Usage: agents browser screenshot');
  }, 60_000);

  it('agents secrets --help is answered by the secrets CLI', () => {
    const out = run(['secrets', '--help'], { SECRETS_BIN: stub('secrets') });
    expect(out).toContain('secrets-stub argv: --help');
    expect(out).not.toContain('Usage: agents secrets');
  }, 60_000);
});
