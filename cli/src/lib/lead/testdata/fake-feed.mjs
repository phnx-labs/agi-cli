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
process.stdout.write(`${JSON.stringify({ v: 1, type: 'reset', scope: 'box-a', streamId: 's', sequence: 1, agents: [row, other, self], attention: [], tools: [], setup: [] })}\n`);
setInterval(() => {}, 1 << 30);
