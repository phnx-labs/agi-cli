import { runDaemon, startDaemon } from '../daemon.js';
if (process.argv[2] === '__start-daemon') {
  try { startDaemon(); } catch (error) {
    console.log((error as Error).message);
    process.exitCode = 2;
  }
} else await runDaemon();
