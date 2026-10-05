import { defineConfig } from 'vitest/config';
import { shouldEnableCiTestProfile } from './tests/hermetic-guards';

// RUSH-2215: a big vitest forks suite can pass every test yet exit 1 as idle workers die (#2622).
// Cap forks on win32; ignore pool errors there and in CI. Gated on shouldEnableCiTestProfile()
// (RUSH-3007), not bare CI, to stay apart from leak tripwires.
const isWin = process.platform === 'win32';
const ignoreUnhandledPoolErrors = isWin || shouldEnableCiTestProfile(process.env);

// RUSH-3081/RUSH-3015: the attestation producer runs the full suite on the shared signing Mac under
// load; a worker per core made real-service tests flake and workers OOM (~every run, ~10 attempts).
// Cap producer concurrency; normal CI keeps full parallelism and its 90s budget.
const isAttestProducer = process.env.AGENTS_ATTEST_PRODUCER === '1';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    ...(isWin ? { maxWorkers: 2, minWorkers: 1 } : {}),
    ...(isAttestProducer && !isWin ? { maxWorkers: 4, minWorkers: 1 } : {}),
    // Hermeticity (#910): every fork gets a temp-pinned broker socket, events
    // sink, and broker-off defaults BEFORE the test file's imports run.
    setupFiles: ['./tests/setup.ts'],
    // RUSH-2639: sweep stale agents-vitest-* temp dirs left by killed workers
    // from past runs, once per whole suite (see tests/global-setup.ts).
    globalSetup: ['./tests/global-setup.ts'],
    include: ['tests/**/*.test.ts', 'src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts', 'scripts/**/*.test.ts'],
    testTimeout: 30000,
    // RUSH-2215: ignore unhandled pool errors on win32 and in CI. Real
    // assertion failures still fail the run; only teardown worker-exits
    // are swallowed. Local non-CI Linux stays strict.
    ...(ignoreUnhandledPoolErrors
      ? { dangerouslyIgnoreUnhandledErrors: true, hookTimeout: 60_000 }
      : {}),
  },
});
