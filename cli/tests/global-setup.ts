import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureStandaloneSecretsBin } from './secrets-standalone.js';

const STALE_AGE_MS = 60 * 60 * 1000;


export default function globalSetup(): void {
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
    if (now - mtimeMs < STALE_AGE_MS) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
    }
  }
}
