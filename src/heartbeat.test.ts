import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getLastHeartbeatRun,
  storeChatMetadata,
  storeMessage,
} from './db.js';

const testPaths = vi.hoisted(() => {
  const root = `${process.cwd().replace(/\\/g, '/')}/.tmp-heartbeat-tests`;
  return {
    groupsDir: `${root}/groups`,
  };
});

const mockBuildContextBundle = vi.fn();
const mockResolveRuntimeSelection = vi.fn();
const mockResolveRuntimeExecutionAsync = vi.fn();
const mockRunAgentProcess = vi.fn();

vi.mock('./config.js', async () => {
  const actual =
    await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    GROUPS_DIR: testPaths.groupsDir,
    HEARTBEAT_INTERVAL: 1_800_000,
    HEARTBEAT_TIMEOUT: 180_000,
    HEARTBEAT_MIN_GAP: 600_000,
    HEARTBEAT_POLL_INTERVAL: 60_000,
  };
});

vi.mock('./context/builder.js', () => ({
  buildContextBundle: (...args: unknown[]) => mockBuildContextBundle(...args),
}));

vi.mock('./runtime/manager.js', () => ({
  resolveRuntimeSelection: (...args: unknown[]) =>
    mockResolveRuntimeSelection(...args),
  resolveRuntimeExecutionAsync: (...args: unknown[]) =>
    mockResolveRuntimeExecutionAsync(...args),
}));

vi.mock('./execution/backend.js', () => ({
  runAgentProcess: (...args: unknown[]) => mockRunAgentProcess(...args),
}));

import {
  _resetHeartbeatLoopForTests,
  buildHeartbeatPrompt,
  loadHeartbeatChecklist,
  runHeartbeat,
  startHeartbeatLoop,
} from './heartbeat.js';

function writeFile(relativePath: string, content: string): void {
  const fullPath = path.join(testPaths.groupsDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

describe('heartbeat', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetHeartbeatLoopForTests();
    vi.useFakeTimers();
    fs.rmSync(testPaths.groupsDir, { recursive: true, force: true });
    fs.mkdirSync(testPaths.groupsDir, { recursive: true });
    mockBuildContextBundle.mockReset();
    mockResolveRuntimeSelection.mockReset();
    mockResolveRuntimeExecutionAsync.mockReset();
    mockRunAgentProcess.mockReset();
    mockBuildContextBundle.mockReturnValue({
      systemPrompt: 'system prompt',
      diagnostics: { warnings: [] },
    });
    mockResolveRuntimeSelection.mockReturnValue({
      profiles: [{ id: 'profile-1', provider: 'openai_compatible' }],
      retryPolicy: {
        maxAttempts: 1,
        backoffMs: 1000,
        retryableErrors: [],
        timeoutMs: 5000,
      },
    });
    mockResolveRuntimeExecutionAsync.mockResolvedValue({
      runtimeConfig: {
        provider: 'openai_compatible',
        model: 'test-model',
        toolPolicy: {
          web: { enabled: true },
          browser: { enabled: true },
          memory: { enabled: true },
        },
      },
      secrets: {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when no HEARTBEAT.md exists', () => {
    expect(loadHeartbeatChecklist('main')).toBeNull();
  });

  it('merges global and per-group checklists and parses overrides', () => {
    writeFile(
      'global/HEARTBEAT.md',
      '<!-- heartbeat-interval: 900000 -->\n# Global\n- Check tasks',
    );
    writeFile(
      'main/HEARTBEAT.md',
      '<!-- heartbeat-timeout: 45000 -->\n# Group\n- Remind me if needed',
    );

    const checklist = loadHeartbeatChecklist('main');

    expect(checklist).toEqual({
      content:
        '# Global\n- Check tasks\n\n---\n\n# Group\n- Remind me if needed',
      intervalMs: 900000,
      timeoutMs: 45000,
    });
  });

  it('builds a heartbeat prompt with status and checklist content', () => {
    const prompt = buildHeartbeatPrompt(
      '# Checklist\n- Notify me once if backup fails',
      {
        lastUserMessageAge: '2 hours',
        activeScheduledTasks: 3,
        recentFailures: [
          {
            prompt: 'nightly backup',
            runAt: '2026-03-14T10:00:00.000Z',
            error: 'Disk full',
          },
        ],
        lastHeartbeatSummary: '2026-03-14T09:00:00.000Z (ok)',
      },
      new Date('2026-03-14T12:00:00.000Z'),
    );

    expect(prompt).toContain(
      'Take action ONLY for explicit watch, reminder, or notify-worthy checklist items',
    );
    expect(prompt).toContain('Last user message: 2 hours ago');
    expect(prompt).toContain('nightly backup - Disk full');
    expect(prompt).toContain('# Checklist');
  });

  it('logs ok and sends nothing when the heartbeat result is HEARTBEAT_OK', async () => {
    writeFile(
      'main/HEARTBEAT.md',
      '# Group\n- Stay quiet unless something explicit is due',
    );
    storeChatMetadata('group@g.us', '2026-03-14T08:00:00.000Z');
    storeMessage({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2026-03-14T08:00:00.000Z',
      is_from_me: false,
    });

    mockRunAgentProcess.mockImplementation(
      async (_group, _input, callbacks) => {
        await callbacks.onOutput?.({
          status: 'success',
          result: 'HEARTBEAT_OK',
        });
        return { status: 'success', result: 'HEARTBEAT_OK' };
      },
    );

    const sendMessage = vi.fn(async () => {});
    await runHeartbeat(
      'group@g.us',
      {
        name: 'Main',
        folder: 'main',
        trigger: '@andy',
        added_at: '2026-03-14T00:00:00.000Z',
      },
      loadHeartbeatChecklist('main')!,
      {
        registeredGroups: () => ({}),
        queue: { closeStdin: vi.fn(), isGroupActive: () => false } as any,
        onProcess: () => {},
        sendMessage,
      },
    );

    expect(sendMessage).not.toHaveBeenCalled();
    expect(getLastHeartbeatRun('main')?.status).toBe('ok');
  });

  it('sends actionable heartbeat output and disables browser tools for the run', async () => {
    writeFile(
      'main/HEARTBEAT.md',
      '# Group\n- At 6 PM, remind me if I have not sent the update',
    );
    storeChatMetadata('group@g.us', '2026-03-14T08:00:00.000Z');
    storeMessage({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'please remind me at 6 pm if I forget',
      timestamp: '2026-03-14T08:00:00.000Z',
      is_from_me: false,
    });
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'backup db',
      schedule_type: 'once',
      schedule_value: '2026-03-14T18:00:00.000Z',
      context_mode: 'group',
      next_run: '2026-03-14T18:00:00.000Z',
      status: 'active',
      created_at: '2026-03-14T00:00:00.000Z',
    });

    mockRunAgentProcess.mockImplementation(async (_group, input, callbacks) => {
      expect(input.sessionId).toBeUndefined();
      expect(input.singleTurn).toBe(true);
      expect(input.isHeartbeat).toBe(true);
      expect(input.runtimeConfig?.capabilityRoute).toBe('web_lookup');
      expect(input.runtimeConfig?.toolPolicy?.browser?.enabled).toBe(false);
      await callbacks.onOutput?.({
        status: 'success',
        result: 'Reminder: you asked me to nudge you about the update.',
      });
      return {
        status: 'success',
        result: 'Reminder: you asked me to nudge you about the update.',
      };
    });

    const sendMessage = vi.fn(async () => {});
    await runHeartbeat(
      'group@g.us',
      {
        name: 'Main',
        folder: 'main',
        trigger: '@andy',
        added_at: '2026-03-14T00:00:00.000Z',
      },
      loadHeartbeatChecklist('main')!,
      {
        registeredGroups: () => ({}),
        queue: { closeStdin: vi.fn(), isGroupActive: () => false } as any,
        onProcess: () => {},
        sendMessage,
      },
    );

    expect(sendMessage).toHaveBeenCalledWith(
      'group@g.us',
      'Reminder: you asked me to nudge you about the update.',
    );
    expect(getLastHeartbeatRun('main')?.status).toBe('acted');
  });

  it('skips active groups and avoids duplicate loop starts', async () => {
    writeFile('main/HEARTBEAT.md', '# Group\n- Reminder item');
    const enqueueTask = vi.fn();
    const queue = {
      isGroupActive: vi.fn(() => true),
      enqueueTask,
    } as any;

    startHeartbeatLoop({
      registeredGroups: () => ({
        'group@g.us': {
          name: 'Main',
          folder: 'main',
          trigger: '@andy',
          added_at: '2026-03-14T00:00:00.000Z',
        },
      }),
      queue,
      onProcess: () => {},
      sendMessage: async () => {},
    });
    startHeartbeatLoop({
      registeredGroups: () => ({
        'group@g.us': {
          name: 'Main',
          folder: 'main',
          trigger: '@andy',
          added_at: '2026-03-14T00:00:00.000Z',
        },
      }),
      queue,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(queue.isGroupActive).toHaveBeenCalledTimes(1);
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it('respects the minimum gap between heartbeat runs', async () => {
    writeFile(
      'main/HEARTBEAT.md',
      '<!-- heartbeat-interval: 1000 -->\n# Group\n- Reminder item',
    );
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: 'HEARTBEAT_OK',
    });

    const sendMessage = vi.fn(async () => {});
    const queue = {
      isGroupActive: () => false,
      closeStdin: vi.fn(),
      enqueueTask: vi.fn(
        async (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
          await fn();
        },
      ),
    } as any;

    startHeartbeatLoop({
      registeredGroups: () => ({
        'group@g.us': {
          name: 'Main',
          folder: 'main',
          trigger: '@andy',
          added_at: '2026-03-14T00:00:00.000Z',
        },
      }),
      queue,
      onProcess: () => {},
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(queue.enqueueTask).toHaveBeenCalledTimes(1);
  });

  it('suppresses repeated identical heartbeat notifications within the cooldown window', async () => {
    writeFile(
      'main/HEARTBEAT.md',
      '# Group\n- Send the same reminder when due',
    );
    storeChatMetadata('group@g.us', '2026-03-14T08:00:00.000Z');
    storeMessage({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'watch this for me',
      timestamp: '2026-03-14T08:00:00.000Z',
      is_from_me: false,
    });

    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: 'Reminder: this is the same notification.',
    });

    const sendMessage = vi.fn(async () => {});
    const deps = {
      registeredGroups: () => ({}),
      queue: { closeStdin: vi.fn(), isGroupActive: () => false } as any,
      onProcess: () => {},
      sendMessage,
    };
    const group = {
      name: 'Main',
      folder: 'main',
      trigger: '@andy',
      added_at: '2026-03-14T00:00:00.000Z',
    };

    await runHeartbeat(
      'group@g.us',
      group,
      loadHeartbeatChecklist('main')!,
      deps,
    );
    await runHeartbeat(
      'group@g.us',
      group,
      loadHeartbeatChecklist('main')!,
      deps,
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
