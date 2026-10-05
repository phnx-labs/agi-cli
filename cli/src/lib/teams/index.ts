
/** Public API imported from '@phnx-labs/agents-cli/teams'. */
export {
  AgentManager,
  AgentProcess,
  AgentStatus,
  VALID_TASK_TYPES,
  computePathLCA,
  checkAllClis,
  checkCliAvailable,
  getAgentsDir,
  resolveMode,
  type TaskType,
  type CloudDispatchFn,
} from './agents.js';

export { type AgentType } from './parsers.js';
export { normalizeEvents, normalizeEvent, parseEvent } from './parsers.js';

export {
  handleSpawn,
  handleStatus,
  handleStop,
  handleTasks,
  type SpawnResult,
  type AgentStatusDetail,
  type TaskStatusResult,
  type StopResult,
  type TaskInfo,
  type TasksResult,
} from './api.js';

export {
  resolveAgentsDir,
  resolveBaseDir,
} from './persistence.js';

export { type EffortLevel } from './agents.js';

export {
  collapseEvents,
  getToolBreakdown,
  groupAndFlattenEvents,
  summarizeEvents,
  getDelta,
  filterEventsByPriority,
  getLastTool,
  getToolUses,
  getLastMessages,
  getQuickStatus,
  getStatusSummary,
  AgentSummary,
  PRIORITY,
  type QuickStatus,
} from './summarizer.js';

export { extractFileOpsFromBash } from './file_ops.js';
export { debug } from './debug.js';

export {
  runForEach,
  type RunForEachOptions,
  type RunForEachResult,
} from './forEach.js';

export {
  createWorktree,
  removeWorktree,
  isGitRepo,
  getGitRoot,
  hasUncommittedChanges,
  getWorktreePath,
  getWorktreeBranch,
} from './worktree.js';
