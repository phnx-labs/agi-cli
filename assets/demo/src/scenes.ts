// Each scene is scripted from REAL agi-cli output (verified from source code).
// Colors match actual chalk output: green = success, gray = hints, yellow = warnings.

export interface TermLine {
  text: string;
  color?: string;       // hex color
  delay?: number;       // frames before this line appears (relative to scene start)
  typing?: boolean;     // typewriter effect for commands
  indent?: number;      // spaces of indent
  spinner?: boolean;    // show spinner animation before text
  badge?: { label: string; color: string }[];  // inline badges like [claude] [codex]
}

export interface Scene {
  id: string;
  title: string;          // shown in progress bar
  caption?: string;       // human-readable description, typewritten above the terminal
  prompt?: string;        // terminal prompt text (default: ~/payments git:(main))
  lines: TermLine[];
  durationFrames: number; // how long this scene lasts
  clear?: boolean;        // clear screen before this scene
}

const G = '#b3ff0c';  // green accent
const W = '#e8e8e8';  // white text
const D = '#777777';  // dim/gray
const Y = '#facc15';  // yellow
const C = '#22d3ee';  // cyan
const R = '#f87171';  // red

export const SCENES: Scene[] = [
  // ── ACT 0: COVER ──
  // 1.5s logo+wordmark intro. No terminal lines — rendered by AgentsDemo's
  // isIntro branch (see AgentsDemo.tsx). Lands inside the music's `enter`
  // section (0-4s) for the agent-cli-neon-* score variants.
  {
    id: 'intro',
    title: 'agents',
    lines: [],
    durationFrames: 45, // 1.5s @ 30fps
  },
  // ── ACT 1: INSTALL + VERSION SWITCH ──
  {
    id: 'install',
    title: 'INSTALL',
    caption: 'Install any agent, pinned to an exact version.',
    lines: [
      { text: '$ agents add claude@2.1.187', color: W, typing: true, delay: 0 },
      { text: 'Installing Claude Code@2.1.187...', color: D, delay: 30, spinner: true },
      { text: 'Installed Claude Code@2.1.187', color: G, delay: 70 },
      { text: '  Created shim: ~/.agents/shims/claude', color: D, delay: 80 },
      { text: '  Synced: commands, skills, mcp, hooks, rules', color: G, delay: 90 },
    ],
    durationFrames: 120,  // 4s
  },
  {
    id: 'use',
    title: 'USE',
    caption: 'Switch the global default in one command.',
    clear: true,
    lines: [
      { text: '$ agents use claude@2.1.187', color: W, typing: true, delay: 0 },
      { text: 'Backed up existing config to: ~/.agents/backups/claude/1713600000/', color: D, delay: 25 },
      { text: 'Set Claude Code@2.1.187 as global default', color: G, delay: 40 },
      { text: 'Synced: commands, skills, mcp, hooks, rules', color: G, delay: 50 },
      { text: '', delay: 60 },
      { text: '  ~/.claude/ -> ~/.agents/versions/claude/2.1.187/home/.claude/', color: C, delay: 65 },
    ],
    durationFrames: 100,  // 3.3s
  },

  // ── ACT 2: PROFILES + CUSTOM MODELS ──
  {
    id: 'profile',
    title: 'PROFILES',
    caption: 'Add profiles — point Claude at Kimi, Grok, or any endpoint.',
    clear: true,
    lines: [
      { text: '$ agents profiles add kimi', color: W, typing: true, delay: 0 },
      { text: 'Applying preset: kimi (OpenRouter)', color: D, delay: 25 },
      { text: '  Host: claude, Model: moonshotai/kimi-k2', color: D, delay: 35 },
      { text: '  Endpoint: https://openrouter.ai/api/v1', color: D, delay: 40 },
      { text: 'API key: ****-****-****-7f3a', color: D, delay: 50 },
      { text: 'Stored in keychain: agents-openrouter-api-key', color: G, delay: 60 },
      { text: "Profile 'kimi' added.", color: G, delay: 75 },
      { text: 'Try: agents run kimi "hello"', color: D, delay: 85 },
    ],
    durationFrames: 110,  // 3.7s
  },

  // ── ACT 3: SKILLS + MCP (INSTALL ONCE, SYNC EVERYWHERE) ──
  {
    id: 'skills',
    title: 'SKILLS',
    caption: 'Install a skill once — synced to every agent.',
    clear: true,
    lines: [
      { text: '$ agents skills add gh:phnx-labs/security-expert', color: W, typing: true, delay: 0 },
      { text: 'Cloning gh:phnx-labs/security-expert...', color: D, delay: 35, spinner: true },
      { text: 'Repository cloned', color: G, delay: 65 },
      { text: 'Found 1 skill(s):', color: W, delay: 75 },
      { text: '  security-expert: OWASP Top 10 vulnerability scanner', color: C, delay: 80 },
      { text: '    3 rules', color: D, delay: 85 },
      { text: 'Installed 1 skills to ~/.agents/skills/', color: G, delay: 95 },
      { text: 'Synced to 4 agent version(s)', color: G, delay: 105 },
    ],
    durationFrames: 130,  // 4.3s
  },
  {
    id: 'mcp',
    title: 'MCP',
    caption: 'Register MCP servers across every agent at once.',
    clear: true,
    lines: [
      { text: '$ agents install mcp:com.linear/linear', color: W, typing: true, delay: 0 },
      { text: "Added MCP server 'linear' to manifest", color: G, delay: 30 },
      { text: 'Registering across agents...', color: D, delay: 40, spinner: true },
      { text: '  + Claude Code@2.1.187', color: G, delay: 55, indent: 2 },
      { text: '  + Codex@0.144.1', color: G, delay: 60, indent: 2 },
      { text: '  + Grok CLI@0.2.32', color: G, delay: 65, indent: 2 },
      { text: '  + Kimi CLI@0.19.2', color: G, delay: 70, indent: 2 },
      { text: '', delay: 80 },
      { text: 'Run: agents mcp register to apply', color: D, delay: 85 },
    ],
    durationFrames: 110,  // 3.7s
  },

  // ── ACT 4: VERSION PINNING ──
  {
    id: 'pin',
    title: 'PIN',
    caption: 'Pin agent versions per project — like .nvmrc, but for AI.',
    clear: true,
    lines: [
      { text: '$ cat .agents-version', color: W, typing: true, delay: 0 },
      { text: 'claude  2.1.187', color: G, delay: 20 },
      { text: 'codex   0.144.1', color: G, delay: 25 },
      { text: '', delay: 35 },
      { text: '$ cd myproject && agents run claude "audit auth"', color: W, typing: true, delay: 40 },
      { text: 'Resolved claude@2.1.187 from .agents-version', color: C, delay: 70 },
      { text: 'booting Claude Code  14 skills  3 MCP servers  ready', color: D, delay: 80 },
    ],
    durationFrames: 110,  // 3.7s
  },

  // ── ACT 5: SESSIONS ──
  {
    id: 'sessions',
    title: 'SESSIONS',
    caption: 'See every session across agents, versions, and projects.',
    clear: true,
    lines: [
      { text: '$ agents sessions', color: W, typing: true, delay: 0 },
      { text: '', delay: 20 },
      { text: 'ID         AGENT     VER      PROJECT         TOPIC                                    WHEN', color: D, delay: 25 },
      { text: 'a7f3e2c1   claude    2.1.187  payments-api    fix stripe webhook signature verify       2m ago', color: W, delay: 30 },
      { text: 'b8d4f102   codex     0.144.1  payments-api    refactor retry logic in queue worker      14m ago', color: W, delay: 35 },
      { text: 'c9e5a213   grok      0.2.32   landing-page    update hero copy and CTA placement        1h ago', color: W, delay: 40 },
      { text: 'd0f6b324   claude    2.1.187  auth-service    add PKCE flow to OAuth provider           3h ago', color: W, delay: 45 },
      { text: 'e1a7c435   codex     0.144.1  infra           terraform plan for staging RDS upgrade     5h ago', color: W, delay: 50 },
      { text: '', delay: 55 },
      { text: '5 sessions across 3 agents', color: D, delay: 60 },
    ],
    durationFrames: 100,  // 3.3s
  },

  // ── ACT 6: PIPE COMPOSITION ──
  {
    id: 'pipe',
    title: 'PIPE',
    caption: 'Chain agents in Unix pipelines — chain by strength.',
    clear: true,
    lines: [
      { text: '$ agents run claude "find auth vulnerabilities in src/" \\', color: W, typing: true, delay: 0 },
      { text: '    | agents run codex "fix the issues Claude found" \\', color: W, typing: true, delay: 30 },
      { text: '    | agents run kimi "write regression tests for the fixes"', color: W, typing: true, delay: 55 },
      { text: '', delay: 75 },
      { text: '[claude] Found 3 issues: missing CSRF token validation, SQL injection in /api/users, open redirect in /auth/callback', color: C, delay: 85 },
      { text: '[codex]  Fixed 3/3 issues across 4 files', color: G, delay: 105 },
      { text: '[kimi]   Generated 7 test cases covering all fixes', color: Y, delay: 125 },
    ],
    durationFrames: 150,  // 5s
  },

  // ── ACT 7: CLOUD DISPATCH ──
  {
    id: 'cloud',
    title: 'CLOUD',
    caption: 'Dispatch work to the cloud — same CLI, remote execution.',
    clear: true,
    lines: [
      { text: '$ agents cloud run "deploy payments-api to staging" --provider rush', color: W, typing: true, delay: 0 },
      { text: 'Dispatching to Rush Cloud...', color: D, delay: 35, spinner: true },
      { text: 'Task tsk_8f3a dispatched to Rush Cloud', color: G, delay: 65 },
      { text: '', delay: 75 },
      { text: 'Streaming output...', color: D, delay: 80 },
      { text: '  cloned user/payments-api (main)', color: D, delay: 90 },
      { text: '  running tests... 47/47 passed', color: G, delay: 105 },
      { text: '  deployed to staging-payments.up.railway.app', color: G, delay: 120 },
      { text: '', delay: 130 },
      { text: 'Task tsk_8f3a completed in 2 minutes', color: G, delay: 135 },
    ],
    durationFrames: 160,  // 5.3s
  },

  // ── ACT 8: DISTRIBUTED TEAMS (FLEET) ──
  {
    id: 'fleet',
    title: 'FLEET',
    caption: 'One team, many machines — teammates run across your fleet over SSH.',
    clear: true,
    lines: [
      { text: '$ agents teams create feat --devices yosemite-s0,yosemite-s1', color: W, typing: true, delay: 0 },
      { text: "Team 'feat' created — device pool: yosemite-s0, yosemite-s1", color: G, delay: 30 },
      { text: '$ agents teams add feat claude "Owns: api/*" --name api', color: W, typing: true, delay: 40 },
      { text: '$ agents teams start feat --watch', color: W, typing: true, delay: 70 },
      { text: '', delay: 90 },
      { text: '  api   claude@2.1.187   yosemite-s0   working', color: W, delay: 95 },
      { text: '  ui    codex@0.144.1    yosemite-s1   working', color: W, delay: 102 },
      { text: '', delay: 110 },
      { text: '2 teammates across 2 machines — dispatched over SSH', color: G, delay: 115 },
    ],
    durationFrames: 150,  // 5s
  },

  // ── ACT 9: SESSIONS FOCUS ──
  {
    id: 'focus',
    title: 'FOCUS',
    caption: 'Jump back into any session, wherever it runs.',
    clear: true,
    lines: [
      { text: '$ agents sessions --active', color: W, typing: true, delay: 0 },
      { text: '', delay: 20 },
      { text: 'ID         AGENT     DEVICE        STATE     TOPIC', color: D, delay: 25 },
      { text: 'a7f3e2c1   claude    zion          working   fix stripe webhook signature verify', color: W, delay: 30 },
      { text: 'b8d4f102   codex     yosemite-s0   waiting   refactor retry logic in queue worker', color: Y, delay: 35 },
      { text: '', delay: 45 },
      { text: '$ agents sessions focus b8d4f102', color: W, typing: true, delay: 55 },
      { text: 'Attaching to codex on yosemite-s0 (ssh -tt, tmux attach)...', color: D, delay: 80, spinner: true },
      { text: 'Attached — you are in the live session', color: G, delay: 95 },
    ],
    durationFrames: 110,  // 3.7s
  },

  // ── ACT 10: ROTATION (UNIQUE FEATURE) ──
  {
    id: 'rotate',
    title: 'ROTATE',
    caption: 'Rotate across accounts — never hit a usage limit again.',
    clear: true,
    lines: [
      { text: '$ agents run claude --balanced "run full test suite"', color: W, typing: true, delay: 0 },
      { text: '', delay: 25 },
      { text: 'Checking usage across 3 Claude accounts...', color: D, delay: 30 },
      { text: '  claude@2.1.187 (you@example.com)    89% used', color: Y, delay: 40 },
      { text: '  claude@2.1.187 (work@example.com)   23% used', color: G, delay: 45 },
      { text: '  claude@2.1.170 (you@example.com)    expired', color: R, delay: 50 },
      { text: '', delay: 55 },
      { text: 'Selected: claude@2.1.187 (work@example.com) -- lowest usage', color: G, delay: 60 },
      { text: 'booting Claude Code  14 skills  3 MCP servers  ready', color: D, delay: 70 },
    ],
    durationFrames: 100,  // 3.3s
  },

  // ── FINALE ── (rendered by <Finale> component, not the terminal)
  {
    id: 'finale',
    title: 'agents',
    clear: true,
    lines: [],
    durationFrames: 180,  // 6s
  },
];

// Total: ~55.8s at 30fps = 1675 frames
// We'll adjust durationInFrames in Root.tsx to match
export const TOTAL_FRAMES = SCENES.reduce((sum, s) => sum + s.durationFrames, 0);
