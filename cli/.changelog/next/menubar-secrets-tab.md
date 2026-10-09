- **`menubar.menu.tabOrder` and `menubar.menu.hiddenTabs` know AGI Menu's Secrets tab (PHNX-4269).**
  AGI Menu 1.15.13 adds a Secrets tab that lists this Mac's secrets bundles with their lock
  state and unlocks or locks them with Touch ID. The menu only offers the tab once the CLI
  accepts its id, so `secrets` joins the tab list. It starts hidden (`hiddenTabs` defaults to
  `secrets`), and an order saved before it existed reads back with `secrets` appended.
  Source: `cli/src/lib/device-config.ts`.
