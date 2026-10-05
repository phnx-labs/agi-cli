import * as path from 'path';
import { notifyDesktop, type DesktopNotification } from './menubar/notify-desktop.js';

interface RunNotifyContext {
  agent: string;
  name?: string;
  prompt?: string;
  cwd?: string;
  host?: string;
  url?: string;
  sessionId?: string;
  reportPath?: string;
}

const BODY_MAX = 120;

function shorten(text: string, max = BODY_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function buildRunFinishNotification(
  ctx: RunNotifyContext,
  exitCode: number,
): DesktopNotification {
  const label = ctx.name?.trim() || ctx.agent;
  const project = ctx.cwd ? path.basename(ctx.cwd) : undefined;
  const where = [project, ctx.host].filter(Boolean).join(' · ');
  const ok = exitCode === 0;
  const n: DesktopNotification = {
    title: ok ? `${label} finished` : `${label} failed`,
    body: shorten(ctx.prompt?.trim() || `${ctx.agent} run`),
    agent: ctx.agent,
    category: ok ? 'done' : 'failure',
  };
  if (where) n.subtitle = where;
  if (ctx.sessionId) n.sessionId = ctx.sessionId;
  if (ctx.reportPath) n.action = `open:${ctx.reportPath}`;
  else if (ctx.url) n.action = `url:${ctx.url}`;
  const choices: { id: string; label: string }[] = [];
  if (ctx.reportPath) choices.push({ id: 'open-report', label: 'Open report' });
  if (ctx.url) choices.push({ id: 'open-pr', label: 'Open PR' });
  if (choices.length) n.choices = choices;
  return n;
}

export function armRunFinishNotification(ctx: RunNotifyContext): void {
  process.on('exit', (code) => {
    notifyDesktop(buildRunFinishNotification(ctx, code));
  });
}
