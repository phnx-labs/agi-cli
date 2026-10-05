

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

interface PickerConfig<T> {
  message: string;
  subtitle?: string;
  items: Array<T | Separator>;
  filter: (query: string) => Array<T | Separator>;
  labelFor: (item: T, query: string) => string;
  buildPreview?: (item: T) => string;
  registerPreviewRepaint?: (repaint: () => void) => void;
  shortIdFor?: (item: T) => string;
  numbered?: boolean;
  pageSize?: number;
  initialSearch?: string;
  emptyMessage?: string;
  enterHint?: string;
  linesAbovePrompt?: number;
}

interface PickedItem<T> {
  item: T;
}

interface MultiPickerConfig<T> {
  message: string;
  items: T[];
  filter: (query: string) => T[];
  labelFor: (item: T, query: string) => string;
  keyFor: (item: T) => string;
  buildPreview?: (item: T) => string;
  pageSize?: number;
  initialSearch?: string;
  emptyMessage?: string;
  enterHint?: string;
  linesAbovePrompt?: number;
}

interface Choice<T> {
  value: T;
  label: string;
}

const DEFAULT_TERMINAL_ROWS = 24;
const DEFAULT_TERMINAL_WIDTH = 80;

export const PREVIEW_MIN_ROWS = 6;

export const PICKER_MIN_LIST_ROWS = 3;

function terminalWidth(): number {
  return Math.max(1, process.stdout.columns || DEFAULT_TERMINAL_WIDTH);
}

function terminalRows(): number {
  return Math.max(1, process.stdout.rows || DEFAULT_TERMINAL_ROWS);
}

export function pickerPageSize(opts: {
  requestedPageSize: number;
  terminalRows: number;
  chromeRows: number;
  previewOpen: boolean;
  linesAbovePrompt?: number;
  previewMinRows?: number;
  minListRows?: number;
}): number {
  // Reserve a preview floor plus separator before sizing the list on small terminals.
  const previewMinRows = opts.previewMinRows ?? PREVIEW_MIN_ROWS;
  const minListRows = opts.minListRows ?? PICKER_MIN_LIST_ROWS;
  const linesAbove = Math.max(0, opts.linesAbovePrompt ?? 0);
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

export function limitPreviewHeight(preview: string, maxRows: number, width: number): string {
  const normalizedRows = Math.max(0, maxRows);
  if (normalizedRows === 0) return '';
  if (renderedRows(preview, width) <= normalizedRows) return preview;
  if (normalizedRows === 1) return previewTruncatedMarker(width);

  const lines = takePreviewRows(preview, normalizedRows - 1, width);
  lines.push(previewTruncatedMarker(width));
  return lines.join('\n');
}

export function itemPicker<T>(config: PickerConfig<T>): Promise<PickedItem<T> | null> {
  const prompt = createPrompt<PickedItem<T> | null, PickerConfig<T>>((cfg, done) => {
    const theme = makeTheme({});
    const [status, setStatus] = useState<'idle' | 'done'>('idle');
    const [searchTerm, setSearchTerm] = useState(cfg.initialSearch ?? '');
    const [previewOpen, setPreviewOpen] = useState(Boolean(cfg.buildPreview));
    // The ref counter makes every repaint callback observable despite stale render closures.
    const [, setPreviewNonce] = useState(0);
    const previewNonce = useRef(0);
    useEffect(() => {
      cfg.registerPreviewRepaint?.(() => setPreviewNonce((previewNonce.current += 1)));
    }, []);
    const prefix = usePrefix({ status, theme });

    const results = useMemo(() => {
      const filtered = cfg.filter(searchTerm).slice(0, 50);
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

    const collectSelected = (): T[] => cfg.items.filter((it) => selectedKeys.has(cfg.keyFor(it)));

    useKeypress((key, rl) => {
      if (isEnterKey(key)) {
        const chosen = selectedKeys.size > 0 ? collectSelected() : selected ? [selected.value] : [];
        if (chosen.length === 0) return;
        setStatus('done');
        done(chosen);
        return;
      }

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

interface DynamicPickerConfig<T, F, A = never> {
  message: string;
  initialFilter: F;
  load: (filter: F) => Promise<T[]>;
  labelFor: (item: T, query: string) => string;
  keyFor: (item: T) => string;
  matches?: (item: T, query: string) => boolean;
  buildPreview?: (item: T) => string;
  registerPreviewRepaint?: (repaint: () => void) => void;
  headerFor?: (filter: F) => string;
  helpFor?: (filter: F, mode: 'nav' | 'search') => string;
  keyBindings?: Record<string, (filter: F) => F>;
  submitKeys?: Record<string, A>;
  onKey?: (
    name: string,
    filter: F,
    active: T | undefined,
    query: string,
  ) => string | void | { flash?: string; reload?: boolean };
  searchKey?: string;
  previewKey?: string;
  pageSize?: number;
  emptyMessage?: string;
  loadingMessage?: string;
  enterHint?: string;
  linesAbovePrompt?: number;
}

export function hotkeyToken(key: { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean }): string {
  // Printable hotkeys use sequence so shifted/punctuation keys survive; control keys use readline names.
  const seq = key.sequence;
  if (!key.ctrl && !key.meta && seq && seq.length === 1 && seq > ' ' && seq !== '\x7f') return seq;
  return key.name ?? '';
}

interface DynamicPicked<T, F, A = never> {
  item: T;
  filter: F;
  action?: A;
}

export function dynamicPicker<T, F, A = never>(config: DynamicPickerConfig<T, F, A>): Promise<DynamicPicked<T, F, A> | null> {
  const prompt = createPrompt<DynamicPicked<T, F, A> | null, DynamicPickerConfig<T, F, A>>((cfg, done) => {
    const theme = makeTheme({});
    const [status, setStatus] = useState<'idle' | 'done'>('idle');
    const [filter, setFilter] = useState<F>(() => cfg.initialFilter);
    const [items, setItems] = useState<T[]>([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState('');
    const [mode, setMode] = useState<'nav' | 'search'>('nav');
    const [previewOpen, setPreviewOpen] = useState(Boolean(cfg.buildPreview));
    const [active, setActive] = useState(0);
    const [flash, setFlash] = useState('');
    // Ref counters make repeated repaint/reload observable; generation rejects stale loads and nonce-only reloads preserve the cursor.
    const [reloadNonce, setReloadNonce] = useState(0);
    const reloadCount = useRef(0);
    const [loadedSeq, setLoadedSeq] = useState(0);
    const loadedCount = useRef(0);
    const prefix = usePrefix({ status, theme });
    const gen = useRef(0);
    const loadedFilter = useRef<F | undefined>(undefined);
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

    // loadedSeq invalidates memoized labels after each completed load.
    const results = useMemo(() => {
      const q = query.trim();
      const pool = q && cfg.matches ? items.filter((it) => cfg.matches!(it, q)) : items;
      return pool.slice(0, 200).map<Choice<T>>((item) => ({
        value: item,
        label: cfg.labelFor(item, q),
      }));
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

      if (mode === 'search') {
        if (key.name === 'escape') {
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

      rl.clearLine(0);
      if (key.name === 'escape') {
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
