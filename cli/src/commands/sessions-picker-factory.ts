/**
 * Shared interactive-routing + browse loop for the task-first session
 * pickers (`browser-sessions-picker.ts`, `computer-sessions-picker.ts`).
 *
 * Each twin keeps its own row formatter, matcher, and enter-handler; this
 * factory owns the TTY/`--json`/`--no-interactive` (and optional `--open`)
 * gate, the empty-list message, and the cancel-aware `itemPicker` loop.
 */
import { itemPicker } from '../lib/picker.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';

/** Flag subset both twins share for the interactive-routing gate. */
interface SessionsPickerGateOpts {
  interactive?: boolean;
  json?: boolean;
  /** Present only on the browser twin; computer never sets it. */
  open?: string | boolean;
}

interface SessionsPickerCommandSpec<TRow, TOpts extends SessionsPickerGateOpts> {
  /**
   * Browser requires `opts.open === undefined` so `--open` (bare or with a
   * selector) falls through to the flat printer. Computer has no `--open`.
   */
  requireOpenUndefined?: boolean;
  /** May be async — the browser spec's flat path awaits an artifact open. */
  runFlat: (opts: TOpts) => void | Promise<void>;
  buildRows: (opts: TOpts) => TRow[];
  emptyMessage: (opts: TOpts) => string;
  message: string;
  matches: (row: TRow, query: string) => boolean;
  labelFor: (row: TRow) => string;
  buildPreview: (row: TRow) => string;
  emptyFilterMessage: string;
  enterHint: string;
  onOpen: (row: TRow) => void | Promise<void>;
}

interface SessionsPickerCommand<TOpts extends SessionsPickerGateOpts> {
  shouldOpen: (opts: TOpts, isTTY: boolean) => boolean;
  run: (opts: TOpts) => Promise<void>;
}

function shouldOpenInteractiveSessions(
  opts: SessionsPickerGateOpts,
  isTTY: boolean,
  requireOpenUndefined = false,
): boolean {
  return (
    opts.interactive !== false &&
    !opts.json &&
    (!requireOpenUndefined || opts.open === undefined) &&
    isTTY
  );
}

async function browseSessionsUntilQuit<TRow>(spec: {
  message: string;
  rows: TRow[];
  matches: (row: TRow, query: string) => boolean;
  labelFor: (row: TRow) => string;
  buildPreview: (row: TRow) => string;
  emptyFilterMessage: string;
  enterHint: string;
  onOpen: (row: TRow) => void | Promise<void>;
}): Promise<void> {
  for (;;) {
    let picked;
    try {
      picked = await itemPicker<TRow>({
        message: spec.message,
        items: spec.rows,
        filter: (query) => (query.trim() ? spec.rows.filter((r) => spec.matches(r, query)) : spec.rows),
        labelFor: spec.labelFor,
        buildPreview: spec.buildPreview,
        emptyMessage: spec.emptyFilterMessage,
        enterHint: spec.enterHint,
      });
    } catch (err) {
      if (isPromptCancelled(err)) return;
      throw err;
    }
    if (!picked) return;
    await spec.onOpen(picked.item);
  }
}

export function createSessionsPickerCommand<TRow, TOpts extends SessionsPickerGateOpts>(
  spec: SessionsPickerCommandSpec<TRow, TOpts>,
): SessionsPickerCommand<TOpts> {
  const shouldOpen = (opts: TOpts, isTTY: boolean): boolean =>
    shouldOpenInteractiveSessions(opts, isTTY, spec.requireOpenUndefined === true);

  return {
    shouldOpen,
    run: async (opts) => {
      if (!shouldOpen(opts, isInteractiveTerminal())) {
        await spec.runFlat(opts);
        return;
      }
      const rows = spec.buildRows(opts);
      if (rows.length === 0) {
        console.log(spec.emptyMessage(opts));
        return;
      }
      await browseSessionsUntilQuit({
        message: spec.message,
        rows,
        matches: spec.matches,
        labelFor: spec.labelFor,
        buildPreview: spec.buildPreview,
        emptyFilterMessage: spec.emptyFilterMessage,
        enterHint: spec.enterHint,
        onOpen: spec.onOpen,
      });
    },
  };
}
