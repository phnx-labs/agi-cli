import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { CDPClient } from './cdp.js';
import { clickAtCoords } from './input.js';
import { getBrowserRuntimeDir } from './profiles.js';
import { resolveRefToCoords, type RefNode } from './refs.js';

export function getUploadStagingDir(): string {
  return path.join(getBrowserRuntimeDir(), 'uploads');
}

export function stageUploadFile(source: string): string {
  if (!path.isAbsolute(source)) {
    throw new Error(`upload-stage: source path must be absolute: ${source}`);
  }
  const resolvedSource = fs.realpathSync(source);
  const stat = fs.statSync(resolvedSource);
  if (!stat.isFile()) {
    throw new Error(`upload-stage: source path is not a file: ${source}`);
  }

  const stagingDir = getUploadStagingDir();
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stagingDir, 0o700);

  const stagedPath = path.join(
    stagingDir,
    `${randomBytes(8).toString('hex')}${path.extname(source)}`
  );
  fs.copyFileSync(resolvedSource, stagedPath);
  return stagedPath;
}

const RESOLVE_FILE_INPUT_FN = `(function() {
  const start = this;
  // Walk multiple paths to find an <input type=file>:
  //   1. The node itself (when the AX backend node IS the input).
  //   2. Its ancestors via parentElement (custom button wrappers).
  //   3. closest('input[type=file]') (handles label/span/button inside or
  //      near a file input).
  //   4. Across user-agent shadow boundaries via getRootNode().host
  //      (Chromium's internal shadow-button pseudo-element for file inputs).
  //   5. If the AX backend node is associated with a <label for=...>, follow
  //      the htmlFor relationship.
  //   6. Last resort: if the start node was a click target that fires
  //      input.click() inside a click handler, fall back to the unique
  //      <input type=file> on the page (when there is exactly one).
  let el = start;
  for (let i = 0; i < 8 && el; i++) {
    if (el.tagName === 'INPUT' && el.type === 'file') return el;
    if (el.closest) {
      const found = el.closest('input[type=file]');
      if (found) return found;
    }
    if (el.tagName === 'LABEL' && el.htmlFor) {
      const t = document.getElementById(el.htmlFor);
      if (t && t.tagName === 'INPUT' && t.type === 'file') return t;
    }
    const root = el.getRootNode && el.getRootNode();
    if (root && root.host && root !== document) {
      el = root.host;
      continue;
    }
    el = el.parentElement;
  }
  // Final fallback: if exactly one file input exists on the page, use it.
  // This handles cases where the AX tree exposes the input as an internal
  // pseudo-button whose parentElement is null. A page with a single uploader
  // (Slack composer, Notion image block, Canva ingredient) hits this branch.
  const all = document.querySelectorAll('input[type=file]');
  if (all.length === 1) return all[0];
  return null;
})`;

/** Pattern A — direct file input via `DOM.setFileInputFiles`. */
export async function uploadToFileInput(
  cdp: CDPClient,
  sessionId: string,
  backendNodeId: number,
  files: string[]
): Promise<void> {
  validateFiles(files);

  const resolvedId = await resolveActualFileInput(cdp, sessionId, backendNodeId);
  await cdp.send(
    'DOM.setFileInputFiles',
    { files, backendNodeId: resolvedId },
    sessionId
  );
}

async function resolveActualFileInput(
  cdp: CDPClient,
  sessionId: string,
  backendNodeId: number
): Promise<number> {
  const { object } = await cdp.send<{ object: { objectId?: string } }>(
    'DOM.resolveNode',
    { backendNodeId },
    sessionId
  );
  if (!object.objectId) return backendNodeId;
  const objectId = object.objectId;
  try {
    const { result } = await cdp.send<{ result: { objectId?: string } }>(
      'Runtime.callFunctionOn',
      { objectId, functionDeclaration: RESOLVE_FILE_INPUT_FN, returnByValue: false },
      sessionId
    );
    if (!result.objectId) {
      throw new Error('Ref is not (and is not contained in) an <input type=file>');
    }
    const inputObjectId = result.objectId;
    try {
      const { node } = await cdp.send<{ node: { backendNodeId: number } }>(
        'DOM.describeNode',
        { objectId: inputObjectId },
        sessionId
      );
      return node.backendNodeId;
    } finally {
      await cdp.send('Runtime.releaseObject', { objectId: inputObjectId }, sessionId);
    }
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId }, sessionId);
  }
}

const DRAG_DROP_FN = `(function(files) {
  const el = this;
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const dt = new DataTransfer();
  for (const f of files) {
    const u8 = Uint8Array.from(atob(f.bytes), c => c.charCodeAt(0));
    const blob = new Blob([u8], { type: f.type || 'application/octet-stream' });
    const file = new File([blob], f.name, { type: f.type || 'application/octet-stream' });
    dt.items.add(file);
  }
  function dispatch(type) {
    // Chromium does not honor the dataTransfer field in DragEventInit for
    // synthetic events. Build the DragEvent with no dataTransfer in the init,
    // then override the event dataTransfer getter via defineProperty so
    // page-level listeners see the File list we constructed.
    const ev = new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
    });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    el.dispatchEvent(ev);
  }
  dispatch('dragenter');
  dispatch('dragover');
  dispatch('drop');
  return { dispatched: 3, files: files.length };
})`;

/** Pattern B — synthetic drag-drop onto a target node. */
export async function uploadToDropTarget(
  cdp: CDPClient,
  sessionId: string,
  backendNodeId: number,
  files: string[]
): Promise<void> {
  validateFiles(files);

  const payload = files.map((p) => ({
    name: path.basename(p),
    type: mimeFromExt(p),
    bytes: fs.readFileSync(p).toString('base64'),
  }));

  const { object } = await cdp.send<{ object: { objectId?: string } }>(
    'DOM.resolveNode',
    { backendNodeId },
    sessionId
  );
  if (!object.objectId) {
    throw new Error('Drop target node could not be resolved');
  }
  const objectId = object.objectId;

  try {
    const r = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: unknown }>(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: DRAG_DROP_FN,
        arguments: [{ value: payload }],
        returnByValue: true,
        awaitPromise: true,
      },
      sessionId
    );
    if (r.exceptionDetails) {
      throw new Error('Drop dispatch threw: ' + JSON.stringify(r.exceptionDetails));
    }
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId }, sessionId);
  }
}

/**
 * Pattern C — click a trigger, intercept the OS file chooser, feed files.
 *
 * `Page.setInterceptFileChooserDialog` must be enabled before the click; the
 * chooser only fires once, so we register a single-shot handler ahead of time.
 * Auto-attached child sessions matter here: the chooser event arrives on the
 * session whose page hosts the input, which is the same session we used for
 * the click — so we filter event params by sessionId.
 */
export async function uploadViaFileChooser(
  cdp: CDPClient,
  sessionId: string,
  triggerRef: { node: RefNode; nodeMap: Map<number, RefNode> },
  files: string[],
  timeoutMs = 5000
): Promise<void> {
  validateFiles(files);

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send(
    'Page.setInterceptFileChooserDialog',
    { enabled: true },
    sessionId
  );

  let opened: { backendNodeId: number } | null = null;
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const wait = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const handler = (params: Record<string, unknown>) => {
    const ev = params as { backendNodeId?: number; mode?: string };
    if (typeof ev.backendNodeId === 'number') {
      opened = { backendNodeId: ev.backendNodeId };
      resolve();
    }
  };
  cdp.on('Page.fileChooserOpened', handler);

  const timer = setTimeout(() => {
    reject(new Error(`File chooser did not open within ${timeoutMs}ms — is the trigger ref correct?`));
  }, timeoutMs);

  try {
    const { x, y } = await resolveRefToCoords(
      cdp,
      sessionId,
      triggerRef.nodeMap,
      triggerRef.node.ref
    );
    await clickAtCoords(cdp, sessionId, x, y);
    await wait;

    await cdp.send(
      'Page.handleFileChooser',
      { action: 'accept', files },
      sessionId
    );
    // Some Chromium builds expect setFileInputFiles instead of handleFileChooser.
    // We try handleFileChooser first because it's the documented path for
    // intercepted dialogs; if Chromium rejects it (older protocol), fall back
    // to setFileInputFiles using the backendNodeId from the event.
  } catch (err) {
    if (opened && err instanceof Error && /not supported|not found|Method/i.test(err.message)) {
      await cdp.send(
        'DOM.setFileInputFiles',
        { files, backendNodeId: (opened as { backendNodeId: number }).backendNodeId },
        sessionId
      );
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timer);
    cdp.off('Page.fileChooserOpened', handler);
    await cdp.send(
      'Page.setInterceptFileChooserDialog',
      { enabled: false },
      sessionId
    ).catch(() => {});
  }
}

function validateFiles(files: string[]): void {
  if (!files || files.length === 0) {
    throw new Error('At least one file path is required');
  }
  const stagingDir = getUploadStagingDir();
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stagingDir, 0o700);
  const resolvedStagingDir = fs.realpathSync(stagingDir);

  for (const f of files) {
    if (!path.isAbsolute(f)) {
      throw new Error(`Upload path must be absolute: ${f}`);
    }
    if (!fs.existsSync(f)) {
      throw new Error(`File not found: ${f}`);
    }
    const resolvedFile = fs.realpathSync(f);
    if (!isPathInside(resolvedFile, resolvedStagingDir)) {
      throw new Error(
        `upload: path ${f} is outside the upload staging directory ${stagingDir}. ` +
          `Stage files via 'agents browser upload-stage <path>' first.`
      );
    }
  }
}

function isPathInside(candidate: string, dir: string): boolean {
  const rel = path.relative(dir, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

export function mimeFromExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/**
 * Inspect a ref's DOM node to decide which pattern fits when the caller
 * didn't specify. Returns 'input' if the node is `<input type=file>`,
 * otherwise 'drop'. Chooser interception (Pattern C) is never auto-selected
 * because it requires clicking the ref, which mutates page state — opt-in only.
 */
export async function detectUploadPattern(
  cdp: CDPClient,
  sessionId: string,
  backendNodeId: number
): Promise<'input' | 'drop'> {
  const { node } = await cdp.send<{
    node: { nodeName?: string; attributes?: string[] };
  }>('DOM.describeNode', { backendNodeId, depth: 0 }, sessionId);

  if (isFileInputNode(node)) return 'input';

  // The node itself isn't <input type=file>, but it might be a button or
  // shadow-DOM descendant *inside* one — that's what the accessibility tree
  // surfaces for file inputs. Walk up to confirm before falling back to drop.
  const { object } = await cdp.send<{ object: { objectId?: string } }>(
    'DOM.resolveNode',
    { backendNodeId },
    sessionId
  );
  if (!object.objectId) return 'drop';
  const objectId = object.objectId;
  try {
    const { result } = await cdp.send<{ result: { objectId?: string } }>(
      'Runtime.callFunctionOn',
      { objectId, functionDeclaration: RESOLVE_FILE_INPUT_FN, returnByValue: false },
      sessionId
    );
    if (result.objectId) {
      await cdp.send('Runtime.releaseObject', { objectId: result.objectId }, sessionId);
      return 'input';
    }
    return 'drop';
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId }, sessionId);
  }
}

function isFileInputNode(node: { nodeName?: string; attributes?: string[] }): boolean {
  const tag = (node.nodeName ?? '').toLowerCase();
  if (tag !== 'input') return false;
  const attrs = node.attributes ?? [];
  for (let i = 0; i < attrs.length; i += 2) {
    if (attrs[i] === 'type' && attrs[i + 1]?.toLowerCase() === 'file') {
      return true;
    }
  }
  return false;
}
