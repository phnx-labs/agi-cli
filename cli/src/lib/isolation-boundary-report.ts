import chalk from 'chalk';
import { IsolationBoundaryError } from './installations/shims.js';
import { listInstalledVersions } from './installations/versions.js';

/** Turns an IsolationBoundaryError into user guidance instead of a stack trace. The remedy is
 * always the same: drop the isolated copies and the agent is ordinary again. */
export function explainIsolationBoundary(err: IsolationBoundaryError): void {
  const versions = listInstalledVersions(err.agent);
  console.error(chalk.red(`\n${err.agent} is installed only as isolated copies.`));
  console.error(chalk.gray(`  Refused: ${err.operation} — that is exactly what --isolated promises not to do.`));
  console.error(chalk.gray('\n  To keep the sandbox and act inside it:'));
  console.error(chalk.gray(`    agents add ${err.agent}@<version> --isolated    # another isolated copy`));
  console.error(chalk.gray(`    agents use ${err.agent}@<version>               # pick which one 'agents run ${err.agent}' uses`));
  console.error(chalk.gray('\n  To manage this agent normally instead, remove the isolated copies first:'));
  for (const v of versions) {
    console.error(chalk.gray(`    agents remove ${err.agent}@${v} --isolated`));
  }
}

/** Run `fn`, converting a boundary refusal into guidance + a non-zero exit. */
export async function withIsolationBoundary<T>(fn: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof IsolationBoundaryError) {
      explainIsolationBoundary(err);
      process.exit(1);
    }
    throw err;
  }
}
