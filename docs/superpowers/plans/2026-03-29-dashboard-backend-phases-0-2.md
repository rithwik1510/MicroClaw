# MicroClaw Dashboard Backend — Phases 0-2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a web dashboard to MicroClaw — `npx microclaw` starts an Express server with a React UI, registers the browser as a first-class channel, and enables single-agent chat via WebSocket.

**Architecture:** Extract an `AppCore` service layer from `src/index.ts` so the runtime can start with zero messaging channels. Add Express + WebSocket as a dashboard channel that writes to the existing `chats`/`messages` tables. Serve a pre-built React SPA as static files.

**Tech Stack:** Express, ws, detect-port, open (npm), React + Vite (placeholder UI only in this plan)

**Spec:** `docs/superpowers/specs/2026-03-29-dashboard-backend-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/core.ts` | AppCore service layer — owns lifecycle, state, message processing, agent execution |
| `src/core.test.ts` | Tests for AppCore |
| `server/index.ts` | Express app factory — mounts API routes, static UI, WebSocket upgrade |
| `server/api/health.ts` | `GET /api/health` — server status |
| `server/api/setup.ts` | `GET/POST /api/setup`, `POST /api/setup/test-connection` |
| `server/api/agents.ts` | Agent CRUD endpoints |
| `server/api/chats.ts` | Chat list + message history endpoints |
| `server/ws.ts` | WebSocket handler for real-time chat |
| `server/middleware.ts` | Error handling middleware |
| `src/channels/dashboard.ts` | Dashboard channel (implements `Channel` interface, backed by WebSocket) |
| `src/channels/dashboard.test.ts` | Tests for dashboard channel |
| `ui/package.json` | React + Vite app config |
| `ui/index.html` | SPA entry point |
| `ui/vite.config.ts` | Vite config with API proxy |
| `ui/src/main.tsx` | React entry |
| `ui/src/App.tsx` | Placeholder app (onboarding vs dashboard) |

### Modified Files
| File | Changes |
|------|---------|
| `src/index.ts` | Refactor to thin startup glue that creates AppCore + wires channels + starts server |
| `src/db.ts` | Add `source` and `thread_id` columns to `messages`; `source` column to `chats`; `agents` table; `setup` table |
| `src/types.ts` | Add `source` field to `NewMessage`; add `Agent` and `SetupState` types |
| `package.json` | Add `express`, `ws`, `detect-port`, `open` deps; add `bin` entry; add `build:ui` script |

---

## Phase 0: App Core Extraction

### Task 1: Add `source` column to database schema

**Files:**
- Modify: `src/db.ts`
- Modify: `src/db.test.ts`

- [ ] **Step 1: Write test for source column migration**

In `src/db.test.ts`, add a test that verifies the `source` column exists on `messages` and `chats`:

```typescript
describe('schema migrations', () => {
  it('messages table has source column', () => {
    const info = db.pragma('table_info(messages)') as Array<{ name: string }>;
    expect(info.some(col => col.name === 'source')).toBe(true);
  });

  it('chats table has source column', () => {
    const info = db.pragma('table_info(chats)') as Array<{ name: string }>;
    expect(info.some(col => col.name === 'source')).toBe(true);
  });

  it('messages table has thread_id column', () => {
    const info = db.pragma('table_info(messages)') as Array<{ name: string }>;
    expect(info.some(col => col.name === 'thread_id')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db.test.ts -t "source column"`
Expected: FAIL — columns don't exist yet

- [ ] **Step 3: Add migration to `createSchema` in `src/db.ts`**

Add after the existing migration blocks (around line 270, before `initDatabase`):

```typescript
// Dashboard source tracking
const msgCols = database.pragma('table_info(messages)') as Array<{ name: string }>;
if (!msgCols.some(c => c.name === 'source')) {
  database.exec(`ALTER TABLE messages ADD COLUMN source TEXT DEFAULT 'legacy'`);
}
if (!msgCols.some(c => c.name === 'thread_id')) {
  database.exec(`ALTER TABLE messages ADD COLUMN thread_id TEXT`);
}

const chatCols = database.pragma('table_info(chats)') as Array<{ name: string }>;
if (!chatCols.some(c => c.name === 'source')) {
  database.exec(`ALTER TABLE chats ADD COLUMN source TEXT DEFAULT 'legacy'`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/db.test.ts -t "source column"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(db): add source and thread_id columns for multi-channel support"
```

---

### Task 2: Add `agents` and `setup` tables

**Files:**
- Modify: `src/db.ts`
- Modify: `src/types.ts`
- Modify: `src/db.test.ts`

- [ ] **Step 1: Add Agent and SetupEntry types to `src/types.ts`**

```typescript
export interface Agent {
  id: string;
  name: string;
  model: string;
  provider: RuntimeProvider;
  personality: string | null;
  tools: string; // JSON array of tool family names
  created_at: string;
}

export interface SetupEntry {
  key: string;
  value: string;
}
```

- [ ] **Step 2: Write tests for agents and setup tables in `src/db.test.ts`**

```typescript
describe('agents table', () => {
  it('create and get agent', () => {
    createAgent({
      id: 'agent-1',
      name: 'TestBot',
      model: 'qwen2.5:14b',
      provider: 'openai_compatible',
      personality: 'Helpful assistant',
      tools: '["web","memory"]',
      created_at: new Date().toISOString(),
    });
    const agent = getAgent('agent-1');
    expect(agent).toBeDefined();
    expect(agent!.name).toBe('TestBot');
    expect(agent!.model).toBe('qwen2.5:14b');
  });

  it('list all agents', () => {
    const agents = getAllAgents();
    expect(agents.length).toBeGreaterThanOrEqual(1);
  });

  it('update agent', () => {
    updateAgent('agent-1', { name: 'UpdatedBot', model: 'llama3.3:70b' });
    const agent = getAgent('agent-1');
    expect(agent!.name).toBe('UpdatedBot');
  });

  it('delete agent', () => {
    deleteAgent('agent-1');
    expect(getAgent('agent-1')).toBeUndefined();
  });
});

describe('setup table', () => {
  it('set and get setup value', () => {
    setSetupValue('onboarding_completed', 'true');
    expect(getSetupValue('onboarding_completed')).toBe('true');
  });

  it('returns undefined for missing key', () => {
    expect(getSetupValue('nonexistent')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/db.test.ts -t "agents table"`
Expected: FAIL — functions not defined

- [ ] **Step 4: Add table creation to `createSchema` in `src/db.ts`**

Add to `createSchema`:

```typescript
database.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    model TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'openai_compatible',
    personality TEXT,
    tools TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS setup (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);
```

- [ ] **Step 5: Add CRUD functions to `src/db.ts`**

```typescript
export function createAgent(agent: Agent): void {
  db.prepare(
    `INSERT INTO agents (id, name, model, provider, personality, tools, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(agent.id, agent.name, agent.model, agent.provider, agent.personality, agent.tools, agent.created_at);
}

export function getAgent(id: string): Agent | undefined {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent | undefined;
}

export function getAllAgents(): Agent[] {
  return db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all() as Agent[];
}

export function updateAgent(id: string, updates: Partial<Pick<Agent, 'name' | 'model' | 'provider' | 'personality' | 'tools'>>): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteAgent(id: string): void {
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
}

export function getSetupValue(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM setup WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetupValue(key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO setup (key, value) VALUES (?, ?)').run(key, value);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/db.test.ts -t "agents table"`
Run: `npx vitest run src/db.test.ts -t "setup table"`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/db.test.ts src/types.ts
git commit -m "feat(db): add agents and setup tables"
```

---

### Task 3: Extract AppCore from `src/index.ts`

This is the biggest task. `src/index.ts` is ~1700 lines. We extract the core runtime logic into `src/core.ts` while keeping `src/index.ts` as thin startup glue.

**Files:**
- Create: `src/core.ts`
- Create: `src/core.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write AppCore test — lifecycle basics**

Create `src/core.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AppCore } from './core.js';
import { _initTestDatabase } from './db.js';

// Mock container-runtime to avoid Docker dependency in tests
vi.mock('./container-runtime.js', () => ({
  cleanupOrphans: vi.fn(),
  ensureContainerRuntimeRunning: vi.fn(),
}));

describe('AppCore', () => {
  let core: AppCore;

  beforeEach(() => {
    _initTestDatabase();
    core = new AppCore();
  });

  afterEach(async () => {
    await core.stop();
  });

  it('starts without channels', async () => {
    await core.start();
    expect(core.isRunning()).toBe(true);
  });

  it('stops cleanly', async () => {
    await core.start();
    await core.stop();
    expect(core.isRunning()).toBe(false);
  });

  it('getRegisteredGroups returns empty initially', async () => {
    await core.start();
    const groups = core.getRegisteredGroups();
    expect(Object.keys(groups).length).toBe(0);
  });

  it('registerGroup adds a group', async () => {
    await core.start();
    core.registerGroup('dashboard:test', {
      name: 'Test',
      folder: 'test',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
    });
    expect(core.getRegisteredGroups()['dashboard:test']).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core.test.ts`
Expected: FAIL — `./core.js` doesn't exist

- [ ] **Step 3: Create `src/core.ts` with lifecycle and state management**

Extract from `src/index.ts` the following into a class:

```typescript
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IDLE_TIMEOUT,
  OPENAI_WARM_SESSIONS,
  OPENAI_SESSION_IDLE_TIMEOUT_MS,
  ONECLI_URL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
  type ChannelOpts,
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
  acquireProcessLock,
  releaseProcessLock,
} from './process-lock.js';
import { runAgentProcess } from './execution/backend.js';
import { ensureToolServicesReadyOnStartup } from './tools/service-supervisor.js';
import { buildRuntimeUsageLog } from './runtime-usage.js';
import {
  probeExecutionBackend,
  resolveExecutionBackendForProvider,
} from './execution/backend.js';
import { migrateEnvCredentialsToAuthProfilesIfNeeded } from './auth/auth-manager.js';
import { OneCLI } from '@onecli-sh/sdk';

type TurnClass = LatencyTurnClass;

export class AppCore {
  private lastTimestamp = '';
  private sessions: Record<string, string> = {};
  private registeredGroups: Record<string, RegisteredGroup> = {};
  private lastAgentTimestamp: Record<string, string> = {};
  private pendingPipedTimestamp: Record<string, string> = {};
  private messageLoopRunning = false;
  private running = false;
  private hasProcessLock = false;

  readonly channels: Channel[] = [];
  readonly queue = new GroupQueue();

  private readonly PROCESS_LOCK_PATH = path.join(DATA_DIR, 'microclaw.lock');
  private readonly CONTINUITY_RECENT_LIMIT = 12;
  private readonly CONTINUITY_SCAN_LIMIT = 120;
  private readonly CONTINUITY_SUMMARY_MIN_OLDER_MESSAGES = 8;
  private readonly CONTINUITY_SUMMARY_MIN_OLDER_CHARS = 3000;
  private readonly DISCORD_TYPING_REFRESH_MS = 8000;
  private typingHeartbeats = new Map<string, ReturnType<typeof setInterval>>();

  private onecli = new OneCLI({ url: ONECLI_URL });

  isRunning(): boolean {
    return this.running;
  }

  getRegisteredGroups(): Record<string, RegisteredGroup> {
    return this.registeredGroups;
  }

  getChannels(): Channel[] {
    return this.channels;
  }

  async start(): Promise<void> {
    this.acquireProcessLock();
    cleanupOrphans();
    initDatabase();
    migrateToLocalOnlyIfNeeded();
    migrateEnvCredentialsToAuthProfilesIfNeeded();
    await ensureToolServicesReadyOnStartup();
    this.loadState();
    this.queue.setProcessMessagesFn((jid) => this.processGroupMessages(jid));
    this.running = true;
  }

  async stop(): Promise<void> {
    this.stopAllTypingHeartbeats();
    await this.queue.shutdown(10000);
    for (const ch of this.channels) {
      try { await ch.disconnect(); } catch { /* best effort */ }
    }
    this.releaseProcessLock();
    this.running = false;
  }

  registerGroup(jid: string, group: RegisteredGroup): void {
    let groupDir: string;
    try {
      groupDir = resolveGroupFolderPath(group.folder);
    } catch (err) {
      logger.warn({ jid, folder: group.folder, err }, 'Rejecting group registration with invalid folder');
      return;
    }
    this.registeredGroups[jid] = group;
    setRegisteredGroup(jid, group);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
    logger.info({ jid, name: group.name, folder: group.folder }, 'Group registered');
  }

  // ... (remaining methods: processGroupMessages, runAgent, startMessageLoop,
  //      recoverPendingMessages, helper functions — moved from index.ts verbatim,
  //      with `this.` prefixed for state access)

  // All private helper functions from index.ts move here as private methods:
  // - loadState, saveState
  // - processGroupMessages, runAgent
  // - startMessageLoop, recoverPendingMessages
  // - pulseTyping, startTypingHeartbeat, stopTypingHeartbeat, stopAllTypingHeartbeats
  // - currentPromptMessage, isHostGreetingLike, isTinyConversationLike, etc.
  // - classifyTurnClass, resolveContextTurnMode, contextToolBudgetForTurnMode
  // - hostFallbackReplyForPrompt, hostFallbackReplyForError
  // - acquireProcessLock, releaseProcessLock
  // - ensureOneCLIAgent
  // - getAvailableGroups

  private loadState(): void {
    this.lastTimestamp = getRouterState('last_timestamp') || '';
    const agentTs = getRouterState('last_agent_timestamp');
    try {
      this.lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
    } catch {
      this.lastAgentTimestamp = {};
    }
    this.sessions = getAllSessions();
    this.registeredGroups = getAllRegisteredGroups();
  }

  private saveState(): void {
    setRouterState('last_timestamp', this.lastTimestamp);
    setRouterState('last_agent_timestamp', JSON.stringify(this.lastAgentTimestamp));
  }

  private acquireProcessLock(): void {
    acquireProcessLock({ lockPath: this.PROCESS_LOCK_PATH, dataDir: DATA_DIR });
    this.hasProcessLock = true;
  }

  private releaseProcessLock(): void {
    if (!this.hasProcessLock) return;
    releaseProcessLock(this.PROCESS_LOCK_PATH);
    this.hasProcessLock = false;
  }

  // Typing heartbeat methods
  private async pulseTyping(channel: Channel, chatJid: string): Promise<void> {
    try { await channel.setTyping?.(chatJid, true); } catch { /* ignore */ }
  }

  private startTypingHeartbeat(channel: Channel, chatJid: string): void {
    if (this.typingHeartbeats.has(chatJid)) return;
    void this.pulseTyping(channel, chatJid);
    const interval = setInterval(() => void this.pulseTyping(channel, chatJid), this.DISCORD_TYPING_REFRESH_MS);
    this.typingHeartbeats.set(chatJid, interval);
  }

  private stopTypingHeartbeat(chatJid: string): void {
    const interval = this.typingHeartbeats.get(chatJid);
    if (!interval) return;
    clearInterval(interval);
    this.typingHeartbeats.delete(chatJid);
  }

  private stopAllTypingHeartbeats(): void {
    for (const interval of this.typingHeartbeats.values()) clearInterval(interval);
    this.typingHeartbeats.clear();
  }

  // Expose for external use (IPC, API routes)
  getAvailableGroups(): { jid: string; name: string; lastActivity: string; isRegistered: boolean }[] {
    const chats = getAllChats();
    const registeredJids = new Set(Object.keys(this.registeredGroups));
    return chats
      .filter(c => c.jid !== '__group_sync__' && c.is_group)
      .map(c => ({ jid: c.jid, name: c.name, lastActivity: c.last_message_time, isRegistered: registeredJids.has(c.jid) }));
  }

  /**
   * Connect all registered messaging channels.
   * Returns the list of successfully connected channels.
   * Does NOT fail if zero channels connect — dashboard is always available.
   */
  async connectChannels(): Promise<Channel[]> {
    const channelOpts: ChannelOpts = {
      onMessage: (chatJid, msg) => {
        if (!msg.is_from_me && !msg.is_bot_message && this.registeredGroups[chatJid]) {
          const cfg = loadSenderAllowlist();
          if (shouldDropMessage(chatJid, cfg) && !isSenderAllowed(chatJid, msg.sender, cfg)) return;
        }
        storeMessage(msg);
      },
      onChatMetadata: (chatJid, timestamp, name, channel, isGroup) =>
        storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
      registeredGroups: () => this.registeredGroups,
    };

    for (const channelName of getRegisteredChannelNames()) {
      const factory = getChannelFactory(channelName)!;
      const channel = factory(channelOpts);
      if (!channel) continue;
      try {
        await channel.connect();
        this.channels.push(channel);
      } catch (err) {
        logger.error({ channel: channelName, err }, 'Channel failed to connect');
      }
    }
    return this.channels;
  }

  /**
   * Start subsystems: scheduler, heartbeat, IPC watcher, message loop.
   * Call after connectChannels().
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
        if (!channel) return;
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
        if (!channel) return;
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
      syncGroups: async (force) => {
        await Promise.all(
          this.channels.filter(ch => ch.syncGroups).map(ch => ch.syncGroups!(force)),
        );
      },
      getAvailableGroups: () => this.getAvailableGroups(),
      writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
      onTasksChanged: () => {
        const tasks = getAllTasks();
        const taskRows = tasks.map(t => ({
          id: t.id, groupFolder: t.group_folder, prompt: t.prompt,
          schedule_type: t.schedule_type, schedule_value: t.schedule_value,
          status: t.status, next_run: t.next_run,
        }));
        for (const group of Object.values(this.registeredGroups)) {
          writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
        }
      },
    });

    restoreRemoteControl();
    this.recoverPendingMessages();
  }

  /**
   * Start the polling message loop (blocking — runs forever).
   */
  async startMessageLoop(): Promise<void> {
    // Move the entire startMessageLoop body from index.ts here,
    // replacing all bare variable references with this.* references.
    // This is a verbatim move — no logic changes.
  }

  /**
   * Process messages for a single group (called by GroupQueue).
   * This is the core processing pipeline — moved verbatim from index.ts processGroupMessages.
   */
  private async processGroupMessages(chatJid: string): Promise<boolean> {
    // Move entire processGroupMessages body from index.ts here.
    // Replace: channels → this.channels, registeredGroups → this.registeredGroups, etc.
    // No logic changes — just add this. prefix to all instance state.
    return true; // placeholder for the plan — actual implementation moves the full function
  }

  /**
   * Run agent against a group. Moved verbatim from index.ts runAgent.
   */
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
    // Move entire runAgent body from index.ts here.
    return { status: 'error', error: 'not implemented' }; // placeholder
  }

  private recoverPendingMessages(): void {
    for (const [chatJid] of Object.entries(this.registeredGroups)) {
      const sinceTimestamp = this.lastAgentTimestamp[chatJid] || '';
      const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
      if (pending.length > 0) {
        this.queue.enqueueMessageCheck(chatJid);
      }
    }
  }
}
```

**Important:** The actual implementation step will move the FULL function bodies from `src/index.ts`. The code above shows the class structure and method signatures. The agentic worker must:
1. Copy each function body from `src/index.ts` into the corresponding AppCore method
2. Replace all bare state references (e.g., `registeredGroups`) with `this.registeredGroups`
3. Replace `channels` array with `this.channels`
4. Replace `queue` with `this.queue`
5. Replace `sessions` with `this.sessions`
6. Replace `lastTimestamp` with `this.lastTimestamp`
7. Replace `lastAgentTimestamp` with `this.lastAgentTimestamp`
8. Replace `pendingPipedTimestamp` with `this.pendingPipedTimestamp`
9. Move helper functions (`currentPromptMessage`, `isHostGreetingLike`, `isTinyConversationLike`, `isLikelyWebPrompt`, `isHostShortCasualPrompt`, `isReferentialFollowUpPrompt`, `hostFallbackReplyForPrompt`, `hostFallbackReplyForError`, `looksLikeSchedulingPrompt`, `isMemoryAssistedPrompt`, `classifyTurnClass`, `resolveContextTurnMode`, `contextToolBudgetForTurnMode`) as private methods

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core.test.ts`
Expected: PASS — lifecycle tests pass

- [ ] **Step 5: Commit**

```bash
git add src/core.ts src/core.test.ts
git commit -m "feat: extract AppCore service layer from index.ts"
```

---

### Task 4: Refactor `src/index.ts` to use AppCore

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Replace `src/index.ts` with thin startup glue**

```typescript
import { AppCore } from './core.js';
import './channels/index.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';
export { AppCore } from './core.js';

async function main(): Promise<void> {
  const core = new AppCore();

  process.on('exit', () => core.stop());

  await core.start();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await core.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Connect messaging channels (optional — zero is OK now)
  const connected = await core.connectChannels();
  if (connected.length === 0) {
    logger.info('No messaging channels connected — dashboard-only mode');
  } else {
    logger.info({ count: connected.length }, 'Messaging channels connected');
  }

  // Start subsystems
  core.startSubsystems();

  // Start polling loop (only if messaging channels exist)
  if (connected.length > 0) {
    core.startMessageLoop().catch(err => {
      logger.fatal({ err }, 'Message loop crashed');
      process.exit(1);
    });
  }

  logger.info(`MicroClaw running (trigger: @${process.env.ASSISTANT_NAME || 'Andy'})`);
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch(err => {
    logger.error({ err }, 'Failed to start MicroClaw');
    process.exit(1);
  });
}
```

- [ ] **Step 2: Run ALL existing tests to verify nothing broke**

Run: `npx vitest run`
Expected: All existing tests PASS. The refactor is a code move, not a logic change.

- [ ] **Step 3: Run the dev server manually to verify it starts**

Run: `npm run dev`
Expected: MicroClaw starts normally, connects to any configured channels, processes messages.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "refactor: simplify index.ts to thin startup glue over AppCore"
```

---

## Phase 1: Foundation

### Task 5: Install dependencies and add build scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install new dependencies**

```bash
npm install express ws detect-port open
npm install -D @types/express @types/ws
```

- [ ] **Step 2: Add build scripts and bin entry to `package.json`**

Add to `scripts`:
```json
"build:ui": "cd ui && npm run build",
"build:all": "npm run build:ui && npm run build",
"start:dashboard": "node dist/server/index.js"
```

Add `bin` field:
```json
"bin": {
  "microclaw": "dist/server/index.js"
}
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add express, ws, detect-port, open dependencies"
```

---

### Task 6: Create Express server with health endpoint

**Files:**
- Create: `server/index.ts`
- Create: `server/api/health.ts`
- Create: `server/middleware.ts`

- [ ] **Step 1: Create `server/middleware.ts`**

```typescript
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../src/logger.js';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  logger.error({ err }, 'API error');
  res.status(500).json({ error: err.message });
}
```

- [ ] **Step 2: Create `server/api/health.ts`**

```typescript
import { Router } from 'express';
import type { AppCore } from '../src/core.js';

export function healthRouter(core: AppCore): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      channels: core.getChannels().map(c => ({
        name: c.name,
        connected: c.isConnected(),
      })),
      groups: Object.keys(core.getRegisteredGroups()).length,
    });
  });

  return router;
}
```

- [ ] **Step 3: Create `server/index.ts`**

```typescript
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import type { AppCore } from '../src/core.js';
import { healthRouter } from './api/health.js';
import { errorHandler } from './middleware.js';
import { logger } from '../src/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(core: AppCore): { app: express.Express; httpServer: ReturnType<typeof createServer> } {
  const app = express();
  app.use(express.json());

  // API routes
  app.use('/api', healthRouter(core));

  // Serve static UI (pre-built React app)
  const uiDistPath = path.resolve(__dirname, '../ui/dist');
  app.use(express.static(uiDistPath));

  // SPA fallback — serve index.html for all non-API routes
  app.get('*', (_req, res) => {
    res.sendFile(path.join(uiDistPath, 'index.html'));
  });

  app.use(errorHandler);

  const httpServer = createServer(app);
  return { app, httpServer };
}

export async function startServer(core: AppCore, port: number): Promise<void> {
  const { httpServer } = createApp(core);

  return new Promise((resolve) => {
    httpServer.listen(port, '127.0.0.1', () => {
      logger.info({ port }, 'Dashboard server listening');
      resolve();
    });
  });
}
```

- [ ] **Step 4: Verify typecheck passes**

Run: `npx tsc --noEmit`
Expected: No errors (server files compile cleanly)

- [ ] **Step 5: Commit**

```bash
git add server/
git commit -m "feat: add Express server with health endpoint"
```

---

### Task 7: Create placeholder React UI

**Files:**
- Create: `ui/package.json`
- Create: `ui/index.html`
- Create: `ui/vite.config.ts`
- Create: `ui/tsconfig.json`
- Create: `ui/src/main.tsx`
- Create: `ui/src/App.tsx`

- [ ] **Step 1: Create `ui/package.json`**

```json
{
  "name": "microclaw-ui",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 2: Create `ui/vite.config.ts`**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3100',
    },
  },
  build: {
    outDir: 'dist',
  },
});
```

- [ ] **Step 3: Create `ui/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create `ui/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MicroClaw</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

- [ ] **Step 5: Create `ui/src/main.tsx`**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 6: Create `ui/src/App.tsx`**

```tsx
import { useEffect, useState } from 'react';

export function App() {
  const [health, setHealth] = useState<{ status: string; uptime: number } | null>(null);
  const [setupDone, setSetupDone] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then(r => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));

    fetch('/api/setup')
      .then(r => r.json())
      .then(data => setSetupDone(data.completed))
      .catch(() => setSetupDone(false));
  }, []);

  if (health === null) {
    return <div style={{ padding: 40, fontFamily: 'system-ui' }}>Connecting to MicroClaw...</div>;
  }

  if (!setupDone) {
    return (
      <div style={{ padding: 40, fontFamily: 'system-ui' }}>
        <h1>Welcome to MicroClaw</h1>
        <p>Onboarding wizard will go here.</p>
        <p>Server status: {health.status} (uptime: {Math.round(health.uptime)}s)</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 40, fontFamily: 'system-ui' }}>
      <h1>MicroClaw Dashboard</h1>
      <p>Server status: {health.status} (uptime: {Math.round(health.uptime)}s)</p>
      <p>Chat interface will go here.</p>
    </div>
  );
}
```

- [ ] **Step 7: Install UI dependencies**

```bash
cd ui && npm install && cd ..
```

- [ ] **Step 8: Build UI**

```bash
cd ui && npm run build && cd ..
```

Expected: `ui/dist/` directory created with built assets

- [ ] **Step 9: Commit**

```bash
git add ui/
git commit -m "feat: add placeholder React UI with Vite"
```

---

### Task 8: Create setup API

**Files:**
- Create: `server/api/setup.ts`

- [ ] **Step 1: Create `server/api/setup.ts`**

```typescript
import { Router } from 'express';
import { getSetupValue, setSetupValue } from '../../src/db.js';

export function setupRouter(): Router {
  const router = Router();

  router.get('/setup', (_req, res) => {
    const completed = getSetupValue('onboarding_completed') === 'true';
    res.json({ completed });
  });

  router.post('/setup', (req, res) => {
    const { provider, model, apiKey, baseUrl } = req.body;

    if (!provider || !model) {
      res.status(400).json({ error: 'provider and model are required' });
      return;
    }

    setSetupValue('provider', provider);
    setSetupValue('model', model);
    if (apiKey) setSetupValue('api_key', apiKey);
    if (baseUrl) setSetupValue('base_url', baseUrl);
    setSetupValue('onboarding_completed', 'true');

    res.json({ ok: true });
  });

  router.post('/setup/test-connection', async (req, res) => {
    const { provider, model, apiKey, baseUrl } = req.body;

    if (!provider || !model) {
      res.status(400).json({ error: 'provider and model are required' });
      return;
    }

    // Basic connectivity test — try to reach the model endpoint
    try {
      const url = baseUrl || 'http://localhost:11434/v1';
      const response = await fetch(`${url}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        res.json({ ok: true, message: 'Connection successful' });
      } else {
        res.json({ ok: false, message: `Provider returned HTTP ${response.status}` });
      }
    } catch (err) {
      res.json({ ok: false, message: `Could not reach endpoint: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  return router;
}
```

- [ ] **Step 2: Mount in `server/index.ts`**

Add import and mount:

```typescript
import { setupRouter } from './api/setup.js';

// In createApp, after healthRouter:
app.use('/api', setupRouter());
```

- [ ] **Step 3: Commit**

```bash
git add server/api/setup.ts server/index.ts
git commit -m "feat: add setup API for onboarding wizard"
```

---

### Task 9: Create CLI entry point with auto-open

**Files:**
- Modify: `src/index.ts`

The existing `src/index.ts` `main()` function gets extended to also start the Express server. We don't create a separate CLI file — we add the server start to the existing main.

- [ ] **Step 1: Update `src/index.ts` main() to start Express server**

```typescript
import { createApp, startServer } from '../server/index.js';
import detectPort from 'detect-port';
import open from 'open';

async function main(): Promise<void> {
  const core = new AppCore();

  // ... (existing startup from Task 4)

  await core.start();
  const connected = await core.connectChannels();
  core.startSubsystems();

  // Start Express dashboard
  const defaultPort = parseInt(process.env.MICROCLAW_PORT || '3100', 10);
  const port = await detectPort(defaultPort);
  await startServer(core, port);

  const url = `http://localhost:${port}`;
  logger.info(`Dashboard: ${url}`);

  // Auto-open browser (skip if NO_OPEN env is set — useful for dev/CI)
  if (!process.env.NO_OPEN) {
    await open(url);
  }

  if (connected.length > 0) {
    core.startMessageLoop().catch(err => {
      logger.fatal({ err }, 'Message loop crashed');
      process.exit(1);
    });
  }
}
```

- [ ] **Step 2: Test manually**

Run: `NO_OPEN=1 npm run dev`
Expected: Server starts, prints `Dashboard: http://localhost:3100`. Visiting that URL shows the placeholder React UI.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: start Express dashboard on startup with auto-open"
```

---

## Phase 2: Single Agent Chat

### Task 10: Create agents API

**Files:**
- Create: `server/api/agents.ts`

- [ ] **Step 1: Create `server/api/agents.ts`**

```typescript
import { Router } from 'express';
import { createAgent, getAgent, getAllAgents, updateAgent, deleteAgent } from '../../src/db.js';

export function agentsRouter(): Router {
  const router = Router();

  router.get('/agents', (_req, res) => {
    res.json(getAllAgents());
  });

  router.post('/agents', (req, res) => {
    const { name, model, provider, personality, tools } = req.body;
    if (!name || !model) {
      res.status(400).json({ error: 'name and model are required' });
      return;
    }
    const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agent = {
      id,
      name,
      model,
      provider: provider || 'openai_compatible',
      personality: personality || null,
      tools: JSON.stringify(tools || []),
      created_at: new Date().toISOString(),
    };
    createAgent(agent);
    res.status(201).json(agent);
  });

  router.get('/agents/:id', (req, res) => {
    const agent = getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json(agent);
  });

  router.put('/agents/:id', (req, res) => {
    const agent = getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    const { name, model, provider, personality, tools } = req.body;
    updateAgent(req.params.id, {
      ...(name !== undefined && { name }),
      ...(model !== undefined && { model }),
      ...(provider !== undefined && { provider }),
      ...(personality !== undefined && { personality }),
      ...(tools !== undefined && { tools: JSON.stringify(tools) }),
    });
    res.json(getAgent(req.params.id));
  });

  router.delete('/agents/:id', (req, res) => {
    const agent = getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    deleteAgent(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 2: Mount in `server/index.ts`**

```typescript
import { agentsRouter } from './api/agents.js';
app.use('/api', agentsRouter());
```

- [ ] **Step 3: Commit**

```bash
git add server/api/agents.ts server/index.ts
git commit -m "feat: add agents CRUD API"
```

---

### Task 11: Create chats API

**Files:**
- Create: `server/api/chats.ts`

- [ ] **Step 1: Create `server/api/chats.ts`**

```typescript
import { Router } from 'express';
import type { AppCore } from '../../src/core.js';
import { getAllChats, getRecentMessages } from '../../src/db.js';

export function chatsRouter(core: AppCore): Router {
  const router = Router();

  router.get('/chats', (req, res) => {
    const source = (req.query.source as string) || undefined;
    let chats = getAllChats();
    if (source) {
      chats = chats.filter(c => c.channel === source || c.source === source);
    }
    res.json(chats);
  });

  router.post('/chats', (req, res) => {
    const { name } = req.body;
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const jid = `dashboard:${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;
    const folder = `dashboard_${name.toLowerCase().replace(/\s+/g, '_')}`;

    core.registerGroup(jid, {
      name,
      folder,
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    });

    res.status(201).json({ jid, name, folder });
  });

  router.get('/chats/:jid/messages', (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const messages = getRecentMessages(req.params.jid, limit);
    res.json(messages);
  });

  return router;
}
```

- [ ] **Step 2: Mount in `server/index.ts`**

```typescript
import { chatsRouter } from './api/chats.js';
app.use('/api', chatsRouter(core));
```

- [ ] **Step 3: Commit**

```bash
git add server/api/chats.ts server/index.ts
git commit -m "feat: add chats API for dashboard"
```

---

### Task 12: Create dashboard channel and WebSocket handler

**Files:**
- Create: `src/channels/dashboard.ts`
- Create: `src/channels/dashboard.test.ts`
- Create: `server/ws.ts`

- [ ] **Step 1: Write dashboard channel test**

Create `src/channels/dashboard.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { DashboardChannel } from './dashboard.js';

describe('DashboardChannel', () => {
  it('implements Channel interface', () => {
    const channel = new DashboardChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });

    expect(channel.name).toBe('dashboard');
    expect(channel.isConnected()).toBe(true);
    expect(channel.ownsJid('dashboard:test')).toBe(true);
    expect(channel.ownsJid('tg:12345')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/channels/dashboard.test.ts`
Expected: FAIL

- [ ] **Step 3: Create `src/channels/dashboard.ts`**

```typescript
import type { ChannelOpts } from './registry.js';
import type { Channel, NewMessage } from '../types.js';

export type DashboardSendFn = (jid: string, text: string) => void;

export class DashboardChannel implements Channel {
  name = 'dashboard';
  private opts: ChannelOpts;
  private sendFn: DashboardSendFn | null = null;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  /** Set the function that delivers messages to WebSocket clients. */
  setSendFn(fn: DashboardSendFn): void {
    this.sendFn = fn;
  }

  async connect(): Promise<void> {
    // Dashboard is always "connected" — it's local
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (this.sendFn) {
      this.sendFn(jid, text);
    }
  }

  isConnected(): boolean {
    return true;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dashboard:');
  }

  async disconnect(): Promise<void> {
    this.sendFn = null;
  }

  async setTyping?(jid: string, isTyping: boolean): Promise<void> {
    // Handled directly via WebSocket status messages — no-op here
  }

  /** Called by the WebSocket handler when a browser sends a message. */
  handleIncomingMessage(chatJid: string, content: string): void {
    const msg: NewMessage = {
      id: `dash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chat_jid: chatJid,
      sender: 'user',
      sender_name: 'User',
      content,
      timestamp: new Date().toISOString(),
      is_from_me: true,
    };
    this.opts.onMessage(chatJid, msg);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/channels/dashboard.test.ts`
Expected: PASS

- [ ] **Step 5: Create `server/ws.ts`**

```typescript
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { AppCore } from '../src/core.js';
import type { DashboardChannel } from '../src/channels/dashboard.js';
import { storeMessageDirect } from '../src/db.js';
import { logger } from '../src/logger.js';

interface WsMessage {
  type: 'message' | 'subscribe' | 'unsubscribe';
  chatJid?: string;
  content?: string;
}

export function setupWebSocket(httpServer: Server, core: AppCore, dashboardChannel: DashboardChannel): void {
  const wss = new WebSocketServer({ noServer: true });

  // Track which JIDs each client is subscribed to
  const subscriptions = new Map<WebSocket, Set<string>>();

  // Wire the dashboard channel's send function to broadcast to subscribed clients
  dashboardChannel.setSendFn((jid: string, text: string) => {
    const message = JSON.stringify({
      type: 'message',
      chatJid: jid,
      from: 'agent',
      content: text,
      timestamp: new Date().toISOString(),
    });

    for (const [ws, subs] of subscriptions) {
      if (subs.has(jid) && ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  });

  httpServer.on('upgrade', (request, socket, head) => {
    if (request.url === '/api/chat/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    subscriptions.set(ws, new Set());

    ws.on('message', (raw) => {
      try {
        const data: WsMessage = JSON.parse(raw.toString());

        switch (data.type) {
          case 'subscribe':
            if (data.chatJid) {
              subscriptions.get(ws)!.add(data.chatJid);
            }
            break;

          case 'unsubscribe':
            if (data.chatJid) {
              subscriptions.get(ws)!.delete(data.chatJid);
            }
            break;

          case 'message':
            if (data.chatJid && data.content) {
              // Store the user message
              storeMessageDirect({
                id: `dash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                chat_jid: data.chatJid,
                sender: 'user',
                sender_name: 'User',
                content: data.content,
                timestamp: new Date().toISOString(),
                is_from_me: true,
              });

              // Route through the dashboard channel → AppCore pipeline
              dashboardChannel.handleIncomingMessage(data.chatJid, data.content);

              // Enqueue for processing
              core.queue.enqueueMessageCheck(data.chatJid);

              // Broadcast status: thinking
              const statusMsg = JSON.stringify({
                type: 'status',
                chatJid: data.chatJid,
                status: 'thinking',
              });
              for (const [client, subs] of subscriptions) {
                if (subs.has(data.chatJid) && client.readyState === WebSocket.OPEN) {
                  client.send(statusMsg);
                }
              }
            }
            break;
        }
      } catch (err) {
        logger.warn({ err }, 'Invalid WebSocket message');
      }
    });

    ws.on('close', () => {
      subscriptions.delete(ws);
    });
  });
}
```

- [ ] **Step 6: Wire WebSocket into `server/index.ts`**

Update `createApp` to accept and set up WebSocket:

```typescript
import { setupWebSocket } from './ws.js';
import { DashboardChannel } from '../src/channels/dashboard.js';
import { storeMessage, storeChatMetadata } from '../src/db.js';

export function createApp(core: AppCore): { app: express.Express; httpServer: ReturnType<typeof createServer>; dashboardChannel: DashboardChannel } {
  // ... existing app setup ...

  const httpServer = createServer(app);

  // Create dashboard channel and register it with AppCore
  const dashboardChannel = new DashboardChannel({
    onMessage: (chatJid, msg) => {
      storeMessage(msg);
    },
    onChatMetadata: (chatJid, timestamp, name, channel, isGroup) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => core.getRegisteredGroups(),
  });
  core.getChannels().push(dashboardChannel);

  // Set up WebSocket
  setupWebSocket(httpServer, core, dashboardChannel);

  return { app, httpServer, dashboardChannel };
}
```

- [ ] **Step 7: Commit**

```bash
git add src/channels/dashboard.ts src/channels/dashboard.test.ts server/ws.ts server/index.ts
git commit -m "feat: add dashboard channel and WebSocket handler for real-time chat"
```

---

### Task 13: End-to-end smoke test

**Files:** None new — manual verification

- [ ] **Step 1: Build the UI**

```bash
cd ui && npm run build && cd ..
```

- [ ] **Step 2: Start the server**

```bash
NO_OPEN=1 npm run dev
```

- [ ] **Step 3: Test health endpoint**

```bash
curl http://localhost:3100/api/health
```

Expected: `{"status":"ok","uptime":...,"channels":[{"name":"dashboard","connected":true}],...}`

- [ ] **Step 4: Test setup endpoints**

```bash
curl http://localhost:3100/api/setup
curl -X POST http://localhost:3100/api/setup -H 'Content-Type: application/json' -d '{"provider":"openai_compatible","model":"qwen2.5:14b"}'
```

Expected: `{"completed":false}` then `{"ok":true}`

- [ ] **Step 5: Test agents CRUD**

```bash
curl -X POST http://localhost:3100/api/agents -H 'Content-Type: application/json' -d '{"name":"TestBot","model":"qwen2.5:14b"}'
curl http://localhost:3100/api/agents
```

Expected: Agent created and listed

- [ ] **Step 6: Test chat creation**

```bash
curl -X POST http://localhost:3100/api/chats -H 'Content-Type: application/json' -d '{"name":"General"}'
curl http://localhost:3100/api/chats
```

Expected: Chat created with `dashboard:general-...` JID

- [ ] **Step 7: Open browser to http://localhost:3100**

Expected: Placeholder React UI renders showing server status

- [ ] **Step 8: Run full test suite**

```bash
npx vitest run
```

Expected: All tests pass (existing + new)

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: MicroClaw dashboard backend phases 0-2 complete"
```

---

## Summary of Deliverables

After completing all 13 tasks:

1. **AppCore service layer** — runtime starts with zero channels, can be driven by CLI, HTTP, or messaging
2. **Express server** — health, setup, agents, chats APIs on port 3100
3. **Dashboard channel** — first-class channel using WebSocket, writes to existing message store
4. **WebSocket handler** — real-time chat with subscribe/unsubscribe per JID
5. **Placeholder React UI** — served as static files, shows server status
6. **Database extended** — `source`/`thread_id` on messages, `agents` and `setup` tables
7. **`npx microclaw`** — starts server, opens browser automatically
8. **All existing tests still pass** — refactor is backwards compatible
