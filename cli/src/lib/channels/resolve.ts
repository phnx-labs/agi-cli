/** Map a channel name to its provider via `notify.transports`; default is name-identity, not a
 * fallback. Only telegram is dual-homed. `lookupTransport` returns the failure (for daemons);
 * `resolveTransport` die()s (for interactive `agents send`). Never give a daemon the dying one. */
import type { Meta } from '../types.js';
import { die } from '../format.js';
import { resolveChannelProvider, listChannelProviders, type ChannelProvider } from './registry.js';

interface TransportLookup {
  /** Provider name after applying the `notify.transports` mapping. */
  providerName: string;
  /** Registered provider, or undefined when `providerName` resolves to nothing. */
  provider?: ChannelProvider;
  /** Why resolution failed — set exactly when `provider` is undefined. */
  error?: string;
}

/** Resolve a channel to its provider, returning the failure instead of exiting. */
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

/** Interactive-command resolution: an unregistered provider dies loud. */
export function resolveTransport(channel: string, meta: Meta): ChannelProvider {
  const { provider, error } = lookupTransport(channel, meta);
  if (!provider) die(error!);
  return provider;
}
