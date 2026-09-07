/**
 * sha256 helpers for verifying downloaded release assets.
 *
 * These live in their own LEAF module — importing only `node:crypto` and
 * `node:fs` — on purpose. They used to sit in `computer/ssh-tunnel.ts`, whose
 * own import graph reached `browser/drivers/ssh.ts` -> `browser/chrome.ts` ->
 * the in-repo secrets engine's own keychain-helper downloader, which imported
 * back into `helper-download.ts` while it was still evaluating — before
 * `EXPECTED_TEAM_ID` was bound, throwing `ReferenceError: Cannot access
 * 'EXPECTED_TEAM_ID' before initialization` for any entry point that reached
 * `helper-download.ts` first (RUSH-3113). The secrets engine that closed that
 * cycle is gone now (PHNX-3989 — the standalone `secrets` CLI downloads its own
 * helper), but the discipline that fixed it still holds: keep this module a
 * leaf, since `helper-download.ts` needs nothing beyond these two pure
 * functions and adding a local import here can reintroduce a cycle with
 * whatever imports it next.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';

/** Pull the digest out of a `<sha256>  <filename>` release asset. */
export function parseSha256Asset(text: string): string {
  const m = text.trim().match(/^([A-Fa-f0-9]{64})(\s|$)/);
  if (!m) throw new Error(`malformed .sha256 release asset: ${JSON.stringify(text.slice(0, 80))}`);
  return m[1].toLowerCase();
}

/** Stream a file through sha256 — the exe is ~157MB, never read it whole. */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')));
  });
}
