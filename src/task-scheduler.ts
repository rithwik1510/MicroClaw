import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import { ContainerOutput, writeTasksSnapshot } from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logRuntimeEvent,
  logRuntimeUsage,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  resolveRuntimeExecutionAsync,
  resolveRuntimeSelection,
} from './runtime/manager.js';
import { resolveCapabilityRoute } from './runtime/capability-router.js';
import { RegisteredGroup, ScheduledTask } from './types.js';
import { runAgentProcess } from './execution/backend.js';
import { buildRuntimeUsageLog } from './runtime-usage.js';

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;
  const runtimeSelection = resolveRuntimeSelection(task.group_folder);
  const requestedPrompt = task.requested_prompt?.trim() || task.prompt;
  const executionPrompt = [
    '[Scheduled task execution]',
    `Task: ${task.prompt}`,
    `Original request: ${requestedPrompt}`,
    '',
    'Execution rules:',
    '- This task is already scheduled and firing NOW. Do NOT reschedule, re-create, or discuss scheduling.',
    '- Do NOT call schedule_once_task, schedule_recurring_task, schedule_interval_task, or register_watch.',
    '- You MUST use your web tools (web_search, web_fetch) to gather real, current information.',
    '- Search for at least 2-3 different queries to get comprehensive coverage.',
    '- After searching, use web_fetch to read the most relevant result pages.',
    '- Deliver a thorough, well-structured answer with specific facts, names, dates, and details.',
    '- Use bullet points or numbered lists for clarity. Include source URLs when possible.',
    '- Do NOT say "I will now search" — just do it. Do NOT give a single vague sentence as the answer.',
  ].join('\n');

  // Compute capability route from the task's actual prompt (not executionPrompt),
  // because executionPrompt includes the original user request which often contains
  // time phrases like "At 5 PM today" — these trigger hasFutureOrRecurringTaskRequest
  // and force route='plain_response', disabling web tools even when needed.
  const taskCapabilityRoute = resolveCapabilityRoute({
    prompt: task.prompt,
    // Pass enabled flags so the router can detect web/browser intent.
    // Without these, webEnabled and browserEnabled are false and the
    // router always returns 'plain_response', stripping web tools.
    toolPolicy: {
      web: { enabled: true },
      browser: { enabled: true },
      isScheduledTask: true,
    },
  });

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    let completed = false;
    for (let i = 0; i < runtimeSelection.profiles.length; i++) {
      const profile = runtimeSelection.profiles[i];
      let sentOutput = false;
      let usageLogged = false;
      error = null;
      const attemptStartedAt = new Date().toISOString();
      const attemptStartedAtMs = Date.now();

      logRuntimeEvent({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        profileId: profile.id,
        provider: profile.provider,
        eventType: 'auth_profile_selected',
        message: `Selected runtime profile ${profile.id}`,
        timestamp: new Date().toISOString(),
      });

      const resolved = await resolveRuntimeExecutionAsync(profile);
      const capabilityRoute = taskCapabilityRoute;
      if (
        resolved.authRefreshMessage &&
        resolved.authRefreshMessage.toLowerCase().includes('refreshed')
      ) {
        logRuntimeEvent({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          groupFolder: task.group_folder,
          chatJid: task.chat_jid,
          profileId: profile.id,
          provider: profile.provider,
          eventType: 'token_refreshed',
          message: resolved.authRefreshMessage,
          timestamp: new Date().toISOString(),
        });
      }

      logRuntimeEvent({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        profileId: profile.id,
        provider: profile.provider,
        eventType: 'attempt',
        message: `Scheduled task attempt ${i + 1} using profile ${profile.id}`,
        timestamp: new Date().toISOString(),
      });

      const output = await runAgentProcess(
        group,
        {
          prompt: executionPrompt,
          sessionId,
          groupFolder: task.group_folder,
          chatJid: task.chat_jid,
          isMain,
          isScheduledTask: true,
          assistantName: ASSISTANT_NAME,
          runtimeProfileId: profile.id,
          runtimeConfig: {
            ...resolved.runtimeConfig,
            capabilityRoute,
            toolPolicy: {
              ...resolved.runtimeConfig.toolPolicy,
              isScheduledTask: true,
            },
          },
          retryPolicy: runtimeSelection.retryPolicy,
          secrets: resolved.secrets,
        },
        {
          onProcess: (proc, containerName) =>
            deps.onProcess(
              task.chat_jid,
              proc,
              containerName,
              task.group_folder,
            ),
          onOutput: async (streamedOutput: ContainerOutput) => {
            if (!usageLogged && streamedOutput.usage) {
              usageLogged = true;
              const usageLog = buildRuntimeUsageLog({
                groupFolder: task.group_folder,
                chatJid: task.chat_jid,
                profileId: profile.id,
                provider: profile.provider,
                model: profile.model,
                triggerKind: 'scheduled_task',
                startedAt: attemptStartedAt,
                durationMs: Date.now() - attemptStartedAtMs,
                usage: streamedOutput.usage,
              });
              logRuntimeUsage(usageLog);
              logger.info(
                {
                  taskId: task.id,
                  profile: profile.id,
                  trigger: 'scheduled_task',
                  tokens: usageLog.usage.totalTokens,
                  costUsd: usageLog.totalCostUsd,
                  usageSource: usageLog.usage.source,
                },
                'Runtime usage recorded',
              );
            }
            if (streamedOutput.result) {
              sentOutput = true;
              result = streamedOutput.result;
              // Forward result to user (sendMessage handles formatting)
              await deps.sendMessage(task.chat_jid, streamedOutput.result);
              scheduleClose();
            }
            if (streamedOutput.status === 'success') {
              deps.queue.notifyIdle(task.chat_jid);
            }
            if (streamedOutput.status === 'error') {
              error = streamedOutput.error || 'Unknown error';
            }
          },
        },
      );

      if (closeTimer) clearTimeout(closeTimer);

      if (output.status !== 'error') {
        if (output.result) {
          // Messages are sent via MCP tool (IPC), result text is just logged
          result = output.result;
        }
        logRuntimeEvent({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          groupFolder: task.group_folder,
          chatJid: task.chat_jid,
          profileId: profile.id,
          provider: profile.provider,
          eventType: 'success',
          message: `Scheduled task succeeded with profile ${profile.id}`,
          timestamp: new Date().toISOString(),
        });
        completed = true;
        break;
      }

      const hasFallback = i < runtimeSelection.profiles.length - 1;
      logRuntimeEvent({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        profileId: profile.id,
        provider: profile.provider,
        eventType: hasFallback ? 'failover' : 'error',
        message: output.error || `Task failed on profile ${profile.id}`,
        timestamp: new Date().toISOString(),
      });

      // If output already reached user, avoid failover duplicates.
      if (sentOutput) {
        completed = true;
        break;
      }
    }

    if (!completed && !error) {
      error = 'All runtime profiles failed';
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  let nextRun: string | null = null;
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    nextRun = interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    nextRun = new Date(Date.now() + ms).toISOString();
  }
  // 'once' tasks have no next run

  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(
          currentTask.chat_jid,
          currentTask.id,
          () => runTask(currentTask, deps),
          { lane: 'background' },
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
