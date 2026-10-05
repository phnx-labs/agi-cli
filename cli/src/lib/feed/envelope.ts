import { randomUUID } from 'node:crypto';
import type { SessionWatchRow, SessionWatchScopeStatus } from '../session/watch.js';
import type { ToolSetupRow } from '../setup-tool-status.js';
import type { AttentionItem } from './attention.js';
import type { ActivityEvent } from './activity.js';
import type { ToolRow } from './tools.js';

type Base = { v: 1; type: string; streamId: string; sequence: number; scope: string };

export type FeedWatchEnvelope =
  | Base & {
    type: 'reset'; capturedAt: number;
    agents: SessionWatchRow[]; attention: AttentionItem[]; tools: ToolRow[];
    setup: ToolSetupRow[];
  }
  | Base & { type: 'agent.upsert'; rowKey: string; agent: SessionWatchRow }
  | Base & { type: 'agent.remove'; rowKey: string }
  | Base & { type: 'attention.upsert'; rowKey: string; attention: AttentionItem }
  | Base & { type: 'attention.remove'; rowKey: string }
  | Base & { type: 'activity.append'; event: ActivityEvent }
  | Base & { type: 'tool.upsert'; rowKey: string; tool: ToolRow }
  | Base & { type: 'tool.remove'; rowKey: string }
  | Base & { type: 'setup.snapshot'; capturedAt: number; setup: ToolSetupRow[] }
  | Base & { type: 'scope'; capturedAt: number; status: SessionWatchScopeStatus; reason?: string }
  | Base & { type: 'heartbeat'; capturedAt: number };

export type FeedWatchPayload = FeedWatchEnvelope extends infer Envelope
  ? Envelope extends FeedWatchEnvelope ? Omit<Envelope, 'v' | 'streamId' | 'sequence'> : never
  : never;

export class FeedWatchState {
  readonly streamId: string;
  private sequence = 0;
  constructor(streamId = randomUUID()) { this.streamId = streamId; }
  emit(event: FeedWatchPayload): FeedWatchEnvelope {
    return { v: 1, streamId: this.streamId, sequence: ++this.sequence, ...event } as unknown as FeedWatchEnvelope;
  }
}
