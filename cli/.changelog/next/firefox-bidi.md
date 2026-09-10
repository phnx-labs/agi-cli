- **Firefox automation over WebDriver BiDi (PHNX-4043).** `agents browser` now drives
  Firefox, which dropped the Chrome DevTools Protocol in 129. Every Firefox profile in
  `profiles.ini` is discovered read-only as a `firefox-<name>` browser profile
  (`firefox-default`, `firefox-default-release`, …) pinned to that profile directory;
  agents launch it headless with a debug port (or attach to a running one, failing loud
  when a portless Firefox already holds the profile). Supported verbs: start, navigate,
  tab add, tabs, evaluate, refs, click, fill/type, scroll, screenshot, done — with the
  same same-task reopen semantics as the rest of the service. A trusted pointer click
  goes through `input.performActions`. Network capture, upload, and PDF fail loud with a
  structured error naming a Chromium-family profile. Source: `apps/cli/src/lib/browser/drivers/firefox.ts`,
  `apps/cli/src/lib/browser/firefox-discovery.ts`, `apps/cli/src/lib/browser/service.ts`.
