# PHNX-3999 F21 — attachment transport, captured run

Terminal output exactly as it printed on `yosemite-m2`, for PR `feat(hosts): stage --attach files on the execution worker` (branch `agents/menu-attachments-0913`, commit `1b9581750`). Nothing here is retyped.

Home paths are replaced with `$HOME` and the SSH peer address with `<peer>`; everything else is verbatim.

Four runs, in order:

1. `attachments.test.ts` with the opt-in **real-SSH** transfer enabled — 28 tests, including an
   `scp` to a live fleet peer whose own `sha256sum` is what the assertions read back.
2. The whole `src/lib/hosts/` suite — 424 tests.
3. The integrated dispatch path against a **remote** worker: real placement, real staging inside
   `dispatchToHost`, and a real claude run on that worker printing the digests it read through the
   `--add-dir` grant. Staging is confirmed reclaimed afterwards.
4. The same driver on the **local / same-host** branch — no network transfer.

In runs 3 and 4 the three attachments are two identical basenames from different directories plus
`déjà vu 'quoted' "double".mov`. Compare each run's printed digests against the `expected sha256`
block at its end.

```console
### PHNX-3999 F21 attachment transport — captured run log
### host: yosemite-m2 (linux) · branch agents/menu-attachments-0913 @ 1b9581750
### captured: 2026-09-13T19:05:24Z

$ AGENTS_TEST_ATTACH_HOST=<peer> bunx vitest run src/lib/hosts/attachments.test.ts

 RUN  v4.1.9 $HOME/.agents/repos/menu-video-cli-0913/.agents/worktrees/menu-attachments-0913/cli

 ✓ src/lib/hosts/attachments.test.ts > validateAttachments > accepts a real file and hashes the bytes that will be transferred 5ms
 ✓ src/lib/hosts/attachments.test.ts > validateAttachments > preserves a basename with spaces, quotes and Unicode byte-exact 1ms
 ✓ src/lib/hosts/attachments.test.ts > validateAttachments > expands a leading ~ against the home directory 1ms
 ✓ src/lib/hosts/attachments.test.ts > validateAttachments > rejects a missing path before anything is staged 1ms
 ✓ src/lib/hosts/attachments.test.ts > validateAttachments > rejects a directory with a steer to --add-dir 1ms
 ✓ src/lib/hosts/attachments.test.ts > validateAttachments > rejects a dangling symlink as a missing file 0ms
 ✓ src/lib/hosts/attachments.test.ts > validateAttachments > resolves a symlink to its target but keeps the name the operator typed 1ms
 ✓ src/lib/hosts/attachments.test.ts > validateAttachments > rejects an empty file 0ms
 ✓ src/lib/hosts/attachments.test.ts > validateAttachments > rejects an unreadable file 0ms
 ✓ src/lib/hosts/attachments.test.ts > validateAttachments > rejects a filename carrying a control character 0ms
 ✓ src/lib/hosts/attachments.test.ts > validateAttachments > rejects the whole set as soon as one path is bad, before hashing the rest 1ms
 ✓ src/lib/hosts/attachments.test.ts > stageAttachmentsLocally > keeps duplicate basenames distinct and byte-exact, with no renaming 5ms
 ✓ src/lib/hosts/attachments.test.ts > stageAttachmentsLocally > preserves spaces, quotes and Unicode in the staged path 1ms
 ✓ src/lib/hosts/attachments.test.ts > stageAttachmentsLocally > stages inside the run-artifact tree as an independent snapshot 18ms
 ✓ src/lib/hosts/attachments.test.ts > stageAttachmentsLocally > stages a symlinked attachment by its target bytes, under the typed name 3ms
 ✓ src/lib/hosts/attachments.test.ts > stageAttachmentsLocally > rejects a source swapped for a same-size file between validation and staging 1ms
 ✓ src/lib/hosts/attachments.test.ts > stageAttachmentsLocally > removes the staging dir when one file cannot be staged 1ms
 ✓ src/lib/hosts/attachments.test.ts > stageAttachmentsLocally > sweeps a staging dir older than the prune window and keeps a fresh one 1ms
 ✓ src/lib/hosts/attachments.test.ts > the prompt block and access grant > names only execution-host paths and grants the staging root once 1ms
 ✓ src/lib/hosts/attachments.test.ts > the prompt block and access grant > adds nothing at all when there are no attachments 0ms
 ✓ src/lib/hosts/attachments.test.ts > the remote staging protocol, executed by a real shell > creates one numbered slot per attachment and reports the absolute root 9ms
 ✓ src/lib/hosts/attachments.test.ts > the remote staging protocol, executed by a real shell > sweeps stale staging dirs on the host as part of setup 9ms
 ✓ src/lib/hosts/attachments.test.ts > the remote staging protocol, executed by a real shell > reports the true size and sha256 of each staged file, including odd basenames 18ms
 ✓ src/lib/hosts/attachments.test.ts > the remote staging protocol, executed by a real shell > digests a filename containing a backslash, which coreutils would otherwise escape 8ms
 ✓ src/lib/hosts/attachments.test.ts > the remote staging protocol, executed by a real shell > exits non-zero when a file never arrived 4ms
 ✓ src/lib/hosts/attachments.test.ts > the remote staging protocol, executed by a real shell > reports a truncated transfer as a hash mismatch the caller can catch 8ms
 ✓ src/lib/hosts/attachments.test.ts > stageAttachmentsOnHost against a real peer > lands every byte on the peer and returns peer-local paths 1911ms
 ✓ src/lib/hosts/attachments.test.ts > stageAttachmentsOnHost against a real peer > fails before dispatch when a file vanishes between validation and transfer 54ms

 Test Files  1 passed (1)
      Tests  28 passed (28)
   Start at  19:05:25
   Duration  3.77s (transform 228ms, setup 26ms, import 317ms, tests 2.07s, environment 0ms)


$ bunx vitest run src/lib/hosts/
error: unknown option '--host'
error: unknown option '-H'

 Test Files  22 passed (22)
      Tests  424 passed | 3 skipped (427)
   Start at  19:05:29
   Duration  6.16s (transform 21.96s, setup 1.15s, import 34.56s, tests 10.81s, environment 7ms)


==============================================================
$ bun run .agents/scratch/attach-e2e.ts remote <worker>   # integrated dispatch, real claude run
=== 1. local validation (runs before placement, before any task) ===
  report.pdf  21B  d511eb49ebacdd4acfc156f7337e9c28a15accabf54ce5c35c1622942e6cfdcd
  report.pdf  22B  0d941ebea946b9a73391ccff9349b0b53ab8d609e3174ee139824282381abaf2
  déjà vu 'quoted' "double".mov  21B  9489b0f8b769286b8a07f34de8f02987784d6492f94c971d2f6f267af58c0f46

=== 2. placement ===
  execution target: yosemite-m5

=== 3. dispatch to yosemite-m5 (staging inside the dispatch path) ===
[secrets] using the encrypted file store at $HOME/.agents/.cache/secrets
[secrets] using the encrypted file store at $HOME/.agents/.cache/secrets
[secrets] using the encrypted file store at $HOME/.agents/.cache/secrets
```
report.pdf d511eb49ebacdd4acfc156f7337e9c28a15accabf54ce5c35c1622942e6cfdcd
report.pdf 0d941ebea946b9a73391ccff9349b0b53ab8d609e3174ee139824282381abaf2
déjà vu 'quoted' "double".mov 9489b0f8b769286b8a07f34de8f02987784d6492f94c971d2f6f267af58c0f46
```
  task b9d70e30 on yosemite-m5 exit=0
  remoteAttachDir recorded: $HOME/.agents/.cache/hosts/c6900eba.attachments
  staging after a followed run: reclaimed

=== expected sha256 ===
  report.pdf d511eb49ebacdd4acfc156f7337e9c28a15accabf54ce5c35c1622942e6cfdcd
  report.pdf 0d941ebea946b9a73391ccff9349b0b53ab8d609e3174ee139824282381abaf2
  déjà vu 'quoted' "double".mov 9489b0f8b769286b8a07f34de8f02987784d6492f94c971d2f6f267af58c0f46

==============================================================
$ bun run .agents/scratch/attach-e2e.ts local            # same-host fallback, no network
=== 1. local validation (runs before placement, before any task) ===
  report.pdf  21B  d511eb49ebacdd4acfc156f7337e9c28a15accabf54ce5c35c1622942e6cfdcd
  report.pdf  22B  0d941ebea946b9a73391ccff9349b0b53ab8d609e3174ee139824282381abaf2
  déjà vu 'quoted' "double".mov  21B  9489b0f8b769286b8a07f34de8f02987784d6492f94c971d2f6f267af58c0f46

=== 2. placement ===
  device=auto -> yosemite-m6 (load yosemite-m2:51%, yosemite-m5:2%, yosemite-m1:28%, yosemite-m6:36%)
  execution target: (this machine)

=== 3. local run (no network transfer) ===
  staged at $HOME/.agents/.cache/hosts/f0a3ec88.attachments (remote=false)
report.pdf d511eb49ebacdd4acfc156f7337e9c28a15accabf54ce5c35c1622942e6cfdcd
report.pdf 0d941ebea946b9a73391ccff9349b0b53ab8d609e3174ee139824282381abaf2
déjà vu 'quoted' "double".mov 9489b0f8b769286b8a07f34de8f02987784d6492f94c971d2f6f267af58c0f46

=== expected sha256 ===
  report.pdf d511eb49ebacdd4acfc156f7337e9c28a15accabf54ce5c35c1622942e6cfdcd
  report.pdf 0d941ebea946b9a73391ccff9349b0b53ab8d609e3174ee139824282381abaf2
  déjà vu 'quoted' "double".mov 9489b0f8b769286b8a07f34de8f02987784d6492f94c971d2f6f267af58c0f46
```
