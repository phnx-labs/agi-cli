/** Vitest `globalSetup`: runs once in the main process. RUSH-2639: setup.ts makes a per-fork
 * `agents-vitest-<random>` temp dir removed in `afterAll`, but killed workers (CI timeout, OOM)
 * orphan theirs. Sweep stale ones (older than STALE_AGE_MS) before the run. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureStandaloneSecretsBin } from './secrets-standalone.js';

const STALE_AGE_MS = 60 * 60 * 1000; // 1 hour — well past any single test file's runtime.

export default function globalSetup(): void {
  // PHNX-3989: every secrets read/write in the suite uses the real standalone `secrets` executable
  // (no mocks). Resolve or install it once here so every fork inherits SECRETS_BIN instead of
  // racing an npm install per file.
  const secretsBin = ensureStandaloneSecretsBin();
  process.env.SECRETS_BIN = secretsBin;
  process.env.AGENTS_TEST_SECRETS_BIN = secretsBin;

  const tmpRoot = os.tmpdir();
  let entries: string[];
  try {
    entries = fs.readdirSync(tmpRoot);
  } catch {
    return;
  }

  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith('agents-vitest-')) continue;
    const full = path.join(tmpRoot, name);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs < STALE_AGE_MS) continue; // young enough to be a live sibling run
    try {
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // best effort — another process may be racing us for the same cleanup
    }
  }
}
