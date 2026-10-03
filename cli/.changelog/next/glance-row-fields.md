- **Session rows now carry what an editor sidebar needs to read an agent at a glance
  (PHNX-4218 follow-up).** `agents sessions --active --json` and `agents feed watch --json`
  rows add `model` (the latest reply's model id), `failures` (the newest 20 failed or
  policy-blocked tool calls with time, command and error), `activityHistogram` (48 fixed
  buckets of tool, failure and block counts across the session, plus your message times),
  `userTurns` (your genuine messages), and `subagents` (each Claude subagent's type, task,
  status, duration, tool count, last result and transcript path). `subAgentCount` now
  counts only this session's own subagent transcripts. Pasted images are written once to
  `~/.agents/.cache/attachments/<session>/` so `attachments[].path` is loadable, and a plan
  or report rendered by the `artifacts` CLI is listed in `artifacts[]` with its title,
  joined by session id from its `.artifact.json`. The existing `activity` status field is
  unchanged. Source: `cli/src/lib/session/glance.ts`, `glance-files.ts`, `state.ts`,
  `timeline-pass.ts`, `highlights.ts`.
