- **`agents projects prs <project> --json` carries `mergeable` and `mergeableState` (PHNX-4326).**
  Every open row had both null, because GitHub's REST PR list never computes them. Each open
  PR the read lists is now read with REST `pulls/{n}` (cached 60 seconds, at most eight at a
  time), the same read and values as the cross-org form and `--number` (`false` / `"dirty"` on
  a conflict). A PR whose read fails keeps both null and the failure is named in `ciError`.
  Source: `src/lib/github/project-prs.ts`.
- **The Projects tab is retired from `menubar.menu.tabOrder` (PHNX-4326).** `projects` is no
  longer in the default order or required in a stored one; an order or `hiddenTabs` list that
  still names it is accepted and kept in place, so older menus keep working. Source:
  `src/lib/device-config.ts`.
