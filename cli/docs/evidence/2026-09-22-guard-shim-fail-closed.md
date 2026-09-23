# Guard shim fail-closed: run evidence

Generated shims from the patched agents-cli template (worktree `guard-fail-closed` @ `4eb20213b`), run under real `bash` on zion on 2026-09-22 21:14 UTC with the source script deleted.

## Fail-closed shim (PreToolUse), real Edit payload against the primary checkout

```
$ printf '{"tool_name":"Edit","tool_input":{"file_path":"/Users/muqsit/src/github.com/muqsitnawaz/agents/README.md"},"cwd":"/Users/muqsit/src/github.com/muqsitnawaz/agents","session_id":"evidence"}' \
    | bash /tmp/guard-shim-run.0UJA/shims/main-branch-guard.sh
main-branch-guard: hook source is missing (/tmp/guard-shim-run.0UJA/gone/main-branch-guard.sh); refusing the tool call unchecked (fail-closed). Run: agents hooks sync
exit=2
```

## Fail-open shim (non-PreToolUse class), same missing source: unchanged behaviour

```
$ printf '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | bash /tmp/guard-shim-run.0UJA/shims/visual-readback-nudge.sh
/tmp/guard-shim-run.0UJA/shims/visual-readback-nudge.sh: line 250: /tmp/guard-shim-run.0UJA/gone/nudge.sh: No such file or directory
exit=127
```

## Events log written by the two shims

```
{"ts":"2026-09-22T21:14:47Z","event":"hook.fire","hook":"main-branch-guard","ms":0,"cache":"missing-source","exit":2}
{"ts":"2026-09-22T21:14:47Z","event":"hook.fire","hook":"visual-readback-nudge","ms":17,"cache":"none","exit":127}
```

## The same failure class on the live fleet before the fix

Events logs, `hook=main-branch-guard`, `exit=127` (every one of these fires allowed the tool call):

| device | fires |
| --- | --- |
| zion | 3,836; continuous from 2026-09-14 22:00 to 2026-09-15 14:56 |
| yosemite-m6 | 375 on 2026-09-14 |
| yosemite-s0 | 108 on 2026-09-13 (rule-bundled shim) |

## Tests

```
$ vitest run src/lib/hooks/cache.test.ts src/lib/hooks/cache-matches.test.ts src/lib/plugins/skills.test.ts
 Test Files  3 passed (3)      Tests  91 passed (91)
$ vitest run src/lib/installations/versions.test.ts -t "plugin"
 Test Files  1 passed (1)      Tests  6 passed | 68 skipped (74)
$ cli/scripts/test.sh --shard 3
  shard 1/3 passed on yosemite-m5
  shard 2/3 passed on yosemite-m2
  shard 3/3 passed on yosemite-m3
All 3 shards passed.
$ npx tsc --noEmit -p cli
0 errors
```
