/**
 * The feed stream's envelope contract and its sequencer.
 *
 * Extracted from `watch.ts` so the three modules that all speak this protocol —
 * the producer (`watch.ts`), the shared collector (`hub.ts`), and the socket
 * boundary (`hub-server.ts`) — can depend on the contract without depending on
 * each other. `watch.ts` needs `FeedHub` to share its local collector and
 * `hub.ts` needs the sequencer, so leaving both here is what keeps that from
 * being an import cycle.
 *
 * `watch.ts` re-exports everything in this file, so every existing importer is
 * unaffected.
 */
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
    /** This device's tool-setup rows; see `setup.snapshot` for why it is a set. */
    setup: ToolSetupRow[];
  }
  | Base & { type: 'agent.upsert'; rowKey: string; agent: SessionWatchRow }
  | Base & { type: 'agent.remove'; rowKey: string }
  | Base & { type: 'attention.upsert'; rowKey: string; attention: AttentionItem }
  | Base & { type: 'attention.remove'; rowKey: string }
  | Base & { type: 'activity.append'; event: ActivityEvent }
  /** A browser task or computer run, projected by `feed/tools.ts`. */
  | Base & { type: 'tool.upsert'; rowKey: string; tool: ToolRow }
  | Base & { type: 'tool.remove'; rowKey: string }
  /**
   * The whole tool-setup set for one device, replaced at once.
   *
   * Deliberately a SNAPSHOT and not per-row upserts: `getCachedToolSetup` always
   * answers for every tool in `SETUP_TOOLS`, so "browser is ready" and "computer
   * needs setup" are one coherent reading of the box taken at one moment. Sending
   * three independent upserts would let a consumer render a mix of two different
   * readings, and there is no row to *remove* — a tool that is not installed is a
   * row saying so, which is exactly what a Setup pane must show.
   */
  | Base & { type: 'setup.snapshot'; capturedAt: number; setup: ToolSetupRow[] }
  | Base & { type: 'scope'; capturedAt: number; status: SessionWatchScopeStatus; reason?: string }
  | Base & { type: 'heartbeat'; capturedAt: number };

export type FeedWatchPayload = FeedWatchEnvelope extends infer Envelope
  ? Envelope extends FeedWatchEnvelope ? Omit<Envelope, 'v' | 'streamId' | 'sequence'> : never
  : never;

/** Per-subscriber stream identity and monotonic sequence. */
export class FeedWatchState {
  readonly streamId: string;
  private sequence = 0;
  constructor(streamId = randomUUID()) { this.streamId = streamId; }
  emit(event: FeedWatchPayload): FeedWatchEnvelope {
    return { v: 1, streamId: this.streamId, sequence: ++this.sequence, ...event } as unknown as FeedWatchEnvelope;
  }
}
