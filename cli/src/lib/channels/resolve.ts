import type { Meta } from '../types.js';
import { die } from '../format.js';
import { resolveChannelProvider, listChannelProviders, type ChannelProvider } from './registry.js';

interface TransportLookup {
  providerName: string;
  provider?: ChannelProvider;
  error?: string;
}

export function lookupTransport(channel: string, meta: Meta): TransportLookup {

  const providerName = meta.notify?.transports?.[channel] ?? channel;
  const provider = resolveChannelProvider(providerName);
  if (provider) return { providerName, provider };
  return {
    providerName,
    error:
      `No channel provider '${providerName}'` +
      (providerName === channel ? '' : ` (mapped from channel '${channel}' via notify.transports)`) +
      `. Registered: ${listChannelProviders().join(', ')}.`,
  };
}

export function resolveTransport(channel: string, meta: Meta): ChannelProvider {
  const { provider, error } = lookupTransport(channel, meta);
  if (!provider) die(error!);
  return provider;
}
