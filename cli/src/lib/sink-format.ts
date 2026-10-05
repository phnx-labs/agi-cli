/**
 * How loudly a destination can render a link — the one decision that shapes the
 * shared owner/broadcast `{message}` per channel (PHNX-3698).
 *
 *   - `mrkdwn` — Slack, which renders `<url|label>` as blue tappable text. The
 *     session crumb and every ticket key the prose NAMES become inline labeled
 *     links, so nothing rides a trailing naked-URL line.
 *   - `plain` — iMessage, the owner-scoped rush message, a spawned `command:`
 *     sink, desktop banners: none can render a labeled link and a dumped naked
 *     URL reads as noise, so the message stays the human sentence with no URLs.
 *
 * The default is `plain`; only Slack opts into `mrkdwn`.
 *
 * This lives in its own tiny module because both the feed broadcast fan-out
 * (`feed-broadcast.ts`) and the owner delivery fan-out (`notify.ts`) key on it,
 * and those two modules already import each other — a shared symbol here keeps
 * the format decision a single source of truth without a circular import.
 */
export type SinkMessageFormat = 'plain' | 'mrkdwn';

/**
 * Only Slack renders `<url|label>`, so it is the one format that gets labeled
 * links. iMessage / owner-scoped rush / command / desktop sinks stay `plain`
 * (they can't turn `claude/6fc1db18` blue, and dumping the raw URL is worse than
 * leaving the crumb unlinked — PHNX-3698).
 *
 * The argument is the **resolved provider name**, not a sink's declared channel:
 * an operator can point an arbitrary channel name at the Slack provider through
 * `notify.transports` (e.g. `eng-alerts -> slack`), and delivery keys off that
 * resolved provider (`lookupTransport`), so the format decision must too —
 * otherwise an aliased Slack sink would compose plain while delivering to Slack,
 * or a name remapped AWAY from Slack would emit `<url|label>` markup a non-Slack
 * transport shows literally.
 */
export function sinkMessageFormat(provider: string | undefined): SinkMessageFormat {
  return provider?.trim().toLowerCase() === 'slack' ? 'mrkdwn' : 'plain';
}
