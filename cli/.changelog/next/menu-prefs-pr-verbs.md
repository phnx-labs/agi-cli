- **Act on a pull request from the CLI: ready, approve, comment (PHNX-4215).**
  `agents projects prs ready|review --approve|comment <project> --repo R --number N`
  join `prs merge`, each with a `--json` result AGI Menu reads. `review` reads the live
  head, refuses one that moved since `--sha`, and records the approval against that
  SHA; `comment` takes `--body` or `--body-file -`. Approve and comment are single REST
  calls; ready is one GraphQL mutation because GitHub has no REST way to leave draft.
  Source: `cli/src/lib/github/project-prs.ts`.
- **AGI Menu preferences for pins, tabs, and milestone grouping (PHNX-3999).**
  `menubar.menu.pinnedProjects`, `menubar.menu.tabOrder`, `menubar.menu.hiddenTabs`,
  and `menubar.menu.groupTicketsByMilestone` sync fleet-wide and ride
  `agents menubar snapshot --json` `menuPreferences`. List keys take a JSON array or
  comma-separated items and are validated when written. Source:
  `cli/src/lib/device-config.ts`.
