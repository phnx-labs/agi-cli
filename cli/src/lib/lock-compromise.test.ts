import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { logAndContinueOnLockCompromised } from './lock-compromise.js';

describe('proper-lockfile crash barrier', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('survives a concurrently removed lock directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-lock-compromise-'));
    dirs.push(dir);
    const target = path.join(dir, 'registry.json');
    fs.writeFileSync(target, '{}');
    const release = await lockfile.lock(target, {
      stale: 2_000,
      update: 1_000,
      onCompromised: logAndContinueOnLockCompromised('devices registry'),
    });

    fs.rmSync(`${target}.lock`, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 1_250));

    expect(process.pid).toBeGreaterThan(0);
    await expect(release()).rejects.toMatchObject({ code: 'ERELEASED' });
  });
});
