/** Poll source evaluator: re-runs a shell command on an interval and diffs the output. Identical to
 * the `command` source (the engine owns the cadence), so it delegates to command.ts. */

export { evaluate } from './command.js';
