- **`agents setup browser` installs browser-cli 0.1.15, up from 0.1.5.** 0.1.15's
  `browser profiles logins` reads Arc, Comet and pinned profiles from their real
  stores and has a `--json` mode, which the fleet credentials-catalog hook uses to
  tell agents which profile is signed in where. The pin only applies to a fresh
  install; an existing `browser` is left alone. Source: `cli/src/lib/setup-tool-install.ts`.
