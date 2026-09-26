- **Fleet probes follow the configured `platform`, not the discovered one.** A box Tailscale
  reports as Windows but whose sshd lands in WSL, configured `agents devices config <name>
  platform linux`, was dialed as a bash login shell yet handed the PowerShell snippet — so
  `agents devices list --refresh` showed it offline, `agents sessions --active` skipped it as
  "unreachable or no agents CLI", and `agents sessions watch` / `agents feed watch` /
  `agents apply` / `agents doctor --check` never reached it, even though `agents ssh <name>`
  worked. Each of those paths now resolves the operator profile before choosing the remote shell,
  the same profile the dial already used. Source: `cli/src/lib/devices/health.ts` (`buildProbeInvocation`),
  `cli/src/lib/session/remote/{remote-list,watch}.ts`, `cli/src/lib/feed/watch.ts`,
  `cli/src/lib/fleet/apply.ts`, `cli/src/lib/teams/placement-probe.ts`,
  `cli/src/lib/accounting/usage-sync.ts`, `cli/src/lib/remote-agents-json.ts`,
  `cli/src/commands/doctor.ts`.
