import { extractLinearTicketId } from './utils';

export interface SessionTabLabelState {
  manualLabel?: string;
  autoLabel?: string;
}

export interface LiveSessionLabelSource {
  label: string;
  topic: string;
}

export interface SessionTabLabelUpdate {
  label: string;
  clearManualLabel: boolean;
}

export interface PersistedSessionTabLabels {
  label?: string;
  autoLabel?: string;
}

/** Slash-command/scaffolding turns are transport, not a useful task title. */
export function isScaffoldingSessionTopic(text: string): boolean {
  const value = text.trim();
  return /^Base directory for this skill:/i.test(value)
    || /^<command-(?:name|message)>/i.test(value)
    || /^\/[a-z][\w:-]*(?:\s|$)/i.test(value);
}

/**
 * Reconcile one editor tab with the canonical name carried by the CLI stream.
 * Manual labels win. The sole migration exception is a label that is plainly a
 * first-turn placeholder: older extension versions re-adopted that generated
 * tab title as a manual label during window reload.
 */
export function planSessionTabLabelUpdate(
  tab: SessionTabLabelState,
  live: LiveSessionLabelSource,
): SessionTabLabelUpdate | undefined {
  const sessionLabel = live.label.trim();
  if (!sessionLabel) return undefined;

  const manualLabel = tab.manualLabel?.trim() || '';
  const topic = live.topic.trim();
  const ticket = extractLinearTicketId(topic);
  const label = ticket && !sessionLabel.startsWith(ticket)
    ? `${ticket} ${sessionLabel}`
    : sessionLabel;
  const staleManualLabel = !!manualLabel
    && (manualLabel === topic || isScaffoldingSessionTopic(manualLabel));
  if (manualLabel && !staleManualLabel) return undefined;

  const current = manualLabel || tab.autoLabel?.trim() || '';
  if (current === label) return undefined;
  return { label, clearManualLabel: staleManualLabel };
}

/** Keep automatic-label provenance when VS Code recreates a terminal widget. */
export function restoredSessionTabLabels(
  visibleLabel: string | undefined,
  persisted: PersistedSessionTabLabels | undefined,
): SessionTabLabelState {
  const autoLabel = persisted?.autoLabel?.trim() || undefined;
  const persistedManualLabel = persisted?.label?.trim() || undefined;
  const visibleManualLabel = visibleLabel?.trim();
  const manualLabel = persistedManualLabel
    || (visibleManualLabel && visibleManualLabel !== autoLabel ? visibleManualLabel : undefined);
  return { manualLabel, autoLabel };
}
