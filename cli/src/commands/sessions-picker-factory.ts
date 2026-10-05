import { itemPicker } from '../lib/picker.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';

interface SessionsPickerGateOpts {
  interactive?: boolean;
  json?: boolean;
  open?: string | boolean;
}

interface SessionsPickerCommandSpec<TRow, TOpts extends SessionsPickerGateOpts> {
  requireOpenUndefined?: boolean;
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
