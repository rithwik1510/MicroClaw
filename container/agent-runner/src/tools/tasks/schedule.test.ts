import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ToolExecutionContext } from '../types.js';

function makeCtx(
  secrets?: Record<string, string>,
): ToolExecutionContext {
  return {
    secrets,
    maxSearchCallsPerTurn: 1,
    maxToolSteps: 3,
    searchTimeoutMs: 1000,
    pageFetchTimeoutMs: 1000,
    totalWebBudgetMs: 5000,
    startedAtMs: Date.now(),
    stepCount: 0,
    searchCount: 0,
  };
}

function tasksDir(tmpDir: string): string {
  return path.join(tmpDir, 'tasks');
}

describe('executeScheduleTask', () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-task-test-'));
    process.env.NANOCLAW_IPC_INPUT_DIR = path.join(tmpDir, 'input');
    process.env.NANOCLAW_CHAT_JID = 'dc:test-chat';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a once schedule request for the current chat', async () => {
    const { executeScheduleTask } = await import('./schedule.js');
    const future = new Date(Date.now() + 60_000).toISOString();

    const result = await executeScheduleTask(
      {
        prompt: 'Read the latest AI release news and send me the key updates.',
        schedule_type: 'once',
        schedule_value: future,
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    const files = fs
      .readdirSync(tasksDir(tmpDir))
      .filter((file) => file.endsWith('.json'));
    expect(files).toHaveLength(1);
    const payload = JSON.parse(
      fs.readFileSync(path.join(tasksDir(tmpDir), files[0]), 'utf8'),
    ) as Record<string, string>;
    expect(payload.type).toBe('schedule_task');
    expect(payload.targetJid).toBe('dc:test-chat');
    expect(payload.context_mode).toBe('isolated');
    expect(payload.schedule_type).toBe('once');
    expect(payload.schedule_value).toBe(future);
    expect(payload.requested_prompt).toBe(
      'Read the latest AI release news and send me the key updates.',
    );
  });

  it('accepts simple local once schedules like today plus a clock time', async () => {
    const { executeScheduleTask } = await import('./schedule.js');
    const now = new Date();
    const future = new Date(now.getTime() + 10 * 60_000);
    const hour12 = future.getHours() % 12 || 12;
    const minutes = String(future.getMinutes()).padStart(2, '0');
    const ampm = future.getHours() >= 12 ? 'PM' : 'AM';
    const result = await executeScheduleTask(
      {
        prompt: 'Read the latest AI release news and send me the important updates.',
        schedule_type: 'once',
        schedule_value: `today ${hour12}:${minutes} ${ampm}`,
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    const files = fs
      .readdirSync(tasksDir(tmpDir))
      .filter((file) => file.endsWith('.json'));
    expect(files).toHaveLength(1);
  });

  it('falls back to the original prompt for one-time natural schedules when the model omits schedule_value', async () => {
    const { executeScheduleOnceTask } = await import('./schedule.js');
    const now = new Date();
    const future = new Date(now.getTime() + 10 * 60_000);
    const hour12 = future.getHours() % 12 || 12;
    const minutes = String(future.getMinutes()).padStart(2, '0');
    const ampm = future.getHours() >= 12 ? 'PM' : 'AM';

    const result = await executeScheduleOnceTask(
      {
        prompt: 'Read the latest AI release news and send me the important updates.',
      },
      makeCtx({
        NANOCLAW_CHAT_JID: 'dc:test-chat',
        NANOCLAW_CURRENT_TIME_ISO: now.toISOString(),
        NANOCLAW_ORIGINAL_PROMPT: `At ${hour12}:${minutes} ${ampm} today, read the latest AI release news and send me the important updates.`,
      }),
    );

    expect(result.ok).toBe(true);
    const files = fs
      .readdirSync(tasksDir(tmpDir))
      .filter((file) => file.endsWith('.json'));
    expect(files).toHaveLength(1);
    const payload = JSON.parse(
      fs.readFileSync(path.join(tasksDir(tmpDir), files[0]), 'utf8'),
    ) as Record<string, string>;
    expect(payload.schedule_type).toBe('once');
    expect(payload.requested_prompt).toContain('At');
  });

  it('validates cron expressions', async () => {
    const { executeScheduleTask } = await import('./schedule.js');
    const result = await executeScheduleTask(
      {
        prompt: 'Send the weekday summary.',
        schedule_type: 'cron',
        schedule_value: 'not a cron',
      },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain('Could not understand the recurring schedule');
  });

  it('parses natural recurring phrases without requiring a raw cron string', async () => {
    const { executeScheduleRecurringTask } = await import('./schedule.js');
    const result = await executeScheduleRecurringTask(
      {
        prompt: 'Send the weekday summary.',
        recurrence: 'every weekday at 9 AM',
      },
      makeCtx({
        NANOCLAW_CHAT_JID: 'dc:test-chat',
      }),
    );

    expect(result.ok).toBe(true);
    const files = fs
      .readdirSync(tasksDir(tmpDir))
      .filter((file) => file.endsWith('.json'));
    const payload = JSON.parse(
      fs.readFileSync(path.join(tasksDir(tmpDir), files[0]), 'utf8'),
    ) as Record<string, string>;
    expect(payload.schedule_type).toBe('cron');
    expect(payload.schedule_value).toBe('0 9 * * 1-5');
  });

  it('normalizes interval numbers and respects explicit context mode', async () => {
    const { executeScheduleTask } = await import('./schedule.js');
    const result = await executeScheduleTask(
      {
        prompt: 'Check the watchlist again.',
        schedule_type: 'interval',
        schedule_value: 3_600_000,
        context_mode: 'isolated',
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    const files = fs
      .readdirSync(tasksDir(tmpDir))
      .filter((file) => file.endsWith('.json'));
    const payload = JSON.parse(
      fs.readFileSync(path.join(tasksDir(tmpDir), files[0]), 'utf8'),
    ) as Record<string, string>;
    expect(payload.schedule_value).toBe('3600000');
    expect(payload.context_mode).toBe('isolated');
  });

  it('parses natural interval phrases', async () => {
    const { executeScheduleIntervalTask } = await import('./schedule.js');
    const result = await executeScheduleIntervalTask(
      {
        prompt: 'Check the watchlist again.',
        every: 'every 5 minutes',
      },
      makeCtx({
        NANOCLAW_CHAT_JID: 'dc:test-chat',
      }),
    );

    expect(result.ok).toBe(true);
    const files = fs
      .readdirSync(tasksDir(tmpDir))
      .filter((file) => file.endsWith('.json'));
    const payload = JSON.parse(
      fs.readFileSync(path.join(tasksDir(tmpDir), files[0]), 'utf8'),
    ) as Record<string, string>;
    expect(payload.schedule_type).toBe('interval');
    expect(payload.schedule_value).toBe('300000');
  });
});
