- **The daemon no longer restarts when a service tick runs slow (PHNX-4225).** A
  tick past its deadline is now aborted, logged as `tick.breach`, and skipped until
  it settles; the daemon exits for a supervised restart only when a tick is still
  unsettled at 10 times its deadline. On a loaded laptop the old exit-on-overrun
  policy restarted the daemon about 200 times a day. Source:
  `cli/src/lib/daemon/supervisor.ts`.
- **Recordings encode one video at a time and stop encodes a dead daemon left
  running (PHNX-4225).** Each daemon exit used to leave its `ffmpeg` running and
  the next start re-encoded every queued recording at once, so encodes of the same
  file piled up. The ledger now records each encode's process and work directory,
  a restarted daemon stops a leftover encode and deletes its directory before
  requeueing, and only one recording is processed at a time. Source:
  `cli/src/lib/recordings/pipeline.ts`.
