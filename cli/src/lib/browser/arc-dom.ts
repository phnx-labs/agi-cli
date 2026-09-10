import { truncate } from '../format.js';
import type { RefNode, RefOpts } from './refs.js';

interface ArcDomRefResult {
  role: string;
  name: string;
  attrs: string[];
  selector: string;
  editor?: string;
}

const INTERACTIVE_SELECTOR = [
  'a[href]', 'button', 'input', 'select', 'textarea', '[contenteditable="true"]',
  '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="checkbox"]',
  '[role="radio"]', '[role="combobox"]', '[role="listbox"]', '[role="option"]',
  '[role="menuitem"]', '[role="tab"]', '[role="slider"]', '[role="spinbutton"]',
  '[role="searchbox"]', '[role="switch"]', '[role="treeitem"]',
].join(',');

/** Build one synchronous expression that reads DOM-backed refs from native Arc. */
export function arcRefsExpression(opts: RefOpts = {}): string {
  const interactive = opts.interactive ?? true;
  const limit = opts.limit ?? 500;
  return `(() => {
    const selectorFor = (el) => {
      if (el.id) return '#' + CSS.escape(el.id);
      const parts = [];
      for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
        let part = node.localName;
        if (!part) return '';
        const siblings = node.parentElement ? Array.from(node.parentElement.children).filter((s) => s.localName === node.localName) : [];
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        parts.unshift(part);
      }
      return parts.join(' > ');
    };
    const roleFor = (el) => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit.toLowerCase();
      if (el.matches('button')) return 'button';
      if (el.matches('a[href]')) return 'link';
      if (el.matches('textarea,[contenteditable="true"]')) return 'textbox';
      if (el.matches('select')) return 'combobox';
      if (el.matches('input')) {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        return 'textbox';
      }
      return el.localName || 'generic';
    };
    const nameFor = (el) => el.getAttribute('aria-label') || el.getAttribute('title') ||
      (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || el.value || el.getAttribute('placeholder') || '';
    const attrsFor = (el) => ['disabled','checked','selected','expanded','required','readonly','invalid']
      .filter((name) => el[name] === true || el.getAttribute('aria-' + name) === 'true');
    const editorFor = (el) => {
      for (let node = el, i = 0; node && i < 6; node = node.parentElement, i++) {
        if (node.hasAttribute('data-lexical-editor')) return 'lexical';
        if (node.classList.contains('ProseMirror')) return 'prosemirror';
        if (node.hasAttribute('data-slate-editor')) return 'slate';
        if (Array.from(node.classList).some((c) => /^DraftEditor-/.test(c))) return 'draft';
        if (node.classList.contains('ql-editor')) return 'quill';
        if (node.classList.contains('ck-editor__editable')) return 'ckeditor5';
        if (node.tagName === 'TRIX-EDITOR') return 'trix';
      }
      return undefined;
    };
    const source = ${interactive ? `document.querySelectorAll(${JSON.stringify(INTERACTIVE_SELECTOR)})` : `document.querySelectorAll('body *')`};
    const rows = [];
    for (const el of source) {
      if (rows.length >= ${JSON.stringify(limit)}) break;
      const selector = selectorFor(el);
      if (!selector) continue;
      const row = { role: roleFor(el), name: String(nameFor(el)).trim(), attrs: attrsFor(el), selector };
      const editor = editorFor(el);
      if (editor) row.editor = editor;
      rows.push(row);
    }
    return JSON.stringify(rows);
  })()`;
}

export function parseArcRefsResult(
  value: unknown,
  opts: RefOpts = {},
): { refs: string; nodeMap: Map<number, RefNode>; opts: { interactive: boolean; limit: number } } {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error('Arc returned an invalid DOM ref listing.');
  const nodeMap = new Map<number, RefNode>();
  const lines: string[] = [];
  const compact = opts.compact ?? false;
  parsed.forEach((raw, index) => {
    const row = raw as Partial<ArcDomRefResult>;
    if (typeof row.role !== 'string' || typeof row.name !== 'string' ||
        typeof row.selector !== 'string' || !Array.isArray(row.attrs) ||
        !row.attrs.every((attr) => typeof attr === 'string')) {
      throw new Error('Arc returned an invalid DOM ref entry.');
    }
    const ref = index + 1;
    const node: RefNode = { ref, role: row.role, name: row.name, attrs: row.attrs, selector: row.selector };
    if (typeof row.editor === 'string') node.editor = row.editor;
    nodeMap.set(ref, node);
    const name = row.name ? ` "${truncate(row.name, 50)}"` : '';
    const attrs = row.attrs.length ? ` [${row.attrs.join('] [')}]` : '';
    const editor = row.editor ? ` [editor=${row.editor}]` : '';
    lines.push(`${compact ? '' : '- '}${row.role}${name} [ref=${ref}]${attrs}${editor}`);
  });
  return { refs: lines.join('\n'), nodeMap, opts: { interactive: opts.interactive ?? true, limit: opts.limit ?? 500 } };
}

export function arcClickExpression(selector: string): string {
  return `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('DOM ref is missing'); el.click(); return true; })()`;
}

export function arcFillExpression(selector: string, text: string, clear = true): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('DOM ref is missing');
    const next = ${JSON.stringify(text)};
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, ${clear ? 'next' : 'el.value + next'});
    } else if (el.isContentEditable) {
      el.textContent = ${clear ? 'next' : '(el.textContent || "") + next'};
    } else throw new Error('DOM ref is not editable');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: next }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}

export function arcScrollExpression(deltaX: number, deltaY: number): string {
  return `(() => { window.scrollBy(${JSON.stringify(deltaX)}, ${JSON.stringify(deltaY)}); return true; })()`;
}
