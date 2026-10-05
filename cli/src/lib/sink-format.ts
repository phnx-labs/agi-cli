export type SinkMessageFormat = 'plain' | 'mrkdwn';

export function sinkMessageFormat(provider: string | undefined): SinkMessageFormat {
  return provider?.trim().toLowerCase() === 'slack' ? 'mrkdwn' : 'plain';
}
