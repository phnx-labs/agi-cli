- **`agents run --local`, and `--device <this machine>` no longer SSHes to itself.** A bare
  interactive run places itself like `--device auto` (PHNX-4083), and the documented way to
  stay put was `--device <this machine>` — which took the remote path and probed its own
  login shell over SSH, timing out on a loaded box. `--local` is the explicit local pin
  (the same door as `--where local`, which previously expanded to nothing and was then
  overridden by the default placement); any host flag naming this machine by short id,
  MagicDNS name, loopback, or the `interactive` sentinel now resolves to the same local
  run. The placement-failure hint names `--local`. Source: `cli/src/commands/exec.ts`
  (`pinLocalWhenTargetIsSelf`), `cli/src/lib/placement.ts`, `cli/src/lib/hosts/remote-cmd.ts`.
