
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';

export function parseSha256Asset(text: string): string {
  const m = text.trim().match(/^([A-Fa-f0-9]{64})(\s|$)/);
  if (!m) throw new Error(`malformed .sha256 release asset: ${JSON.stringify(text.slice(0, 80))}`);
  return m[1].toLowerCase();
}

export function sha256File(file: string): Promise<string> {

  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')));
  });
}
