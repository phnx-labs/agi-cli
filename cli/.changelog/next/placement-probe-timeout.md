- **`--device auto` no longer refuses every worker when the load probe times out.** The
  2.5 s load/memory probe could time out on every worker at once during a brief stall on
  the launching machine, and placement then failed with `no healthy device ... (probe
  timed out)` even though each worker had just answered the sign-in probe. A worker that
  answers the sign-in probe now counts as reachable; only its load is reported as
  unknown. Source: `cli/src/lib/teams/placement-probe.ts`.
