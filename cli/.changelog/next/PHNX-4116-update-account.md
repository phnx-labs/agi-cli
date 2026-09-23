- **`agents update claude#work` works, and a refused update names the process holding the installation (PHNX-4116).**
  The `<agent>#<account>` selector `agents run` already takes was rejected by `update` as
  "Unknown agent 'claude#work'"; it now resolves to the managed installation that account runs on
  and refuses only an account the registry does not know. "Account home is in use; retry after its
  sessions finish" is replaced by the actual holder, e.g. `pid 2173999, up 01:10:22, pts/1:
  …/claude --resume 3ef30267…`, with `agents sessions stop <id>` as the way out. Source:
  `cli/src/commands/update.ts`, `cli/src/lib/installations/active-check.ts`.
