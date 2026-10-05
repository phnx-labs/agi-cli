/** sha256 helpers for verifying downloaded release assets. Keep this a LEAF module (only
 * `node:crypto`, `node:fs`): a local import can reintroduce a cycle like the one that threw a
 * ReferenceError on `EXPECTED_TEAM_ID` in `helper-download.ts` (RUSH-3113; PHNX-4075, PHNX-3989). */

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
