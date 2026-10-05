import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLink } from './links.js';

describe('createLink', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-links-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('links a directory so its contents are reachable through the link', () => {
    const src = path.join(dir, 'srcdir');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'inner.txt'), 'hello');
    const dst = path.join(dir, 'linkdir');

    createLink(src, dst);

    expect(fs.readFileSync(path.join(dst, 'inner.txt'), 'utf8')).toBe('hello');
  });

  it('links a file so its content is reachable through the link', () => {
    const src = path.join(dir, 'src.txt');
    fs.writeFileSync(src, 'payload');
    const dst = path.join(dir, 'link.txt');

    createLink(src, dst);

    expect(fs.readFileSync(dst, 'utf8')).toBe('payload');
  });

  it('throws when the source does not exist (no silent no-op)', () => {
    expect(() => createLink(path.join(dir, 'nope'), path.join(dir, 'x'))).toThrow();
  });
});
