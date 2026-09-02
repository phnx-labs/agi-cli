/**
 * Compile-failure fixture for the headline-ladder type guard (PHNX-3797).
 *
 * This file is DELIBERATELY not type-correct and is excluded from the build
 * (`src/**/__tests__/**` in tsconfig). `title.ladder-completeness.test.ts` runs
 * the real `tsc` over it and asserts it FAILS — proving that a projection which
 * dropped `generatedTitle` cannot quietly reach `sessionHeadline` and degrade it
 * back to `label || topic`. That is the exact bug the watchdog's `SessionOutcome`
 * shipped, and no lexical lint can see it: the call site reads correctly.
 */
import { sessionHeadline } from '../title.js';

/** A projection that forgot the generated-title rung — the bug shape. */
interface DroppedTheRung {
  label?: string;
  topic?: string;
}

export function mustNotCompile(row: DroppedTheRung): string | undefined {
  return sessionHeadline(row);
}
