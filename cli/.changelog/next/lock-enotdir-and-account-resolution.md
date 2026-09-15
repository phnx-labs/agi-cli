- **Fix `ENOTDIR` crash on stale lock files.** `withFileLock` and `withFileLockAsync`
  now self-heal when a prior crash left a regular file instead of the directory
  `proper-lockfile` expects, matching the caller's `realpath` option when computing
  the lock path. Source: `cli/src/lib/fs-atomic.ts`.

- **Fix `Unknown account` for unregistered native logins.** `ag run claude#email`
  now discovers a native OAuth login from version-home `.claude.json` files when the
  account is not yet in `accounts.native`, and correctly routes it through the
  provider-backed harness guard. Source: `cli/src/lib/account-registry.ts`.
