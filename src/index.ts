import fs from 'fs';
import path from 'path';
import { migrateEnvCredentialsToAuthProfilesIfNeeded } from './auth/auth-manager.js';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IDLE_TIMEOUT,
  OPENAI_WARM_SESSIONS,
  OPENAI_SESSION_IDLE_TIMEOUT_MS,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { cleanupOrphans } from './container-runtime.js';
import {
  getAllChats,
  getAllRuntimeProfiles,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getConversationSummary,
  logRuntimeEvent,
  logRuntimeUsage,
  getMessagesSince,
  getRecentMessages,
  getNewMessages,
  getRouterState,
  initDatabase,
  setConversationSummary,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessageDirect,
  storeMessage,
} from './db.js';
import {
  buildContinuityPlan,
  buildContinuityPrompt,
  isSyntheticAssistantReply,
} from './continuity.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { buildContextBundle } from './context/builder.js';
import {
  CONTEXT_ESTIMATED_TOOL_SCHEMA_CHARS,
  CONTEXT_RESERVED_TOOL_CHARS,
} from './context/config.js';
import {
  hasPendingAssistantBootstrap,
  isExplicitAssistantBootstrapRequest,
  maybeHandleAssistantBootstrap,
} from './context/bootstrap.js';
import {
  appendDailyMemoryNotes,
  extractMemoryCandidates,
} from './context/memory.js';
import { insertMemoryEntry } from './db.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { startHeartbeatLoop } from './heartbeat.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  Channel,
  ChannelMessageRef,
  NewMessage,
  RegisteredGroup,
} from './types.js';
import { logger } from './logger.js';
import {
  resolveRuntimeExecutionAsync,
  resolveRuntimeSelection,
} from './runtime/manager.js';
import {
  capabilityRouteSummary,
  resolveCapabilityRoute,
} from './runtime/capability-router.js';
import { migrateToLocalOnlyIfNeeded } from './runtime/local-only-migration.js';
import {
  acquireProcessLock as claimProcessLock,
  releaseProcessLock as dropProcessLock,
} from './process-lock.js';
import { runAgentProcess } from './execution/backend.js';
import { ensureToolServicesReadyOnStartup } from './tools/service-supervisor.js';
import { buildRuntimeUsageLog } from './runtime-usage.js';
import {
  probeExecutionBackend,
  resolveExecutionBackendForProvider,
} from './execution/backend.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
const pendingPipedTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
const DISCORD_TYPING_REFRESH_MS = 8000;

const channels: Channel[] = [];
const queue = new GroupQueue();
const PROCESS_LOCK_PATH = path.join(DATA_DIR, 'microclaw.lock');
let hasProcessLock = false;
/*
 * Quality-path truth table:
 * - Continuity recent/scan limits: this file (`CONTINUITY_RECENT_LIMIT`, `CONTINUITY_SCAN_LIMIT`)
 * - Cloud output caps and cloud-safe prompt sanitization: `container/agent-runner/src/runtime/openai.ts`
 * - Web tool budgets for cloud turns: `container/agent-runner/src/runtime/openai.ts` (`webConfig`)
 * - Provider fetch/extract content cap: `container/agent-runner/src/tools/web/providers.ts` (`fetchMaxChars`)
 * - Runtime/env defaults: `.env.example`
 */
const CONTINUITY_RECENT_LIMIT = 12;
const CONTINUITY_SCAN_LIMIT = 120;
const CONTINUITY_SUMMARY_MIN_OLDER_MESSAGES = 8;
const CONTINUITY_SUMMARY_MIN_OLDER_CHARS = 3000;
const typingHeartbeats = new Map<string, ReturnType<typeof setInterval>>();
type TurnClass =
  | 'tiny_conversation'
  | 'simple_conversation'
  | 'normal_conversation'
  | 'memory_or_state'
  | 'web_or_browser'
  | 'scheduling';

async function pulseTyping(channel: Channel, chatJid: string): Promise<void> {
  try {
    await channel.setTyping?.(chatJid, true);
  } catch (err) {
    logger.warn({ chatJid, err }, 'Failed to set typing indicator');
  }
}

function startTypingHeartbeat(channel: Channel, chatJid: string): void {
  if (typingHeartbeats.has(chatJid)) return;
  void pulseTyping(channel, chatJid);
  const interval = setInterval(() => {
    void pulseTyping(channel, chatJid);
  }, DISCORD_TYPING_REFRESH_MS);
  typingHeartbeats.set(chatJid, interval);
}

function stopTypingHeartbeat(chatJid: string): void {
  const interval = typingHeartbeats.get(chatJid);
  if (!interval) return;
  clearInterval(interval);
  typingHeartbeats.delete(chatJid);
}

function stopAllTypingHeartbeats(): void {
  for (const interval of typingHeartbeats.values()) {
    clearInterval(interval);
  }
  typingHeartbeats.clear();
}

function currentPromptMessage(prompt: string): string {
  const marker = '[Current message - respond to this]';
  const index = prompt.lastIndexOf(marker);
  if (index === -1) return prompt.trim();
  return prompt.slice(index + marker.length).trim();
}

function isHostGreetingLike(prompt: string): boolean {
  const current = currentPromptMessage(prompt)
    .toLowerCase()
    .replace(/^[^a-z0-9]+|[^a-z0-9!? ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /^(hi|hello|hey|yo|sup|what s up|whats up|good morning|good afternoon|good evening|hola|namaste|heya|hello there)[!.? ]*$/.test(
    current,
  );
}

function isTinyConversationLike(prompt: string): boolean {
  const current = currentPromptMessage(prompt)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return (
    isHostGreetingLike(current) ||
    /^(thanks|thank you|thx|ok|okay|cool|nice|great|got it|understood|alright|see ya|bye|gn|good night)[!.? ]*$/.test(
      current,
    )
  );
}

function isLikelyWebPrompt(prompt: string): boolean {
  const current = currentPromptMessage(prompt).toLowerCase();
  return (
    /https?:\/\//.test(current) ||
    /\b(latest|news|today|recent|search|look up|lookup|find online|web|browser|source|sources|benchmark|price|weather)\b/.test(
      current,
    )
  );
}

function isHostShortCasualPrompt(prompt: string): boolean {
  const current = currentPromptMessage(prompt).replace(/\s+/g, ' ').trim();
  if (!current) return false;
  const words = current.split(' ').filter(Boolean);
  return (
    words.length <= 6 && current.length <= 32 && !isLikelyWebPrompt(current)
  );
}

function hostFallbackReplyForPrompt(prompt: string): string | null {
  return null;
}

function hostFallbackReplyForError(
  error: string | null | undefined,
): string | null {
  if (!error) return null;
  const normalized = error.toLowerCase();

  if (
    normalized.includes('http 401') ||
    normalized.includes('unauthorized') ||
    normalized.includes('not authorized')
  ) {
    return 'The configured model API key was rejected by the provider (HTTP 401). Please verify that the key is a valid DeepInfra API key with access to the selected model.';
  }

  if (normalized.includes('http 403') || normalized.includes('forbidden')) {
    return 'The model provider refused access to this request (HTTP 403). The key may lack access to the selected model or endpoint.';
  }

  if (
    normalized.includes('network request failed') ||
    normalized.includes('econnrefused') ||
    normalized.includes('enotfound')
  ) {
    return 'The configured model endpoint could not be reached. Please verify the provider base URL and network access.';
  }

  return null;
}

function looksLikeSchedulingPrompt(prompt: string): boolean {
  const current = currentPromptMessage(prompt).toLowerCase();
  const timeCue =
    /\b(at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|tomorrow|today|tonight|later today|later tonight|in\s+\d+\s+(?:minute|minutes|hour|hours)|every\s+(?:day|weekday|weekdays|week|weekend|weekends|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|daily|weekly|each\s+(?:day|week)|every morning|every evening)\b/.test(
      current,
    );
  const taskCue =
    /\b(remind|send|check|read|look up|lookup|watch|monitor|notify|message|summarize|summary)\b/.test(
      current,
    );
  return timeCue && taskCue;
}

function isMemoryAssistedPrompt(prompt: string): boolean {
  const current = currentPromptMessage(prompt).toLowerCase();
  return /\b(remember|recall|what do you remember|what did i tell you|keep in mind|my preference|my timezone|my name is|from now on)\b/.test(
    current,
  );
}

function classifyTurnClass(prompt: string): TurnClass {
  if (looksLikeSchedulingPrompt(prompt)) return 'scheduling';
  if (isLikelyWebPrompt(prompt)) return 'web_or_browser';
  if (isMemoryAssistedPrompt(prompt)) return 'memory_or_state';
  if (isTinyConversationLike(prompt)) return 'tiny_conversation';
  if (isHostShortCasualPrompt(prompt)) return 'simple_conversation';
  return 'normal_conversation';
}

function resolveContextTurnMode(
  prompt: string,
  capabilityRoute:
    | 'plain_response'
    | 'web_lookup'
    | 'browser_operation'
    | 'deny_or_escalate',
):
  | 'conversational'
  | 'memory_assisted'
  | 'web_browser'
  | 'scheduling_planning' {
  if (looksLikeSchedulingPrompt(prompt)) return 'scheduling_planning';
  if (
    capabilityRoute === 'web_lookup' ||
    capabilityRoute === 'browser_operation'
  ) {
    return 'web_browser';
  }
  if (isMemoryAssistedPrompt(prompt)) return 'memory_assisted';
  return 'conversational';
}

function contextToolBudgetForTurnMode(
  turnMode:
    | 'conversational'
    | 'memory_assisted'
    | 'web_browser'
    | 'scheduling_planning',
): { reservedToolChars: number; actualToolSchemaChars: number } {
  switch (turnMode) {
    case 'memory_assisted':
      return {
        reservedToolChars: 7_000,
        actualToolSchemaChars: 4_500,
      };
    case 'web_browser':
    case 'scheduling_planning':
      return {
        reservedToolChars: CONTEXT_RESERVED_TOOL_CHARS,
        actualToolSchemaChars: CONTEXT_ESTIMATED_TOOL_SCHEMA_CHARS,
      };
    case 'conversational':
    default:
      return {
        reservedToolChars: 2_500,
        actualToolSchemaChars: 0,
      };
  }
}

function acquireProcessLock(): void {
  claimProcessLock({
    lockPath: PROCESS_LOCK_PATH,
    dataDir: DATA_DIR,
  });
  hasProcessLock = true;
}

function releaseProcessLock(): void {
  if (!hasProcessLock) return;
  dropProcessLock(PROCESS_LOCK_PATH);
  hasProcessLock = false;
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const processingStartedAt = Date.now();
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  const latestUserMessage = [...missedMessages]
    .reverse()
    .find(
      (message) =>
        message.is_bot_message !== true &&
        message.sender_name !== ASSISTANT_NAME,
    );
  const chatInfo = getAllChats().find((chat) => chat.jid === chatJid);
  const isDm = chatInfo ? chatInfo.is_group === 0 : /dm/i.test(group.folder);
  const bootstrapBypassesTrigger =
    isDm &&
    !!latestUserMessage &&
    (hasPendingAssistantBootstrap(group.folder) ||
      isExplicitAssistantBootstrapRequest(latestUserMessage.content));

  // For non-main groups, check if trigger is required and present.
  // DMs never require a trigger — the user is already talking directly to the bot.
  if (!isMainGroup && !isDm && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger && !bootstrapBypassesTrigger) return true;
  }

  const recordAssistantReply = (chatJidValue: string, text: string): void => {
    if (isSyntheticAssistantReply(text)) {
      return;
    }
    const timestamp = new Date().toISOString();
    storeMessageDirect({
      id: `bot:${chatJidValue}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      chat_jid: chatJidValue,
      sender: ASSISTANT_NAME,
      sender_name: ASSISTANT_NAME,
      content: text,
      timestamp,
      is_from_me: true,
      is_bot_message: true,
    });

    const continuityPlan = buildContinuityPlan({
      assistantName: ASSISTANT_NAME,
      conversationMessages: getRecentMessages(
        chatJidValue,
        CONTINUITY_SCAN_LIMIT,
      ),
      recentTurnLimit: CONTINUITY_RECENT_LIMIT,
      summaryMinMessages: CONTINUITY_SUMMARY_MIN_OLDER_MESSAGES,
      summaryMinChars: CONTINUITY_SUMMARY_MIN_OLDER_CHARS,
    });
    if (continuityPlan.shouldPersistSummary) {
      setConversationSummary({
        groupFolder: group.folder,
        summary: continuityPlan.computedSummary,
        sourceMessageCount: continuityPlan.sourceMessageCount,
        lastMessageTimestamp: continuityPlan.lastMessageTimestamp,
      });
    }
  };

  const bootstrapResult =
    latestUserMessage &&
    maybeHandleAssistantBootstrap({
      groupFolder: group.folder,
      latestMessageText: latestUserMessage.content,
      isDm,
    });

  if (bootstrapResult?.messageToSend) {
    await channel.sendMessage(chatJid, bootstrapResult.messageToSend);
    recordAssistantReply(chatJid, bootstrapResult.messageToSend);
  }

  if (bootstrapResult?.handled) {
    lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
    saveState();
    return true;
  }

  const runtimeSelection = resolveRuntimeSelection(group.folder);
  const primaryProvider =
    runtimeSelection.profiles[0]?.provider || 'openai_compatible';
  const latestPromptText =
    latestUserMessage?.content || formatMessages(missedMessages);
  const turnClass = classifyTurnClass(latestPromptText);
  const useFastLane =
    primaryProvider === 'openai_compatible' &&
    (turnClass === 'tiny_conversation' || turnClass === 'simple_conversation');
  let prompt: string;
  if (useFastLane) {
    prompt =
      turnClass === 'tiny_conversation'
        ? formatMessages(missedMessages.slice(-1))
        : formatMessages(missedMessages.slice(-2));
    logger.info(
      {
        group: group.folder,
        turnClass,
        mode: 'fast_lane',
        session_mode: 'cold_start',
      },
      'Skipped continuity for trivial conversational turn',
    );
  } else {
    const recentConversation = getRecentMessages(
      chatJid,
      CONTINUITY_SCAN_LIMIT,
    );
    const storedSummary = getConversationSummary(group.folder);
    const continuityPlan = buildContinuityPlan({
      assistantName: ASSISTANT_NAME,
      conversationMessages: recentConversation,
      currentMessages: missedMessages,
      storedSummary: storedSummary?.summary,
      recentTurnLimit: CONTINUITY_RECENT_LIMIT,
      summaryMinMessages: CONTINUITY_SUMMARY_MIN_OLDER_MESSAGES,
      summaryMinChars: CONTINUITY_SUMMARY_MIN_OLDER_CHARS,
    });
    if (
      continuityPlan.shouldPersistSummary &&
      (storedSummary?.summary !== continuityPlan.computedSummary ||
        storedSummary?.sourceMessageCount !==
          continuityPlan.sourceMessageCount ||
        storedSummary?.lastMessageTimestamp !==
          continuityPlan.lastMessageTimestamp)
    ) {
      setConversationSummary({
        groupFolder: group.folder,
        summary: continuityPlan.computedSummary,
        sourceMessageCount: continuityPlan.sourceMessageCount,
        lastMessageTimestamp: continuityPlan.lastMessageTimestamp,
      });
    }
    prompt =
      primaryProvider === 'openai_compatible'
        ? buildContinuityPrompt({
            assistantName: ASSISTANT_NAME,
            summary: continuityPlan.summaryToUse,
            recentContextMessages: continuityPlan.recentContextMessages,
            currentMessages: continuityPlan.currentMessages,
          })
        : formatMessages(missedMessages);

    logger.info(
      {
        group: group.folder,
        continuity: continuityPlan.diagnostics,
        turnClass,
        session_mode: 'cold_start',
      },
      'Continuity context assembled',
    );
  }

  const memoryCandidates = extractMemoryCandidates(
    missedMessages,
    ASSISTANT_NAME,
  );
  if (!bootstrapResult?.suppressMemoryWrite && memoryCandidates.length > 0) {
    appendDailyMemoryNotes(group.folder, memoryCandidates);
    // Also write to FTS5 index immediately for real-time retrieval
    for (const candidate of memoryCandidates) {
      try {
        insertMemoryEntry({
          group_folder: group.folder,
          scope: 'group',
          kind: candidate.kind,
          content: candidate.text,
          source: 'auto',
          origin:
            candidate.origin === 'explicit_request'
              ? 'explicit_request'
              : 'conversation',
          durability: candidate.durability,
          confidence: candidate.confidence,
          created_at: candidate.timestamp || new Date().toISOString(),
          last_confirmed_at: candidate.timestamp || new Date().toISOString(),
          pinned: candidate.durability === 'pinned',
        });
      } catch {
        /* non-fatal */
      }
    }
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  const contextReadyAt = Date.now();

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  // Use a shorter idle timeout for warm OpenAI sessions to avoid long-lived zombie processes.
  const effectiveIdleTimeout =
    primaryProvider === 'openai_compatible' && OPENAI_WARM_SESSIONS
      ? OPENAI_SESSION_IDLE_TIMEOUT_MS
      : IDLE_TIMEOUT;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name, idleTimeoutMs: effectiveIdleTimeout },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, effectiveIdleTimeout);
  };

  const stopTypingNow = async () => {
    stopTypingHeartbeat(chatJid);
    await channel.setTyping?.(chatJid, false);
  };

  startTypingHeartbeat(channel, chatJid);
  let hadError = false;
  let outputSentToUser = false;
  let lastStreamError: string | null = null;
  let firstVisibleOutputAt: number | null = null;
  let partialBuffer = '';
  let streamedMessageRef: ChannelMessageRef | null = null;
  let assistantReplyRecorded = false;

  const runResult = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text && result.isPartial) {
          partialBuffer += text;
          firstVisibleOutputAt ??= Date.now();
          if (channel.updateMessage && partialBuffer.length <= 1900) {
            try {
              if (!streamedMessageRef) {
                streamedMessageRef = await channel.sendMessage(
                  chatJid,
                  partialBuffer,
                );
              } else {
                await channel.updateMessage(
                  chatJid,
                  streamedMessageRef,
                  partialBuffer,
                );
              }
              outputSentToUser = streamedMessageRef !== null;
              if (outputSentToUser) {
                await stopTypingNow();
              }
            } catch (err) {
              logger.debug(
                { group: group.name, err },
                'Failed to update streamed Discord message',
              );
            }
          }
        } else if (text) {
          firstVisibleOutputAt ??= Date.now();
          if (
            streamedMessageRef &&
            channel.updateMessage &&
            text.length <= 2000
          ) {
            await channel.updateMessage(chatJid, streamedMessageRef, text);
          } else {
            if (streamedMessageRef && channel.deleteMessage) {
              await channel.deleteMessage(chatJid, streamedMessageRef);
              streamedMessageRef = null;
            }
            await channel.sendMessage(chatJid, text);
          }
          if (!assistantReplyRecorded) {
            recordAssistantReply(chatJid, text);
            assistantReplyRecorded = true;
          }
          outputSentToUser = true;
          await stopTypingNow();
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success' && !result.isPartial && !result.result) {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
        lastStreamError = result.error || 'Unknown runtime error';
        logger.warn(
          { group: group.name, error: result.error },
          'Streamed agent error event',
        );
        // In warm-session mode, an errored turn can leave the runner waiting
        // for more IPC input. Close stdin now so this run unwinds quickly and
        // fallback profiles (or host fallback text) can be delivered promptly.
        queue.closeStdin(chatJid);
        await stopTypingNow();
      }
    },
    {
      turnClass,
      // Fast lane skips continuity assembly, but still keeps compact persona
      // and user-memory context so short Discord turns remain grounded.
      skipContextBundle: false,
      disableTools: useFastLane,
    },
  );

  await stopTypingNow();
  if (idleTimer) clearTimeout(idleTimer);
  logger.info(
    {
      group: group.name,
      durationMs: Date.now() - processingStartedAt,
      latency: {
        ingest_ms: contextReadyAt - processingStartedAt,
        context_ms: contextReadyAt - processingStartedAt,
        api_first_byte_ms:
          firstVisibleOutputAt === null
            ? null
            : firstVisibleOutputAt - contextReadyAt,
        total_ms: Date.now() - processingStartedAt,
      },
      partialChars: partialBuffer.length,
      outputSentToUser,
      hadError,
      session_mode: 'cold_start',
      turnClass,
    },
    'Finished processing messages',
  );

  if (outputSentToUser && !assistantReplyRecorded && partialBuffer.trim()) {
    recordAssistantReply(chatJid, partialBuffer.trim());
    assistantReplyRecorded = true;
  }

  // Commit piped follow-up cursor only when the run completed cleanly.
  // If we mark it early and then error, the follow-up can be lost.
  if (!hadError && pendingPipedTimestamp[chatJid]) {
    const pipedTs = pendingPipedTimestamp[chatJid];
    if (!lastAgentTimestamp[chatJid] || lastAgentTimestamp[chatJid] < pipedTs) {
      lastAgentTimestamp[chatJid] = pipedTs;
      saveState();
    }
    delete pendingPipedTimestamp[chatJid];
  }

  if (runResult.status === 'error' || hadError) {
    if (!outputSentToUser && partialBuffer.trim()) {
      try {
        if (
          streamedMessageRef &&
          channel.updateMessage &&
          partialBuffer.trim().length <= 2000
        ) {
          await channel.updateMessage(
            chatJid,
            streamedMessageRef,
            partialBuffer.trim(),
          );
        } else {
          await channel.sendMessage(chatJid, partialBuffer.trim());
        }
        if (!assistantReplyRecorded) {
          recordAssistantReply(chatJid, partialBuffer.trim());
          assistantReplyRecorded = true;
        }
        logger.warn(
          { group: group.name, turnClass },
          'Stream ended after partial output; delivered buffered partial text',
        );
        return true;
      } catch (sendErr) {
        logger.warn(
          { group: group.name, err: sendErr },
          'Failed to deliver buffered partial text after stream error',
        );
      }
    }
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      if (!assistantReplyRecorded && partialBuffer.trim()) {
        recordAssistantReply(chatJid, partialBuffer.trim());
        assistantReplyRecorded = true;
      }
      // If follow-up messages were piped during this run, force a re-check.
      // This avoids requiring the user to send another "?" to unstick queueing.
      if (pendingPipedTimestamp[chatJid]) {
        queue.enqueueMessageCheck(chatJid);
      }
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Do not fail silently: send a concise fallback message to the user.
    try {
      const fallbackText =
        hostFallbackReplyForError(lastStreamError || runResult.error) ||
        hostFallbackReplyForPrompt(prompt) ||
        'I ran into a runtime issue while processing that request. Please retry in a moment.';
      await channel.sendMessage(chatJid, fallbackText);
      recordAssistantReply(chatJid, fallbackText);
      logger.warn(
        {
          group: group.name,
          usedFriendlyFallback:
            fallbackText !==
            'I ran into a runtime issue while processing that request. Please retry in a moment.',
        },
        'Agent error with no output; sent fallback user-facing error message',
      );
      return true;
    } catch (sendErr) {
      logger.warn(
        { group: group.name, err: sendErr },
        'Failed to send fallback error message to user',
      );
    }

    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  if (!outputSentToUser && !hadError) {
    if (partialBuffer.trim()) {
      try {
        if (
          streamedMessageRef &&
          channel.updateMessage &&
          partialBuffer.trim().length <= 2000
        ) {
          await channel.updateMessage(
            chatJid,
            streamedMessageRef,
            partialBuffer.trim(),
          );
        } else {
          await channel.sendMessage(chatJid, partialBuffer.trim());
        }
        if (!assistantReplyRecorded) {
          recordAssistantReply(chatJid, partialBuffer.trim());
          assistantReplyRecorded = true;
        }
        logger.warn(
          { group: group.name, turnClass },
          'Agent completed without final text; delivered buffered partial output',
        );
        return true;
      } catch (sendErr) {
        logger.warn(
          { group: group.name, err: sendErr },
          'Failed to send buffered partial output',
        );
      }
    }
    try {
      const fallbackText =
        hostFallbackReplyForPrompt(prompt) ||
        "I couldn't produce a reply for that just now. Please try again.";
      await channel.sendMessage(chatJid, fallbackText);
      recordAssistantReply(chatJid, fallbackText);
      logger.warn(
        {
          group: group.name,
          usedFriendlyFallback:
            fallbackText !==
            "I couldn't produce a reply for that just now. Please try again.",
        },
        'Agent completed without user-visible output; sent fallback prompt',
      );
      return true;
    } catch (sendErr) {
      logger.warn(
        { group: group.name, err: sendErr },
        'Failed to send no-output fallback message',
      );
    }
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  options?: {
    turnClass?: TurnClass;
    skipContextBundle?: boolean;
    disableTools?: boolean;
  },
): Promise<{ status: 'success' | 'error'; error?: string }> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];
  const runtimeSelection = resolveRuntimeSelection(group.folder);
  let lastProfileError: string | undefined;
  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
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

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    for (let i = 0; i < runtimeSelection.profiles.length; i++) {
      const profile = runtimeSelection.profiles[i];
      let streamedSuccessLogged = false;
      let usageLogged = false;
      const attemptStartedAt = new Date().toISOString();
      const attemptStartedAtMs = Date.now();

      logRuntimeEvent({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        groupFolder: group.folder,
        chatJid,
        profileId: profile.id,
        provider: profile.provider,
        eventType: 'auth_profile_selected',
        message: `Selected runtime profile ${profile.id}`,
        timestamp: new Date().toISOString(),
      });

      const resolved = await resolveRuntimeExecutionAsync(profile);
      const capabilityRoute = resolveCapabilityRoute({
        prompt,
        toolPolicy: resolved.runtimeConfig.toolPolicy,
      });
      const turnMode = resolveContextTurnMode(prompt, capabilityRoute);
      const contextBudget = contextToolBudgetForTurnMode(turnMode);
      const contextBundle = options?.skipContextBundle
        ? null
        : buildContextBundle({
            groupFolder: group.folder,
            prompt,
            turnMode,
            reservedToolChars: contextBudget.reservedToolChars,
            actualToolSchemaChars: contextBudget.actualToolSchemaChars,
          });
      if (contextBundle && contextBundle.diagnostics.warnings.length > 0) {
        logger.warn(
          {
            group: group.folder,
            profile: profile.id,
            turnMode,
            warnings: contextBundle.diagnostics.warnings,
            finalChars: contextBundle.diagnostics.finalChars,
          },
          'Context builder warnings',
        );
      }
      if (
        resolved.authRefreshMessage &&
        resolved.authRefreshMessage.toLowerCase().includes('refreshed')
      ) {
        logRuntimeEvent({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          groupFolder: group.folder,
          chatJid,
          profileId: profile.id,
          provider: profile.provider,
          eventType: 'token_refreshed',
          message: resolved.authRefreshMessage,
          timestamp: new Date().toISOString(),
        });
      }

      logRuntimeEvent({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        groupFolder: group.folder,
        chatJid,
        profileId: profile.id,
        provider: profile.provider,
        eventType: 'attempt',
        message: `Attempt ${i + 1} using profile ${profile.id} (${capabilityRoute}${options?.turnClass ? `, ${options.turnClass}` : ''})`,
        timestamp: new Date().toISOString(),
      });
      logger.info(
        {
          group: group.folder,
          profile: profile.id,
          capabilityRoute,
          turnClass: options?.turnClass,
          detail: capabilityRouteSummary(capabilityRoute),
        },
        'Capability route selected',
      );

      const output = await runAgentProcess(
        group,
        {
          prompt,
          systemPrompt: contextBundle?.systemPrompt || undefined,
          sessionId,
          groupFolder: group.folder,
          chatJid,
          isMain,
          assistantName: ASSISTANT_NAME,
          runtimeProfileId: profile.id,
          runtimeConfig: {
            ...resolved.runtimeConfig,
            capabilityRoute,
            capabilities: options?.disableTools
              ? {
                  ...(resolved.runtimeConfig.capabilities || {
                    supportsResponses: true,
                    supportsChatCompletions: true,
                    supportsTools: true,
                    supportsStreaming: true,
                    requiresApiKey: false,
                    checkedAt: new Date().toISOString(),
                  }),
                  supportsTools: false,
                }
              : resolved.runtimeConfig.capabilities,
          },
          retryPolicy: runtimeSelection.retryPolicy,
          secrets: resolved.secrets,
        },
        {
          onProcess: (proc, containerName) =>
            queue.registerProcess(chatJid, proc, containerName, group.folder),
          onOutput: wrappedOnOutput
            ? async (streamed) => {
                if (!usageLogged && streamed.usage) {
                  usageLogged = true;
                  const usageLog = buildRuntimeUsageLog({
                    groupFolder: group.folder,
                    chatJid,
                    profileId: profile.id,
                    provider: profile.provider,
                    model: profile.model,
                    triggerKind: 'message',
                    startedAt: attemptStartedAt,
                    durationMs: Date.now() - attemptStartedAtMs,
                    usage: streamed.usage,
                  });
                  logRuntimeUsage(usageLog);
                  logger.info(
                    {
                      group: group.folder,
                      profile: profile.id,
                      trigger: 'message',
                      tokens: usageLog.usage.totalTokens,
                      costUsd: usageLog.totalCostUsd,
                      usageSource: usageLog.usage.source,
                    },
                    'Runtime usage recorded',
                  );
                }
                if (
                  !streamedSuccessLogged &&
                  streamed.status === 'success' &&
                  typeof streamed.result === 'string' &&
                  streamed.result.trim().length > 0
                ) {
                  streamedSuccessLogged = true;
                  logRuntimeEvent({
                    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
                    groupFolder: group.folder,
                    chatJid,
                    profileId: profile.id,
                    provider: profile.provider,
                    eventType: 'success',
                    message: `Profile ${profile.id} streamed output`,
                    timestamp: new Date().toISOString(),
                  });
                }
                await wrappedOnOutput(streamed);
              }
            : undefined,
        },
      );

      if (output.newSessionId) {
        sessions[group.folder] = output.newSessionId;
        setSession(group.folder, output.newSessionId);
      }

      if (output.status !== 'error') {
        if (!streamedSuccessLogged) {
          logRuntimeEvent({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            groupFolder: group.folder,
            chatJid,
            profileId: profile.id,
            provider: profile.provider,
            eventType: 'success',
            message: `Profile ${profile.id} succeeded`,
            timestamp: new Date().toISOString(),
          });
        }
        return { status: 'success' };
      }

      const hasFallback = i < runtimeSelection.profiles.length - 1;
      lastProfileError = output.error || lastProfileError;
      logRuntimeEvent({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        groupFolder: group.folder,
        chatJid,
        profileId: profile.id,
        provider: profile.provider,
        eventType: hasFallback ? 'failover' : 'error',
        message: output.error || `Profile ${profile.id} failed`,
        timestamp: new Date().toISOString(),
      });

      logger.warn(
        {
          group: group.name,
          profile: profile.id,
          provider: profile.provider,
          error: output.error,
          fallback: hasFallback,
        },
        hasFallback
          ? 'Runtime profile failed, trying fallback'
          : 'Runtime profile failed with no fallback',
      );
    }

    return {
      status: 'error',
      error:
        lastProfileError ||
        'All runtime profiles failed without a provider error message.',
    };
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`MicroClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const isDmChat = /dm/i.test(group.folder);
          const needsTrigger = !isMainGroup && !isDmChat && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          // DMs never require a trigger.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);
          const runtimeSelection = resolveRuntimeSelection(group.folder);
          const primaryProvider =
            runtimeSelection.profiles[0]?.provider || 'openai_compatible';
          // Live piping: for Claude, the SDK's streaming loop handles IPC natively.
          // For OpenAI-compatible with warm sessions enabled, the native process stays
          // alive after the first turn and polls IPC for follow-up messages.
          const supportsLivePiping =
            primaryProvider === 'claude' ||
            (primaryProvider === 'openai_compatible' && OPENAI_WARM_SESSIONS);

          if (supportsLivePiping && queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              {
                chatJid,
                count: messagesToSend.length,
                session_mode: 'warm_reuse',
              },
              'Piped messages to active container',
            );
            pendingPipedTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            // Keep typing alive while the active container handles piped follow-ups.
            startTypingHeartbeat(channel, chatJid);
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  cleanupOrphans();
}

async function main(): Promise<void> {
  acquireProcessLock();
  process.on('exit', () => {
    stopAllTypingHeartbeats();
    releaseProcessLock();
  });
  ensureContainerSystemRunning();
  initDatabase();
  migrateToLocalOnlyIfNeeded();
  migrateEnvCredentialsToAuthProfilesIfNeeded();
  const toolsReady = await ensureToolServicesReadyOnStartup();
  if (toolsReady.ok) {
    logger.info({ detail: toolsReady.detail }, 'Tool services ready');
  } else {
    logger.warn(
      { detail: toolsReady.detail, failed: toolsReady.failed },
      'Tool services unavailable; continuing startup',
    );
  }
  logger.info('Database initialized');
  loadState();
  const runtimeProfiles = getAllRuntimeProfiles();
  logger.info(
    { runtimeProfileCount: runtimeProfiles.length },
    'Runtime startup snapshot',
  );

  const activeRuntimeProfiles = getAllChats(); // lightweight log context only
  if (activeRuntimeProfiles.length === 0) {
    logger.warn(
      'No chats discovered yet; runtime will wait for inbound messages',
    );
  }

  const providersToProbe = new Set<string>(
    runtimeProfiles.filter((p) => p.enabled).map((p) => p.provider),
  );
  if (providersToProbe.size === 0) {
    providersToProbe.add('openai_compatible');
  }
  for (const provider of providersToProbe) {
    const backend = resolveExecutionBackendForProvider(provider);
    const probe = probeExecutionBackend(backend);
    logger.info(
      { provider, backend, ok: probe.ok, detail: probe.detail },
      'Execution backend probe',
    );
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    stopAllTypingHeartbeats();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    releaseProcessLock();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    try {
      await channel.connect();
      channels.push(channel);
    } catch (err) {
      logger.error(
        { channel: channelName, err },
        'Channel failed to connect; skipping channel startup',
      );
    }
  }
  if (channels.length === 0) {
    logger.fatal(
      'No channels connected. Check channel credentials (for Discord: DISCORD_BOT_TOKEN) and try again.',
    );
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startHeartbeatLoop({
    registeredGroups: () => registeredGroups,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn(
          { jid },
          'No channel owns JID, cannot send heartbeat message',
        );
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      await channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start MicroClaw');
    process.exit(1);
  });
}
