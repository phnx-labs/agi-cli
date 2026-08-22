# Agents

Orchestrate Claude, Codex, Antigravity, and Cursor in parallel — from one IDE. Open source. Free.

Turn your editor into a command center for orchestrating Claude, Codex, Antigravity, and Cursor in parallel. Each agent runs as a full-screen editor tab. Each agent can spawn sub-agents. You orchestrate — approving plans, monitoring execution, shipping faster.

## Why an IAE?

Text editors became IDEs when coding got complex. Now that AI agents do the coding, your environment needs to evolve again. When you're running 10+ orchestrators each spinning 10+ agents, terminals and TUIs collapse. You need an environment built for that scale.

This extension turns your IDE into an IAE:

- **Full-screen terminals** - Agents run as editor tabs, not buried panels. See your code and agent side-by-side.
- **Session persistence** - Close VS Code, reopen it, your agent tabs come back exactly where you left off.
- **Approval gates** - You approve plans before agents execute. Control without bottleneck.
- **Keyboard-first** - 12+ shortcuts for spawning, switching, labeling, and reviewing agents. No mouse needed.

## Workflow: Task, Plan, Approve

1. **Task** - Describe what you need with `/swarm` inside the IDE.
2. **Plan** - The orchestrator drafts a distribution: who codes, who debugs, who researches.
3. **Approve** - You gate execution. Agents run only after your approval.

## Quick Start

1. Install the extension from VS Code Marketplace
2. Press `Cmd+Shift+A` to spawn your first agent
3. Open Dashboard (`Cmd+Shift+D`) to configure auto-start

### agents-dbg Mac App

Install the private Mac app through the Homebrew tap:

```bash
brew install --cask muqsitnawaz/tap/agents-dbg
```

The public install script uses that tap and launches the installed app:

```bash
curl -fsSL https://raw.githubusercontent.com/phnx-labs/agents-cli/main/scripts/install-agents-dbg.sh | sh
```

## Navigation

| Shortcut | Action |
| --- | --- |
| `Cmd+Shift+A` | Spawn a new agent through agi-cli automatic routing |
| `Cmd+Shift+L` | Label agent by task |
| `Cmd+Shift+C` | Clear and restart agent |
| `Cmd+Shift+D` | Open Dashboard |
| `Cmd+Shift+I` | Focus agent (quick picker) |
| `Cmd+Shift+H` | Horizontal split (tmux-style) |
| `Cmd+Shift+V` | Vertical split (tmux-style) |

## Features

### Agent Terminals

Spawn any agent as a full-screen editor tab. Built-in support for Claude Code, Codex, Antigravity, OpenCode, and Cursor. Add custom agents through settings.

**Where a new agent runs** is `agents.launch.defaultTarget`: `auto` (default — agents-cli picks the device), `local` (this machine), or `ask` (prompt every time). Under `auto`, mark your compute boxes once with `agents devices role <name> worker` and every `Agents: New <Harness>` rotates over those workers instead of the machine you are sitting at. Once the device is resolved, the command lists the versions/accounts installed there for you to choose. `Agents: New <Harness> (Pick Host)` asks for the device first and then shows that device's versions/accounts. `Agents: New <Harness> (Auto)` chooses both automatically.

### Session Persistence

Every open agent terminal is fully restorable. Session ID, icon, and custom labels are saved to disk in real-time. VS Code crashes? Restart? All your agent tabs come back exactly as they were.

Automatic tab titles follow the canonical session name from the fleet stream.
A remote tab may briefly show its first meaningful prompt, then replaces it when
the harness generates a name or the session is renamed; a label set with
`Cmd+Shift+L` remains authoritative.

### Task Management

- **Labels** - Tag agents by task (`Cmd+Shift+L`). Status bar shows active agent and label.
- **Tasks** - Renders tasks returned by agi-cli; the extension does not parse task files or query trackers itself.
- **Session history** - Browse CLI-provided sessions from the dashboard and resume through `agents sessions resume`.
- **Fork a session** - `Agents: Fork` delegates the copy and identity semantics to `agents sessions fork <id>` and leaves the original untouched.
- **Fork pairs in the Recap ledger** - a fork and the session it came from finish as two rows that share no id. AGI EXT remembers the edge and reunites them: one side-by-side row in Recap, parent on the left, fork on the right, each stamped with the machine it ran on and its own duration/cost/PR.
- **Agents: Resume** - The picker performs one bounded CLI listing when opened, then sends only the chosen canonical IDs to `agents sessions resume <id> --vscodium`.
- **Resume variants** - `Agents: Resume (Pick Session)` lists only abandoned sessions — detached, backgrounded, parked, or idle, nothing currently open anywhere — and resumes each on the device it was created on. `Agents: Resume (Pick Host)` reopens the active tab's session on a device you pick (same harness, same version). `Agents: Resume (Pick Harness)` continues the active tab's session in a different harness on the same device, replaying the transcript through the universal `/continue` flow. `Agents: Resume (Best Profile)` rotates the active tab to the signed-in account with the most usage headroom (`Cmd+Shift+J`).

### Fleet

The dashboard's mission control. A live grid of interactive agents and cloud dispatches beside your Linear cycle. Background/headless runs are hidden by default; use the **Background** feed toggle when you need them. Compose and dispatch work with the Cmd+K composer, drag issue cards onto agents, or send a ticket straight to the cloud.

Agent cards surface outputs such as PRs, spawned teams, created tickets, and plan
artifacts. `.html` and `ref-*.md` plans detected in session output, worktree
files, or attachments appear as one-click preview chips. Screenshots and other
session attachments appear as thumbnail artifacts that click through to the host
preview. The expanded project and host sidebar can be resized by dragging its
right edge.

### Foreman Voice Orb

Talk to your fleet. Tap the orb in the dashboard and ask "what's running?", "what's left this cycle?", or "dispatch RUSH-557 to the cloud" — a realtime voice model answers out loud with live floor state, and it can dispatch tickets, spawn agents, and file Linear issues for you. Tap to talk, tap again to stop, or press-and-hold to talk only while pressed. A silent-mode toggle under the orb switches replies to text-only transcript.

### AI Git Commits

Generate commit messages from staged changes with `Cmd+Shift+G`. Learns from your commit style, then stages, commits, and pushes in one action.

### Additional Features

- **Auto-start** - Configure which agents launch when VS Code opens
- **Default models** - Set preferred model per agent type
- **Shell terminals** - Spawn plain shells alongside agents (`Cmd+Shift+S`)
- **Reader** - Notion-style `.md` editor (TipTap) plus sandboxed HTML preview for artifacts-cli pages; Command Palette: `Agents: Reader (Enable)` / `Agents: Reader (Disable)`
- **Notifications** - Native macOS notifications when agents need attention

## For Teams

- Shared dashboard keeps approvals and assignments visible.
- Consistent agent distribution prevents over- or under-staffing tasks.
- Approval gates make it easy for leads to review before code runs.

## Requirements

- VS Code or Cursor
- Agent CLIs installed (`claude`, `codex`, `antigravity`, `cursor-agent`, `opencode`)
- OpenAI API key (optional, for commit generation and the Foreman voice orb)
- ffmpeg (optional, for the Foreman voice orb: `brew install ffmpeg`)

## Related Packages

- [@swarmify/agents-cli](https://www.npmjs.com/package/@swarmify/agents-cli) - Moved to its own repository

## License

MIT
