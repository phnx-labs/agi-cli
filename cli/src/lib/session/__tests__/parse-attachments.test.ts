import { describe, expect, test } from 'vitest';
import { parseClaudeContent } from '@phnx-labs/sessions-cli/reader';

describe('session attachment parsing', () => {
  test('Claude image blocks preserve path, display name, media type, and size', () => {
    const events = parseClaudeContent(JSON.stringify({
      type: 'user',
      timestamp: '2026-07-12T10:00:00Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Please use this screenshot.' },
          {
            type: 'image',
            name: 'factory-floor.png',
            source: {
              type: 'file',
              path: '/home/muqsit/.agents/.history/attachments/factory-floor.png',
              media_type: 'image/png',
              sizeBytes: 12345,
            },
          },
        ],
      },
    }));

    expect(events.find((event) => event.type === 'attachment')).toMatchObject({
      type: 'attachment',
      agent: 'claude',
      timestamp: '2026-07-12T10:00:00Z',
      path: '/home/muqsit/.agents/.history/attachments/factory-floor.png',
      name: 'factory-floor.png',
      mediaType: 'image/png',
      sizeBytes: 12345,
    });
  });
});
