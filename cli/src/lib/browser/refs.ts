import type { CDPClient } from './cdp.js';
import { truncate } from '../format.js';

export interface RefOpts {
  interactive?: boolean;
  limit?: number;
  compact?: boolean;
}

interface AXNode {
  nodeId: string;
  role: { value: string };
  name?: { value: string };
  properties?: Array<{ name: string; value: { value: unknown } }>;
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface RefNode {
  ref: number;
  role: string;
  name: string;
  attrs: string[];
  backendNodeId?: number;
  /** Stable selector used by non-CDP DOM backends such as native Arc. */
  selector?: string;
  editor?: string;
}

/**
 * Stable, navigation-surviving identity for a ref. Unlike {@link RefNode}, this
 * carries no `backendNodeId` (which goes stale the moment the DOM re-renders) —
 * only the accessible descriptor a fresh `getRefs` can be re-matched against.
 * Cached in per-task state so a later `click <ref>` can self-heal when the
 * integer ref has drifted (see {@link healRef}).
 */
export interface RefDescriptor {
  ref: number;
  role: string;
  name: string;
  attrs: string[];
  /**
   * Best-effort CSS selector captured via DOM. Reserved for future
   * selector-based healing; matching today is role+name+attrs+position.
   */
  selector?: string;
}

/**
 * A cached ref listing for one tab: the stable descriptors plus the resolved
 * {@link RefOpts} the listing was built with. A later `click`/`type` MUST
 * rebuild its node map with these same opts, or the integer refs it looks up
 * are numbered against a *different* accessibility filter than the one the
 * user saw in `browser refs` — the drift that makes self-heal silently click
 * the wrong element on the second click.
 */
export interface RefSnapshot {
  descriptors: RefDescriptor[];
  opts: { interactive: boolean; limit: number };
}

/** Snapshot the stable descriptor for every ref in a freshly-built node map. */
export function describeRefs(nodeMap: Map<number, RefNode>): RefDescriptor[] {
  return Array.from(nodeMap.values()).map((n) => ({
    ref: n.ref,
    role: n.role,
    name: n.name,
    attrs: n.attrs.slice(),
    selector: n.selector,
  }));
}

/**
 * Re-resolve a stale ref against a freshly-built node map by matching the
 * cached descriptor. Pure — no CDP, no DOM.
 *
 * The integer ref assigned by {@link getRefs} is positional: it shifts whenever
 * the accessibility tree changes (navigation, re-render, or even a different
 * `interactive` filter). The descriptor's (role, name) pair is the coarse
 * identity, but a page can carry duplicate (role, name) elements — two "Submit"
 * buttons, one action button per repeated list row. Matching on (role, name)
 * alone would heal to whichever duplicate the fresh scan happens to hit first,
 * which can be the wrong one. So among (role, name) matches we tie-break, in
 * priority order:
 *
 *   1. **DOM-backed** — a candidate with a `backendNodeId` is resolvable to
 *      coordinates; one without is unclickable, so healing to it is useless.
 *   2. **Attribute similarity** — the cached `attrs` (disabled / checked /
 *      selected / …) disambiguate otherwise-identical twins (the *disabled*
 *      Submit vs the enabled one).
 *   3. **Positional proximity** — the fresh ref closest to the original cached
 *      ref index wins, so a repeated list-row action heals to its nearest
 *      positional twin rather than jumping across the page.
 *
 * Returns the new integer ref, or `null` when no node with the same role+name
 * exists in the fresh map (unhealable — the element is genuinely gone).
 */
export function healRef(
  descriptor: Pick<RefDescriptor, 'ref' | 'role' | 'name' | 'attrs'>,
  freshNodeMap: Map<number, RefNode>
): number | null {
  const { ref, role, name, attrs } = descriptor;
  const cachedAttrs = new Set(attrs);

  // How well a candidate's attribute set matches the cached one: reward shared
  // attrs, penalize both extras the candidate carries and cached attrs it is
  // missing. Exact set equality scores highest; an all-attrs-empty comparison
  // scores 0 for every candidate (so the tie-break falls through to proximity).
  const attrScore = (node: RefNode): number => {
    let shared = 0;
    for (const a of node.attrs) if (cachedAttrs.has(a)) shared += 1;
    const extra = node.attrs.length - shared;
    const missing = cachedAttrs.size - shared;
    return shared * 2 - extra - missing;
  };

  let best: RefNode | null = null;
  let bestKey: [number, number, number] | null = null;
  for (const node of freshNodeMap.values()) {
    if (node.role !== role || node.name !== name) continue;
    // Lexicographic key, all "higher is better":
    //   [ DOM-backed, attribute similarity, -distance-to-original-ref ].
    const key: [number, number, number] = [
      node.backendNodeId !== undefined || node.selector !== undefined ? 1 : 0,
      attrScore(node),
      -Math.abs(node.ref - ref),
    ];
    if (
      bestKey === null ||
      key[0] > bestKey[0] ||
      (key[0] === bestKey[0] && key[1] > bestKey[1]) ||
      (key[0] === bestKey[0] && key[1] === bestKey[1] && key[2] > bestKey[2])
    ) {
      best = node;
      bestKey = key;
    }
  }
  return best ? best.ref : null;
}

const EDITOR_DETECT_FN = `(function() {
  let el = this;
  for (let i = 0; i < 5; i++) {
    if (!el || el === document.documentElement) break;
    if (el.hasAttribute && el.hasAttribute('data-lexical-editor')) return 'lexical';
    if (el.classList && el.classList.contains('ProseMirror')) return 'prosemirror';
    if (el.hasAttribute && el.hasAttribute('data-slate-editor')) return 'slate';
    if (el.classList && Array.from(el.classList).some(function(c) { return /^DraftEditor-/.test(c); })) return 'draft';
    if (el.classList && el.classList.contains('ql-editor')) return 'quill';
    if (el.classList && el.classList.contains('ck-editor__editable')) return 'ckeditor5';
    if (el.tagName === 'TRIX-EDITOR') return 'trix';
    el = el.parentElement;
  }
  return null;
})`;

async function detectEditorForNode(
  cdp: CDPClient,
  sessionId: string,
  backendNodeId: number
): Promise<string | undefined> {
  const { object } = await cdp.send<{ object: { objectId?: string } }>(
    'DOM.resolveNode',
    { backendNodeId },
    sessionId
  );
  if (!object.objectId) return undefined;
  const objectId = object.objectId;
  try {
    const { result } = await cdp.send<{ result: { value: string | null } }>(
      'Runtime.callFunctionOn',
      { objectId, functionDeclaration: EDITOR_DETECT_FN, returnByValue: true },
      sessionId
    );
    return result.value ?? undefined;
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId }, sessionId);
  }
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'tab',
  'slider',
  'spinbutton',
  'searchbox',
  'switch',
  'menuitemcheckbox',
  'menuitemradio',
  'treeitem',
]);

export async function getRefs(
  cdp: CDPClient,
  sessionId: string,
  opts: RefOpts = {}
): Promise<{
  refs: string;
  nodeMap: Map<number, RefNode>;
  opts: { interactive: boolean; limit: number };
}> {
  const { interactive = true, limit = 500, compact = false } = opts;

  const { nodes } = (await cdp.send(
    'Accessibility.getFullAXTree',
    {},
    sessionId
  )) as { nodes: AXNode[] };

  const nodeMap = new Map<number, RefNode>();
  const lines: string[] = [];
  let refCounter = 1;

  for (const node of nodes) {
    if (refCounter > limit) break;

    const role = node.role?.value?.toLowerCase() || '';
    if (!role || role === 'none' || role === 'generic') continue;
    if (interactive && !INTERACTIVE_ROLES.has(role)) continue;

    const name = node.name?.value || '';
    const attrs: string[] = [];

    for (const prop of node.properties || []) {
      const propName = prop.name;
      const propValue = prop.value?.value;
      if (propName === 'disabled' && propValue === true) attrs.push('disabled');
      if (propName === 'checked' && propValue === true) attrs.push('checked');
      if (propName === 'selected' && propValue === true) attrs.push('selected');
      if (propName === 'expanded' && propValue === true) attrs.push('expanded');
      if (propName === 'required' && propValue === true) attrs.push('required');
      if (propName === 'readonly' && propValue === true) attrs.push('readonly');
      if (propName === 'invalid' && propValue === true) attrs.push('invalid');
    }

    const ref = refCounter++;
    const refNode: RefNode = {
      ref,
      role,
      name,
      attrs,
      backendNodeId: node.backendDOMNodeId,
    };

    if (role === 'textbox' && node.backendDOMNodeId) {
      const editor = await detectEditorForNode(cdp, sessionId, node.backendDOMNodeId);
      if (editor) refNode.editor = editor;
    }

    nodeMap.set(ref, refNode);

    const attrStr = attrs.length > 0 ? ` [${attrs.join('] [')}]` : '';
    const editorStr = refNode.editor ? ` [editor=${refNode.editor}]` : '';
    const nameStr = name ? ` "${truncate(name, 50)}"` : '';
    const line = compact
      ? `${role}${nameStr} [ref=${ref}]${attrStr}${editorStr}`
      : `- ${role}${nameStr} [ref=${ref}]${attrStr}${editorStr}`;
    lines.push(line);
  }

  return { refs: lines.join('\n'), nodeMap, opts: { interactive, limit } };
}


export async function resolveRefToCoords(
  cdp: CDPClient,
  sessionId: string,
  nodeMap: Map<number, RefNode>,
  ref: number
): Promise<{ x: number; y: number }> {
  const node = nodeMap.get(ref);
  if (!node) throw new Error(`Ref ${ref} not found`);
  if (!node.backendNodeId) throw new Error(`Ref ${ref} has no DOM node`);

  const { model } = (await cdp.send(
    'DOM.getBoxModel',
    { backendNodeId: node.backendNodeId },
    sessionId
  )) as { model: { content: number[] } };

  const [x1, y1, x2, y2, x3, y3, x4, y4] = model.content;
  const centerX = (x1 + x2 + x3 + x4) / 4;
  const centerY = (y1 + y2 + y3 + y4) / 4;

  return { x: centerX, y: centerY };
}
