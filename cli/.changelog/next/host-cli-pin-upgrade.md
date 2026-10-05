- **Installed host CLIs now follow their version pin.** The daemon's update tick
  upgrades `browser`, `secrets`, `computer` and any other host CLI whose manifest
  pins an npm version (`npm: "@phnx-labs/secrets-cli@0.1.8"`) when the installed
  binary reports an older version. Before, the pin only applied to a first install,
  so a box kept whatever version it started with. The upgrade targets the npm
  prefix that owns the binary on PATH, is confirmed by re-running `--version`,
  never installs a missing tool or downgrades one, ignores project-layer
  manifests, and leaves the old version in place if the install fails. Source: `cli/src/lib/cli-resources.ts`
  (`upgradeOutdatedClis`), `cli/src/lib/daemon/self-update-service.ts`.
