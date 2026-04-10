import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  GROUPS_DIR,
  HEARTBEAT_INTERVAL,
  HEARTBEAT_MIN_GAP,
  HEARTBEAT_POLL_INTERVAL,
  HEARTBEAT_TIMEOUT,
} from './config.js';
import {
  getLastHeartbeatRun,
  getRecentMessages,
  getRecentTaskFailuresForGroup,
  getTasksForGroup,
  logRuntimeUsage,
  logHeartbeatRun,
} from './db.js';
import { runAgentProcess } from './execution/backend.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import {
  resolveRuntimeExecutionAsync,
  resolveRuntimeSelection,
} from './runtime/manager.js';
import { buildContextBundle } from './context/builder.js';
import { ContainerOutput } from './container-runner.js';
import { RegisteredGroup } from './types.js';
import { buildRuntimeUsageLog } from './runtime-usage.js';

const HEARTBEAT_OK_SENTINEL = 'HEARTBEAT_OK';
const HEARTBEAT_CLOSE_DELAY_MS = 5000;
const HEARTBEAT_REPEAT_SUPPRESSION_MS = 12 * 60 * 60 * 1000;
const OVERRIDE_COMMENT_PATTERN =
  /<!--\s*heartbeat-(interval|timeout)\s*:\s*(\d+)\s*-->/gi;

export interface HeartbeatChecklist {
  content: string;
  intervalMs: number;
  timeoutMs: number;
}

interface ParsedHeartbeatChecklist extends HeartbeatChecklist {
  intervalOverridden: boolean;
  timeoutOverridden: boolean;
}

export interface HeartbeatDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

type HeartbeatStatusSummary = {
  lastUserMessageAge: string;
  activeScheduledTasks: number;
  recentFailures: Array<{
    prompt: string;
    runAt: string;
    error: string | null;
  }>;
  lastHeartbeatSummary: string;
};

let heartbeatRunning = false;

function readHeartbeatFile(filePath: string): ParsedHeartbeatChecklist | null {
  if (!fs.existsSync(filePath)) return null;

  let intervalMs = HEARTBEAT_INTERVAL;
  let timeoutMs = HEARTBEAT_TIMEOUT;
  let intervalOverridden = false;
  let timeoutOverridden = false;
  const raw = fs.readFileSync(filePath, 'utf8');
  const content = raw
    .replace(OVERRIDE_COMMENT_PATTERN, (_full, key, value) => {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        if (key === 'interval') {
          intervalMs = parsed;
          intervalOverridden = true;
        }
        if (key === 'timeout') {
          timeoutMs = parsed;
          timeoutOverridden = true;
        }
      }
      return '';
    })
    .trim();

  if (!content) {
    return {
      content: '',
      intervalMs,
      timeoutMs,
      intervalOverridden,
      timeoutOverridden,
    };
  }

  return {
    content,
    intervalMs,
    timeoutMs,
    intervalOverridden,
    timeoutOverridden,
  };
}

export function loadHeartbeatChecklist(
  groupFolder: string,
): HeartbeatChecklist | null {
  const globalPath = path.join(GROUPS_DIR, 'global', 'HEARTBEAT.md');
  const groupPath = path.join(GROUPS_DIR, groupFolder, 'HEARTBEAT.md');
  const globalChecklist = readHeartbeatFile(globalPath);
  const groupChecklist = readHeartbeatFile(groupPath);

  if (!globalChecklist && !groupChecklist) return null;

  const parts = [globalChecklist?.content, groupChecklist?.content].filter(
    (part): part is string =>
      typeof part === 'string' && part.trim().length > 0,
  );
  return {
    content: parts.join('\n\n---\n\n').trim(),
    intervalMs: groupChecklist?.intervalOverridden
      ? groupChecklist.intervalMs
      : globalChecklist?.intervalOverridden
        ? globalChecklist.intervalMs
        : HEARTBEAT_INTERVAL,
    timeoutMs: groupChecklist?.timeoutOverridden
      ? groupChecklist.timeoutMs
      : globalChecklist?.timeoutOverridden
        ? globalChecklist.timeoutMs
        : HEARTBEAT_TIMEOUT,
  };
}

function formatDurationFromMs(ms: number): string {
  if (ms < 60_000) return 'less than a minute';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

function summarizeRecentFailures(
  failures: Array<{ prompt: string; run_at: string; error: string | null }>,
): Array<{ prompt: string; runAt: string; error: string | null }> {
  return failures.map((failure) => ({
    prompt: failure.prompt,
    runAt: failure.run_at,
    error: failure.error,
  }));
}

function getHeartbeatStatusSummary(
  groupJid: string,
  group: RegisteredGroup,
): HeartbeatStatusSummary {
  const recentMessages = getRecentMessages(groupJid, 16);
  const lastUserMessage = [...recentMessages]
    .reverse()
    .find((message) => !message.is_from_me && !message.is_bot_message);
  const lastUserMessageAge = lastUserMessage
    ? formatDurationFromMs(
        Date.now() - new Date(lastUserMessage.timestamp).getTime(),
      )
    : 'no user messages yet';
  const activeScheduledTasks = getTasksForGroup(group.folder).filter(
    (task) => task.status === 'active',
  ).length;
  const lastHeartbeat = getLastHeartbeatRun(group.folder);
  const recentFailures = summarizeRecentFailures(
    getRecentTaskFailuresForGroup(group.folder, lastHeartbeat?.run_at),
  );
  const lastHeartbeatSummary = lastHeartbeat
    ? `${lastHeartbeat.run_at} (${lastHeartbeat.status})`
    : 'never';

  return {
    lastUserMessageAge,
    activeScheduledTasks,
    recentFailures,
    lastHeartbeatSummary,
  };
}

export function buildHeartbeatPrompt(
  checklist: string,
  metadata: HeartbeatStatusSummary,
  now = new Date(),
): string {
  const failureLines =
    metadata.recentFailures.length > 0
      ? metadata.recentFailures
          .map((failure) => {
            const errorSummary = failure.error ? ` - ${failure.error}` : '';
            return `- ${failure.runAt}: ${failure.prompt}${errorSummary}`;
          })
          .join('\n')
      : '- None since the last heartbeat';

  return [
    `[Heartbeat check - ${now.toISOString()}, ${now.toLocaleDateString('en-US', { weekday: 'long' })}]`,
    '',
    'You are performing a scheduled heartbeat check.',
    'Review the checklist and structured status below.',
    'Take action ONLY for explicit watch, reminder, or notify-worthy checklist items that need attention right now.',
    'Prefer silence. Do not send greetings, small talk, or broad helpful observations.',
    'Do not browse unless an explicit checklist item needs lightweight web verification.',
    `If NOTHING needs attention, respond with exactly: ${HEARTBEAT_OK_SENTINEL}`,
    '',
    '## Status',
    `- Last user message: ${metadata.lastUserMessageAge} ago`,
    `- Active scheduled tasks: ${metadata.activeScheduledTasks}`,
    `- Last heartbeat: ${metadata.lastHeartbeatSummary}`,
    '- Recent failed tasks:',
    failureLines,
    '',
    '## Checklist',
    checklist || '- No checklist items configured.',
  ].join('\n');
}

function sanitizeHeartbeatOutput(text: string | null | undefined): string {
  if (!text) return '';
  return (
    text
      .replace(/<internal>[\s\S]*?<\/internal>/gi, '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      // Strip LM Studio / model interruption artifacts that appear when
      // concurrent requests race (e.g. "[Request interrupted by user]").
      .replace(/\[Request interrupted by user\]/gi, '')
      .replace(/\[Generation interrupted\]/gi, '')
      .trim()
  );
}

export async function runHeartbeat(
  groupJid: string,
  group: RegisteredGroup,
  checklist: HeartbeatChecklist,
  deps: HeartbeatDependencies,
): Promise<void> {
  const startedAt = Date.now();
  const status = getHeartbeatStatusSummary(groupJid, group);
  const heartbeatPrompt = buildHeartbeatPrompt(checklist.content, status);
  const contextBundle = buildContextBundle({
    groupFolder: group.folder,
    prompt: heartbeatPrompt,
  });
  const runtimeSelection = resolveRuntimeSelection(group.folder);
  let finalText = '';
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let lastError: string | null = null;

  const scheduleClose = () => {
    if (closeTimer) return;
    closeTimer = setTimeout(() => {
      deps.queue.closeStdin(groupJid);
    }, HEARTBEAT_CLOSE_DELAY_MS);
  };

  try {
    for (let i = 0; i < runtimeSelection.profiles.length; i++) {
      const profile = runtimeSelection.profiles[i];
      let usageLogged = false;
      const attemptStartedAt = new Date().toISOString();
      const attemptStartedAtMs = Date.now();
      const resolved = await resolveRuntimeExecutionAsync(profile);
      const output = await runAgentProcess(
        group,
        {
          prompt: heartbeatPrompt,
          systemPrompt: contextBundle.systemPrompt,
          groupFolder: group.folder,
          chatJid: groupJid,
          isMain: group.isMain === true,
          singleTurn: true,
          isHeartbeat: true,
          assistantName: ASSISTANT_NAME,
          runtimeProfileId: profile.id,
          runtimeConfig: {
            ...resolved.runtimeConfig,
            capabilityRoute: 'web_lookup',
            plannerCritic: {
              enabled: false,
              maxRevisionCycles: 0,
            },
            toolPolicy: {
              ...resolved.runtimeConfig.toolPolicy,
              isHeartbeat: true,
              browser: {
                ...resolved.runtimeConfig.toolPolicy?.browser,
                enabled: false,
              },
            },
          },
          retryPolicy: runtimeSelection.retryPolicy,
          secrets: resolved.secrets,
        },
        {
          onProcess: (proc, containerName) =>
            deps.onProcess(groupJid, proc, containerName, group.folder),
          onOutput: async (streamedOutput: ContainerOutput) => {
            if (!usageLogged && streamedOutput.usage) {
              usageLogged = true;
              const usageLog = buildRuntimeUsageLog({
                groupFolder: group.folder,
                chatJid: groupJid,
                profileId: profile.id,
                provider: profile.provider,
                model: profile.model,
                triggerKind: 'heartbeat',
                startedAt: attemptStartedAt,
                durationMs: Date.now() - attemptStartedAtMs,
                usage: streamedOutput.usage,
              });
              logRuntimeUsage(usageLog);
              logger.info(
                {
                  group: group.folder,
                  profile: profile.id,
                  trigger: 'heartbeat',
                  tokens: usageLog.usage.totalTokens,
                  costUsd: usageLog.totalCostUsd,
                  usageSource: usageLog.usage.source,
                },
                'Runtime usage recorded',
              );
            }
            if (streamedOutput.result) {
              finalText = streamedOutput.result;
              scheduleClose();
            }
            if (streamedOutput.status === 'error') {
              lastError = streamedOutput.error || 'Unknown heartbeat error';
            }
          },
        },
      );

      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }

      if (output.status !== 'error') {
        if (output.result) finalText = output.result;
        lastError = null;
        break;
      }

      lastError = output.error || 'Unknown heartbeat error';
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - startedAt;
  const sanitized = sanitizeHeartbeatOutput(finalText);
  const previousRun = getLastHeartbeatRun(group.folder);
  if (lastError) {
    logHeartbeatRun({
      group_folder: group.folder,
      chat_jid: groupJid,
      run_at: new Date().toISOString(),
      duration_ms: durationMs,
      status: 'error',
      actions_taken: null,
      error: lastError,
    });
    logger.error({ group: group.folder, error: lastError }, 'Heartbeat failed');
    return;
  }

  if (
    !sanitized ||
    sanitized === HEARTBEAT_OK_SENTINEL ||
    sanitized.startsWith(HEARTBEAT_OK_SENTINEL)
  ) {
    logHeartbeatRun({
      group_folder: group.folder,
      chat_jid: groupJid,
      run_at: new Date().toISOString(),
      duration_ms: durationMs,
      status: 'ok',
      actions_taken: null,
      error: null,
    });
    return;
  }

  if (
    previousRun?.status === 'acted' &&
    previousRun.actions_taken === sanitized &&
    Date.now() - new Date(previousRun.run_at).getTime() <
      HEARTBEAT_REPEAT_SUPPRESSION_MS
  ) {
    logHeartbeatRun({
      group_folder: group.folder,
      chat_jid: groupJid,
      run_at: new Date().toISOString(),
      duration_ms: durationMs,
      status: 'ok',
      actions_taken: null,
      error: null,
    });
    return;
  }

  await deps.sendMessage(groupJid, sanitized);
  logHeartbeatRun({
    group_folder: group.folder,
    chat_jid: groupJid,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: 'acted',
    actions_taken: sanitized,
    error: null,
  });
}

export function startHeartbeatLoop(deps: HeartbeatDependencies): void {
  if (heartbeatRunning) {
    logger.debug('Heartbeat loop already running, skipping duplicate start');
    return;
  }
  heartbeatRunning = true;
  logger.info('Heartbeat loop started');

  const loop = async () => {
    try {
      const groups = deps.registeredGroups();
      for (const [groupJid, group] of Object.entries(groups)) {
        const checklist = loadHeartbeatChecklist(group.folder);
        if (!checklist) continue;

        const lastRun = getLastHeartbeatRun(group.folder);
        const minGapMs = Math.max(checklist.intervalMs, HEARTBEAT_MIN_GAP);
        if (
          lastRun &&
          Date.now() - new Date(lastRun.run_at).getTime() < minGapMs
        ) {
          continue;
        }

        if (deps.queue.isGroupActive(groupJid)) {
          logger.debug(
            { groupJid, groupFolder: group.folder },
            'Skipping heartbeat for active group',
          );
          continue;
        }

        deps.queue.enqueueTask(
          groupJid,
          `heartbeat:${group.folder}:${Date.now()}`,
          () => runHeartbeat(groupJid, group, checklist, deps),
          { lane: 'background' },
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in heartbeat loop');
    }

    setTimeout(loop, HEARTBEAT_POLL_INTERVAL);
  };

  void loop();
}

/** @internal - for tests only. */
export function _resetHeartbeatLoopForTests(): void {
  heartbeatRunning = false;
}
