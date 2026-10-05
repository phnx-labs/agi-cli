import { registerChannelProvider } from '../registry.js';
import { mailboxProvider } from './mailbox.js';
import { rushProviders } from './rush.js';
import { openclawTelegramProvider } from './openclaw-telegram.js';
import { desktopProvider } from './desktop.js';
import { sessionProvider } from './session.js';

let registered = false;

export function registerBuiltinProviders(): void {
  if (registered) return;
  registered = true;
  registerChannelProvider(mailboxProvider);
  for (const p of rushProviders) registerChannelProvider(p);
  registerChannelProvider(openclawTelegramProvider);
  registerChannelProvider(desktopProvider);
  registerChannelProvider(sessionProvider);
}
