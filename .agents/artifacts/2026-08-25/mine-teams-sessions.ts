#!/usr/bin/env bun

/** Mine original fleet transcripts for agents-teams invocations: discovery uses the sessions.db
 * tool index, evidence comes from transcript bodies via `agents sessions export`. Output is
 * permanently anonymized: raw identifiers never leave this process. */

type ToolCall = {
  timestamp?: string;
  input?: string;
  output?: string;
  outcome?: string;
};

type Candidate = {
  id: string;
  shortId?: string;
  agent: string;
  machine: string;
  timestamp?: string;
  project?: string;
  calls: ToolCall[];
};

type BundleRow = {
  agent?: string;
  machine?: string;
  sessionId?: string;
  body?: string;
};

const wantedAgents = new Set(["claude", "codex", "grok", "kimi", "cursor"]);
const launchPattern = /(?:^|[;&|\n]\s*|\b)(?:agents|ag)\s+teams\s+(create|add|start)\b(?!\s+--help)/i;
const diagnosticPattern = /(?:^|[;&|\n]\s*|\b)(?:agents|ag)\s+teams\s+(status|logs|doctor|active|list|--help)\b/i;
const issueRules: Array<[string, RegExp]> = [
  ["environment bootstrap noise", /GVM_ROOT|nvm is not compatible|npm_config_prefix/i],
  ["stale checkout gate", /commits? behind origin\/main|stale repo|bring it up to date|--confirm/i],
  ["unsupported or misplaced option", /unknown option|does not exist on `teams add`|too many arguments/i],
  ["authentication or harness readiness", /not logged in|log in|authentication|unauthorized|not installed|fails? to start/i],
  ["worktree creation or collision", /worktree.*(?:already exists|failed|collision)|fatal:.*worktree/i],
  ["remote host or SSH failure", /unreachable|ssh:|connection (?:refused|timed out)|remote.*failed/i],
  ["spawn reports success but no teammate", /0 working, 0 done, 0 failed|no teammates yet/i],
  ["teammate process failure", /\bFAILED\b|exit(?:ed)? (?:code )?[1-9]\d*|pane died|process.*(?:died|crashed)/i],
  ["watch or orchestration stalled", /still running|stalled|no progress|watch.*(?:dead|exited)|background.*(?:dead|nothing)/i],
  ["completion stranded before merge", /PR (?:is )?open|waiting (?:for|on) (?:CI|review)|not merged|unmerged/i],
];

function run(argv: string[], timeout = 120_000): { stdout: string; stderr: string; exitCode: number } {
  const proc = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode ?? 1,
  };
}

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${String(error)}\n${text.slice(0, 500)}`);
  }
}

function exportCommand(machine: string, ids: string[]): string[] {
  const base = ["agents", "sessions", "export", ...ids, "--stdout"];
  if (machine === "zion") return base;
  // Session ids are UUIDs, so joining them cannot introduce shell syntax.
  return ["agents", "ssh", machine, base.join(" ")];
}

function parseBundle(stdout: string): BundleRow[] {
  const rows: BundleRow[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as BundleRow & { kind?: string };
      if (row.kind !== "agents-session-bundle" && row.body) rows.push(row);
    } catch {
      // SSH warnings are evidence in stderr; non-NDJSON stdout is ignored here.
    }
  }
  return rows;
}

function nearbyEvidence(body: string, call: ToolCall): string {
  const lines = body.split("\n");
  let index = -1;
  if (call.timestamp) {
    index = lines.findIndex((line) => line.includes(call.timestamp!) && launchPattern.test(line));
  }
  if (index < 0 && call.input) {
    const fragment = call.input.slice(0, 160);
    index = lines.findIndex((line) => line.includes(fragment));
  }
  if (index < 0) return "";
  return lines.slice(index, index + 12).join("\n").slice(0, 12_000);
}

function classify(text: string): string[] {
  return issueRules.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

const query = run([
  "agents", "sessions", "--include", "tools", "--query", "program:agents input:teams",
  "--fleet", "--since", "100d", "--limit", "1000", "--json",
]);
if (query.exitCode !== 0 && !query.stdout.trim()) {
  throw new Error(`fleet query failed (${query.exitCode}): ${query.stderr}`);
}

const discovered = parseJson<{ coverage: unknown; sessions: Candidate[] }>(query.stdout, "fleet query");
const candidates = discovered.sessions
  .filter((session) => wantedAgents.has(session.agent))
  .map((session) => ({
    ...session,
    calls: session.calls.filter((call) => launchPattern.test(call.input ?? "")),
  }))
  .filter((session) => session.calls.length > 0)
  .sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));

// Forked transcripts can retain the exact same historical tool call. Count the
// tool call once while preserving the earliest-created session as its source.
const seenCalls = new Set<string>();
for (const session of candidates) {
  session.calls = session.calls.filter((call) => {
    const key = `${session.machine}\0${call.timestamp ?? ""}\0${call.input ?? ""}`;
    if (seenCalls.has(key)) return false;
    seenCalls.add(key);
    return true;
  });
}
const uniqueCandidates = candidates.filter((session) => session.calls.length > 0);
const machineAliases = new Map(
  [...new Set(uniqueCandidates.map((session) => session.machine))]
    .sort()
    .map((machine, index) => [machine, `host-${index + 1}`]),
);
const sessionAliases = new Map(
  uniqueCandidates.map((session, index) => [session.id, `S${String(index + 1).padStart(3, '0')}`]),
);

const byMachine = Map.groupBy(uniqueCandidates, (session) => session.machine);
const exported = new Map<string, BundleRow>();
const hostFailures: Array<{ machine: string; sessionCount: number; error: string }> = [];

for (const [machine, sessions] of byMachine) {
  const result = run(exportCommand(machine, sessions.map((session) => session.id)), 180_000);
  for (const row of parseBundle(result.stdout)) {
    if (row.sessionId) exported.set(row.sessionId, row);
  }
  const missing = sessions.filter((session) => !exported.has(session.id));
  if (result.exitCode !== 0 || missing.length > 0) {
    hostFailures.push({
      machine,
      sessionCount: missing.length,
      error: (result.stderr || result.stdout || `missing ${missing.length} transcript bodies`).trim().slice(0, 1000),
    });
  }
}

const incidents = uniqueCandidates.flatMap((session) => session.calls.map((call) => {
  const row = exported.get(session.id);
  const nearby = row?.body ? nearbyEvidence(row.body, call) : "";
  const evidence = [call.output, nearby].filter(Boolean).join("\n");
  return {
    session: sessionAliases.get(session.id),
    host: machineAliases.get(session.machine),
    agent: session.agent,
    version: row?.body?.match(/\"version\":\"([^\"]+)\"/)?.[1],
    transcriptAgent: row?.agent,
    timestamp: call.timestamp ?? session.timestamp,
    launchActions: [...(call.input ?? '').matchAll(/(?:agents|ag)\s+teams\s+(create|add|start)\b(?!\s+--help)/gi)]
      .map((match) => match[1]!.toLowerCase()),
    categories: classify(evidence),
    hasOriginalTranscript: Boolean(row?.body),
  };
}));

const report = {
  generatedAt: new Date().toISOString(),
  windowDays: 100,
  requestedAgents: [...wantedAgents],
  coverage: discovered.coverage,
  unreachableOrIncompatibleHostCount: query.stderr.trim().split("\n").filter(Boolean).length,
  candidateSessions: uniqueCandidates.length,
  launchBearingToolCalls: incidents.length,
  originalTranscriptsRecovered: new Set(incidents.filter((item) => item.hasOriginalTranscript).map((item) => item.session)).size,
  hostFailures: hostFailures.map((failure) => ({
    host: machineAliases.get(failure.machine) ?? 'unindexed-host',
    sessionCount: failure.sessionCount,
    failed: true,
  })),
  diagnosticOnlySessionsExcluded: discovered.sessions.filter((session) =>
    wantedAgents.has(session.agent) && session.calls.some((call) => diagnosticPattern.test(call.input ?? "")) &&
    !session.calls.some((call) => launchPattern.test(call.input ?? ""))
  ).length,
  byAgent: Object.fromEntries([...Map.groupBy(incidents, (item) => item.agent)].map(([agent, rows]) => [agent, rows.length])),
  byHost: Object.fromEntries([...Map.groupBy(incidents, (item) => item.host)].map(([host, rows]) => [host, rows.length])),
  byCategory: Object.fromEntries([...Map.groupBy(incidents.flatMap((item) => item.categories), (name) => name)].map(([name, rows]) => [name, rows.length])),
  incidents,
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
const outputIndex = Bun.argv.indexOf("--output");
if (outputIndex >= 0) {
  const outputPath = Bun.argv[outputIndex + 1];
  if (!outputPath) throw new Error("--output requires a path");
  await Bun.write(outputPath, serialized);
} else {
  process.stdout.write(serialized);
}
