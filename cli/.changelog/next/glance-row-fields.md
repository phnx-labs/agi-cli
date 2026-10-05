- **Session rows carry the facts the sidebar needs to read an agent at a glance (PHNX-4218).**
  A watch row now includes the latest reply's `model`, the newest 20 failed or
  policy-blocked calls, a 48-bucket activity histogram, the user's own turns, and
  this session's subagents (task, type, tools, result). `subAgentCount` counts
  this session's own subagent transcripts when it has any; an empty `subagents/`
  directory no longer reports zero over the tool-call count. Pasted images are
  written once under `~/.agents/.cache/attachments/<session>/` so the editor can
  show them, including a paste larger than one timeline read. That record resumes
  from the next tick instead of freezing the row, and its image bytes are not
  stored in the timeline cache. An unfinished record that still fits in one
  read is left until its newline arrives, so a long turn that is still flushing
  is not dropped. Plans rendered by the artifacts CLI join the row by session id.
  The projection comes from `@phnx-labs/sessions-cli@0.5.0` and is folded once
  in the daemon timeline pass. Older extensions ignore the new fields.
  Source: `cli/src/lib/session/glance-files.ts`, `cli/src/lib/session/timeline-pass.ts`,
  `cli/src/lib/session/active.ts`, `cli/package.json`.
