/**
 * The passphrase that seals a bundle for TRANSPORT — `secrets push`/`pull` and
 * the portable `export --to-file` / `import --from-file` envelope.
 *
 * This is deliberately a DIFFERENT secret from the file store's master key
 * (`AGENTS_SECRETS_PASSPHRASE`, `filestore.ts:getPassphrase`). The two were one
 * variable, and that overload is what put a master key into `~/.zshenv` on seven
 * worker boxes (RUSH-1968): the file store stopped needing a passphrase once it
 * auto-provisioned a machine-local key, but headless `push`/`pull` still hard-
 * failed without one, so an operator exported the master key fleet-wide to make
 * sync work — handing every same-user process the key to the whole store.
 *
 * Splitting them means a box that only needs headless sync sets
 * `AGENTS_SYNC_PASSPHRASE` and never has the store's master key in its
 * environment at all.
 *
 * Resolution order:
 *   1. `AGENTS_SYNC_PASSPHRASE`        — the current name.
 *   2. `AGENTS_SECRETS_PASSPHRASE`     — deprecated fallback, warns once.
 *   3. (caller prompts, or fails)
 *
 * The fallback exists so already-scripted CI and release automation keep working
 * across the upgrade; it is not a second supported spelling.
 */
import chalk from 'chalk';

/** The current variable for transport/sync passphrases. */
export const SYNC_PASSPHRASE_ENV = 'AGENTS_SYNC_PASSPHRASE';
/** The file-store master key, honoured for sync only as a deprecated fallback. */
export const LEGACY_PASSPHRASE_ENV = 'AGENTS_SECRETS_PASSPHRASE';

/** Warn at most once per process: a `--all` push over many bundles must not
 *  flood stderr with the same notice. */
let deprecatedVarWarned = false;
/** Same, for the "this came from an env var at all" readability notice. */
let envPassphraseWarned = false;

/** Reset the one-shot warning latches. Tests only — production never re-warns. */
export function resetSyncPassphraseWarnings(): void {
  deprecatedVarWarned = false;
  envPassphraseWarned = false;
}

/** Where a resolved sync passphrase came from, so callers can report honestly. */
export type SyncPassphraseSource = 'sync-env' | 'legacy-env' | null;

export interface ResolvedSyncPassphrase {
  value: string | null;
  source: SyncPassphraseSource;
}

/**
 * Read the transport passphrase from the environment, preferring the current
 * variable and falling back to the deprecated one with a single warning.
 * Returns `{ value: null }` when neither is set — the caller decides whether to
 * prompt (TTY) or fail (headless). Never prompts, never throws.
 */
export function resolveSyncPassphraseFromEnv(): ResolvedSyncPassphrase {
  const current = process.env[SYNC_PASSPHRASE_ENV];
  if (current) return { value: current, source: 'sync-env' };

  const legacy = process.env[LEGACY_PASSPHRASE_ENV];
  if (legacy) {
    if (!deprecatedVarWarned) {
      deprecatedVarWarned = true;
      process.stderr.write(chalk.yellow(
        `warn: ${LEGACY_PASSPHRASE_ENV} is deprecated for sync — it is the file store's master key, ` +
        `not a transport passphrase. Set ${SYNC_PASSPHRASE_ENV} instead; the old name still works ` +
        'for now. Keeping the master key in the environment exposes the whole store to every ' +
        'same-user process (RUSH-1968).\n',
      ));
    }
    return { value: legacy, source: 'legacy-env' };
  }
  return { value: null, source: null };
}

/**
 * The one-shot reminder that an env-sourced passphrase is readable by other
 * same-user processes. Separate from the deprecation notice above so a caller
 * using the CURRENT variable still gets the readability warning exactly once.
 */
export function warnEnvPassphraseReadableOnce(): void {
  if (envPassphraseWarned) return;
  envPassphraseWarned = true;
  process.stderr.write(chalk.yellow(
    'warn: using a sync passphrase from the environment. Env vars are readable by other ' +
    'same-user processes (/proc, ps, crash dumps, CI logs) — rotate after CI use.\n',
  ));
}

/** The message a headless caller shows when no passphrase is available. */
export function missingSyncPassphraseMessage(): string {
  return `A sync passphrase is required. Run from a TTY, or set ${SYNC_PASSPHRASE_ENV}.`;
}
