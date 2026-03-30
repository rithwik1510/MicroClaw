import fs from 'fs';
import path from 'path';
import { migrateEnvCredentialsToAuthProfilesIfNeeded } from './auth/auth-manager.js';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IDLE_TIMEOUT,
  OPENAI_WARM_SESSIONS,
  OPENAI_SESSION_IDLE_TIMEOUT_MS,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
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
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
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
import {
  appendStreamText,
  resolveLatencyTurnPolicy,
  type LatencyTurnClass,
  type RuntimeSecretOverrides,
} from './runtime/latency-policy.js';
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
import type { AvailableGroup } from './container-runner.js';

type TurnClass = LatencyTurnClass;

const PROCESS_LOCK_PATH = path.join(DATA_DIR, 'microclaw.lock');
const DISCORD_TYPING_REFRESH_MS = 8000;

export class AppCore {
  // --- Instance state (was module-level) ---
  private lastTimestamp = '';
  private sessions: Record<string, string> = {};
  private registeredGroups: Record<string, RegisteredGroup> = {};
  private lastAgentTimestamp: Record<string, string> = {};
  private readonly pendingPipedTimestamp: Record<string, string> = {};
  private messageLoopRunning = false;
  readonly channels: Channel[] = [];
  readonly queue = new GroupQueue();
  private hasProcessLock = false;
  private running = false;

  /*
   * Quality-path truth table:
   * - Continuity recent/scan limits: this file (`CONTINUITY_RECENT_LIMIT`, `CONTINUITY_SCAN_LIMIT`)
   * - Cloud output caps and cloud-safe prompt sanitization: `container/agent-runner/src/runtime/openai.ts`
   * - Web tool budgets for cloud turns: `container/agent-runner/src/runtime/openai.ts` (`webConfig`)
   * - Provider fetch/extract content cap: `container/agent-runner/src/tools/web/providers.ts` (`fetchMaxChars`)
   * - Runtime/env defaults: `.env.example`
   */
  private readonly CONTINUITY_RECENT_LIMIT = 12;
  private readonly CONTINUITY_SCAN_LIMIT = 120;
  private readonly CONTINUITY_SUMMARY_MIN_OLDER_MESSAGES = 8;
  private readonly CONTINUITY_SUMMARY_MIN_OLDER_CHARS = 3000;
  private readonly typingHeartbeats = new Map<
    string,
    ReturnType<typeof setInterval>
  >();

  private readonly onecli = new OneCLI({ url: ONECLI_URL });

  // --- Public API ---

  async start(): Promise<void> {
    this.acquireProcessLock();
    this.ensureContainerSystemRunning();
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
    this.loadState();

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

    // Ensure OneCLI agents exist for all registered groups.
    // Recovers from missed creates (e.g. OneCLI was down at registration time).
    for (const [jid, group] of Object.entries(this.registeredGroups)) {
      this.ensureOneCLIAgent(jid, group);
    }

    restoreRemoteControl();

    this.queue.setProcessMessagesFn((chatJid) =>
      this.processGroupMessages(chatJid),
    );

    this.running = true;
  }

  async stop(): Promise<void> {
    this.stopAllTypingHeartbeats();
    await this.queue.shutdown(10000);
    for (const ch of this.channels) await ch.disconnect();
    this.releaseProcessLock();
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  getRegisteredGroups(): Record<string, RegisteredGroup> {
    return this.registeredGroups;
  }

  getChannels(): Channel[] {
    return this.channels;
  }

  /**
   * Get available groups list for the agent.
   * Returns groups ordered by most recent activity.
   */
  getAvailableGroups(): AvailableGroup[] {
    const chats = getAllChats();
    const registeredJids = new Set(Object.keys(this.registeredGroups));

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
  _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
    this.registeredGroups = groups;
  }

  registerGroup(jid: string, group: RegisteredGroup): void {
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

    this.registeredGroups[jid] = group;
    setRegisteredGroup(jid, group);

    // Create group folder
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

    // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
    this.ensureOneCLIAgent(jid, group);

    logger.info(
      { jid, name: group.name, folder: group.folder },
      'Group registered',
    );
  }

  /**
   * Connect all registered messaging channels.
   * Returns the list of successfully connected channels.
   */
  async connectChannels(): Promise<Channel[]> {
    const connected: Channel[] = [];

    // Handle /remote-control and /remote-control-end commands
    const handleRemoteControl = async (
      command: string,
      chatJid: string,
      msg: NewMessage,
    ): Promise<void> => {
      const group = this.registeredGroups[chatJid];
      if (!group?.isMain) {
        logger.warn(
          { chatJid, sender: msg.sender },
          'Remote control rejected: not main group',
        );
        return;
      }

      const channel = findChannel(this.channels, chatJid);
      if (!channel) return;

      if (command === '/remote-control') {
        const result = await startRemoteControl(
          msg.sender,
          chatJid,
          process.cwd(),
        );
        if (result.ok) {
          await channel.sendMessage(chatJid, result.url);
        } else {
          await channel.sendMessage(
            chatJid,
            `Remote Control failed: ${result.error}`,
          );
        }
      } else {
        const result = stopRemoteControl();
        if (result.ok) {
          await channel.sendMessage(chatJid, 'Remote Control session ended.');
        } else {
          await channel.sendMessage(chatJid, result.error);
        }
      }
    };

    // Channel callbacks (shared by all channels)
    const channelOpts = {
      onMessage: (chatJid: string, msg: NewMessage) => {
        // Remote control commands - intercept before storage
        const trimmed = msg.content.trim();
        if (
          trimmed === '/remote-control' ||
          trimmed === '/remote-control-end'
        ) {
          handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
            logger.error({ err, chatJid }, 'Remote control command error'),
          );
          return;
        }

        // Sender allowlist drop mode: discard messages from denied senders before storing
        if (
          !msg.is_from_me &&
          !msg.is_bot_message &&
          this.registeredGroups[chatJid]
        ) {
          const cfg = loadSenderAllowlist();
          if (
            shouldDropMessage(chatJid, cfg) &&
            !isSenderAllowed(chatJid, msg.sender, cfg)
          ) {
            if (cfg.logDenied) {
              logger.debug(
                { chatJid, sender: msg.sender },
                'sender-allowlist: dropping message (drop mode)',
              );
            }
            return;
          }
        }
        storeMessage(msg);
      },
      onChatMetadata: (
        chatJid: string,
        timestamp: string,
        name?: string,
        channel?: string,
        isGroup?: boolean,
      ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
      registeredGroups: () => this.registeredGroups,
    };

    // Create and connect all registered channels.
    // Each channel self-registers via the barrel import in index.ts.
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
        this.channels.push(channel);
        connected.push(channel);
      } catch (err) {
        logger.error(
          { channel: channelName, err },
          'Channel failed to connect; skipping channel startup',
        );
      }
    }

    return connected;
  }

  /**
   * Start background subsystems: scheduler, heartbeat, IPC watcher, pending message recovery.
   */
  startSubsystems(): void {
    startSchedulerLoop({
      registeredGroups: () => this.registeredGroups,
      getSessions: () => this.sessions,
      queue: this.queue,
      onProcess: (groupJid, proc, containerName, groupFolder) =>
        this.queue.registerProcess(groupJid, proc, containerName, groupFolder),
      sendMessage: async (jid, rawText) => {
        const channel = findChannel(this.channels, jid);
        if (!channel) {
          logger.warn({ jid }, 'No channel owns JID, cannot send message');
          return;
        }
        const text = formatOutbound(rawText);
        if (text) await channel.sendMessage(jid, text);
      },
    });
    startHeartbeatLoop({
      registeredGroups: () => this.registeredGroups,
      queue: this.queue,
      onProcess: (groupJid, proc, containerName, groupFolder) =>
        this.queue.registerProcess(groupJid, proc, containerName, groupFolder),
      sendMessage: async (jid, rawText) => {
        const channel = findChannel(this.channels, jid);
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
        const channel = findChannel(this.channels, jid);
        if (!channel) throw new Error(`No channel for JID: ${jid}`);
        await channel.sendMessage(jid, text);
      },
      registeredGroups: () => this.registeredGroups,
      registerGroup: (jid, group) => this.registerGroup(jid, group),
      syncGroups: async (force: boolean) => {
        await Promise.all(
          this.channels
            .filter((ch) => ch.syncGroups)
            .map((ch) => ch.syncGroups!(force)),
        );
      },
      getAvailableGroups: () => this.getAvailableGroups(),
      writeGroupsSnapshot: (gf, im, ag, rj) =>
        writeGroupsSnapshot(gf, im, ag, rj),
      onTasksChanged: () => {
        const tasks = getAllTasks();
        const taskRows = tasks.map((t) => ({
          id: t.id,
          groupFolder: t.group_folder,
          prompt: t.prompt,
          schedule_type: t.schedule_type,
          schedule_value: t.schedule_value,
          status: t.status,
          next_run: t.next_run,
        }));
        for (const group of Object.values(this.registeredGroups)) {
          writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
        }
      },
    });

    this.recoverPendingMessages();
  }

  /**
   * Start the infinite message polling loop.
   * Only useful when messaging channels are connected.
   */
  async startMessageLoop(): Promise<void> {
    if (this.messageLoopRunning) {
      logger.debug('Message loop already running, skipping duplicate start');
      return;
    }
    this.messageLoopRunning = true;

    logger.info(`MicroClaw running (trigger: @${ASSISTANT_NAME})`);

    while (true) {
      try {
        const jids = Object.keys(this.registeredGroups);
        const { messages, newTimestamp } = getNewMessages(
          jids,
          this.lastTimestamp,
          ASSISTANT_NAME,
        );

        if (messages.length > 0) {
          logger.info({ count: messages.length }, 'New messages');

          // Advance the "seen" cursor for all messages immediately
          this.lastTimestamp = newTimestamp;
          this.saveState();

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
            const group = this.registeredGroups[chatJid];
            if (!group) continue;

            const channel = findChannel(this.channels, chatJid);
            if (!channel) {
              logger.warn(
                { chatJid },
                'No channel owns JID, skipping messages',
              );
              continue;
            }

            const isMainGroup = group.isMain === true;
            const isDmChat = /dm/i.test(group.folder);
            const needsTrigger =
              !isMainGroup && !isDmChat && group.requiresTrigger !== false;

            // For non-main groups, only act on trigger messages.
            // Non-trigger messages accumulate in DB and get pulled as
            // context when a trigger eventually arrives.
            // DMs never require a trigger.
            if (needsTrigger) {
              const allowlistCfg = loadSenderAllowlist();
              const hasTrigger = groupMessages.some(
                (m) =>
                  TRIGGER_PATTERN.test(m.content.trim()) &&
                  (m.is_from_me ||
                    isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
              );
              if (!hasTrigger) continue;
            }

            // Pull all messages since lastAgentTimestamp so non-trigger
            // context that accumulated between triggers is included.
            const allPending = getMessagesSince(
              chatJid,
              this.lastAgentTimestamp[chatJid] || '',
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

            if (
              supportsLivePiping &&
              this.queue.sendMessage(chatJid, formatted)
            ) {
              logger.debug(
                {
                  chatJid,
                  count: messagesToSend.length,
                  session_mode: 'warm_reuse',
                },
                'Piped messages to active container',
              );
              this.pendingPipedTimestamp[chatJid] =
                messagesToSend[messagesToSend.length - 1].timestamp;
              // Keep typing alive while the active container handles piped follow-ups.
              this.startTypingHeartbeat(channel, chatJid);
            } else {
              // No active container - enqueue for a new one
              this.queue.enqueueMessageCheck(chatJid);
            }
          }
        }
      } catch (err) {
        logger.error({ err }, 'Error in message loop');
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }
  }

  // --- Private methods ---

  private async pulseTyping(channel: Channel, chatJid: string): Promise<void> {
    try {
      await channel.setTyping?.(chatJid, true);
    } catch (err) {
      logger.warn({ chatJid, err }, 'Failed to set typing indicator');
    }
  }

  private startTypingHeartbeat(channel: Channel, chatJid: string): void {
    if (this.typingHeartbeats.has(chatJid)) return;
    void this.pulseTyping(channel, chatJid);
    const interval = setInterval(() => {
      void this.pulseTyping(channel, chatJid);
    }, DISCORD_TYPING_REFRESH_MS);
    this.typingHeartbeats.set(chatJid, interval);
  }

  private stopTypingHeartbeat(chatJid: string): void {
    const interval = this.typingHeartbeats.get(chatJid);
    if (!interval) return;
    clearInterval(interval);
    this.typingHeartbeats.delete(chatJid);
  }

  private stopAllTypingHeartbeats(): void {
    for (const interval of this.typingHeartbeats.values()) {
      clearInterval(interval);
    }
    this.typingHeartbeats.clear();
  }

  private currentPromptMessage(prompt: string): string {
    const markers = [
      '[Current message - this is the only request you should answer now]',
      '[Current message - respond to this]',
    ];
    for (const marker of markers) {
      const index = prompt.lastIndexOf(marker);
      if (index !== -1) return prompt.slice(index + marker.length).trim();
    }
    return prompt.trim();
  }

  private isHostGreetingLike(prompt: string): boolean {
    const current = this.currentPromptMessage(prompt)
      .toLowerCase()
      .replace(/^[^a-z0-9]+|[^a-z0-9!? ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return /^(hi|hello|hey|yo|sup|what s up|whats up|good morning|good afternoon|good evening|hola|namaste|heya|hello there)[!.? ]*$/.test(
      current,
    );
  }

  private isTinyConversationLike(prompt: string): boolean {
    const current = this.currentPromptMessage(prompt)
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    return (
      this.isHostGreetingLike(current) ||
      /^(thanks|thank you|thx|ok|okay|cool|nice|great|got it|understood|alright|see ya|bye|gn|good night)[!.? ]*$/.test(
        current,
      )
    );
  }

  private isLikelyWebPrompt(prompt: string): boolean {
    const current = this.currentPromptMessage(prompt).toLowerCase();
    return (
      /https?:\/\//.test(current) ||
      /\b(latest|news|today|recent|search|look up|lookup|find online|web|browser|source|sources|benchmark|price|weather)\b/.test(
        current,
      )
    );
  }

  private isHostShortCasualPrompt(prompt: string): boolean {
    const current = this.currentPromptMessage(prompt)
      .replace(/\s+/g, ' ')
      .trim();
    if (!current) return false;
    const words = current.split(' ').filter(Boolean);
    return (
      words.length <= 6 &&
      current.length <= 32 &&
      !this.isLikelyWebPrompt(current)
    );
  }

  private isReferentialFollowUpPrompt(prompt: string): boolean {
    const current = this.currentPromptMessage(prompt)
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    if (!current) return false;
    return (
      /\b(again|repeat|rephrase|continue|resume|elaborate|expand|clarify|that|this|previous|last answer|last response|same answer|same thing)\b/.test(
        current,
      ) ||
      /^(what do you mean|can you explain|can you give me the answer again|say that again|repeat that|what was that)\b/.test(
        current,
      )
    );
  }

  private hostFallbackReplyForPrompt(prompt: string): string | null {
    return null;
  }

  private hostFallbackReplyForError(
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

  private looksLikeSchedulingPrompt(prompt: string): boolean {
    const current = this.currentPromptMessage(prompt).toLowerCase();
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

  private isMemoryAssistedPrompt(prompt: string): boolean {
    const current = this.currentPromptMessage(prompt).toLowerCase();
    return /\b(remember|recall|what do you remember|what did i tell you|keep in mind|my preference|my timezone|my name is|from now on)\b/.test(
      current,
    );
  }

  private classifyTurnClass(prompt: string): TurnClass {
    if (this.looksLikeSchedulingPrompt(prompt)) return 'scheduling';
    if (this.isLikelyWebPrompt(prompt)) return 'web_or_browser';
    if (this.isMemoryAssistedPrompt(prompt)) return 'memory_or_state';
    if (this.isReferentialFollowUpPrompt(prompt)) return 'memory_or_state';
    if (this.isTinyConversationLike(prompt)) return 'tiny_conversation';
    if (this.isHostShortCasualPrompt(prompt)) return 'simple_conversation';
    return 'normal_conversation';
  }

  private resolveContextTurnMode(
    prompt: string,
    capabilityRoute:
      | 'plain_response'
      | 'host_file_operation'
      | 'web_lookup'
      | 'browser_operation'
      | 'deny_or_escalate',
  ):
    | 'conversational'
    | 'memory_assisted'
    | 'web_browser'
    | 'scheduling_planning' {
    if (this.looksLikeSchedulingPrompt(prompt)) return 'scheduling_planning';
    if (
      capabilityRoute === 'host_file_operation' ||
      capabilityRoute === 'web_lookup' ||
      capabilityRoute === 'browser_operation'
    ) {
      return 'web_browser';
    }
    if (this.isMemoryAssistedPrompt(prompt)) return 'memory_assisted';
    return 'conversational';
  }

  private contextToolBudgetForTurnMode(
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

  private acquireProcessLock(): void {
    claimProcessLock({
      lockPath: PROCESS_LOCK_PATH,
      dataDir: DATA_DIR,
    });
    this.hasProcessLock = true;
  }

  private releaseProcessLock(): void {
    if (!this.hasProcessLock) return;
    dropProcessLock(PROCESS_LOCK_PATH);
    this.hasProcessLock = false;
  }

  private ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
    if (group.isMain) return;
    const identifier = group.folder.toLowerCase().replace(/_/g, '-');
    this.onecli.ensureAgent({ name: group.name, identifier }).then(
      (res) => {
        logger.info(
          { jid, identifier, created: res.created },
          'OneCLI agent ensured',
        );
      },
      (err) => {
        logger.debug(
          { jid, identifier, err: String(err) },
          'OneCLI agent ensure skipped',
        );
      },
    );
  }

  private loadState(): void {
    this.lastTimestamp = getRouterState('last_timestamp') || '';
    const agentTs = getRouterState('last_agent_timestamp');
    try {
      this.lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
    } catch {
      logger.warn('Corrupted last_agent_timestamp in DB, resetting');
      this.lastAgentTimestamp = {};
    }
    this.sessions = getAllSessions();
    this.registeredGroups = getAllRegisteredGroups();
    logger.info(
      { groupCount: Object.keys(this.registeredGroups).length },
      'State loaded',
    );
  }

  private saveState(): void {
    setRouterState('last_timestamp', this.lastTimestamp);
    setRouterState(
      'last_agent_timestamp',
      JSON.stringify(this.lastAgentTimestamp),
    );
  }

  private ensureContainerSystemRunning(): void {
    cleanupOrphans();
  }

  /**
   * Startup recovery: check for unprocessed messages in registered groups.
   * Handles crash between advancing lastTimestamp and processing messages.
   */
  private recoverPendingMessages(): void {
    for (const [chatJid, group] of Object.entries(this.registeredGroups)) {
      const sinceTimestamp = this.lastAgentTimestamp[chatJid] || '';
      const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
      if (pending.length > 0) {
        logger.info(
          { group: group.name, pendingCount: pending.length },
          'Recovery: found unprocessed messages',
        );
        this.queue.enqueueMessageCheck(chatJid);
      }
    }
  }

  /**
   * Process all pending messages for a group.
   * Called by the GroupQueue when it's this group's turn.
   */
  private async processGroupMessages(chatJid: string): Promise<boolean> {
    const processingStartedAt = Date.now();
    const group = this.registeredGroups[chatJid];
    if (!group) return true;

    const channel = findChannel(this.channels, chatJid);
    if (!channel) {
      logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
      return true;
    }

    const isMainGroup = group.isMain === true;

    const sinceTimestamp = this.lastAgentTimestamp[chatJid] || '';
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
    // DMs never require a trigger - the user is already talking directly to the bot.
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
          this.CONTINUITY_SCAN_LIMIT,
        ),
        recentTurnLimit: this.CONTINUITY_RECENT_LIMIT,
        summaryMinMessages: this.CONTINUITY_SUMMARY_MIN_OLDER_MESSAGES,
        summaryMinChars: this.CONTINUITY_SUMMARY_MIN_OLDER_CHARS,
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
      this.lastAgentTimestamp[chatJid] =
        missedMessages[missedMessages.length - 1].timestamp;
      this.saveState();
      return true;
    }

    const runtimeSelection = resolveRuntimeSelection(group.folder);
    const primaryProvider =
      runtimeSelection.profiles[0]?.provider || 'openai_compatible';
    const latestPromptText =
      latestUserMessage?.content || formatMessages(missedMessages);
    const turnClass = this.classifyTurnClass(latestPromptText);
    const latencyTurnPolicy = resolveLatencyTurnPolicy(turnClass);
    let prompt: string;
    const recentConversation = getRecentMessages(
      chatJid,
      this.CONTINUITY_SCAN_LIMIT,
    );
    const storedSummary = getConversationSummary(group.folder);
    const continuityPlan = buildContinuityPlan({
      assistantName: ASSISTANT_NAME,
      conversationMessages: recentConversation,
      currentMessages: missedMessages,
      storedSummary: storedSummary?.summary,
      recentTurnLimit: this.CONTINUITY_RECENT_LIMIT,
      summaryMinMessages: this.CONTINUITY_SUMMARY_MIN_OLDER_MESSAGES,
      summaryMinChars: this.CONTINUITY_SUMMARY_MIN_OLDER_CHARS,
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
    const previousCursor = this.lastAgentTimestamp[chatJid] || '';
    this.lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
    this.saveState();

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
        this.queue.closeStdin(chatJid);
      }, effectiveIdleTimeout);
    };

    const stopTypingNow = async () => {
      this.stopTypingHeartbeat(chatJid);
      await channel.setTyping?.(chatJid, false);
    };

    this.startTypingHeartbeat(channel, chatJid);
    let hadError = false;
    let outputSentToUser = false;
    let lastStreamError: string | null = null;
    let firstModelOutputAt: number | null = null;
    let firstUserVisibleOutputAt: number | null = null;
    let finalUserVisibleOutputAt: number | null = null;
    let partialBuffer = '';
    let streamedMessageRef: ChannelMessageRef | null = null;
    let assistantReplyRecorded = false;

    const runResult = await this.runAgent(
      group,
      prompt,
      chatJid,
      async (result) => {
        // Streaming output callback - called for each agent result
        if (result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          // Strip <internal>...</internal> blocks - agent uses these for internal reasoning
          const text = raw
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          logger.info(
            { group: group.name },
            `Agent output: ${raw.slice(0, 200)}`,
          );
          if (text && result.isPartial) {
            firstModelOutputAt ??= Date.now();
            partialBuffer = appendStreamText(partialBuffer, text);
          } else if (text) {
            firstModelOutputAt ??= Date.now();
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
            firstUserVisibleOutputAt ??= Date.now();
            finalUserVisibleOutputAt = Date.now();
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

        if (
          result.status === 'success' &&
          !result.isPartial &&
          !result.result
        ) {
          this.queue.notifyIdle(chatJid);
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
          this.queue.closeStdin(chatJid);
          await stopTypingNow();
        }
      },
      {
        turnClass,
        skipContextBundle: latencyTurnPolicy.skipContextBundle,
        disableTools: latencyTurnPolicy.disableTools,
        runtimeSecretOverrides: latencyTurnPolicy.runtimeSecretOverrides,
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
          model_first_output_ms:
            firstModelOutputAt === null
              ? null
              : firstModelOutputAt - contextReadyAt,
          first_visible_output_ms:
            firstUserVisibleOutputAt === null
              ? null
              : firstUserVisibleOutputAt - contextReadyAt,
          final_visible_output_ms:
            finalUserVisibleOutputAt === null
              ? null
              : finalUserVisibleOutputAt - contextReadyAt,
          total_ms: Date.now() - processingStartedAt,
        },
        promptChars: prompt.length,
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
    if (!hadError && this.pendingPipedTimestamp[chatJid]) {
      const pipedTs = this.pendingPipedTimestamp[chatJid];
      if (
        !this.lastAgentTimestamp[chatJid] ||
        this.lastAgentTimestamp[chatJid] < pipedTs
      ) {
        this.lastAgentTimestamp[chatJid] = pipedTs;
        this.saveState();
      }
      delete this.pendingPipedTimestamp[chatJid];
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
      // If we already sent output to the user, don't roll back the cursor -
      // the user got their response and re-processing would send duplicates.
      if (outputSentToUser) {
        if (!assistantReplyRecorded && partialBuffer.trim()) {
          recordAssistantReply(chatJid, partialBuffer.trim());
          assistantReplyRecorded = true;
        }
        // If follow-up messages were piped during this run, force a re-check.
        // This avoids requiring the user to send another "?" to unstick queueing.
        if (this.pendingPipedTimestamp[chatJid]) {
          this.queue.enqueueMessageCheck(chatJid);
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
          this.hostFallbackReplyForError(lastStreamError || runResult.error) ||
          this.hostFallbackReplyForPrompt(prompt) ||
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
      this.lastAgentTimestamp[chatJid] = previousCursor;
      this.saveState();
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
          this.hostFallbackReplyForPrompt(prompt) ||
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

  private async runAgent(
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    onOutput?: (output: ContainerOutput) => Promise<void>,
    options?: {
      turnClass?: TurnClass;
      skipContextBundle?: boolean;
      disableTools?: boolean;
      runtimeSecretOverrides?: RuntimeSecretOverrides;
      singleTurn?: boolean;
    },
  ): Promise<{ status: 'success' | 'error'; error?: string }> {
    const isMain = group.isMain === true;
    const sessionId = this.sessions[group.folder];
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
    const availableGroups = this.getAvailableGroups();
    writeGroupsSnapshot(
      group.folder,
      isMain,
      availableGroups,
      new Set(Object.keys(this.registeredGroups)),
    );

    // Wrap onOutput to track session ID from streamed results
    const wrappedOnOutput = onOutput
      ? async (output: ContainerOutput) => {
          if (output.newSessionId) {
            this.sessions[group.folder] = output.newSessionId;
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
        const turnMode = this.resolveContextTurnMode(prompt, capabilityRoute);
        const contextBudget = this.contextToolBudgetForTurnMode(turnMode);
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
        logger.info(
          {
            group: group.folder,
            profile: profile.id,
            turnClass: options?.turnClass,
            promptChars: prompt.length,
            skipContextBundle: options?.skipContextBundle === true,
            disableTools: options?.disableTools === true,
            contextChars: contextBundle?.systemPrompt.length || 0,
            contextWarnings: contextBundle?.diagnostics.warnings.length || 0,
            runtimeOverrides: options?.runtimeSecretOverrides
              ? Object.keys(options.runtimeSecretOverrides)
              : [],
          },
          'Prepared turn context',
        );
        const runtimeSecretOverrides = Object.fromEntries(
          Object.entries(options?.runtimeSecretOverrides || {}).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        );
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
            singleTurn: options?.singleTurn,
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
            secrets: {
              ...resolved.secrets,
              ...runtimeSecretOverrides,
            },
          },
          {
            onProcess: (proc, containerName) =>
              this.queue.registerProcess(
                chatJid,
                proc,
                containerName,
                group.folder,
              ),
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
          this.sessions[group.folder] = output.newSessionId;
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
}

// --- Module-level helpers for backwards compatibility ---
// These are singleton-backed functions that delegate to a shared AppCore instance.

let _singletonCore: AppCore | null = null;

/** @internal - used by routing.test.ts for backwards compat */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  if (!_singletonCore) {
    _singletonCore = new AppCore();
  }
  _singletonCore._setRegisteredGroups(groups);
}

/** @internal - used by routing.test.ts for backwards compat */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  if (!_singletonCore) {
    _singletonCore = new AppCore();
  }
  return _singletonCore.getAvailableGroups();
}

/** @internal - set the singleton core (used by index.ts) */
export function _setSingletonCore(core: AppCore): void {
  _singletonCore = core;
}
