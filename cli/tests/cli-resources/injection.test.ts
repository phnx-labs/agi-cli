import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseCliManifest,
  isCliInstalled,
  installCli,
  type CliManifest,
  type CheckSpec,
} from '../../src/lib/cli-resources.js';

const CANARY = path.join(os.tmpdir(), `agents-rce-test-${process.pid}`);

function readCanary(): boolean {
  return fs.existsSync(CANARY);
}

beforeEach(() => {
  try { fs.unlinkSync(CANARY); } catch {  }
});
afterEach(() => {
  try { fs.unlinkSync(CANARY); } catch {  }
});

const PAYLOAD_CHECK = `echo a; touch ${CANARY}`;
const PAYLOAD_NPM = `evil; touch ${CANARY}`;

describe('cli-resources injection hardening', () => {
  it('parseCliManifest rejects a shell-metachar payload in `check:`', () => {
    const yaml = `name: evil\ncheck: "${PAYLOAD_CHECK}"\ninstall:\n  - brew: ok\n`;
    expect(() =>
      parseCliManifest(yaml, { name: 'evil', source: 'user', path: '/x' }),
    ).toThrow(/unsafe token/);
    expect(readCanary()).toBe(false);
  });

  it('parseCliManifest rejects a shell-metachar payload in `install.npm`', () => {
    const yaml = `name: evil\ninstall:\n  - npm: "${PAYLOAD_NPM}"\n`;
    expect(() =>
      parseCliManifest(yaml, { name: 'evil', source: 'user', path: '/x' }),
    ).toThrow(/not allowlisted/);
    expect(readCanary()).toBe(false);
  });

  it('parseCliManifest rejects a non-https script URL', () => {
    const yaml = `name: evil\ninstall:\n  - script: "http://evil.example.com/x.sh"\n`;
    expect(() =>
      parseCliManifest(yaml, { name: 'evil', source: 'user', path: '/x' }),
    ).toThrow(/https/);
    expect(readCanary()).toBe(false);
  });

  it('parseCliManifest rejects a path-traversal extract in a binary spec', () => {
    const yaml =
      `name: evil\ninstall:\n  - binary:\n      ${process.platform}-${process.arch}:\n        url: "https://example.com/x.tgz"\n        extract: "../../etc/passwd"\n`;
    expect(() =>
      parseCliManifest(yaml, { name: 'evil', source: 'user', path: '/x' }),
    ).toThrow(/not allowlisted/);
    expect(readCanary()).toBe(false);
  });

  it('isCliInstalled does not evaluate a shell payload when given a malicious CheckSpec directly', () => {
    const checkAsObj: CheckSpec = {
      kind: 'version',
      cmd: `echo a; touch ${CANARY}`,
      args: [],
    };
    const m: CliManifest = {
      name: 'evil',
      check: checkAsObj,
      install: [{ brew: 'ok' }],
      source: 'user',
      path: '/x',
    };
    isCliInstalled(m);
    expect(readCanary()).toBe(false);
  });

  it('installCli refuses a malicious npm package without running it', () => {
    const m: CliManifest = {
      name: 'evil',
      check: { kind: 'which', cmd: 'evil' },
      install: [{ npm: PAYLOAD_NPM }],
      source: 'user',
      path: '/x',
    };
    const result = installCli(m);
    expect(result.installed).toBe(false);
    expect(result.error ?? '').toMatch(/not allowlisted|No compatible install method/);
    expect(readCanary()).toBe(false);
  });
});
