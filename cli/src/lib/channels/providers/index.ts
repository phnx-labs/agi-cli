/** Provider barrel: importing it registers every built-in channel provider, same as app providers. */
import { registerChannelProvider } from '../registry.js';
import { mailboxProvider } from './mailbox.js';
import { rushProviders } from './rush.js';
import { openclawTelegramProvider } from './openclaw-telegram.js';
import { desktopProvider } from './desktop.js';

let registered = false;

/** Register all built-in providers once (idempotent). */
export function registerBuiltinProviders(): void {
  if (registered) return;
  registered = true;
  registerChannelProvider(mailboxProvider);
  for (const p of rushProviders) registerChannelProvider(p);
  registerChannelProvider(openclawTelegramProvider);
  registerChannelProvider(desktopProvider);
}
