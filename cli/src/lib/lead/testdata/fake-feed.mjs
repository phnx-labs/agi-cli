const row = {
  sessionId: 'abcd1234-0000-4000-8000-000000000001',
  title: 'Fix the flaky login test',
  status: 'running',
  machine: 'box-a',
  confirmedProject: 'demo',
  cwd: '/nonexistent/demo',
  previous: false,
};
const self = { ...row, sessionId: 'eeee0000-0000-4000-8000-000000000003', title: 'lead-demo' };
const other = { ...row, sessionId: 'ffff0000-0000-4000-8000-000000000002', title: 'Other project work', confirmedProject: 'elsewhere' };
const ask = (session, generation, extra = {}) => ({
  key: `box-a/${session}/${generation}`, sessionId: session, mailboxId: 'm', host: 'box-a', kind: 'question', source: 'hook', state: 'open',
  openedAt: new Date(Date.now() - 5 * 60_000).toISOString(), replyCapability: 'terminal', fingerprint: 'f', urgency: 'normal',
  question: { text: 'Which database should the migration run against?', header: 'Database' },
  choices: [{ id: '1', label: 'Staging' }, { id: '2', label: 'Production' }],
  ...extra,
});
const attention = [
  ask(row.sessionId, '4'),
  ask(other.sessionId, '9', { project: 'elsewhere', question: { text: 'Ship it?' }, choices: [] }),
  ask(row.sessionId, '3', { state: 'answered' }),
];
process.stdout.write(`${JSON.stringify({ v: 1, type: 'reset', scope: 'box-a', streamId: 's', sequence: 1, agents: [row, other, self], attention, tools: [], setup: [] })}\n`);
setInterval(() => {}, 1 << 30);
