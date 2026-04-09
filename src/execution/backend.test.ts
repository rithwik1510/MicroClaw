import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChildProcess } from 'child_process';

const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockWrite = vi.fn();
const mockEnd = vi.fn();
const spawnMock = vi.fn();

vi.mock('fs', () => ({
  default: {
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  },
}));

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

vi.mock('../container-runner.js', () => ({
  readSecretsForAgent: () => ({}),
  runContainerAgent: vi.fn(),
}));

vi.mock('../group-folder.js', () => ({
  resolveGroupIpcPath: () => 'C:\\temp\\ipc',
  resolveGroupFolderPath: () => 'C:\\temp\\groups\\test',
}));

describe('runAgentProcess native timeout handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('returns error when native runner times out even after streaming output', async () => {
    mockExistsSync.mockReturnValue(true);

    const closeHandlers: Array<(code: number) => void> = [];
    const proc = {
      stdin: { write: mockWrite, end: mockEnd },
      stdout: {
        on: vi.fn(),
      },
      stderr: {
        on: vi.fn(),
      },
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') {
          closeHandlers.push(cb as (code: number) => void);
        }
      }),
      kill: vi.fn(() => {
        for (const handler of closeHandlers) handler(0);
      }),
    } as unknown as ChildProcess;

    spawnMock.mockReturnValue(proc);
    vi.useFakeTimers();

    const { runAgentProcess } = await import('./backend.js');
    const promise = runAgentProcess(
      {
        name: 'Test',
        folder: 'test',
        trigger: '@bot',
        added_at: new Date().toISOString(),
      },
      {
        prompt: 'hello',
        groupFolder: 'test',
        chatJid: 'dc:test',
        isMain: false,
        runtimeConfig: {
          provider: 'openai_compatible',
          model: 'test-model',
        },
      },
      {
        onProcess: () => undefined,
        onOutput: async () => undefined,
      },
    );

    vi.advanceTimersByTime(180_000);
    const result = await promise;
    vi.useRealTimers();

    expect(result.status).toBe('error');
    expect(result.error).toContain('Native agent timed out');
  });
});
