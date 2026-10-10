import { afterEach, describe, expect, it } from 'vitest';
import { DaemonVitals, installSpanLog, levelEnabled, parseLogLevel, span, spanSync, type LogFields, type LogLevel } from './diagnostics.js';

interface Line { level: LogLevel; message: string; fields?: LogFields }

function collector(): { lines: Line[]; log: (level: LogLevel, message: string, fields?: LogFields) => void } {
  const lines: Line[] = [];
  return { lines, log: (level, message, fields) => { lines.push({ level, message, fields }); } };
}

function blockFor(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => installSpanLog(null));

describe('daemon log levels', () => {
  it('orders debug < info < warn < error and rejects unknown names', () => {
    expect(levelEnabled('DEBUG', 'INFO')).toBe(false);
    expect(levelEnabled('INFO', 'INFO')).toBe(true);
    expect(levelEnabled('WARN', 'INFO')).toBe(true);
    expect(levelEnabled('DEBUG', 'DEBUG')).toBe(true);
    expect(levelEnabled('INFO', 'ERROR')).toBe(false);
    expect(levelEnabled('FATAL', 'ERROR')).toBe(true);
    expect(parseLogLevel('debug')).toBe('DEBUG');
    expect(parseLogLevel('verbose')).toBeUndefined();
  });
});

describe('spans', () => {
  it('a synchronous section past the threshold is a span.slow warning naming it and its duration', () => {
    const c = collector();
    installSpanLog(c.log, { slowSyncMs: 40 });
    spanSync('test.blocker', () => blockFor(80), () => ({ rows: 7 }));
    const slow = c.lines.find((l) => l.fields?.event === 'span.slow');
    expect(slow?.level).toBe('WARN');
    expect(slow?.fields).toMatchObject({ span: 'test.blocker', kind: 'sync', rows: 7 });
    expect(slow?.fields?.durMs as number).toBeGreaterThanOrEqual(70);
  });

  it('a fast section and every async section log at debug only', async () => {
    const c = collector();
    installSpanLog(c.log, { slowSyncMs: 1_000 });
    spanSync('test.fast', () => 1);
    await span('test.async', () => sleep(30));
    expect(c.lines.map((l) => [l.level, l.fields?.span])).toEqual([['DEBUG', 'test.fast'], ['DEBUG', 'test.async']]);
  });

  it('records nothing and returns the value unchanged when no daemon log is installed', () => {
    expect(spanSync('test.none', () => 42)).toBe(42);
  });
});

describe('DaemonVitals', () => {
  it('a blocked event loop is a loop.stall warning that names the section that blocked it', async () => {
    const c = collector();
    installSpanLog(c.log, { slowSyncMs: 10_000 });
    const vitals = new DaemonVitals({ log: c.log, probeMs: 50, stallMs: 200, reportMs: 60_000 });
    vitals.start();
    try {
      await sleep(120);
      spanSync('test.hog', () => blockFor(450));
      await sleep(150);
      const stall = c.lines.find((l) => l.fields?.event === 'loop.stall');
      expect(stall?.level).toBe('WARN');
      expect(stall?.fields?.stalledMs as number).toBeGreaterThanOrEqual(300);
      expect((stall?.fields?.blockers as Array<{ span: string }>).map((b) => b.span)).toContain('test.hog');
      expect(stall?.message).toContain('test.hog');

      vitals.report();
      const report = c.lines.find((l) => l.fields?.event === 'vitals');
      expect(report?.level).toBe('INFO');
      expect((report?.fields?.loop as { maxMs: number }).maxMs).toBeGreaterThanOrEqual(300);
      expect((report?.fields?.topSpans as Array<{ name: string; count: number }>)).toContainEqual(expect.objectContaining({ name: 'test.hog', count: 1 }));
    } finally {
      vitals.stop();
    }
  });

  it('a stall with no instrumented section says so rather than blaming one', async () => {
    const c = collector();
    installSpanLog(c.log);
    const vitals = new DaemonVitals({ log: c.log, probeMs: 50, stallMs: 200 });
    vitals.start();
    try {
      await sleep(120);
      blockFor(400);
      await sleep(150);
      const stall = c.lines.find((l) => l.fields?.event === 'loop.stall');
      expect(stall?.fields?.blockers).toEqual([]);
      expect(stall?.message).toContain('no instrumented section');
    } finally {
      vitals.stop();
    }
  });
});
