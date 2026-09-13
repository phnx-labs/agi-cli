/**
 * Interactive fuzzy-filter picker built on @inquirer/core.
 *
 * Provides a searchable, paginated list UI with optional preview pane
 * for selecting items in the terminal. Used by session picker, command
 * picker, and other interactive selection flows.
 */

/**
 * Custom inquirer prompt for searchable, scrollable selection lists.
 *
 * Extends @inquirer/core to support type-ahead filtering, column-aligned
 * display, and keyboard navigation. Used by sessions, teams, and other
 * interactive pickers throughout the CLI.
 */

import {
  createPrompt,
  useState,
  useKeypress,
  useEffect,
  useMemo,
  useRef,
  usePagination,
  usePrefix,
  makeTheme,
  isEnterKey,
  isUpKey,
  isDownKey,
  isSpaceKey,
  isBackspaceKey,
  Separator,
} from '@inquirer/core';
import chalk from 'chalk';
import { stripVTControlCharacters } from 'node:util';

/** Configuration for the interactive picker prompt. */
interface PickerConfig<T> {
  message: string;
  /** Optional dim hint line rendered directly under the header (above the rows). */
  subtitle?: string;
  /**
   * The row pool. A {@link Separator} entry renders as a non-selectable divider
   * (used for group headers) — navigation skips it and it is never returned.
   */
  items: Array<T | Separator>;
  filter: (query: string) => Array<T | Separator>;
  labelFor: (item: T, query: string) => string;
  buildPreview?: (item: T) => string;
  /**
   * Called once with a repaint trigger for the open prompt. An async preview
   * source (e.g. a remote row's digest arriving over SSH) invokes the trigger
   * when data `buildPreview` reported as pending is now ready, so the pane
   * refreshes without a keypress. The trigger is inert after the prompt closes.
   */
  registerPreviewRepaint?: (repaint: () => void) => void;
  shortIdFor?: (item: T) => string;
  /**
   * Prefix each selectable row with its 1-based position in the current
   * filtered list (`  1.`, ` 12.`), right-aligned so the labels stay columnar
   * and a user scanning a long list can tell where they are. Separators are
   * never numbered.
   */
  numbered?: boolean;
  pageSize?: number;
  initialSearch?: string;
  emptyMessage?: string;
  enterHint?: string;
  /**
   * Lines the caller already printed above the Inquirer prompt (e.g. the
   * hidden-session footer). Subtracted from the row budget so the list page is
   * capped to keep the preview — and those notices — on screen together.
   */
  linesAbovePrompt?: number;
}

/** The result returned when the user selects an item. */
interface PickedItem<T> {
  item: T;
}

/** Configuration for the multi-select picker prompt. */
interface MultiPickerConfig<T> {
  message: string;
  items: T[];
  filter: (query: string) => T[];
  labelFor: (item: T, query: string) => string;
  /** Stable identity for an item — drives the selected set. */
  keyFor: (item: T) => string;
  buildPreview?: (item: T) => string;
  pageSize?: number;
  initialSearch?: string;
  emptyMessage?: string;
  enterHint?: string;
  /** See {@link PickerConfig.linesAbovePrompt}. */
  linesAbovePrompt?: number;
}

interface Choice<T> {
  value: T;
  label: string;
}

const DEFAULT_TERMINAL_ROWS = 24;
const DEFAULT_TERMINAL_WIDTH = 80;

/**
 * Rows the detail preview is guaranteed when it is open and a row is selected.
 * The list page is capped so this floor always fits the viewport — without it a
 * long list (PICKER_RECENT_COUNT = 15) consumes the whole default 24-row
 * terminal, `availablePreviewRows` goes <= 0, and the preview silently collapses
 * to empty (RUSH-2198).
 */
export const PREVIEW_MIN_ROWS = 6;

/** Floor for the visible list page, so a short terminal still shows a few rows. */
export const PICKER_MIN_LIST_ROWS = 3;

function terminalWidth(): number {
  return Math.max(1, process.stdout.columns || DEFAULT_TERMINAL_WIDTH);
}

function terminalRows(): number {
  return Math.max(1, process.stdout.rows || DEFAULT_TERMINAL_ROWS);
}

/**
 * Cap the visible list page so an open preview keeps a guaranteed floor of rows.
 *
 * The picker renders header + list page + separator + preview + help. When the
 * requested page size (e.g. 15) is large enough to fill the terminal on its own,
 * the preview has no room left and collapses. This reserves
 * {@link PREVIEW_MIN_ROWS} (plus its separator) for the preview and hands the
 * list whatever remains, never below {@link PICKER_MIN_LIST_ROWS}.
 *
 * `chromeRows` counts the fixed non-list, non-preview lines (header, subtitle,
 * help, any flash). `linesAbovePrompt` counts lines the caller printed above the
 * Inquirer prompt that have scrolled the viewport but the picker cannot measure —
 * today the session picker passes the hidden-session footer; subtracting it keeps
 * that notice on screen alongside the preview. (The fleet browser folds its
 * unreachable-peer warning into the header instead, so it needs no reserve here.)
 */
export function pickerPageSize(opts: {
  requestedPageSize: number;
  terminalRows: number;
  chromeRows: number;
  previewOpen: boolean;
  linesAbovePrompt?: number;
  previewMinRows?: number;
  minListRows?: number;
}): number {
  const previewMinRows = opts.previewMinRows ?? PREVIEW_MIN_ROWS;
  const minListRows = opts.minListRows ?? PICKER_MIN_LIST_ROWS;
  const linesAbove = Math.max(0, opts.linesAbovePrompt ?? 0);
  // The separator line rides with the preview only when it is open.
  const previewReserve = opts.previewOpen ? previewMinRows + 1 : 0;
  const budget = opts.terminalRows - linesAbove - opts.chromeRows - previewReserve;
  return Math.max(minListRows, Math.min(opts.requestedPageSize, budget));
}

function renderedRows(text: string, width: number): number {
  const normalizedWidth = Math.max(1, width);
  return text.split('\n').reduce((rows, line) => {
    const visible = stripVTControlCharacters(line).length;
    return rows + Math.max(1, Math.ceil(visible / normalizedWidth));
  }, 0);
}

function truncateAnsiLine(line: string, maxVisibleWidth: number): string {
  if (maxVisibleWidth <= 0) return '';

  const targetWidth = Math.max(0, maxVisibleWidth - 1);
  const ansiPattern = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/y;
  let out = '';
  let visible = 0;

  for (let i = 0; i < line.length;) {
    ansiPattern.lastIndex = i;
    const ansi = ansiPattern.exec(line);
    if (ansi) {
      out += ansi[0];
      i = ansiPattern.lastIndex;
      continue;
    }

    const char = line[i];
    if (visible >= targetWidth) break;
    out += char;
    visible += 1;
    i += char.length;
  }

  return out + '\x1b[0m' + chalk.gray('…');
}

function takePreviewRows(preview: string, rowBudget: number, width: number): string[] {
  const lines = preview.split('\n');
  const out: string[] = [];
  let used = 0;

  for (const line of lines) {
    const lineRows = renderedRows(line, width);
    if (used + lineRows <= rowBudget) {
      out.push(line);
      used += lineRows;
      continue;
    }

    const remainingRows = rowBudget - used;
    if (remainingRows > 0) {
      out.push(truncateAnsiLine(line, remainingRows * width));
    }
    break;
  }

  return out;
}

function previewTruncatedMarker(width: number): string {
  const full = '... preview truncated to fit terminal';
  const short = '... truncated';
  const text = full.length <= width ? full : short;
  if (text.length <= width) return chalk.gray(text);
  return chalk.gray(text.slice(0, Math.max(0, width - 1)) + '…');
}

/** Clip a picker preview so the full prompt can fit in the terminal viewport. */
export function limitPreviewHeight(preview: string, maxRows: number, width: number): string {
  const normalizedRows = Math.max(0, maxRows);
  if (normalizedRows === 0) return '';
  if (renderedRows(preview, width) <= normalizedRows) return preview;
  if (normalizedRows === 1) return previewTruncatedMarker(width);

  const lines = takePreviewRows(preview, normalizedRows - 1, width);
  lines.push(previewTruncatedMarker(width));
  return lines.join('\n');
}

/** Show an interactive fuzzy-filter picker and return the selected item, or null on cancel. */
export function itemPicker<T>(config: PickerConfig<T>): Promise<PickedItem<T> | null> {
  const prompt = createPrompt<PickedItem<T> | null, PickerConfig<T>>((cfg, done) => {
    const theme = makeTheme({});
    const [status, setStatus] = useState<'idle' | 'done'>('idle');
    const [searchTerm, setSearchTerm] = useState(cfg.initialSearch ?? '');
    const [previewOpen, setPreviewOpen] = useState(Boolean(cfg.buildPreview));
    // An async preview source repaints the pane by bumping this nonce; the
    // counter lives in a ref because the trigger closure would otherwise hold a
    // stale value and the second repaint would silently no-op (the same
    // stale-closure trap dynamicPicker's reloadNonce documents).
    const [, setPreviewNonce] = useState(0);
    const previewNonce = useRef(0);
    useEffect(() => {
      cfg.registerPreviewRepaint?.(() => setPreviewNonce((previewNonce.current += 1)));
    }, []);
    const prefix = usePrefix({ status, theme });

    const results = useMemo(() => {
      const filtered = cfg.filter(searchTerm).slice(0, 50);
      // Ordinals count only selectable rows, in filtered order, and are padded
      // to the widest index so single- and double-digit rows stay aligned.
      const selectableCount = filtered.filter((it) => !Separator.isSeparator(it)).length;
      const ordinalWidth = String(Math.max(1, selectableCount)).length;
      let ordinal = 0;
      return filtered.map<Choice<T> | Separator>((item) => {
        if (Separator.isSeparator(item)) return item;
        const label = cfg.labelFor(item, searchTerm);
        if (!cfg.numbered) return { value: item, label };
        ordinal += 1;
        return {
          value: item,
          label: `${chalk.gray(`${String(ordinal).padStart(ordinalWidth)}.`)} ${label}`,
        };
      });
    }, [searchTerm]);

    // A row is selectable unless it is a divider (Separator). Navigation and the
    // initial cursor skip dividers, and enter never resolves one.
    const isSelectable = (i: number): boolean =>
      i >= 0 && i < results.length && !Separator.isSeparator(results[i]);
    const firstSelectable = (): number => {
      for (let i = 0; i < results.length; i++) if (isSelectable(i)) return i;
      return -1;
    };
    const nextSelectable = (from: number, dir: 1 | -1): number => {
      if (results.length === 0) return -1;
      let i = from;
      for (let n = 0; n < results.length; n++) {
        i = (i + dir + results.length) % results.length;
        if (isSelectable(i)) return i;
      }
      return -1;
    };

    const [active, setActive] = useState(0);

    // Keep the cursor on a selectable row: after a filter change the old index can
    // land past the end or on a divider, so snap to the first selectable row.
    useEffect(() => {
      if (!isSelectable(active)) setActive(firstSelectable());
    }, [results]);

    const activeRow = results[active];
    const selected =
      activeRow && !Separator.isSeparator(activeRow) ? (activeRow as Choice<T>) : undefined;

    useKeypress((key, rl) => {
      if (isEnterKey(key)) {
        if (selected) {
          setStatus('done');
          done({ item: selected.value });
        }
        return;
      }

      if (isSpaceKey(key) && searchTerm === '' && cfg.buildPreview) {
        rl.clearLine(0);
        setPreviewOpen(!previewOpen);
        return;
      }

      if (isUpKey(key)) {
        rl.clearLine(0);
        const target = nextSelectable(active, -1);
        if (target >= 0) setActive(target);
        return;
      }

      if (isDownKey(key)) {
        rl.clearLine(0);
        const target = nextSelectable(active, 1);
        if (target >= 0) setActive(target);
        return;
      }

      setSearchTerm(rl.line);
      if (previewOpen) setPreviewOpen(false);
    });

    const message = theme.style.message(cfg.message, status);

    if (status === 'done' && selected) {
      const shortId = cfg.shortIdFor ? cfg.shortIdFor(selected.value) : '';
      return `${prefix} ${message}${shortId ? ' ' + chalk.cyan(shortId) : ''}`;
    }

    const hasPreview = Boolean(cfg.buildPreview);
    const placeholder = hasPreview
      ? '(type to filter, space to hide preview)'
      : '(type to filter)';
    const searchStr = searchTerm ? chalk.cyan(searchTerm) : chalk.gray(placeholder);
    const header = [prefix, message, searchStr].filter(Boolean).join(' ');

    // Cap the list page so an open preview keeps a guaranteed floor of rows.
    // chrome = header + optional subtitle + help; the preview separator is
    // reserved inside pickerPageSize.
    const chromeRows = 1 + (cfg.subtitle ? 1 : 0) + 1;
    const effectivePageSize = pickerPageSize({
      requestedPageSize: cfg.pageSize ?? 10,
      terminalRows: terminalRows(),
      chromeRows,
      previewOpen: previewOpen && Boolean(cfg.buildPreview),
      linesAbovePrompt: cfg.linesAbovePrompt,
    });

    const page = usePagination({
      items: results as any,
      active,
      renderItem({ item, isActive }: { item: Choice<T>; isActive: boolean }) {
        if (Separator.isSeparator(item)) return ` ${(item as any).separator}`;
        const cursor = isActive ? chalk.cyan('>') : ' ';
        const row = isActive ? chalk.bold(item.label) : item.label;
        return `${cursor} ${row}`;
      },
      pageSize: effectivePageSize,
      loop: false,
    });

    const enter = cfg.enterHint ?? 'select';
    const help = previewOpen
      ? chalk.gray(`↑↓ navigate · space: close preview · ⏎ ${enter} · esc: cancel`)
      : chalk.gray(
          `↑↓ navigate${hasPreview ? ' · space: preview' : ''} · ⏎ ${enter} · esc: cancel`
        );

    const parts: string[] = [header];
    if (cfg.subtitle) parts.push(cfg.subtitle);
    parts.push(page);
    if (results.length === 0) {
      parts.push(chalk.gray(`  ${cfg.emptyMessage ?? 'No matches.'}`));
    }

    if (previewOpen && selected && cfg.buildPreview) {
      const width = terminalWidth();
      const separator = chalk.gray('─'.repeat(Math.min(width, 80)));
      const fixedRows =
        renderedRows(header, width) +
        renderedRows(parts.slice(1).join('\n'), width) +
        renderedRows(separator, width) +
        renderedRows(help, width);
      const availablePreviewRows = terminalRows() - Math.max(0, cfg.linesAbovePrompt ?? 0) - fixedRows;
      const preview = limitPreviewHeight(cfg.buildPreview(selected.value), availablePreviewRows, width);
      if (preview) {
        parts.push(separator);
        parts.push(preview);
      }
    }

    parts.push(help);

    return [header, parts.slice(1).join('\n')];
  });
  return prompt(config);
}

/**
 * Multi-select variant of {@link itemPicker}. Same searchable, paginated list
 * and preview pane, but `space` toggles a checkbox on the active row instead of
 * the preview (preview moves to `tab`), and `enter` confirms every checked row.
 *
 * Returns the selected items (in the config's `items` order) or `null` on
 * cancel. Pressing `enter` with nothing checked confirms just the highlighted
 * row, so a quick single-pick still works.
 */
export function multiItemPicker<T>(config: MultiPickerConfig<T>): Promise<T[] | null> {
  const prompt = createPrompt<T[] | null, MultiPickerConfig<T>>((cfg, done) => {
    const theme = makeTheme({});
    const [status, setStatus] = useState<'idle' | 'done'>('idle');
    const [searchTerm, setSearchTerm] = useState(cfg.initialSearch ?? '');
    const [previewOpen, setPreviewOpen] = useState(Boolean(cfg.buildPreview));
    const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
    const [active, setActive] = useState(0);
    const prefix = usePrefix({ status, theme });

    const results = useMemo(() => {
      const filtered = cfg.filter(searchTerm).slice(0, 200);
      return filtered.map<Choice<T>>((item) => ({
        value: item,
        label: cfg.labelFor(item, searchTerm),
      }));
    }, [searchTerm]);

    useEffect(() => {
      if (active >= results.length) setActive(0);
    }, [results]);

    const selected = results[active];

    // Selected items resolved in the original list order for deterministic fan-out.
    const collectSelected = (): T[] => cfg.items.filter((it) => selectedKeys.has(cfg.keyFor(it)));

    useKeypress((key, rl) => {
      if (isEnterKey(key)) {
        const chosen = selectedKeys.size > 0 ? collectSelected() : selected ? [selected.value] : [];
        if (chosen.length === 0) return;
        setStatus('done');
        done(chosen);
        return;
      }

      // space toggles the active row's checkbox; strip the space from the buffer
      // so it never leaks into the filter.
      if (isSpaceKey(key)) {
        rl.clearLine(0);
        if (selected) {
          const k = cfg.keyFor(selected.value);
          const next = new Set(selectedKeys);
          if (next.has(k)) next.delete(k);
          else next.add(k);
          setSelectedKeys(next);
        }
        return;
      }

      if (key.name === 'tab' && cfg.buildPreview) {
        rl.clearLine(0);
        setPreviewOpen(!previewOpen);
        return;
      }

      if (isUpKey(key)) {
        rl.clearLine(0);
        if (results.length > 0) setActive((active - 1 + results.length) % results.length);
        return;
      }

      if (isDownKey(key)) {
        rl.clearLine(0);
        if (results.length > 0) setActive((active + 1) % results.length);
        return;
      }

      setSearchTerm(rl.line);
    });

    const message = theme.style.message(cfg.message, status);
    const count = selectedKeys.size;

    if (status === 'done') {
      return `${prefix} ${message} ${chalk.cyan(`${count || 1} session${(count || 1) === 1 ? '' : 's'}`)}`;
    }

    const placeholder = '(type to filter · space to toggle · enter to resume)';
    const searchStr = searchTerm ? chalk.cyan(searchTerm) : chalk.gray(placeholder);
    const header = [prefix, message, searchStr].filter(Boolean).join(' ');

    // Cap the list page so an open preview keeps a guaranteed floor of rows.
    // chrome = header + help; the preview separator is reserved inside
    // pickerPageSize.
    const chromeRows = 2;
    const effectivePageSize = pickerPageSize({
      requestedPageSize: cfg.pageSize ?? 10,
      terminalRows: terminalRows(),
      chromeRows,
      previewOpen: previewOpen && Boolean(cfg.buildPreview),
      linesAbovePrompt: cfg.linesAbovePrompt,
    });

    const page = usePagination({
      items: results as any,
      active,
      renderItem({ item, isActive }: { item: Choice<T>; isActive: boolean }) {
        if (Separator.isSeparator(item)) return ` ${(item as any).separator}`;
        const checked = selectedKeys.has(cfg.keyFor(item.value));
        const box = checked ? chalk.green('[x]') : chalk.gray('[ ]');
        const cursor = isActive ? chalk.cyan('>') : ' ';
        const row = isActive ? chalk.bold(item.label) : item.label;
        return `${cursor} ${box} ${row}`;
      },
      pageSize: effectivePageSize,
      loop: false,
    });

    const enter = cfg.enterHint ?? 'resume';
    const countStr = count > 0 ? chalk.green(`${count} selected`) : chalk.gray('0 selected');
    const help = chalk.gray(
      `${countStr}${chalk.gray(' · ↑↓ navigate · space toggle')}${
        cfg.buildPreview ? chalk.gray(' · tab preview') : ''
      }${chalk.gray(` · ⏎ ${enter} · esc cancel`)}`,
    );

    const parts: string[] = [header, page];
    if (results.length === 0) {
      parts.push(chalk.gray(`  ${cfg.emptyMessage ?? 'No matches.'}`));
    }

    if (previewOpen && selected && cfg.buildPreview) {
      const width = terminalWidth();
      const separator = chalk.gray('─'.repeat(Math.min(width, 80)));
      const fixedRows =
        renderedRows(header, width) +
        renderedRows(parts.slice(1).join('\n'), width) +
        renderedRows(separator, width) +
        renderedRows(help, width);
      const availablePreviewRows = terminalRows() - Math.max(0, cfg.linesAbovePrompt ?? 0) - fixedRows;
      const preview = limitPreviewHeight(cfg.buildPreview(selected.value), availablePreviewRows, width);
      if (preview) {
        parts.push(separator);
        parts.push(preview);
      }
    }

    parts.push(help);

    return [header, parts.slice(1).join('\n')];
  });
  return prompt(config);
}

/** Configuration for the dynamic (async-refetch) picker prompt. */
interface DynamicPickerConfig<T, F, A = never> {
  message: string;
  /** The initial filter state. Changing it (via a keybinding) re-runs {@link load}. */
  initialFilter: F;
  /** Async loader for the current filter state. Its result is the row pool. */
  load: (filter: F) => Promise<T[]>;
  labelFor: (item: T, query: string) => string;
  /** Stable identity for an item (used for the active-row cursor across reloads). */
  keyFor: (item: T) => string;
  /** Client-side text filter over the loaded pool (the `S` search). */
  matches?: (item: T, query: string) => boolean;
  buildPreview?: (item: T) => string;
  /** See {@link PickerConfig.registerPreviewRepaint}. */
  registerPreviewRepaint?: (repaint: () => void) => void;
  /** Dim summary of the current filter state, rendered in the header. */
  headerFor?: (filter: F) => string;
  /** The hotkey-legend help line; receives the mode so it can adapt. */
  helpFor?: (filter: F, mode: 'nav' | 'search') => string;
  /**
   * Single-key bindings (by key name) that transform the filter. Returning the
   * SAME reference is a no-op; a new object triggers a reload.
   */
  keyBindings?: Record<string, (filter: F) => F>;
  /** Keys that submit the highlighted row with an alternate typed action. */
  submitKeys?: Record<string, A>;
  /**
   * Side-effecting keys that don't change the filter (e.g. `y` copies a command).
   * Receives the live search `query` so the effect can be search-aware. Return a
   * short string to flash under the list, or `{ flash, reload }` when the effect
   * changed something the rows RENDER (a star, a mark) and the list has to be
   * rebuilt — the row labels are memoized, so a flash alone leaves them stale.
   */
  onKey?: (
    name: string,
    filter: F,
    active: T | undefined,
    query: string,
  ) => string | void | { flash?: string; reload?: boolean };
  /** Key that enters search mode (default `s`). */
  searchKey?: string;
  /** Key that toggles the preview pane (default `tab`). */
  previewKey?: string;
  pageSize?: number;
  emptyMessage?: string;
  loadingMessage?: string;
  enterHint?: string;
  /** See {@link PickerConfig.linesAbovePrompt}. */
  linesAbovePrompt?: number;
}

/**
 * The lookup token for a hotkey: the literal character the key produced, else
 * readline's key name (`tab`, `escape`, arrows).
 *
 * readline reports both `f` and `F` as name `f` — only `sequence` tells them
 * apart — and gives a punctuation key like `*` no name at all. Keying on the
 * character makes shifted letters and punctuation bindable, and is a no-op for
 * every existing binding: for a plain lowercase letter, sequence === name.
 *
 * Callers receiving this in `onKey` see the literal character, so a handler that
 * wants to accept both cases of a letter must say so (`'y'` and `'Y'`); the
 * keyBindings lookup falls back to the key NAME, which keeps the shifted form of
 * an existing single-letter binding working without each caller restating it.
 */
export function hotkeyToken(key: { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean }): string {
  const seq = key.sequence;
  // Printable single characters only — a control code's sequence (`\t`, `\r`,
  // `\x7f`) must keep resolving to its name.
  if (!key.ctrl && !key.meta && seq && seq.length === 1 && seq > ' ' && seq !== '\x7f') return seq;
  return key.name ?? '';
}

/** The result returned when the user selects a row: the item plus the live filter. */
interface DynamicPicked<T, F, A = never> {
  item: T;
  filter: F;
  action?: A;
}

/**
 * Async-refetch variant of {@link itemPicker}. Holds a `filter` object in state and
 * re-runs `load(filter)` whenever a keybinding mutates it (with a loading placeholder
 * while the fetch — e.g. an SSH fleet fan-out — is in flight). A separate `S` search
 * mode filters the loaded pool client-side. `enter` returns the active row + the live
 * filter; `esc` cancels (from search mode, `esc` first exits search).
 *
 * Same render/pagination/preview machinery as the static pickers — only the data
 * source and keymap are dynamic.
 */
export function dynamicPicker<T, F, A = never>(config: DynamicPickerConfig<T, F, A>): Promise<DynamicPicked<T, F, A> | null> {
  const prompt = createPrompt<DynamicPicked<T, F, A> | null, DynamicPickerConfig<T, F, A>>((cfg, done) => {
    const theme = makeTheme({});
    const [status, setStatus] = useState<'idle' | 'done'>('idle');
    const [filter, setFilter] = useState<F>(() => cfg.initialFilter);
    const [items, setItems] = useState<T[]>([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState('');
    const [mode, setMode] = useState<'nav' | 'search'>('nav');
    // Default the preview pane open when the caller supplies a preview builder —
    // matches the static `itemPicker`, so the session browser shows a live preview
    // as you arrow through rows instead of hiding it behind `tab`.
    const [previewOpen, setPreviewOpen] = useState(Boolean(cfg.buildPreview));
    const [active, setActive] = useState(0);
    const [flash, setFlash] = useState('');
    // Bumped by an `onKey` that asks for a reload; a dep of the load effect, so a
    // side effect that changed the rows can rebuild them without a filter change.
    const [reloadNonce, setReloadNonce] = useState(0);
    // The counter lives in a ref, not in the state read back from the keypress
    // closure: that closure can hold a STALE `reloadNonce`, so a second reload
    // would recompute the same value, the state would not change, and the
    // repaint would silently never happen (the first star appeared, the second
    // did not). A ref is always current.
    const reloadCount = useRef(0);
    // Bumped when a load RESOLVES. `load` is async, so the render that follows
    // `setReloadNonce` still sees the pre-load data — memoizing the row labels on
    // the nonce alone rendered each press's result one press late. Keying them on
    // load COMPLETION is what actually makes them current.
    const [loadedSeq, setLoadedSeq] = useState(0);
    const loadedCount = useRef(0);
    const prefix = usePrefix({ status, theme });
    // Guards against a slow load resolving after a newer filter superseded it.
    const gen = useRef(0);
    // The filter the last load ran on, so a nonce-only reload (a row's own state
    // changed) can keep the cursor where the user left it. Snapping back to the
    // top every time you star a row would make the key unusable for a second one.
    const loadedFilter = useRef<F | undefined>(undefined);
    // Async preview repaint — same ref-counter shape as reloadNonce above, but
    // it only re-renders (buildPreview runs in render) without re-running load.
    const [, setPreviewNonce] = useState(0);
    const previewNonce = useRef(0);
    useEffect(() => {
      cfg.registerPreviewRepaint?.(() => setPreviewNonce((previewNonce.current += 1)));
    }, []);

    useEffect(() => {
      const my = ++gen.current;
      const filterChanged = loadedFilter.current !== filter;
      loadedFilter.current = filter;
      setLoading(true);
      Promise.resolve(cfg.load(filter))
        .then((rows) => {
          if (my !== gen.current) return;
          setItems(rows);
          setLoading(false);
          setLoadedSeq((loadedCount.current += 1));
          if (filterChanged) setActive(0);
        })
        .catch(() => {
          if (my !== gen.current) return;
          setItems([]);
          setLoading(false);
        });
    }, [filter, reloadNonce]);

    const results = useMemo(() => {
      const q = query.trim();
      const pool = q && cfg.matches ? items.filter((it) => cfg.matches!(it, q)) : items;
      return pool.slice(0, 200).map<Choice<T>>((item) => ({
        value: item,
        label: cfg.labelFor(item, q),
      }));
      // `loadedSeq` is a dep because a reload can legitimately return the SAME
      // array — `load` hands back its cached pool unchanged when no filter is
      // active — while what a row RENDERS has changed underneath it. Without this
      // the labels stay memoized on the old state and the side effect looks like
      // it silently did nothing (starring a row left the star invisible).
    }, [items, query, loadedSeq]);

    useEffect(() => {
      if (active >= results.length) setActive(0);
    }, [results]);

    const selected = results[active];

    const finish = (action?: A): void => {
      if (!selected) return;
      setStatus('done');
      done({ item: selected.value, filter, ...(action === undefined ? {} : { action }) });
    };

    useKeypress((key, rl) => {
      if (isEnterKey(key)) {
        finish();
        return;
      }

      // Search mode: we own the query buffer (readline's line doesn't survive
      // across renders here, so we build it from key events). Clear readline
      // every keystroke so nothing leaks, then append the typed character.
      if (mode === 'search') {
        if (key.name === 'escape') {
          // Exit search but KEEP the query as an active filter, so hotkeys (and
          // the y copy-cmd) operate on the searched view. A second esc in nav
          // clears it. Enter also confirms the highlighted row directly.
          rl.clearLine(0);
          setMode('nav');
          return;
        }
        if (isUpKey(key)) {
          rl.clearLine(0);
          if (results.length > 0) setActive((active - 1 + results.length) % results.length);
          return;
        }
        if (isDownKey(key)) {
          rl.clearLine(0);
          if (results.length > 0) setActive((active + 1) % results.length);
          return;
        }
        if (isBackspaceKey(key)) {
          rl.clearLine(0);
          setQuery(query.slice(0, -1));
          return;
        }
        const seq = (key as { sequence?: string }).sequence;
        rl.clearLine(0);
        if (seq && seq.length === 1 && seq >= ' ' && !key.ctrl) {
          setQuery(query + seq);
        }
        return;
      }

      // Nav mode: single keys are hotkeys — clear the readline buffer so a hotkey
      // letter (r/b/c/…) never accumulates as stray input.
      rl.clearLine(0);
      if (key.name === 'escape') {
        // First esc clears an active search filter; a second (no filter) cancels.
        if (query) {
          setQuery('');
          return;
        }
        done(null);
        return;
      }
      if (isUpKey(key)) {
        if (results.length > 0) setActive((active - 1 + results.length) % results.length);
        return;
      }
      if (isDownKey(key)) {
        if (results.length > 0) setActive((active + 1) % results.length);
        return;
      }
      if (flash) setFlash('');
      if (key.name === (cfg.searchKey ?? 's')) {
        setMode('search');
        return;
      }
      if (cfg.buildPreview && key.name === (cfg.previewKey ?? 'tab')) {
        setPreviewOpen(!previewOpen);
        return;
      }
      const token = hotkeyToken(key);
      // Exact character first (so `*` and a shifted `F` are addressable), then
      // the readline name. The fallback is what preserves the shifted form of an
      // existing single-letter hotkey: `R`/`C`/`A` used to reach their bindings
      // via `key.name`, and keying on the character alone would silently retire
      // them for anyone with caps lock on.
      const submitAction = cfg.submitKeys?.[token] ?? cfg.submitKeys?.[key.name ?? ''];
      if (submitAction !== undefined) {
        finish(submitAction);
        return;
      }
      const binding = cfg.keyBindings?.[token] ?? cfg.keyBindings?.[key.name ?? ''];
      if (binding) {
        const next = binding(filter);
        if (!Object.is(next, filter)) setFilter(next);
        return;
      }
      if (cfg.onKey) {
        const res = cfg.onKey(token, filter, selected?.value, query);
        if (typeof res === 'string') setFlash(res);
        else if (res) {
          if (res.flash) setFlash(res.flash);
          // The rows themselves changed — force the load effect to re-run so the
          // memoized labels are rebuilt.
          if (res.reload) setReloadNonce((reloadCount.current += 1));
        }
      }
    });

    const message = theme.style.message(cfg.message, status);

    if (status === 'done') {
      return `${prefix} ${message}`;
    }

    const headerBits = [prefix, message];
    if (cfg.headerFor) headerBits.push(chalk.gray(cfg.headerFor(filter)));
    if (mode === 'search') {
      headerBits.push(query ? chalk.cyan('/' + query) : chalk.gray('/ (type to filter)'));
    } else if (query) {
      headerBits.push(chalk.cyan('/' + query));
    }
    const header = headerBits.filter(Boolean).join(' ');

    // Cap the list page so an open preview keeps a guaranteed floor of rows.
    // chrome = header + help + optional flash line; the preview separator is
    // reserved inside pickerPageSize. Only the loaded list steals viewport, so
    // skip the cap while the loading placeholder is showing.
    const chromeRows = 2 + (flash ? renderedRows(flash, terminalWidth()) : 0);
    const effectivePageSize = pickerPageSize({
      requestedPageSize: cfg.pageSize ?? 12,
      terminalRows: terminalRows(),
      chromeRows,
      previewOpen: previewOpen && Boolean(cfg.buildPreview) && !loading,
      linesAbovePrompt: cfg.linesAbovePrompt,
    });

    const page = usePagination({
      items: results as any,
      active,
      renderItem({ item, isActive }: { item: Choice<T>; isActive: boolean }) {
        if (Separator.isSeparator(item)) return ` ${(item as any).separator}`;
        const cursor = isActive ? chalk.cyan('>') : ' ';
        const row = isActive ? chalk.bold(item.label) : item.label;
        return `${cursor} ${row}`;
      },
      pageSize: effectivePageSize,
      loop: false,
    });

    const help = chalk.gray(
      cfg.helpFor
        ? cfg.helpFor(filter, mode)
        : mode === 'search'
          ? '↑↓ navigate · esc exit search · ⏎ ' + (cfg.enterHint ?? 'select')
          : 's search · ↑↓ navigate · ⏎ ' + (cfg.enterHint ?? 'select') + ' · esc cancel',
    );

    const parts: string[] = [header];
    if (loading) {
      parts.push(chalk.gray(`  ${cfg.loadingMessage ?? 'Loading…'}`));
    } else {
      parts.push(page);
      if (results.length === 0) {
        parts.push(chalk.gray(`  ${cfg.emptyMessage ?? 'No matches.'}`));
      }
    }

    if (previewOpen && selected && cfg.buildPreview && !loading) {
      const width = terminalWidth();
      const separator = chalk.gray('─'.repeat(Math.min(width, 80)));
      const flashRows = flash ? renderedRows(flash, width) : 0;
      const fixedRows =
        renderedRows(header, width) +
        renderedRows(parts.slice(1).join('\n'), width) +
        renderedRows(separator, width) +
        renderedRows(help, width) +
        flashRows;
      const availablePreviewRows = terminalRows() - Math.max(0, cfg.linesAbovePrompt ?? 0) - fixedRows;
      const preview = limitPreviewHeight(cfg.buildPreview(selected.value), availablePreviewRows, width);
      if (preview) {
        parts.push(separator);
        parts.push(preview);
      }
    }

    if (flash) parts.push(chalk.green(flash));
    parts.push(help);

    return [header, parts.slice(1).join('\n')];
  });
  return prompt(config);
}
