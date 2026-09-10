/** Native Apple Events transport. Never uses CDP or launches an Arc process. */
import { spawn } from 'node:child_process';

export interface ArcNativeTabRef {
  windowId: string;
  spaceId: string;
  tabId: string;
}
export interface ArcNativeTab extends ArcNativeTabRef { url: string; title: string }
export interface ArcEnumeratedSpace {
  windowId: string;
  spaceId: string;
  spaceTitle: string;
  activeTabId?: string;
  tabs: ArcNativeTab[];
}

export const ARC_NATIVE_CAPABILITIES = Object.freeze({
  createTab: true, navigate: true, evaluateSync: true, closeTab: true, enumerate: true,
  screenshot: false, asyncEvaluate: false, networkCapture: false, consoleCapture: false,
  upload: false, pdf: false, background: false,
} as const);

export class ArcNativeCapabilityError extends Error {
  constructor(public readonly capability: string, message?: string) {
    super(message ?? `Native Arc does not support ${capability}. Use a configured browser with that capability.`);
    this.name = 'ArcNativeCapabilityError';
  }
}

const TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const APP_ID = 'company.thebrowser.Browser';
let operationQueue: Promise<unknown> = Promise.resolve();

/** Serialize native operations in this service, including failures. */
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.catch(() => undefined);
  return result;
}

/** AppleScript strings do not implement JSON's \uXXXX escape syntax. */
export function escapeAppleScriptString(value: string): string {
  const parts = value.split(/([\u0000-\u001f])/u).filter(Boolean);
  if (parts.length === 0) return '""';
  return '(' + parts.map(part => part.length === 1 && part.charCodeAt(0) < 32
    ? `(character id ${part.charCodeAt(0)})`
    : `"${part.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(' & ') + ')';
}

/** No shell, bounded output and lifetime, and no blocking of the shared daemon. */
export function execAppleScript(source: string, timeoutMs = TIMEOUT_MS): Promise<string> {
  if (process.platform !== 'darwin') return Promise.reject(new Error('Native Arc requires macOS.'));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('Invalid Apple Events timeout.'));
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const abort = (error: Error) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => abort(new Error(`Arc Apple Event timed out after ${timeoutMs}ms.`)), timeoutMs);
    for (const [stream, target] of [[child.stdout, chunks], [child.stderr, errors]] as const) {
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) abort(new Error('Arc Apple Event output exceeded the safety limit.'));
        else target.push(chunk);
      });
    }
    child.stdin.on('error', error => abort(error));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) { reject(failure); return; }
      if (code !== 0) {
        reject(new Error(`Arc Apple Event failed (${signal ?? code}): ${Buffer.concat(errors).toString('utf8').trim()}`));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
    child.stdin.end(source);
  });
}

// Foundation serializes arbitrary titles/URLs, including tabs, newlines and Unicode.
// Delimiter splitting is not a safe wire format for browser-controlled strings.
const PRELUDE = `use framework "Foundation"
use scripting additions
on jsonString(rawValue)
  if rawValue is missing value then set rawValue to ""
  set wrapped to {current application's NSString's stringWithString:(rawValue as text)}
  set jsonData to current application's NSJSONSerialization's dataWithJSONObject:wrapped options:0 |error|:(missing value)
  set jsonText to (current application's NSString's alloc()'s initWithData:jsonData encoding:(current application's NSUTF8StringEncoding)) as text
  return text 2 thru -2 of jsonText
end jsonString
`;

function script(body: string): string {
  return `${PRELUDE}\nif application id "${APP_ID}" is not running then error "Arc is not running. Open it before starting a native task."
tell application id "${APP_ID}"
${body}
end tell`;
}

function identity(value: string, kind: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new Error(`Missing or invalid native ${kind} ID.`);
  return escapeAppleScriptString(value);
}

/**
 * Resolve all ordinals afresh INSIDE the operation; never persist an index.
 *
 * Every `X of every Y` below is ONE Apple Event returning a list. The naive
 * form (`id of tab ti of targetSpace` inside a repeat) costs one round trip per
 * tab — on a 30-tab Space that alone took the create path past the 15 s budget
 * from inside the shared daemon, whose loop also serves everything else.
 */
function lookup(ref: Pick<ArcNativeTabRef, 'windowId' | 'spaceId'> & { tabId?: string }, missing = 'error "Native Arc target is no longer in its original window and Space."'): string {
  return `set targetWindowIndex to 0
set windowIds to id of every window
set windowVisible to visible of every window
repeat with wi from 1 to count of windowIds
  if (item wi of windowIds as text) is ${identity(ref.windowId, 'window')} and (item wi of windowVisible) then set targetWindowIndex to wi as integer
end repeat
if targetWindowIndex is 0 then
  ${missing}
end if
set targetSpaceIndex to 0
set spaceIds to id of every space of window targetWindowIndex
repeat with si from 1 to count of spaceIds
  if (item si of spaceIds as text) is ${identity(ref.spaceId, 'Space')} then set targetSpaceIndex to si as integer
end repeat
if targetSpaceIndex is 0 then
  ${missing}
end if
set targetSpace to a reference to space targetSpaceIndex of window targetWindowIndex
${ref.tabId === undefined ? '' : `set targetTabIndex to 0
set tabIds to id of every tab of targetSpace
repeat with ti from 1 to count of tabIds
  if (item ti of tabIds as text) is ${identity(ref.tabId, 'tab')} then set targetTabIndex to ti as integer
end repeat
if targetTabIndex is 0 then
  ${missing}
end if
set targetTab to a reference to tab targetTabIndex of targetSpace`}`;
}

const TAB_JSON = `"{\\"windowId\\":" & my jsonString(id of window targetWindowIndex) & ",\\"spaceId\\":" & my jsonString(id of targetSpace) & ",\\"tabId\\":" & my jsonString(id of targetTab) & ",\\"url\\":" & my jsonString(URL of targetTab) & ",\\"title\\":" & my jsonString(title of targetTab) & "}"`;

function parse<T>(raw: string): T {
  try { return JSON.parse(raw) as T; }
  catch { throw new Error('Arc returned an invalid native response; no target was adopted.'); }
}

export function isArcRunning(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return serialized(async () => (await execAppleScript(`return application id "${APP_ID}" is running`)) === 'true');
}

export function enumerateArcSpaces(): Promise<ArcEnumeratedSpace[]> {
  return serialized(async () => parse(await execAppleScript(script(`set resultText to "["
set separator to ""
set windowIds to id of every window
set windowVisible to visible of every window
repeat with wi from 1 to count of windowIds
  if item wi of windowVisible then
    set targetWindowIndex to wi as integer
    set windowIdText to my jsonString(item wi of windowIds)
    set activeId to ""
    try
      set activeId to id of active tab of window targetWindowIndex as text
    end try
    set spaceIds to id of every space of window targetWindowIndex
    set spaceTitles to title of every space of window targetWindowIndex
    repeat with si from 1 to count of spaceIds
      set targetSpace to a reference to space si of window targetWindowIndex
      set resultText to resultText & separator & "{\\"windowId\\":" & windowIdText & ",\\"spaceId\\":" & my jsonString(item si of spaceIds) & ",\\"spaceTitle\\":" & my jsonString(item si of spaceTitles) & ",\\"activeTabId\\":" & my jsonString(activeId) & ",\\"tabs\\":["
      set tabIds to id of every tab of targetSpace
      set tabUrls to URL of every tab of targetSpace
      set tabTitles to title of every tab of targetSpace
      set tabSeparator to ""
      repeat with ti from 1 to count of tabIds
        set resultText to resultText & tabSeparator & "{\\"windowId\\":" & windowIdText & ",\\"spaceId\\":" & my jsonString(item si of spaceIds) & ",\\"tabId\\":" & my jsonString(item ti of tabIds) & ",\\"url\\":" & my jsonString(item ti of tabUrls) & ",\\"title\\":" & my jsonString(item ti of tabTitles) & "}"
        set tabSeparator to ","
      end repeat
      set resultText to resultText & "]}"
      set separator to ","
    end repeat
  end if
end repeat
return resultText & "]"`))));
}

/** Caller durably records marker intent before calling; never use a real page URL as ownership. */
export function createArcTab(target: Pick<ArcNativeTabRef, 'windowId' | 'spaceId'>, markerUrl: string): Promise<ArcNativeTab> {
  if (!markerUrl || markerUrl.length > 16_384) return Promise.reject(new Error('A bounded unique tab creation marker URL is required.'));
  return serialized(async () => parse(await execAppleScript(script(`${lookup(target)}
set existingUrls to URL of every tab of targetSpace
repeat with ti from 1 to count of existingUrls
  if (item ti of existingUrls as text) is ${escapeAppleScriptString(markerUrl)} then error "Creation marker already exists; reconcile the saved intent instead of creating another tab."
end repeat
tell targetSpace
  make new tab with properties {URL:${escapeAppleScriptString(markerUrl)}}
end tell
set matchCount to 0
set targetTabIndex to 0
-- Arc commits the new tab's URL asynchronously: read back immediately it is
-- still empty. Poll briefly (bounded) until the marker shows up.
repeat with attempt from 1 to 30
  set matchCount to 0
  set createdUrls to URL of every tab of targetSpace
  repeat with ti from 1 to count of createdUrls
    if (item ti of createdUrls as text) is ${escapeAppleScriptString(markerUrl)} then
      set matchCount to matchCount + 1
      set targetTabIndex to ti as integer
    end if
  end repeat
  if matchCount is not 0 then exit repeat
  delay 0.1
end repeat
if matchCount is not 1 then error "Creation marker did not resolve exactly one tab; preserve the creation intent for recovery."
set targetTab to a reference to tab targetTabIndex of targetSpace
return ${TAB_JSON}`))));
}

export function resolveArcTab(ref: ArcNativeTabRef): Promise<ArcNativeTab | null> {
  return serialized(async () => parse(await execAppleScript(script(`${lookup(ref, 'return "null"')}\nreturn ${TAB_JSON}`))));
}

export function navigateArcTab(ref: ArcNativeTabRef, url: string): Promise<void> {
  return serialized(async () => {
    await execAppleScript(script(`${lookup(ref)}\nset URL of targetTab to ${escapeAppleScriptString(url)}\nreturn "navigated"`));
  });
}

/** Arc serializes a returned object once. JSON.stringify at the top level would double-encode. */
export function executeJavaScript(ref: ArcNativeTabRef, expression: string): Promise<unknown> {
  const wrapper = `(()=>{try{const value=(0,eval)(${JSON.stringify(expression)});if(value!=null&&typeof value.then==='function')return {ok:false,error:'Native Arc does not support asynchronous evaluation.'};return {ok:true,hasValue:value!==undefined,value:value===undefined?null:JSON.parse(JSON.stringify(value))}}catch(error){return {ok:false,error:String(error)}}})()`;
  return serialized(async () => {
    const result = parse<{ ok: boolean; hasValue?: boolean; value?: unknown; error?: string }>(await execAppleScript(script(`${lookup(ref)}\nreturn execute targetTab javascript ${escapeAppleScriptString(wrapper)}`)));
    if (!result || result.ok !== true) throw new Error(result?.error ?? 'Native Arc JavaScript returned no result.');
    return result.hasValue ? result.value : undefined;
  });
}

export function closeArcTab(ref: ArcNativeTabRef): Promise<'closed' | 'missing'> {
  return serialized(async () => {
    const result = await execAppleScript(script(`${lookup(ref, 'return "missing"')}\nclose targetTab\nreturn "closed"`));
    if (result !== 'closed' && result !== 'missing') throw new Error('Arc did not confirm tab cleanup.');
    return result;
  });
}

/** Explicit user-facing focus only. Evaluation and cleanup never invoke this. */
export function selectArcTab(ref: ArcNativeTabRef): Promise<void> {
  return serialized(async () => { await execAppleScript(script(`${lookup(ref)}\nselect targetTab\nreturn "selected"`)); });
}

/** AppleScript that selects `tabId` in whatever Space of window `targetWindowIndex` holds it; returns "true"/"false". */
function selectTabInWindowScript(tabId: string): string {
  return `set spaceCount to count of spaces of window targetWindowIndex
repeat with si from 1 to spaceCount
  set candidateIds to id of every tab of space si of window targetWindowIndex
  repeat with ti from 1 to count of candidateIds
    if (item ti of candidateIds as text) is ${identity(tabId, 'tab')} then
      select tab ti of space si of window targetWindowIndex
      return "true"
    end if
  end repeat
end repeat
return "false"`;
}

/**
 * Select `tabId` wherever it lives in window `windowId` (any Space). Used to put
 * the owner back on their tab after a creation that failed mid-way, when there is
 * no owned tab to check against. Returns false when the tab is gone.
 */
export function selectWindowTab(windowId: string, tabId: string): Promise<boolean> {
  return serialized(async () => (await execAppleScript(script(`set targetWindowIndex to 0
set windowIds to id of every window
set windowVisible to visible of every window
repeat with wi from 1 to count of windowIds
  if (item wi of windowIds as text) is ${identity(windowId, 'window')} and (item wi of windowVisible) then set targetWindowIndex to wi as integer
end repeat
if targetWindowIndex is 0 then return "false"
${selectTabInWindowScript(tabId)}`))) === 'true');
}

/** Restore only while the task's new tab is still selected; preserve a later human choice. */
export function restoreArcSelection(owned: ArcNativeTabRef, previousTabId: string): Promise<boolean> {
  return serialized(async () => (await execAppleScript(script(`${lookup(owned, 'return "false"')}
if (id of active tab of window targetWindowIndex as text) is not ${identity(owned.tabId, 'tab')} then return "false"
${selectTabInWindowScript(previousTabId)}`))) === 'true');
}
