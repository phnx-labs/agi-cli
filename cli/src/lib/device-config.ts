
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';
import { META_HEADER, getUserAgentsDir, readMeta, updateMeta, withMetaLock } from './state.js';
import { atomicWriteFileSync } from './fs-atomic.js';
import { machineId } from './machine-id.js';
import { assertValidDeviceName, assertRegistrableDeviceName } from './devices/registry.js';
import { migrateDeviceConfigStores } from './devices/config-migration.js';
import { parseAddress } from './address.js';
import type { FleetManifest } from './fleet/types.js';
import { isAgentId } from './types.js';

export type ConfigScope = 'user' | 'device';

export type ConfigVisibility = 'shared' | 'machine';

type ConfigType = 'string' | 'int' | 'bool' | 'string-list';

interface ConfigKeySpecBase {
  name: string;
  yamlKey: string;
  type: ConfigType;
  description: string;
  defaultValue?: unknown;
  validate?: (value: unknown) => string | null;
  normalize?: (value: unknown) => unknown;
}

export type ConfigKeySpec =
  | (ConfigKeySpecBase & { scope: 'user'; visibility?: never })
  | (ConfigKeySpecBase & { scope: 'device'; visibility: ConfigVisibility });

export type ConfigSource = 'user' | 'device' | 'fleet' | 'default';

export interface ConfigEntry {
  spec: ConfigKeySpec;
  value: unknown;
  source: ConfigSource;
}

interface ConfigTarget {
  device?: string;
  fleet?: boolean;
}

const DEVICE_PLATFORMS = ['windows', 'linux', 'macos', 'unknown'] as const;
const SSH_AUTH_METHODS = ['key', 'password'] as const;
const DEVICE_ROLES = ['worker', 'personal', 'desktop'] as const;
const AUTO_POOL_MODES = ['workers', 'all'] as const;
const DEVICE_FORM_FACTORS = ['laptop', 'desktop', 'server', 'unknown'] as const;

export const MENUBAR_TABS = ['home', 'goals', 'secrets', 'projects', 'github', 'sessions', 'inbox'] as const;

const MENUBAR_TABS_ADDED_LATER: readonly string[] = ['goals', 'secrets', 'github'];

export const MENUBAR_HOME_GOALS = ['company', 'week', 'myWeek', 'myDay'] as const;

export function resolveMenubarTabOrder(stored: readonly string[]): string[] {
  const known = MENUBAR_TABS as readonly string[];
  const tabs: string[] = [];
  for (const id of stored) {
    if (known.includes(id) && !tabs.includes(id)) tabs.push(id);
  }
  return [...tabs, ...known.filter((t) => !tabs.includes(t))];
}

function oneOf(name: string, allowed: readonly string[]): (v: unknown) => string | null {
  return (v) => (allowed.includes(v as string) ? null : `${name} must be one of ${allowed.join(' | ')}.`);
}

export const CONFIG_KEYS: readonly ConfigKeySpec[] = [
  {
    name: 'interactive.host',
    yamlKey: 'interactiveHost',
    scope: 'user',
    type: 'string',
    description:
      'Device that shows the user artifacts (browser opens, dashboards) — the "online macOS box" skills should use instead of guessing.',
    validate: (v) => {
      try {
        assertRegistrableDeviceName(v as string);
        return null;
      } catch (err: any) {
        return err?.message ?? String(err);
      }
    },
  },
  {
    name: 'auto.pool',
    yamlKey: 'autoPool',
    scope: 'user',
    type: 'string',
    description:
      "Which devices automatic placement (`--device auto`) may pick: 'workers' (default — only devices marked role=worker, " +
      "once at least one is marked) or 'all' (every online device, ignoring worker marks). A device marked personal or " +
      'desktop is never picked automatically under either mode.',
    defaultValue: 'workers',
    validate: (v) =>
      (AUTO_POOL_MODES as readonly string[]).includes(v as string)
        ? null
        : `auto.pool must be one of ${AUTO_POOL_MODES.join(' | ')}.`,
  },
  {
    name: 'summarizer.enabled',
    yamlKey: 'summarizerEnabled',
    scope: 'user',
    type: 'bool',
    defaultValue: false,
    description:
      'Whether the daemon computes a per-session goal / progress checkpoints / checklist and delivers them on the ' +
      'session stream (PHNX-3939). Off by default — zero model calls, no behavior change until enabled. Needs a local ' +
      'Anthropic-wire model endpoint via summarizer.baseUrl + summarizer.model.',
  },
  {
    name: 'summarizer.baseUrl',
    yamlKey: 'summarizerBaseUrl',
    scope: 'user',
    type: 'string',
    description:
      'Base URL of the Anthropic-wire model endpoint the summarizer calls (Ollama / vLLM / LiteLLM), ' +
      'e.g. http://localhost:11434. Overridden per-process by AGENTS_SUMMARIZER_BASEURL.',
  },
  {
    name: 'summarizer.model',
    yamlKey: 'summarizerModel',
    scope: 'user',
    type: 'string',
    description:
      'Model the summarizer requests from summarizer.baseUrl, e.g. qwen2.5:3b. Overridden per-process by AGENTS_SUMMARIZER_MODEL.',
  },
  {
    name: 'updates.auto',
    yamlKey: 'updatesAuto',
    scope: 'user',
    type: 'bool',
    defaultValue: true,
    description:
      'Whether the daemon\'s automatic-update pass (PHNX-3940) may move any safely-transactional npm harness ' +
      '(Claude, Codex, …) to its latest release with no operator action. This is the fleet-wide KILL SWITCH: ' +
      'off, no harness auto-updates regardless of any updates.<agent>.auto override. On (the default), each ' +
      "harness's own updates.<agent>.auto refines it. Per-installation pins (agents update … --to <release>) " +
      'apply on top of this either way.',
  },
  {
    name: 'browser.viewer',
    yamlKey: 'browserViewer',
    scope: 'device',
    visibility: 'machine',
    type: 'string',
    description:
      "Which browser THIS machine shows YOU a page in (an .html artifact, a login " +
      "dashboard): a profile name, or `os` for the OS default handler. Unset follows browser.profile. " +
      "Distinct from browser.profile, which is the profile agents DRIVE — see RUSH-2709 for why " +
      "collapsing the two was a mistake. Set it to `os` to keep the OS default handler.",
    validate: (v: unknown) =>
      typeof v === 'string' && v.length > 0 ? null : 'browser.viewer must be `os` or a profile name.',
  },
  {
    name: 'browser.profile',
    yamlKey: 'defaultBrowserProfile',
    scope: 'device',
    visibility: 'machine',
    type: 'string',
    description:
      'Browser profile `browser start` resolves to without --profile (set via `browser use`).',
  },
  {
    name: 'computer.host',
    yamlKey: 'computerHost',
    scope: 'device',
    visibility: 'shared',
    type: 'string',
    description:
      'The --host address (PHNX-4090) `agents computer --device <name>` forwards to the standalone engine: ' +
      'ssh://[user@]host[:port], vnc://host[:port], or tcp://host:port. Unset falls back to the fleet ssh ' +
      'identity (ssh://user@host resolved against the device registry).',
    validate: (v) => {
      try {
        const addr = parseAddress(v as string);
        if (addr.scheme !== 'ssh' && addr.scheme !== 'vnc' && addr.scheme !== 'tcp') {
          return `computer.host speaks ssh://, vnc:// and tcp:// only (got ${addr.scheme}://).`;
        }
        return null;
      } catch (err: any) {
        return err?.message ?? String(err);
      }
    },
  },
  {
    name: 'browser.device',
    yamlKey: 'defaultBrowserDevice',
    scope: 'user',
    type: 'string',
    description:
      'Fleet browser hub: the device whose browser `browser` drive verbs target by default, with no --device. ' +
      'The hub itself runs locally; every other box forwards to it. Unset = each box drives its own browser.',
    validate: (v) => {
      try {
        assertValidDeviceName(v as string);
        return null;
      } catch (err: any) {
        return err?.message ?? String(err);
      }
    },
  },
  {
    name: 'agents.max-concurrent',
    yamlKey: 'maxAgents',
    scope: 'device',
    visibility: 'shared',
    type: 'int',
    description:
      'Cap on concurrent agents on this device. What counts toward it depends on the consumer: ' +
      'AGI EXT auto-launch counts device-wide running agents; teams placement counts the team’s own roster on the device.',
    validate: (v) => ((v as number) >= 1 ? null : 'agents.max-concurrent must be >= 1.'),
  },
  {
    name: 'scheduler.enabled',
    yamlKey: 'schedulerEnabled',
    scope: 'device',
    visibility: 'machine',
    type: 'bool',
    defaultValue: true,
    description: 'Whether the routines scheduler (daemon) may fire on this device.',
  },
  {
    name: 'daemon.enabled',
    yamlKey: 'daemonEnabled',
    scope: 'device',
    visibility: 'machine',
    type: 'bool',
    defaultValue: true,
    description:
      'Whether the daemon may run on this device at all (browser IPC, watchdog, and the ' +
      'routines scheduler). Disabling is the top-level kill switch: nothing auto-starts the daemon while it ' +
      'is set, including `routines add`/`routines start`/`routines catchup`/webhook triggers. ' +
      '`agents daemon start` still starts it explicitly.',
  },
  {
    name: 'watchdog.enabled',
    yamlKey: 'watchdogEnabled',
    scope: 'device',
    visibility: 'shared',
    type: 'bool',
    defaultValue: false,
    description: 'Whether the daemon runs the watchdog pass on this device.',
  },
  {
    name: 'tmux.enabled',
    yamlKey: 'tmuxEnabled',
    scope: 'device',
    visibility: 'machine',
    type: 'bool',
    defaultValue: false,
    description:
      'Whether an interactive `agents run` on this device is wrapped in the shared-socket tmux session — local runs and ' +
      'followed `--device` runs alike (PHNX-3316). Off, the default, spawns the agent directly; a remote run left bare ' +
      'is protected by reconnect-and-resume, not a pane. Turn it on to give every agent an addressable pane for ' +
      '`agents message`, injection, and `agents ps focus` once the tmux mouse, clipboard, and scrollback behavior suits this device.',
  },
  {
    name: 'browser.remote-control',
    yamlKey: 'browserRemoteControl',
    scope: 'device',
    visibility: 'machine',
    type: 'bool',
    defaultValue: false,
    description:
      "Whether other fleet machines may drive THIS device's browser over `browser --device <this-device>` or `agents ssh <this-device> …` (`agents browser` / `ag browser` / standalone `browser`). " +
      'Default off — a fleet-remote drive is refused until the owner runs `browser remote-control on`.',
  },
  {
    name: 'browser.task-idle-minutes',
    yamlKey: 'browserTaskIdleMinutes',
    scope: 'device',
    visibility: 'machine',
    type: 'int',
    defaultValue: 30,
    description:
      'Minutes a browser task may sit with no IPC action (navigate, click, type, screenshot, …) before the daemon\'s ' +
      'abandoned-task reaper closes its tabs and marks it done (RUSH-2622). 0 disables idle reaping — the reaper still ' +
      "closes a task whose owning agent session has exited, whatever this is set to. Read only on THIS box's own " +
      'reaper tick and `browser prune`, so it never applies to a peer.',
    validate: (v) =>
      (v as number) >= 0 ? null : 'browser.task-idle-minutes must be >= 0 (0 disables idle reaping).',
  },
  {
    name: 'notes',
    yamlKey: 'notes',
    scope: 'device',
    visibility: 'shared',
    type: 'string-list',
    description:
      'Free-form operator notes about this device (one entry per `agents devices config <name> notes <text>`). ' +
      'Long-form scratch, never shown in device listings — for the one-line synced summary of what the box is for, use `description`.',
  },
  {
    name: 'description',
    yamlKey: 'description',
    scope: 'device',
    visibility: 'shared',
    type: 'string',
    description:
      'One line saying what this device is FOR ("gpu box — cuda 12.4"), synced fleet-wide. Kept to one short line ' +
      'because the device-list renderer will show it (RUSH-3062, `surface` track). ' +
      'Replaces the value on each set; for appended long-form scratch use `notes`.',
    validate: (v) => {
      const s = v as string;
      if (s.includes('\n') || s.includes('\r')) return 'description must be a single line.';
      if (s.length > 80) return `description must be at most 80 characters (got ${s.length}) — it is a one-line table cell.`;
      return null;
    },
  },
  {
    name: 'ssh.user',
    yamlKey: 'sshUser',
    scope: 'device',
    visibility: 'shared',
    type: 'string',
    description: 'SSH login user for the device — overrides the registry profile’s user at dial time.',
  },
  {
    name: 'ssh.auth',
    yamlKey: 'sshAuth',
    scope: 'device',
    visibility: 'shared',
    type: 'string',
    description: 'SSH auth method: `key` (ssh agent / on-disk keys) or `password` (pulled from a secrets bundle).',
    validate: (v) =>
      (SSH_AUTH_METHODS as readonly string[]).includes(v as string)
        ? null
        : `ssh.auth must be one of ${SSH_AUTH_METHODS.join(' | ')}.`,
  },
  {
    name: 'ssh.bundle',
    yamlKey: 'sshBundle',
    scope: 'device',
    visibility: 'shared',
    type: 'string',
    description: 'Secrets bundle holding the SSH password (for ssh.auth=password). A bundle NAME — never a secret value.',
  },
  {
    name: 'ssh.bundle-key',
    yamlKey: 'sshBundleKey',
    scope: 'device',
    visibility: 'shared',
    type: 'string',
    description: "Key within the bundle whose value is the password (default 'password').",
  },
  {
    name: 'ssh.identity-file',
    yamlKey: 'sshIdentityFile',
    scope: 'device',
    visibility: 'shared',
    type: 'string',
    description: 'Explicit private-key path for key auth (passed to OpenSSH with IdentitiesOnly=yes).',
  },
  {
    name: 'platform',
    yamlKey: 'platform',
    scope: 'device',
    visibility: 'shared',
    type: 'string',
    description: 'OS family of the device — picks PowerShell vs POSIX on the remote end. Overrides the discovered platform.',
    validate: (v) =>
      (DEVICE_PLATFORMS as readonly string[]).includes(v as string)
        ? null
        : `platform must be one of ${DEVICE_PLATFORMS.join(' | ')}.`,
  },
  {
    name: 'role',
    yamlKey: 'role',
    scope: 'device',
    visibility: 'shared',
    type: 'string',
    description:
      "What this device is for, fleet-wide: 'worker' (a box agents run on), 'personal' (a machine you sit at — your " +
      "interactive seat), or 'desktop' (a headed always-on box like a Mac mini — the release/credential home). Personal " +
      'and desktop are never picked automatically. Marking ANY device worker turns automatic placement into an allowlist: ' +
      '`--device auto` then picks only from the marked workers.',
    validate: (v) =>
      (DEVICE_ROLES as readonly string[]).includes(v as string)
        ? null
        : `role must be one of ${DEVICE_ROLES.join(' | ')}.`,
  },
  {
    name: 'auto-launch.enabled',
    yamlKey: 'autoLaunchEnabled',
    scope: 'device',
    visibility: 'shared',
    type: 'bool',
    defaultValue: true,
    description: 'Whether `--device auto` (run, teams, AGI EXT) may pick this device (default on). Off drops it from every automatic-placement path.',
  },
  {
    name: 'auto-launch.preferred',
    yamlKey: 'autoLaunchPreferred',
    scope: 'device',
    visibility: 'shared',
    type: 'bool',
    defaultValue: false,
    description: 'Boost this device in `--device auto` ranking (default off) — picked ahead of load-equal peers when eligible.',
  },
  {
    name: 'formFactor',
    yamlKey: 'formFactor',
    scope: 'device',
    visibility: 'shared',
    type: 'string',
    defaultValue: 'unknown',
    description:
      "This device's physical form factor, a factual hardware fact the menu bar renders as an icon: " +
      'laptop, desktop, server, or unknown. Synced fleet-wide (any box may set it for any device). Set it ' +
      'explicitly — never inferred from the OS platform. Unset reads as `unknown`.',
    validate: oneOf('formFactor', DEVICE_FORM_FACTORS),
  },

  {
    name: 'menubar.menu.defaultProject',
    yamlKey: 'menubarMenuDefaultProject',
    scope: 'user',
    type: 'string',
    description: 'AGI Menu: the project name the menu opens focused on. Unset = no default project.',
  },
  {
    name: 'menubar.menu.workingRowsShown',
    yamlKey: 'menubarMenuWorkingRowsShown',
    scope: 'user',
    type: 'int',
    defaultValue: 3,
    description: 'AGI Menu: how many working (in-progress) rows to show per group — 2, 3, or 4.',
    validate: (v) => ([2, 3, 4].includes(v as number) ? null : 'menubar.menu.workingRowsShown must be 2, 3, or 4.'),
  },
  {
    name: 'menubar.menu.showPreviews',
    yamlKey: 'menubarMenuShowPreviews',
    scope: 'user',
    type: 'bool',
    defaultValue: true,
    description: 'AGI Menu: show the session preview line under each row.',
  },
  {
    name: 'menubar.menu.projectPriorityFilter',
    yamlKey: 'menubarMenuProjectPriorityFilter',
    scope: 'user',
    type: 'string',
    defaultValue: 'all',
    description: 'AGI Menu: minimum project priority shown — all, urgent, high, or medium.',
    validate: oneOf('menubar.menu.projectPriorityFilter', ['all', 'urgent', 'high', 'medium']),
  },
  {
    name: 'menubar.menu.hideCompletedMilestones',
    yamlKey: 'menubarMenuHideCompletedMilestones',
    scope: 'user',
    type: 'bool',
    defaultValue: true,
    description: 'AGI Menu: hide milestones that are fully complete.',
  },
  {
    name: 'menubar.menu.bannerWhenNeedsYou',
    yamlKey: 'menubarMenuBannerWhenNeedsYou',
    scope: 'user',
    type: 'bool',
    defaultValue: true,
    description: 'AGI Menu: show a top banner when a session needs the operator.',
  },
  {
    name: 'menubar.menu.includeOtherDeviceRequests',
    yamlKey: 'menubarMenuIncludeOtherDeviceRequests',
    scope: 'user',
    type: 'bool',
    defaultValue: true,
    description: 'AGI Menu: include needs-you requests from sessions on OTHER fleet devices.',
  },
  {
    name: 'menubar.menu.groupBy',
    yamlKey: 'menubarMenuGroupBy',
    scope: 'user',
    type: 'string',
    defaultValue: 'project',
    description: 'AGI Menu: primary grouping of rows — none, project, agent, or device.',
    validate: oneOf('menubar.menu.groupBy', ['none', 'project', 'agent', 'device']),
  },
  {
    name: 'menubar.menu.thenBy',
    yamlKey: 'menubarMenuThenBy',
    scope: 'user',
    type: 'string',
    defaultValue: 'none',
    description: 'AGI Menu: secondary grouping within each group — none, project, agent, or device.',
    validate: oneOf('menubar.menu.thenBy', ['none', 'project', 'agent', 'device']),
  },
  {
    name: 'menubar.menu.projectScope',
    yamlKey: 'menubarMenuProjectScope',
    scope: 'user',
    type: 'string',
    defaultValue: 'cycle',
    description: 'AGI Menu: which project issues to show — the current cycle only, or all.',
    validate: oneOf('menubar.menu.projectScope', ['cycle', 'all']),
  },
  {
    name: 'menubar.menu.projectSort',
    yamlKey: 'menubarMenuProjectSort',
    scope: 'user',
    type: 'string',
    defaultValue: 'updated',
    description: 'AGI Menu: how projects are ordered — updated, priority, or name.',
    validate: oneOf('menubar.menu.projectSort', ['updated', 'priority', 'name']),
  },
  {
    name: 'menubar.menu.ticketSort',
    yamlKey: 'menubarMenuTicketSort',
    scope: 'user',
    type: 'string',
    defaultValue: 'priority',
    description: 'AGI Menu: how tickets within a project are ordered — priority, updated, or title.',
    validate: oneOf('menubar.menu.ticketSort', ['priority', 'updated', 'title']),
  },
  {
    name: 'menubar.menu.showPullRequests',
    yamlKey: 'menubarMenuShowPullRequests',
    scope: 'user',
    type: 'bool',
    defaultValue: true,
    description: 'AGI Menu: show the open pull requests section for each project.',
  },
  {
    name: 'menubar.menu.sessionUpdates',
    yamlKey: 'menubarMenuSessionUpdates',
    scope: 'user',
    type: 'bool',
    defaultValue: true,
    description:
      'AGI Menu: show the session-updates section on Home. Off leaves Home to requests and progress ' +
      'only; the full list stays on the Sessions tab either way.',
  },
  {
    name: 'menubar.menu.deviceSort',
    yamlKey: 'menubarMenuDeviceSort',
    scope: 'user',
    type: 'string',
    defaultValue: 'name',
    description:
      'AGI Menu: how the device list is ordered — name, role, load, memory, or disk. The spec orders read ' +
      'the same cached fleet stats the rows render, so a device with no observation sorts last rather than ' +
      'as zero.',
    validate: oneOf('menubar.menu.deviceSort', ['name', 'role', 'load', 'memory', 'disk']),
  },
  {
    name: 'menubar.menu.headlessAgent',
    yamlKey: 'menubarMenuHeadlessAgent',
    scope: 'user',
    type: 'string',
    description:
      'AGI Menu: the harness a Headless run dispatches to by default (an agent id, e.g. claude). Unset ' +
      'leaves the choice to the menu\'s own default — this key never invents a primary harness.',
    validate: (v) =>
      isAgentId(v as string) ? null : `menubar.menu.headlessAgent must be an agent id (e.g. claude, codex), got ${JSON.stringify(v)}.`,
  },
  {
    name: 'menubar.menu.headlessFallbackAgent',
    yamlKey: 'menubarMenuHeadlessFallbackAgent',
    scope: 'user',
    type: 'string',
    description:
      'AGI Menu: the permitted alternate harness for a Headless run, dispatched as `agents run --fallback ' +
      '<agent>`. It is reached only after every usable account of the primary harness is exhausted (the ' +
      'run\'s own same-agent account failover runs first). Unset sends no --fallback.',
    validate: (v) =>
      isAgentId(v as string) ? null : `menubar.menu.headlessFallbackAgent must be an agent id (e.g. codex, grok), got ${JSON.stringify(v)}.`,
  },
  {
    name: 'menubar.menu.headlessPlacement',
    yamlKey: 'menubarMenuHeadlessPlacement',
    scope: 'user',
    type: 'string',
    defaultValue: 'auto',
    description:
      'AGI Menu: where a Headless run executes — `auto` (the CLI picks an eligible worker; `agents run ' +
      '--device auto` never picks a personal or desktop box), `local` (this machine, no --device), ' +
      '`interactive` (the box pinned as interactive.host), or a device name to pin one explicitly.',
    validate: (v) => {
      const value = v as string;
      if (value === 'auto' || value === 'local' || value === 'interactive') return null;
      try {
        assertValidDeviceName(value);
        return null;
      } catch {
        return 'menubar.menu.headlessPlacement must be auto | local | interactive | a device name.';
      }
    },
  },
  {
    name: 'menubar.menu.pinnedProjects',
    yamlKey: 'menubarMenuPinnedProjects',
    scope: 'user',
    type: 'string-list',
    defaultValue: [],
    description:
      'AGI Menu: project names pinned to the top of the Projects tab, in pin order. Set the whole list ' +
      'each time (`a,b` or a JSON array); unset = nothing pinned.',
    validate: (v) => {
      const names = v as string[];
      if (names.some((n) => n.trim() === '' || n !== n.trim())) {
        return 'menubar.menu.pinnedProjects names must be non-empty with no surrounding spaces.';
      }
      const dup = names.find((n, i) => names.indexOf(n) !== i);
      return dup === undefined ? null : `menubar.menu.pinnedProjects lists "${dup}" twice.`;
    },
  },
  {
    name: 'menubar.menu.tabOrder',
    yamlKey: 'menubarMenuTabOrder',
    scope: 'user',
    type: 'string-list',
    defaultValue: [...MENUBAR_TABS],
    description:
      `AGI Menu: the order of the tab bar — every one of ${MENUBAR_TABS.join(', ')} exactly once. ` +
      'Settings is always last and is not listed. An order saved before Goals, Secrets or GitHub existed may omit them; ' +
      'they read back appended. Hiding a tab is menubar.menu.hiddenTabs, not this key.',
    validate: (v) => {
      const tabs = v as string[];
      const required = MENUBAR_TABS.filter((t) => !MENUBAR_TABS_ADDED_LATER.includes(t));
      const ok = new Set(tabs).size === tabs.length
        && tabs.every((t) => (MENUBAR_TABS as readonly string[]).includes(t))
        && required.every((t) => tabs.includes(t));
      return ok
        ? null
        : `menubar.menu.tabOrder must list each of ${MENUBAR_TABS.join(', ')} exactly once ` +
          `(${MENUBAR_TABS_ADDED_LATER.join(', ')} may be left out and are appended).`;
    },
    normalize: (v) => (Array.isArray(v) ? resolveMenubarTabOrder(v.map(String)) : v),
  },
  {
    name: 'menubar.menu.hiddenTabs',
    yamlKey: 'menubarMenuHiddenTabs',
    scope: 'user',
    type: 'string-list',
    defaultValue: ['secrets'],
    description:
      `AGI Menu: tabs hidden from the tab bar — any of ${MENUBAR_TABS.join(', ')}, but not all of them. ` +
      'Settings cannot be hidden. Hiding Inbox loses nothing: its requests still show on Home. Secrets is hidden unless this list is set without it.',
    validate: (v) => {
      const tabs = v as string[];
      const bad = tabs.find((t) => !(MENUBAR_TABS as readonly string[]).includes(t));
      if (bad !== undefined) return `menubar.menu.hiddenTabs: "${bad}" is not one of ${MENUBAR_TABS.join(', ')}.`;
      if (new Set(tabs).size !== tabs.length) return 'menubar.menu.hiddenTabs lists a tab twice.';
      if (tabs.length === MENUBAR_TABS.length) return 'menubar.menu.hiddenTabs cannot hide every tab.';
      return null;
    },
  },
  {
    name: 'menubar.menu.githubHidden',
    yamlKey: 'menubarMenuGithubHidden',
    scope: 'user',
    type: 'string-list',
    defaultValue: [],
    description:
      'AGI Menu: what the GitHub tab leaves out — an org or account login hides all of its repos, an ' +
      'owner/repo slug hides one repo. Unset shows every org and repo `agents projects prs --json` reads.',
    validate: (v) => {
      const entries = v as string[];
      const bad = entries.find((e) => !/^[\w.-]+(\/[\w.-]+)?$/.test(e));
      if (bad !== undefined) return `menubar.menu.githubHidden: "${bad}" is not an org login or owner/repo.`;
      const dup = entries.find((e, i) => entries.findIndex((x) => x.toLowerCase() === e.toLowerCase()) !== i);
      return dup === undefined ? null : `menubar.menu.githubHidden lists "${dup}" twice.`;
    },
  },
  {
    name: 'menubar.menu.githubDrafts',
    yamlKey: 'menubarMenuGithubDrafts',
    scope: 'user',
    type: 'bool',
    defaultValue: false,
    description: 'AGI Menu: show draft pull requests on the GitHub tab (default off).',
  },
  {
    name: 'menubar.menu.githubBots',
    yamlKey: 'menubarMenuGithubBots',
    scope: 'user',
    type: 'bool',
    defaultValue: false,
    description: 'AGI Menu: show pull requests opened by bots (dependabot, CI bots) on the GitHub tab (default off).',
  },
  {
    name: 'menubar.menu.groupTicketsByMilestone',
    yamlKey: 'menubarMenuGroupTicketsByMilestone',
    scope: 'user',
    type: 'bool',
    defaultValue: false,
    description: 'AGI Menu: group a project\'s tickets under milestone headers. Off = one flat list ordered by ticketSort.',
  },
  {
    name: 'menubar.menu.prGroupOpen',
    yamlKey: 'menubarMenuPrGroupOpen',
    scope: 'user',
    type: 'string',
    defaultValue: 'none',
    description:
      'AGI Menu: how a project\'s open pull requests are grouped (the All, Ready, Drafts and Mine filters) — ' +
      'none, type (the conventional-commit type in the title), or day.',
    validate: oneOf('menubar.menu.prGroupOpen', ['none', 'type', 'day']),
  },
  {
    name: 'menubar.menu.prGroupMerged',
    yamlKey: 'menubarMenuPrGroupMerged',
    scope: 'user',
    type: 'string',
    defaultValue: 'day',
    description:
      'AGI Menu: how a project\'s recently merged pull requests are grouped — none, type (the ' +
      'conventional-commit type in the title), or day (Today, Yesterday, Earlier this week).',
    validate: oneOf('menubar.menu.prGroupMerged', ['none', 'type', 'day']),
  },
  {
    name: 'menubar.menu.homeGoals',
    yamlKey: 'menubarMenuHomeGoals',
    scope: 'user',
    type: 'string-list',
    defaultValue: ['company'],
    description:
      `AGI Menu: the goal levels shown on Home, in order — any of ${MENUBAR_HOME_GOALS.join(', ')} ` +
      '(company quarter goal, company week goal, your week goal, your day goal). Empty shows none.',
    validate: (v) => {
      const levels = v as string[];
      const bad = levels.find((l) => !(MENUBAR_HOME_GOALS as readonly string[]).includes(l));
      if (bad !== undefined) return `menubar.menu.homeGoals: "${bad}" is not one of ${MENUBAR_HOME_GOALS.join(', ')}.`;
      const dup = levels.find((l, i) => levels.indexOf(l) !== i);
      return dup === undefined ? null : `menubar.menu.homeGoals lists "${dup}" twice.`;
    },
  },
  {
    name: 'menubar.statusbar.goalCountdown',
    yamlKey: 'menubarStatusbarGoalCountdown',
    scope: 'user',
    type: 'bool',
    defaultValue: false,
    description: 'AGI Menu: show the countdown to the next goal deadline beside the menu-bar icon.',
  },
];

function dynamicAgentAutoUpdateSpec(name: string): ConfigKeySpec | null {
  const match = name.match(/^updates\.(.+)\.auto$/);
  if (!match) return null;
  const agent = match[1];
  if (!isAgentId(agent)) return null;
  return {
    name,
    yamlKey: `updatesAgentAuto.${agent}`,
    scope: 'user',
    type: 'bool',
    description:
      `Per-harness override of updates.auto for ${agent}. Only takes effect while ` +
      'updates.auto is on (the global switch is a hard kill switch, not a default this can override). Unset ' +
      'defers to updates.auto.',
  };
}

export function configKeySpec(name: string): ConfigKeySpec {
  const spec = CONFIG_KEYS.find((k) => k.name === name) ?? dynamicAgentAutoUpdateSpec(name);
  if (!spec) {
    throw new Error(
      `Unknown config key '${name}'. Known keys: ${CONFIG_KEYS.map((k) => k.name).join(', ')}.`,
    );
  }
  return spec;
}

export function assertValidValue(spec: ConfigKeySpec, value: unknown): void {
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`Config key '${spec.name}' expects a non-empty string, got ${JSON.stringify(value)}.`);
      }
      break;
    case 'int':
      if (!Number.isInteger(value)) {
        throw new Error(`Config key '${spec.name}' expects an integer, got ${JSON.stringify(value)}.`);
      }
      break;
    case 'bool':
      if (typeof value !== 'boolean') {
        throw new Error(`Config key '${spec.name}' expects a boolean, got ${JSON.stringify(value)}.`);
      }
      break;
    case 'string-list':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw new Error(`Config key '${spec.name}' expects a list of strings, got ${JSON.stringify(value)}.`);
      }
      break;
  }
  const err = spec.validate?.(value);
  if (err) throw new Error(`Invalid value for '${spec.name}': ${err}`);
}


let migrationDone = false;

function ensureDeviceConfigMigrated(): void {
  if (migrationDone || process.env.AGENTS_SKIP_MIGRATION === '1') return;
  try {
    migrateDeviceConfigStores();
    migrationDone = true;
  } catch (err: any) {
    console.error(`device config migration failed (${err?.message ?? err}); a later run retries`);
  }
}


function deviceDocPath(device: string): string {
  return path.join(getUserAgentsDir(), 'devices', device, 'agents.yaml');
}

function parseDeviceDoc(raw: string, p: string): Record<string, unknown> {
  const corrupted = (detail: string) =>
    new Error(`Device config corrupted at ${p}: ${detail}. Inspect and restore from backup.`);
  let parsed: unknown;
  try {
    parsed = yaml.parse(raw);
  } catch (err: any) {
    throw corrupted(err?.message ?? String(err));
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw corrupted(`expected a YAML map, got ${Array.isArray(parsed) ? 'a list' : JSON.stringify(parsed)}`);
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.config !== undefined && (typeof doc.config !== 'object' || doc.config === null || Array.isArray(doc.config))) {
    throw corrupted('config: must be a mapping');
  }
  return doc;
}

function readDeviceDoc(device: string): Record<string, unknown> | null {
  const p = deviceDocPath(device);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  return parseDeviceDoc(raw, p);
}

async function readDeviceDocAsync(device: string): Promise<Record<string, unknown> | null> {
  const p = deviceDocPath(device);
  let raw: string;
  try {
    raw = await fsp.readFile(p, 'utf-8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  return parseDeviceDoc(raw, p);
}

function writeDeviceDoc(device: string, doc: Record<string, unknown>): void {
  const p = deviceDocPath(device);
  if (Object.keys(doc).length === 0) {
    try {
      fs.rmSync(p, { force: true });
      fs.rmdirSync(path.dirname(p));
    } catch {  }
    return;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  atomicWriteFileSync(p, META_HEADER + yaml.stringify(doc));
}

function readFleetConfigDefaults(): Record<string, unknown> {
  const config = readMeta().fleet?.defaults?.config;
  return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
}

function readDeviceDocConfig(device: string): Record<string, unknown> {
  return (readDeviceDoc(device)?.config as Record<string, unknown> | undefined) ?? {};
}

export function readDeviceConfigValues(device: string): Record<string, unknown> {
  return { ...readFleetConfigDefaults(), ...readDeviceDocConfig(device) };
}

function targetDevice(opts?: ConfigTarget): string {
  return opts?.device ?? machineId();
}

function assertLocalTarget(spec: ConfigKeySpec, device: string): void {

  if (spec.scope !== 'device' || spec.visibility !== 'machine') return;
  if (device === machineId()) return;
  throw new Error(
    `${spec.name} is machine-local, so it can only be read or set on the device itself.\n` +
    `Run it on ${device}, e.g.: agents ssh ${device} 'agents devices config ${device} ${spec.name} <value>'`,
  );
}

export function getConfigValue(name: string, opts?: ConfigTarget): ConfigEntry {
  const spec = configKeySpec(name);
  if (spec.scope === 'user') {
    const value = readMeta({ migrate: false }).config?.[spec.yamlKey];
    if (value === undefined) return { spec, value, source: 'default' };
    return { spec, value: spec.normalize ? spec.normalize(value) : value, source: 'user' };
  }
  ensureDeviceConfigMigrated();
  if (opts?.fleet) {
    const value = readFleetConfigDefaults()[spec.yamlKey];
    return { spec, value, source: value !== undefined ? 'fleet' : 'default' };
  }
  const device = targetDevice(opts);
  assertLocalTarget(spec, device);
  const docConfig = readDeviceDocConfig(device);
  if (spec.yamlKey in docConfig) return { spec, value: docConfig[spec.yamlKey], source: 'device' };
  const fleetConfig = readFleetConfigDefaults();
  if (spec.yamlKey in fleetConfig) return { spec, value: fleetConfig[spec.yamlKey], source: 'fleet' };
  return { spec, value: undefined, source: 'default' };
}

export async function getConfigValueAsync(name: string, opts?: ConfigTarget): Promise<ConfigEntry> {
  const spec = configKeySpec(name);
  if (spec.scope === 'user') {
    const value = readMeta({ migrate: false }).config?.[spec.yamlKey];
    if (value === undefined) return { spec, value, source: 'default' };
    return { spec, value: spec.normalize ? spec.normalize(value) : value, source: 'user' };
  }
  ensureDeviceConfigMigrated();
  if (opts?.fleet) {
    const value = readFleetConfigDefaults()[spec.yamlKey];
    return { spec, value, source: value !== undefined ? 'fleet' : 'default' };
  }
  const device = targetDevice(opts);
  assertLocalTarget(spec, device);
  const docConfig = ((await readDeviceDocAsync(device))?.config as Record<string, unknown> | undefined) ?? {};
  if (spec.yamlKey in docConfig) return { spec, value: docConfig[spec.yamlKey], source: 'device' };
  const fleetConfig = readFleetConfigDefaults();
  if (spec.yamlKey in fleetConfig) return { spec, value: fleetConfig[spec.yamlKey], source: 'fleet' };
  return { spec, value: undefined, source: 'default' };
}

export function listConfig(opts?: ConfigTarget): ConfigEntry[] {
  const isPeer = !opts?.fleet && targetDevice(opts) !== machineId();
  const visible = isPeer
    ? CONFIG_KEYS.filter((spec) => spec.scope !== 'device' || spec.visibility !== 'machine')
    : CONFIG_KEYS;
  return visible.map((spec) => getConfigValue(spec.name, opts));
}



function fleetForDefaultsWrite(fleet: FleetManifest | undefined): FleetManifest {
  return { ...fleet, devices: fleet && fleet.devices !== undefined ? fleet.devices : {} };
}

function setInFleetDefaults(spec: ConfigKeySpec, value: unknown): void {
  updateMeta((m) => {
    const fleet = fleetForDefaultsWrite(m.fleet);
    const defaults = { ...fleet.defaults, config: { ...fleet.defaults?.config, [spec.yamlKey]: value } };
    return { ...m, fleet: { ...fleet, defaults } };
  });
}

function unsetInFleetDefaults(spec: ConfigKeySpec): void {
  updateMeta((m) => {
    const stored = m.fleet?.defaults?.config;
    if (!stored || !(spec.yamlKey in stored)) return m;
    const config = { ...stored };
    delete config[spec.yamlKey];
    const defaults = { ...m.fleet!.defaults };
    if (Object.keys(config).length > 0) defaults.config = config;
    else delete defaults.config;
    const fleet: FleetManifest = { ...m.fleet!, devices: m.fleet!.devices };
    if (Object.keys(defaults).length > 0) fleet.defaults = defaults;
    else delete fleet.defaults;
    const devicesEmpty = fleet.devices == null || fleet.devices === 'all'
      ? false
      : Object.keys(fleet.devices).length === 0;
    if (devicesEmpty && !fleet.defaults && !fleet.secrets && !fleet.routines) {
      const { fleet: _, ...rest } = m;
      void _;
      return rest;
    }
    return { ...m, fleet };
  });
}

function setInDeviceDoc(device: string, spec: ConfigKeySpec, value: unknown): void {
  withMetaLock(() => {
    const doc = readDeviceDoc(device) ?? {};
    doc.config = { ...(doc.config as Record<string, unknown> | undefined), [spec.yamlKey]: value };
    writeDeviceDoc(device, doc);
  });
}

function unsetInDeviceDoc(device: string, spec: ConfigKeySpec): void {
  withMetaLock(() => {
    const doc = readDeviceDoc(device);
    if (!doc) return;
    const config = doc.config as Record<string, unknown> | undefined;
    if (!config || !(spec.yamlKey in config)) return;
    delete config[spec.yamlKey];
    if (Object.keys(config).length > 0) doc.config = config;
    else delete doc.config;
    writeDeviceDoc(device, doc);
  });
}

export function setConfigValue(name: string, value: unknown, opts?: ConfigTarget): void {
  ensureDeviceConfigMigrated();
  const spec = configKeySpec(name);
  assertValidValue(spec, value);
  if (spec.normalize) value = spec.normalize(value);
  if (spec.scope === 'user') {
    if (opts?.fleet) {
      throw new Error(`Config key '${spec.name}' is user-scope (already fleet-wide) — --fleet does not apply.`);
    }
    updateMeta((m) => ({ ...m, config: { ...m.config, [spec.yamlKey]: value } }));
    return;
  }
  if (opts?.fleet) {
    setInFleetDefaults(spec, value);
    return;
  }
  const device = targetDevice(opts);
  assertLocalTarget(spec, device);
  setInDeviceDoc(device, spec, value);
}

export function unsetConfigValue(name: string, opts?: ConfigTarget): void {
  ensureDeviceConfigMigrated();
  const spec = configKeySpec(name);
  if (spec.scope === 'user') {
    if (opts?.fleet) {
      throw new Error(`Config key '${spec.name}' is user-scope (already fleet-wide) — --fleet does not apply.`);
    }
    updateMeta((m) => {
      if (!m.config || !(spec.yamlKey in m.config)) return m;
      const next = { ...m.config };
      delete next[spec.yamlKey];
      return { ...m, config: Object.keys(next).length > 0 ? next : undefined };
    });
    return;
  }
  if (opts?.fleet) {
    unsetInFleetDefaults(spec);
    return;
  }
  const device = targetDevice(opts);
  assertLocalTarget(spec, device);
  unsetInDeviceDoc(device, spec);
}


export type ConfiguredDeviceRole = (typeof DEVICE_ROLES)[number];

export type AutoPoolMode = (typeof AUTO_POOL_MODES)[number];

export function configuredDeviceRole(name: string): ConfiguredDeviceRole | undefined {
  assertValidDeviceName(name);
  return getConfigValue('role', { device: name }).value as ConfiguredDeviceRole | undefined;
}

export function selfConfiguredDeviceRole(): ConfiguredDeviceRole | undefined {
  return configuredDeviceRole(machineId());
}

export function isHeadedDeviceRole(role: ConfiguredDeviceRole | undefined): boolean {

  return role === 'personal' || role === 'desktop';
}

export function setConfiguredDeviceRole(name: string, role: ConfiguredDeviceRole | undefined): void {
  assertValidDeviceName(name);
  if (role === undefined) unsetConfigValue('role', { device: name });
  else setConfigValue('role', role, { device: name });
}

export function devicesPinningBrowserProfile(
  profile: string,
): Array<{ device: string; key: 'browser.profile' | 'browser.viewer' }> {
  ensureDeviceConfigMigrated();
  const hits: Array<{ device: string; key: 'browser.profile' | 'browser.viewer' }> = [];
  const devicesRoot = path.join(getUserAgentsDir(), 'devices');
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(devicesRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return hits;
  }
  for (const name of names.sort()) {
    const cfg = readDeviceDocConfig(name);
    if (cfg.defaultBrowserProfile === profile) hits.push({ device: name, key: 'browser.profile' });
    if (cfg.browserViewer === profile) hits.push({ device: name, key: 'browser.viewer' });
  }
  return hits;
}

export function listConfiguredDeviceRoles(roster?: string[]): Record<string, ConfiguredDeviceRole> {
  ensureDeviceConfigMigrated();
  const out: Record<string, ConfiguredDeviceRole> = {};
  const fleetRole = readFleetConfigDefaults().role;
  const names = new Set(roster ?? []);
  if (!roster) {
    const devicesRoot = path.join(getUserAgentsDir(), 'devices');
    try {
      for (const entry of fs.readdirSync(devicesRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) names.add(entry.name);
      }
    } catch {  }
  }
  for (const name of names) {
    const role = readDeviceDocConfig(name).role ?? fleetRole;
    if (typeof role === 'string' && (DEVICE_ROLES as readonly string[]).includes(role)) {
      out[name] = role as ConfiguredDeviceRole;
    }
  }
  return out;
}

export function autoPoolMode(): AutoPoolMode {
  const value = getConfigValue('auto.pool').value;
  return value === 'all' ? 'all' : 'workers';
}


export interface AutoLaunchPreference {
  enabled?: boolean;
  preferred?: boolean;
}

export function isAutoLaunchEnabled(name: string): boolean {
  assertValidDeviceName(name);
  return getConfigValue('auto-launch.enabled', { device: name }).value !== false;
}

export function setAutoLaunchEnabled(name: string, enabled: boolean): void {
  assertValidDeviceName(name);
  if (enabled) unsetConfigValue('auto-launch.enabled', { device: name });
  else setConfigValue('auto-launch.enabled', false, { device: name });
}

export function isAutoLaunchPreferred(name: string): boolean {
  assertValidDeviceName(name);
  return getConfigValue('auto-launch.preferred', { device: name }).value === true;
}

export function setAutoLaunchPreferred(name: string, preferred: boolean): void {
  assertValidDeviceName(name);
  if (preferred) setConfigValue('auto-launch.preferred', true, { device: name });
  else unsetConfigValue('auto-launch.preferred', { device: name });
}

export function loadAutoLaunchPreferences(roster?: string[]): Record<string, AutoLaunchPreference> {
  ensureDeviceConfigMigrated();
  const fleet = readFleetConfigDefaults();
  const names = new Set(roster ?? []);
  if (!roster) {
    const devicesRoot = path.join(getUserAgentsDir(), 'devices');
    try {
      for (const entry of fs.readdirSync(devicesRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) names.add(entry.name);
      }
    } catch {  }
  }
  const out: Record<string, AutoLaunchPreference> = {};
  for (const name of names) {
    const doc = readDeviceDocConfig(name);
    const enabled = (doc.autoLaunchEnabled ?? fleet.autoLaunchEnabled) as boolean | undefined;
    const preferred = (doc.autoLaunchPreferred ?? fleet.autoLaunchPreferred) as boolean | undefined;
    const pref: AutoLaunchPreference = {};
    if (enabled === false) pref.enabled = false;
    if (preferred === true) pref.preferred = true;
    if (pref.enabled !== undefined || pref.preferred !== undefined) out[name] = pref;
  }
  return out;
}


export function isSchedulerEnabled(): boolean {
  return getConfigValue('scheduler.enabled').value !== false;
}

export function assertSchedulerEnabled(): void {
  if (isSchedulerEnabled()) return;
  throw new Error(
    `The routines scheduler is disabled on this device (scheduler.enabled=false in ~/.agents/devices/${machineId()}/agents.yaml). ` +
      `Re-enable with: agents devices config ${machineId()} scheduler.enabled on`,
  );
}

export function isTmuxEnabled(): boolean {

  return getConfigValue('tmux.enabled').value === true;
}

export function isDaemonEnabled(): boolean {
  return getConfigValue('daemon.enabled').value !== false;
}

export function assertDaemonEnabled(): void {
  if (isDaemonEnabled()) return;
  throw new Error(
    `The daemon is disabled on this device (daemon.enabled=false in ~/.agents/devices/${machineId()}/agents.yaml). ` +
      `Re-enable with: agents daemon enable`,
  );
}

export async function resolveBrowserTaskIdleMs(): Promise<number | null> {
  const minutes = ((await getConfigValueAsync('browser.task-idle-minutes')).value as number | undefined) ?? 30;
  return minutes === 0 ? null : minutes * 60_000;
}

export function readMaxConcurrentCaps(devices: string[]): Record<string, number> {
  const caps: Record<string, number> = {};
  for (const device of devices) {
    const value = getConfigValue('agents.max-concurrent', { device }).value;
    if (typeof value === 'number') caps[device] = value;
  }
  return caps;
}
