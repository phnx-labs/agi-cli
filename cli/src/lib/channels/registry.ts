import type { InjectOptions, InjectResult } from '../terminal/index.js';

export type TerminalSendOptions = Pick<InjectOptions, 'enter' | 'combined'> & {
  pane?: string;
  socket?: string;
};

export interface SendOptions {
  target: string;
  thread?: string;
  attachments?: string[];
  from?: string;
  ownerScoped?: boolean;
  dryRun?: boolean;
  terminal?: TerminalSendOptions;
}

export interface SendResult {
  ok: boolean;
  channel: string;
  id: string;
  error?: string;
  attachments?: string[];
  msgId?: string;
  body?: string;
  deliveries?: SendResult[];
  backend?: InjectResult['backend'];
  writes?: number;
  confirmed?: boolean;
}

export interface ChannelProvider {
  name: string;
  send(text: string, opts: SendOptions): Promise<SendResult>;
}

const REGISTRY = new Map<string, ChannelProvider>();

export function registerChannelProvider(p: ChannelProvider): void {
  REGISTRY.set(p.name, p);
}

export function resolveChannelProvider(name: string): ChannelProvider | undefined {
  return REGISTRY.get(name);
}

export function listChannelProviders(): string[] {
  return [...REGISTRY.keys()].sort();
}
