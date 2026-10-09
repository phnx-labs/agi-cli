- **AGI Menu floor 1.15.9: Home shows the latest artifacts and who made them (PHNX-4269).**
  Installed CLIs now pull AGI Menu 1.15.9. Under Needs you, Home lists what agents on this
  Mac made in the last day, one line per session: the page's title, its kind and age, the
  agent, its status, the session's title and where its terminal is. It reads each live feed
  row's `artifacts`. Source: `cli/src/lib/helper-versions.ts`.
