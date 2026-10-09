- **Claude routines run on worker devices again.** Before launching, a routine checked
  each candidate account with `claude auth status` in an environment that left out the
  setup-token a worker launch injects. Every account on a worker read as signed out, so
  every Claude routine there failed with "found no authenticated Claude account". The
  check now uses the same environment as the launch. Source: `cli/src/lib/daemon/runner.ts`.
