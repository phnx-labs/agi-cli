/**
 * Provider barrel — importing this registers every built-in channel provider.
 * "App" providers register themselves the same way (registerChannelProvider),
 * so nothing here is privileged over an extension.
 */
import { registerChannelProvider } from '../registry.js';
import { mailboxProvider } from './mailbox.js';
import { rushProviders } from './rush.js';
import { openclawTelegramProvider } from './openclaw-telegram.js';
import { desktopProvider } from './desktop.js';
import { sessionProvider } from './session.js';

let registered = false;

/** Register all built-in providers once (idempotent). */
export function registerBuiltinProviders(): void {
  if (registered) return;
  registered = true;
  registerChannelProvider(mailboxProvider);
  for (const p of rushProviders) registerChannelProvider(p);
  registerChannelProvider(openclawTelegramProvider);
  registerChannelProvider(desktopProvider);
  registerChannelProvider(sessionProvider);
}
