/** How a destination renders links, the one decision shaping the shared `{message}` per channel
 * (PHNX-3698). `mrkdwn` (Slack): crumbs and ticket keys become inline labeled links. `plain`
 * (iMessage, rush, `command:` sinks, desktop): no URLs. Default `plain`. */
export type SinkMessageFormat = 'plain' | 'mrkdwn';

/** Only Slack renders `<url|label>`, so only it gets labeled links; other sinks stay `plain`
 * (PHNX-3698). Key off the RESOLVED provider (`notify.transports` aliases), not the channel name. */
export function sinkMessageFormat(provider: string | undefined): SinkMessageFormat {
  return provider?.trim().toLowerCase() === 'slack' ? 'mrkdwn' : 'plain';
}
