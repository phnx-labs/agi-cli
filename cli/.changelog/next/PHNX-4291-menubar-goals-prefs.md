- **AGI Menu gains a Goals tab and two goal preferences (PHNX-4291).** `goals` joins
  the tab ids, and the default tab bar becomes home, goals, projects, sessions, inbox.
  A `menubar.menu.tabOrder` saved before Goals existed still validates and reads back
  with `goals` appended, the same way the menu resolves an order that leaves a tab out.
  `menubar.menu.homeGoals` picks the goal levels Home shows (any of `company`, `week`,
  `myWeek`, `myDay`, no duplicates; default `["company"]`) and rides the snapshot's
  `menuListPreferences`. `menubar.statusbar.goalCountdown` (default `false`) turns on
  the goal countdown beside the menu-bar icon and rides `menuPreferences`. All three
  work with `agents config set/get/list/unset`. Source: `cli/src/lib/device-config.ts`,
  `cli/src/lib/config-keys.ts`, `cli/src/lib/menubar/snapshot.ts`.
