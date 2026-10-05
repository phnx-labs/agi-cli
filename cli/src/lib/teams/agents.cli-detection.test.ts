import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('checkCliAvailable — shims-dir detection', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let origPath: string | undefined;

  beforeEach(() => {
    origHome = process.env.HOME;
    origPath = process.env.PATH;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'checkcli-'));
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origPath === undefined) delete process.env.PATH; else process.env.PATH = origPath;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  it('reports installed from the shim even when PATH is empty', async () => {
    process.env.HOME = tmpHome;
    process.env.PATH = '';
    const shimsDir = path.join(tmpHome, '.agents', '.cache', 'shims');
    fs.mkdirSync(shimsDir, { recursive: true });
    fs.writeFileSync(path.join(shimsDir, 'claude'), '#!/bin/sh\n', { mode: 0o755 });

    vi.resetModules();
    const { checkCliAvailable } = await import('./agents.js');
    const [installed, resolved] = checkCliAvailable('claude' as never);

    expect(installed).toBe(true);
    expect(resolved).toBe(path.join(shimsDir, 'claude'));
  });

  it('reports not-installed when neither the shims dir nor PATH has the CLI', async () => {
    process.env.HOME = tmpHome;
    process.env.PATH = '';
    fs.mkdirSync(path.join(tmpHome, '.agents', '.cache', 'shims'), { recursive: true });

    vi.resetModules();
    const { checkCliAvailable } = await import('./agents.js');
    const [installed, err] = checkCliAvailable('claude' as never);

    expect(installed).toBe(false);
    expect(err).toMatch(/not found in PATH/);
  });

  it('reports NOT installed when the shim exists but the default version binary is missing', async () => {
    process.env.HOME = tmpHome;
    process.env.PATH = '';
    const shimsDir = path.join(tmpHome, '.agents', '.cache', 'shims');
    fs.mkdirSync(shimsDir, { recursive: true });
    fs.writeFileSync(path.join(shimsDir, 'claude'), '#!/bin/sh\n', { mode: 0o755 });

    vi.resetModules();
    const versions = await import('../installations/versions.js');
    versions.setGlobalDefault('claude', '9.9.9');
    const { checkCliAvailable } = await import('./agents.js');
    const [installed, err] = checkCliAvailable('claude' as never);

    expect(installed).toBe(false);
    expect(err).toMatch(/not runnable|binary is missing/i);
  });
});
