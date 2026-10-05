import { beforeEach, describe, expect, it, vi } from 'vitest';
type WatchCallback = (
  eventType: string,
  filename: string | Buffer | null,
) => void;

const watchState: { callbacks: WatchCallback[] } = { callbacks: [] };

vi.mock('fs', () => {
  const actual = require('node:fs') as typeof import('fs');
  return {
    ...actual,
    default: actual,
    watch: ((_: fs.PathLike, __: fs.WatchOptions | undefined, listener?: WatchCallback) => {
      if (listener) watchState.callbacks.push(listener);
      return { close() {} } as fs.FSWatcher;
    }) as typeof actual.watch,
  };
});

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { tailFile } from '../sessions-tail.js';

function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-tail-test-'));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for predicate after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

function triggerWatch(filename: string | null): void {
  for (const cb of watchState.callbacks) {
    cb('change', filename);
  }
}

beforeEach(() => {
  watchState.callbacks = [];
});

describe('tailFile', () => {
  it('emits each line exactly once across multiple appends', async () => {
    const dir = mkTempDir();
    const filePath = path.join(dir, 'session.jsonl');
    fs.writeFileSync(filePath, '');

    const lines: string[] = [];
    const ac = new AbortController();
    const tailPromise = tailFile(filePath, (l) => lines.push(l), ac);

    await new Promise((r) => setTimeout(r, 50));

    await fsp.appendFile(filePath, 'one\n');
    triggerWatch(path.basename(filePath));
    await waitFor(() => lines.length >= 1);

    await fsp.appendFile(filePath, 'two\nthree\n');
    triggerWatch(path.basename(filePath));
    await waitFor(() => lines.length >= 3);

    await fsp.appendFile(filePath, 'partial');
    triggerWatch(path.basename(filePath));
    await new Promise((r) => setTimeout(r, 80));
    expect(lines).toEqual(['one', 'two', 'three']);

    await fsp.appendFile(filePath, '-done\n');
    triggerWatch(path.basename(filePath));
    await waitFor(() => lines.length >= 4);

    ac.abort();
    await tailPromise;

    expect(lines).toEqual(['one', 'two', 'three', 'partial-done']);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts at EOF by default (does not emit pre-existing lines)', async () => {
    const dir = mkTempDir();
    const filePath = path.join(dir, 'session.jsonl');
    fs.writeFileSync(filePath, 'old-a\nold-b\n');

    const lines: string[] = [];
    const ac = new AbortController();
    const tailPromise = tailFile(filePath, (l) => lines.push(l), ac);

    await new Promise((r) => setTimeout(r, 80));

    await fsp.appendFile(filePath, 'new\n');
    triggerWatch(path.basename(filePath));
    await waitFor(() => lines.length >= 1);

    ac.abort();
    await tailPromise;

    expect(lines).toEqual(['new']);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('replays the full file when fromStart is true', async () => {
    const dir = mkTempDir();
    const filePath = path.join(dir, 'session.jsonl');
    fs.writeFileSync(filePath, 'a\nb\nc\n');

    const lines: string[] = [];
    const ac = new AbortController();
    const tailPromise = tailFile(filePath, (l) => lines.push(l), ac, { fromStart: true });

    await waitFor(() => lines.length >= 3);

    ac.abort();
    await tailPromise;

    expect(lines).toEqual(['a', 'b', 'c']);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('waits for a file that does not exist yet', async () => {
    const dir = mkTempDir();
    const filePath = path.join(dir, 'later.jsonl');

    const lines: string[] = [];
    const ac = new AbortController();
    const tailPromise = tailFile(filePath, (l) => lines.push(l), ac);

    await new Promise((r) => setTimeout(r, 60));
    fs.writeFileSync(filePath, 'hello\n');
    triggerWatch(path.basename(filePath));
    await waitFor(() => lines.length >= 1);

    expect(lines).toEqual(['hello']);

    ac.abort();
    await tailPromise;

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('handles file truncation by resetting offset', async () => {
    const dir = mkTempDir();
    const filePath = path.join(dir, 'trunc.jsonl');
    fs.writeFileSync(filePath, '');

    const lines: string[] = [];
    const ac = new AbortController();
    const tailPromise = tailFile(filePath, (l) => lines.push(l), ac);

    await new Promise((r) => setTimeout(r, 50));

    await fsp.appendFile(filePath, 'first\nsecond\n');
    triggerWatch(path.basename(filePath));
    await waitFor(() => lines.length >= 2);

    fs.writeFileSync(filePath, 'after-trunc\n');
    triggerWatch(path.basename(filePath));
    await waitFor(() => lines.length >= 3, 3000);

    ac.abort();
    await tailPromise;

    expect(lines).toContain('first');
    expect(lines).toContain('second');
    expect(lines).toContain('after-trunc');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
