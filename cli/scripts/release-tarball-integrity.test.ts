import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, 'release-tarball-integrity.sh');

function run(...args: string[]) {
  const result = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf-8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('release tarball registry identity', () => {
  it('calculates npm sha512 SRI from the exact tarball bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-sri-'));
    const file = path.join(dir, 'package.tgz');
    const bytes = Buffer.from('exact published bytes\n');
    fs.writeFileSync(file, bytes);
    const expected = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const result = run('calculate', file);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toBe(expected);
  });

  it('fails closed when an existing registry version has different bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-sri-mismatch-'));
    const file = path.join(dir, 'package.tgz');
    fs.writeFileSync(file, 'attested bytes\n');
    const other = `sha512-${createHash('sha512').update('other bytes\n').digest('base64')}`;
    const result = run('verify-sri', other, file);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain('!= attested tarball integrity');
  });
});
