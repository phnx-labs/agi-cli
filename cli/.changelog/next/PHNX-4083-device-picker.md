- **Device picker module for `agents run <agent>@` (PHNX-4083).** New
  `run-device-picker` command module builds the fleet device menu entirely from
  on-disk state — the device registry, the cached fleet stats, configured roles
  and descriptions, and the fleet-synced account catalog — with zero SSH, zero
  network, and no re-probing of stale rows. Source: `src/commands/run-device-picker.ts`.
