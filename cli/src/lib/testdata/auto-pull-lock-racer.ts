import { sleepSync } from '../fs-atomic.js';
import { tryAcquireSyncLock } from '../auto-pull.js';

const [fetchDir, startAtRaw, aliasCountRaw] = process.argv.slice(2);
const startAt = Number(startAtRaw);
const won: string[] = [];

sleepSync(Math.max(0, startAt - Date.now()));
for (let i = 0; i < Number(aliasCountRaw); i++) {
  if (tryAcquireSyncLock(`repo-${i}`, fetchDir)) won.push(`repo-${i}`);
}
process.stdout.write(JSON.stringify(won));
