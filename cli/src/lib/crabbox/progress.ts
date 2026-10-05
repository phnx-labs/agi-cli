
export const LEASE_AGENT_MARKER = '___AGENTS_LEASE_AGENT_OUTPUT_b1f4c2___';

export type LeaseStep = { name: string; detail?: string; elapsedMs?: number };

const PHASE_PREFIX = '___PHASE_';
const PHASE_SUFFIX = '___';

export function leasePhaseSentinel(name: string): string {
  return `${PHASE_PREFIX}${name}${PHASE_SUFFIX}`;
}

function parsePhaseSentinel(line: string): string | null {
  const t = line.trim();
  if (!t.startsWith(PHASE_PREFIX) || !t.endsWith(PHASE_SUFFIX) || t.length <= PHASE_PREFIX.length + PHASE_SUFFIX.length) {
    return null;
  }
  const name = t.slice(PHASE_PREFIX.length, t.length - PHASE_SUFFIX.length);
  return /^[a-z0-9-]+$/.test(name) ? name : null;
}

const STEP_LABELS: Record<string, string> = {
  sync: 'Syncing workspace',
  install: 'Installing agents-cli',
  runtime: 'Installing agent runtimes',
  creds: 'Provisioning credentials',
  'copy-setup': 'Copying your setup',
  'joined-tailnet': 'Joined tailnet',
};

function formatElapsed(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export function renderStepLine(step: LeaseStep): string {
  const label = STEP_LABELS[step.name] ?? step.name;
  const detail = step.detail ? ` — ${step.detail}` : '';
  const elapsed = step.elapsedMs !== undefined ? ` (${formatElapsed(step.elapsedMs)})` : '';
  return `${label}${detail}${elapsed}`;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface Spinner {
  start(text: string): void;
  update(text: string): void;
  stopAndPersist(symbol: string, text: string): void;
  stop(): void;
  readonly active: boolean;
}

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
      text = t;
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
  push(chunk: string): void;
  end(): void;
  sawAgent(): boolean;
  setupLines(): string[];
  steps(): LeaseStep[];
}

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
          if (buf) {
            cb.onAgentChunk(buf);
            buf = '';
          }
          return;
        }
        const phase = parsePhaseSentinel(line);
        if (phase !== null) {
          emitStep(phase);
          continue;
        }
        emitLine(line);
      }
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
