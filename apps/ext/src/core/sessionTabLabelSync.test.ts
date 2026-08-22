import { describe, expect, test } from 'bun:test';
import {
  isScaffoldingSessionTopic,
  planSessionTabLabelUpdate,
  restoredSessionTabLabels,
} from './sessionTabLabelSync';

describe('session tab label reconciliation', () => {
  test('replaces a provisional remote /continue title when the session name arrives', () => {
    expect(planSessionTabLabelUpdate(
      { autoLabel: '/continue /Users/muqsit/Screenshots/CleanShot.png' },
      { topic: '/continue /Users/muqsit/Screenshots/CleanShot.png', label: 'Release the project' },
    )).toEqual({ label: 'Release the project', clearManualLabel: false });
  });

  test('repairs the same provisional title after an older extension promoted it to manual', () => {
    expect(planSessionTabLabelUpdate(
      { manualLabel: '/continue /Users/muqsit/Screenshots/CleanShot.png' },
      { topic: '/continue /Users/muqsit/Screenshots/CleanShot.png', label: 'Release the project' },
    )).toEqual({ label: 'Release the project', clearManualLabel: true });
  });

  test('preserves a genuine user label over the harness-generated name', () => {
    expect(planSessionTabLabelUpdate(
      { manualLabel: 'Ship blocker' },
      { topic: 'Release the project', label: 'Release agents-cli' },
    )).toBeUndefined();
  });

  test('preserves the ticket prefix used by generated tab labels', () => {
    expect(planSessionTabLabelUpdate(
      { autoLabel: 'RUSH-3011 Initial task' },
      { topic: 'Fix RUSH-3011 remote tabs', label: 'Release the project' },
    )).toEqual({ label: 'RUSH-3011 Release the project', clearManualLabel: false });
  });

  test('does nothing until a canonical session name exists or when already current', () => {
    expect(planSessionTabLabelUpdate(
      { autoLabel: 'Initial task' },
      { topic: 'Initial task', label: '' },
    )).toBeUndefined();
    expect(planSessionTabLabelUpdate(
      { autoLabel: 'Release the project' },
      { topic: 'Initial task', label: 'Release the project' },
    )).toBeUndefined();
  });

  test('rejects raw slash commands as task topics', () => {
    expect(isScaffoldingSessionTopic('/continue /path/to/clip.png')).toBe(true);
    expect(isScaffoldingSessionTopic('<command-name>/continue</command-name>')).toBe(true);
    expect(isScaffoldingSessionTopic('Release the project')).toBe(false);
  });

  test('restores a generated title as automatic rather than manual', () => {
    expect(restoredSessionTabLabels('Release the project', {
      autoLabel: 'Release the project',
    })).toEqual({ manualLabel: undefined, autoLabel: 'Release the project' });
  });

  test('restores a genuine manual label over the remembered automatic title', () => {
    expect(restoredSessionTabLabels('Ship blocker', {
      label: 'Ship blocker',
      autoLabel: 'Release the project',
    })).toEqual({ manualLabel: 'Ship blocker', autoLabel: 'Release the project' });
  });
});
