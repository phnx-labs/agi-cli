/** Progress routing for `agents run --lease`. Output before `LEASE_AGENT_MARKER` is setup noise
 * (shown as spinner text, captured for a failure dump); output after is the agent's, printed
 * verbatim. The marker line is swallowed. */

/** Sentinel echoed on the box right before `agents run`. Distinctive + collision-proof. */
export const LEASE_AGENT_MARKER = '___AGENTS_LEASE_AGENT_OUTPUT_b1f4c2___';

/** A structured setup step parsed from a `___PHASE_<name>___` sentinel the bootstrap echoes before
 * each block. The command layer renders these; the lib never prints (see `renderStepLine`). */
export type LeaseStep = { name: string; detail?: string; elapsedMs?: number };

const PHASE_PREFIX = '___PHASE_';
const PHASE_SUFFIX = '___';

/** The sentinel line announcing phase `name`. Distinct from `LEASE_AGENT_MARKER`, which does not
 * start with `___PHASE_`. */
export function leasePhaseSentinel(name: string): string {
  return `${PHASE_PREFIX}${name}${PHASE_SUFFIX}`;
}

/** Parse a phase name out of a sentinel line, or null when the line is not one. */
function parsePhaseSentinel(line: string): string | null {
  const t = line.trim();
  if (!t.startsWith(PHASE_PREFIX) || !t.endsWith(PHASE_SUFFIX) || t.length <= PHASE_PREFIX.length + PHASE_SUFFIX.length) {
    return null;
  }
  const name = t.slice(PHASE_PREFIX.length, t.length - PHASE_SUFFIX.length);
  // Phase names are lowercase kebab tokens; this also rejects the agent marker's
  // underscore-laden tail if it ever changed to share the ___PHASE_ prefix.
  return /^[a-z0-9-]+$/.test(name) ? name : null;
}

/** Human labels for the known bootstrap phases. Falls back to the raw name. */
const STEP_LABELS: Record<string, string> = {
  sync: 'Syncing workspace',
  install: 'Installing agents-cli',
  runtime: 'Installing agent runtimes',
  creds: 'Provisioning credentials',
  'copy-setup': 'Copying your setup',
  'joined-tailnet': 'Joined tailnet',
};

/** Human-readable elapsed: "0.8s", "3.4s", "1m 5s". */
function formatElapsed(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/** Render one lease step as a single human line for the command layer to print. Self-contained: the
 * lib never writes to a stream. */
export function renderStepLine(step: LeaseStep): string {
  const label = STEP_LABELS[step.name] ?? step.name;
  const detail = step.detail ? ` — ${step.detail}` : '';
  const elapsed = step.elapsedMs !== undefined ? ` (${formatElapsed(step.elapsedMs)})` : '';
  return `${label}${detail}${elapsed}`;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface Spinner {
  /** Begin animating a phase (renders `frame text` on one line, TTY only). */
  start(text: string): void;
  /** Change the text shown; rendered on the next throttled tick (no write itself). */
  update(text: string): void;
  /** Finalize the current line with a symbol (e.g. ✔) and a newline. */
  stopAndPersist(symbol: string, text: string): void;
  /** Clear the current animated line without persisting anything. */
  stop(): void;
  /** True while a phase is active. */
  readonly active: boolean;
}

/** A minimal self-throttled spinner. Unlike `ora` it does not hook the stream's `write`, writing
 * one short line per fixed tick, so it cannot re-render-loop when a lease streams output past it.
 * Non-TTY prints each label once. One phase at a time; stop it before writing other output. */
export function createSpinner(opts: {
  stream?: { write(s: string): unknown; isTTY?: boolean };
  enabled?: boolean;
  intervalMs?: number;
} = {}): Spinner {
  const stream = opts.stream ?? process.stderr;
  const enabled = opts.enabled ?? !!(stream as { isTTY?: boolean }).isTTY;
  const intervalMs = opts.intervalMs ?? 120;
  const CLEAR = '\r\u001b[2K';
  let text = '';
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  const write = (s: string) => stream.write(s);
  return {
    start(t: string) {
      text = t;
      running = true;
      if (!enabled) {
        write(`${t}\n`);
        return;
      }
      if (timer) return;
      frame = 0;
      write(`${CLEAR}${SPINNER_FRAMES[0]} ${text}`);
      timer = setInterval(() => {
        frame = (frame + 1) % SPINNER_FRAMES.length;
        write(`${CLEAR}${SPINNER_FRAMES[frame]} ${text}`);
      }, intervalMs);
    },
    update(t: string) {
      text = t; // next tick renders it; on a non-TTY we stay silent (no flood)
    },
    stopAndPersist(symbol: string, t: string) {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      running = false;
      write(enabled ? `${CLEAR}${symbol} ${t}\n` : `${symbol} ${t}\n`);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
        if (enabled) write(CLEAR);
      }
      running = false;
    },
    get active() {
      return running;
    },
  };
}

interface LeaseOutputRouter {
  /** Feed a raw chunk of the crabbox run's combined stdout/stderr. */
  push(chunk: string): void;
  /** Flush any buffered partial line (call once the stream closes). */
  end(): void;
  /** True once the agent-output marker has been seen. */
  sawAgent(): boolean;
  /** The setup lines seen so far (for a failure dump). */
  setupLines(): string[];
  /** The structured steps parsed from phase sentinels so far. */
  steps(): LeaseStep[];
}

/** Split the crabbox run stream at `LEASE_AGENT_MARKER`: `onSetupLine` per complete line before it,
 * `onAgentChunk` raw text after (not line-buffered, so agent output is live). `___PHASE_<name>___`
 * lines are swallowed and surfaced via `onStep`. */
export function createLeaseOutputRouter(cb: {
  onSetupLine: (line: string) => void;
  onAgentChunk: (chunk: string) => void;
  onStep?: (step: LeaseStep) => void;
  marker?: string;
  now?: () => number;
}): LeaseOutputRouter {
  const marker = cb.marker ?? LEASE_AGENT_MARKER;
  const now = cb.now;
  let seen = false;
  let buf = '';
  const setup: string[] = [];
  const stepList: LeaseStep[] = [];
  let lastStepAt: number | undefined = now ? now() : undefined;

  const emitLine = (line: string) => {
    const t = line.replace(/\r$/, '');
    if (t.trim()) {
      setup.push(t);
      cb.onSetupLine(t);
    }
  };

  const emitStep = (name: string) => {
    let elapsedMs: number | undefined;
    if (now) {
      const t = now();
      elapsedMs = lastStepAt !== undefined ? t - lastStepAt : undefined;
      lastStepAt = t;
    }
    const step: LeaseStep = elapsedMs !== undefined ? { name, elapsedMs } : { name };
    stepList.push(step);
    cb.onStep?.(step);
  };

  return {
    push(chunk: string) {
      if (seen) {
        cb.onAgentChunk(chunk);
        return;
      }
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.includes(marker)) {
          seen = true;
          // Anything already buffered past the marker is agent output.
          if (buf) {
            cb.onAgentChunk(buf);
            buf = '';
          }
          return;
        }
        const phase = parsePhaseSentinel(line);
        if (phase !== null) {
          emitStep(phase); // swallow the sentinel; report a structured step
          continue;
        }
        emitLine(line);
      }
      // A trailing partial line stays in `buf` — it may be the marker forming.
    },
    end() {
      if (!seen && buf) emitLine(buf);
      buf = '';
    },
    sawAgent() {
      return seen;
    },
    setupLines() {
      return setup;
    },
    steps() {
      return stepList;
    },
  };
}
