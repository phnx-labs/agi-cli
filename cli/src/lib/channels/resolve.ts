/**
 * Transport resolution: map a user-facing channel name to the provider that
 * actually delivers it, using `notify.transports` from agents.yaml.
 *
 * Default is name-identity (`--channel slack` -> `slack` provider) — NOT a
 * fallback to a different transport. Only telegram is dual-homed (rush vs
 * openclaw-telegram); config picks.
 *
 * Two entry points, deliberately: `lookupTransport` *returns* the failure, for
 * long-lived callers (the monitor daemon, the feed-dispatch loop) that must
 * survive a bad channel name; `resolveTransport` `die()`s on it, for the
 * interactive `agents send` command path where exiting with a
 * loud message is the right answer. Never give a daemon the dying one.
 */
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
