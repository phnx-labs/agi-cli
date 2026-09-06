import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { getTerminalsDir } from '../../state.js';
import { hostProcessView, requireWriterProcessView, recordDaemonProcessView } from '../process-view.js';

const mode = process.argv[2];
try {
  if (mode === 'hook-first') {
    const hook = process.env.AGENTS_SESSION_IDENTITY_TEST_HOOK;
    const child = hook
      ? spawnSync('bash', [hook], { input: JSON.stringify({ session_id: 'init-hook', cwd: process.cwd() }), encoding: 'utf8', env: process.env })
      : spawnSync('bun', [import.meta.filename, 'once'], { encoding: 'utf8', env: process.env });
    if (child.status !== 0) throw new Error(child.stderr);
    if (!fs.existsSync(`${getTerminalsDir()}/process-view.json`)) throw new Error('child did not enroll its namespace');
  }
  if (mode === 'daemon') recordDaemonProcessView();
  if (mode === 'read') {
    if (hostProcessView()) throw new Error('unexpected owner');
    console.log('unowned');
    process.exit(0);
  }
  requireWriterProcessView();
  console.log('owned');
  if (mode === 'hold' || mode === 'hook-first') {
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  }
} catch (error) {
  console.error((error as Error).message);
  console.log('denied');
  process.exitCode = 2;
}
