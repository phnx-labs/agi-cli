- **Worker daemons now actually relaunch onto a new agents-cli release, so a fix
  that ships reaches every worker without a hand `agents daemon restart`
  (PHNX-3940 rollout).** Two defects kept every fleet daemon on the code it
  booted with: `resolveRunningPackageRoot(__dirname)` resolved one level up from
  the calling module, which from `dist/lib/daemon/self-update-service.js` is
  `dist/lib`, so every self-update tick failed with `… is not an npm-managed
  install` (eight Linux workers logged it for days and ran 1.22.79 code while the
  disk sat at 1.22.88); and the tick only exited after an install it performed
  itself, so an install written by an operator's `agents` command never relaunched
  the daemon, and on a box with a second `agents` on PATH the tick declined
  silently. The resolver now walks up to the `package.json` naming this package;
  the tick compares the on-disk version with the version it booted with and, when
  the disk is newer and the install has settled (`package.json` at rest for a
  minute and every `bin` entry present, because bun's write is not atomic), exits
  for the OS-supervisor relaunch without downloading anything. The shadow decline
  is logged once per daemon process, and `auth-sync` logs accounts skipped
  because their durable key is not readable on the box. Source:
  `cli/src/lib/self-update.ts`, `cli/src/lib/daemon/self-update-service.ts`,
  `cli/src/lib/daemon/auth-sync-service.ts`.
