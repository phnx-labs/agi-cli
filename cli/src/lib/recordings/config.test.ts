import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalHome = process.env.HOME;
const directories: string[] = [];

afterEach(async () => {
  process.env.HOME = originalHome;
  vi.resetModules();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('recordingsStateDir', () => {
  it('moves the legacy ~/.agents/recordings ledger under .history so published rows survive', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'recordings-home-'));
    directories.push(home);
    const legacy = path.join(home, '.agents', 'recordings');
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, 'ledger.json'), '{"version":1,"rows":[]}\n');
    process.env.HOME = home;
    vi.resetModules();
    const { recordingsLedgerPath } = await import('./config.js');

    const ledgerPath = recordingsLedgerPath();

    expect(ledgerPath).toBe(path.join(home, '.agents', '.history', 'recordings', 'ledger.json'));
    expect(await fs.readFile(ledgerPath, 'utf8')).toBe('{"version":1,"rows":[]}\n');
    await expect(fs.stat(legacy)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
