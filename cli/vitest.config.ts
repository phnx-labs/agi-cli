import { defineConfig } from 'vitest/config';
import { shouldEnableCiTestProfile } from './tests/hermetic-guards';

const isWin = process.platform === 'win32';
const ignoreUnhandledPoolErrors = isWin || shouldEnableCiTestProfile(process.env);
// CI/Windows suppress only orphan-worker teardown errors; assertions still fail and local Linux stays strict.

const isAttestProducer = process.env.AGENTS_ATTEST_PRODUCER === '1';
// The shared signing producer is capped at four workers; ordinary CI remains uncapped.

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    ...(isWin ? { maxWorkers: 2, minWorkers: 1 } : {}),
    ...(isAttestProducer && !isWin ? { maxWorkers: 4, minWorkers: 1 } : {}),
    // setupFiles makes forks hermetic before imports; globalSetup sweeps stale worker temp dirs once.
    setupFiles: ['./tests/setup.ts'],
    globalSetup: ['./tests/global-setup.ts'],
    include: ['tests/**/*.test.ts', 'src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts', 'scripts/**/*.test.ts'],
    testTimeout: 30000,
    ...(ignoreUnhandledPoolErrors
      ? { dangerouslyIgnoreUnhandledErrors: true, hookTimeout: 60_000 }
      : {}),
  },
});
