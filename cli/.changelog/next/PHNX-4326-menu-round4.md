- **`agents projects prs <project> --json` carries `mergeable` and `mergeableState` (PHNX-4326).**
  Every open row had both null, because the REST list GitHub returns never computes them.
  They now come from one GraphQL read of the open PRs per repository (cached 60 seconds),
  with the same values the cross-org read and `--number` report (`false` / `"dirty"` on a
  conflict). A failed read leaves them null and names the failure in `ciError`. Source:
  `src/lib/github/project-prs.ts`.
- **`agents config set menubar.menu.artifactApps` (PHNX-4326).** A list of `kind=bundle-id`
  entries, default `[]`, naming the app AGI Menu opens each kind of artifact with. It rides
  `snapshot.menuListPreferences`. Source: `src/lib/device-config.ts`, `src/lib/config-keys.ts`.
- **The Projects tab is retired from `menubar.menu.tabOrder` (PHNX-4326).** `projects` is no
  longer in the default order or required in a stored one; an order or `hiddenTabs` list that
  still names it is accepted and kept in place, so older menus keep working. Source:
  `src/lib/device-config.ts`.
