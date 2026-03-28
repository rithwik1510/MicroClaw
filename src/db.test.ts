import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  acquireAuthRefreshLock,
  getPinnedMemoryEntries,
  insertMemoryEntry,
  queryMemoryFts,
  deleteAuthProfile,
  deleteLocalEndpointProfile,
  createTask,
  deleteWizardSession,
  getAllAuthProfiles,
  getAllLocalEndpointProfiles,
  getAllRuntimeProfiles,
  getAuthProfile,
  getConversationSummary,
  getGroupRuntimePolicy,
  getLatestActiveWizardSession,
  getProviderCapability,
  getRuntimeEvents,
  getWizardSession,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getMessagesSince,
  getRecentMessages,
  getNewMessages,
  logRuntimeEvent,
  setGroupRuntimePolicy,
  setRuntimeProfile,
  getTaskById,
  setRegisteredGroup,
  setAuthProfile,
  setLocalEndpointProfile,
  setProviderCapability,
  setWizardSession,
  releaseAuthRefreshLock,
  setConversationSummary,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
  updateTask,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

describe('getRecentMessages', () => {
  it('returns recent messages including bot replies in chronological order', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    store({
      id: 'r1',
      chat_jid: 'group@g.us',
      sender: 'alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    storeMessageDirect({
      id: 'r2',
      chat_jid: 'group@g.us',
      sender: 'Andy',
      sender_name: 'Andy',
      content: 'hi there',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: true,
      is_bot_message: true,
    });
    store({
      id: 'r3',
      chat_jid: 'group@g.us',
      sender: 'alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'follow up',
      timestamp: '2024-01-01T00:00:03.000Z',
    });

    const recent = getRecentMessages('group@g.us', 3);
    expect(recent.map((m) => m.content)).toEqual([
      'hello',
      'hi there',
      'follow up',
    ]);
    expect(recent[1].is_bot_message).toBe(1 as unknown as boolean);
  });
});

describe('conversation summary storage', () => {
  it('stores and retrieves a persistent summary for a group', () => {
    setConversationSummary({
      groupFolder: 'discord_main',
      summary: '- User wants MicroClaw to preserve continuity across turns.',
      sourceMessageCount: 12,
      lastMessageTimestamp: '2026-03-06T10:00:00.000Z',
    });

    const summary = getConversationSummary('discord_main');
    expect(summary).toBeDefined();
    expect(summary?.summary).toContain('preserve continuity');
    expect(summary?.sourceMessageCount).toBe(12);
    expect(summary?.lastMessageTimestamp).toBe('2026-03-06T10:00:00.000Z');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      requested_prompt: 'At 9 AM, do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.requested_prompt).toBe('At 9 AM, do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp reflects latest returned row
    expect(newTimestamp).toBe('2024-01-01T00:00:10.000Z');
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

describe('runtime profile storage', () => {
  it('stores and retrieves runtime profiles in priority order', () => {
    setRuntimeProfile({
      id: 'claude-default',
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      enabled: true,
      priority: 10,
    });

    setRuntimeProfile({
      id: 'openai-fallback',
      provider: 'openai_compatible',
      model: 'gpt-4.1-mini',
      enabled: true,
      priority: 20,
    });

    const profiles = getAllRuntimeProfiles();
    expect(profiles).toHaveLength(2);
    expect(profiles[0].id).toBe('claude-default');
    expect(profiles[1].id).toBe('openai-fallback');
  });

  it('stores and retrieves runtime profile tool policy', () => {
    setRuntimeProfile({
      id: 'openai-web-off',
      provider: 'openai_compatible',
      model: 'gpt-4.1-mini',
      enabled: true,
      priority: 5,
      toolPolicy: {
        web: {
          enabled: false,
          maxSteps: 4,
        },
      },
    });

    const profiles = getAllRuntimeProfiles();
    expect(profiles[0].toolPolicy?.web?.enabled).toBe(false);
    expect(profiles[0].toolPolicy?.web?.maxSteps).toBe(4);
  });

  it('stores and retrieves group runtime policy', () => {
    setGroupRuntimePolicy({
      groupFolder: 'whatsapp_main',
      primaryProfileId: 'claude-default',
      fallbackProfileIds: ['openai-fallback'],
      retryPolicy: {
        maxAttempts: 2,
        backoffMs: 1000,
        retryableErrors: ['timeout'],
        timeoutMs: 60000,
      },
    });

    const policy = getGroupRuntimePolicy('whatsapp_main');
    expect(policy).toBeDefined();
    expect(policy!.primaryProfileId).toBe('claude-default');
    expect(policy!.fallbackProfileIds).toEqual(['openai-fallback']);
    expect(policy!.retryPolicy?.maxAttempts).toBe(2);
  });

  it('stores and retrieves runtime events', () => {
    logRuntimeEvent({
      id: 'evt-1',
      groupFolder: 'whatsapp_main',
      chatJid: '123@s.whatsapp.net',
      profileId: 'claude-default',
      provider: 'claude',
      eventType: 'attempt',
      message: 'Attempting runtime',
      timestamp: '2024-01-01T00:00:00.000Z',
    });

    const events = getRuntimeEvents('whatsapp_main');
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('evt-1');
    expect(events[0].eventType).toBe('attempt');
  });
});

describe('auth profile storage', () => {
  it('stores and retrieves auth profile metadata', () => {
    setAuthProfile({
      id: 'auth-1',
      provider: 'openai_compatible',
      credentialType: 'api_key',
      accountLabel: 'work-account',
      scopes: ['inference'],
      tokenType: 'Bearer',
      refreshEligible: true,
      providerAccountId: 'acct_123',
      riskLevel: 'standard',
      status: 'active',
    });

    const row = getAuthProfile('auth-1');
    expect(row).toBeDefined();
    expect(row!.provider).toBe('openai_compatible');
    expect(row!.scopes).toEqual(['inference']);
    expect(row!.providerAccountId).toBe('acct_123');
    expect(row!.refreshEligible).toBe(true);
    expect(getAllAuthProfiles()).toHaveLength(1);
  });

  it('deletes auth profile', () => {
    setAuthProfile({
      id: 'auth-2',
      provider: 'openai_compatible',
      credentialType: 'api_key',
      status: 'active',
    });
    deleteAuthProfile('auth-2');
    expect(getAuthProfile('auth-2')).toBeUndefined();
  });
});

describe('local endpoint and capability cache storage', () => {
  it('stores local endpoint profile', () => {
    setLocalEndpointProfile({
      id: 'local-1',
      engine: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKeyMode: 'none',
      containerReachableUrl: 'http://host.docker.internal:1234/v1',
      healthStatus: 'healthy',
    });
    const rows = getAllLocalEndpointProfiles();
    expect(rows).toHaveLength(1);
    expect(rows[0].engine).toBe('lmstudio');

    deleteLocalEndpointProfile('local-1');
    expect(getAllLocalEndpointProfiles()).toHaveLength(0);
  });

  it('stores provider capability cache', () => {
    setProviderCapability(
      'openai_compatible',
      'http://host.docker.internal:1234/v1',
      {
        supportsResponses: true,
        supportsChatCompletions: true,
        supportsTools: false,
        supportsStreaming: true,
        requiresApiKey: false,
        checkedAt: '2026-01-01T00:00:00.000Z',
      },
    );
    const cap = getProviderCapability(
      'openai_compatible',
      'http://host.docker.internal:1234/v1',
    );
    expect(cap).toBeDefined();
    expect(cap!.supportsResponses).toBe(true);
  });
});

describe('wizard and refresh lock storage', () => {
  it('stores and retrieves wizard sessions', () => {
    setWizardSession({
      sessionId: 'wiz-1',
      status: 'active',
      currentStep: 'model_provider',
      stateJson: { provider: 'openai_compatible' },
    });

    const session = getWizardSession('wiz-1');
    expect(session).toBeDefined();
    expect(session!.currentStep).toBe('model_provider');

    const latest = getLatestActiveWizardSession();
    expect(latest?.sessionId).toBe('wiz-1');

    deleteWizardSession('wiz-1');
    expect(getWizardSession('wiz-1')).toBeUndefined();
  });

  it('acquires and releases refresh lock', () => {
    const first = acquireAuthRefreshLock({
      authProfileId: 'auth-1',
      owner: 'worker-a',
      ttlMs: 10000,
    });
    const second = acquireAuthRefreshLock({
      authProfileId: 'auth-1',
      owner: 'worker-b',
      ttlMs: 10000,
    });
    expect(first).toBe(true);
    expect(second).toBe(false);

    releaseAuthRefreshLock('auth-1', 'worker-a');
    const third = acquireAuthRefreshLock({
      authProfileId: 'auth-1',
      owner: 'worker-c',
      ttlMs: 10000,
    });
    expect(third).toBe(true);
  });
});

// --- Memory FTS5 (insertMemoryEntry, queryMemoryFts, getPinnedMemoryEntries) ---

function memEntry(
  overrides: Partial<Parameters<typeof insertMemoryEntry>[0]> & {
    content: string;
  },
) {
  return insertMemoryEntry({
    group_folder: 'test_group',
    scope: 'group',
    kind: 'fact',
    source: 'auto',
    created_at: new Date().toISOString(),
    ...overrides,
  });
}

describe('insertMemoryEntry', () => {
  it('inserts an entry and returns its id', () => {
    const id = memEntry({ content: 'user prefers dark mode', kind: 'pref' });
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('deduplicates normalized content — strips leading pronoun', () => {
    memEntry({ content: 'I prefer dark mode', kind: 'pref' });
    memEntry({ content: 'prefer dark mode', kind: 'pref' });
    // both normalize to "prefer dark mode" — only one entry
    const results = queryMemoryFts({
      groupFolder: 'test_group',
      keywords: ['dark'],
    });
    expect(results).toHaveLength(1);
  });

  it('upgrades an existing entry to pinned when a duplicate with pin:true is inserted', () => {
    memEntry({ content: 'prefer dark mode', kind: 'pref', source: 'explicit' });
    memEntry({
      content: 'prefer dark mode',
      kind: 'pref',
      source: 'explicit',
      pinned: true,
    });
    const pinned = getPinnedMemoryEntries('test_group');
    expect(pinned).toHaveLength(1);
    expect(pinned[0].content).toBe('prefer dark mode');
  });

  it('does not downgrade a pinned entry when same content re-inserted without pin', () => {
    memEntry({
      content: 'prefer dark mode',
      kind: 'pref',
      source: 'explicit',
      pinned: true,
    });
    memEntry({
      content: 'prefer dark mode',
      kind: 'pref',
      source: 'explicit',
      pinned: false,
    });
    const pinned = getPinnedMemoryEntries('test_group');
    expect(pinned).toHaveLength(1); // still pinned
  });

  it('isolates entries by group_folder', () => {
    memEntry({ group_folder: 'group_a', content: 'fact about cooking' });
    memEntry({ group_folder: 'group_b', content: 'fact about cooking' });
    // same content but different groups — both stored
    const a = queryMemoryFts({ groupFolder: 'group_a', keywords: ['cooking'] });
    const b = queryMemoryFts({ groupFolder: 'group_b', keywords: ['cooking'] });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});

describe('queryMemoryFts', () => {
  it('returns empty array when keywords list is empty', () => {
    memEntry({ content: 'something interesting' });
    expect(
      queryMemoryFts({ groupFolder: 'test_group', keywords: [] }),
    ).toHaveLength(0);
  });

  it('returns matching entries for keywords', () => {
    memEntry({ content: 'user enjoys cooking Italian food', kind: 'fact' });
    memEntry({ content: 'user prefers dark mode', kind: 'pref' });
    const results = queryMemoryFts({
      groupFolder: 'test_group',
      keywords: ['cooking', 'italian'],
    });
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('cooking');
  });

  it('excludes pinned entries (they are returned separately)', () => {
    memEntry({
      content: 'always use metric units',
      kind: 'pref',
      source: 'explicit',
      pinned: true,
    });
    memEntry({
      content: 'metric is better than imperial',
      kind: 'fact',
      source: 'auto',
    });
    const results = queryMemoryFts({
      groupFolder: 'test_group',
      keywords: ['metric'],
    });
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('better than imperial'); // pinned entry excluded
  });

  it('ranks explicit source entries above auto for same keyword match', () => {
    memEntry({
      content: 'fridgechef cooking project notes',
      kind: 'proj',
      source: 'auto',
    });
    memEntry({
      content: 'fridgechef uses local models',
      kind: 'proj',
      source: 'explicit',
    });
    const results = queryMemoryFts({
      groupFolder: 'test_group',
      keywords: ['fridgechef'],
    });
    expect(results).toHaveLength(2);
    expect(results[0].source).toBe('explicit'); // boosted rank comes first
  });

  it('ranks recent entries above equally relevant old entries after decay', () => {
    insertMemoryEntry({
      group_folder: 'test_group',
      scope: 'group',
      kind: 'fact',
      content: 'project uses supabase edge functions',
      source: 'auto',
      created_at: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    });
    insertMemoryEntry({
      group_folder: 'test_group',
      scope: 'group',
      kind: 'fact',
      content: 'project uses supabase edge functions today',
      source: 'auto',
      created_at: new Date().toISOString(),
    });

    const results = queryMemoryFts({
      groupFolder: 'test_group',
      keywords: ['supabase', 'edge'],
    });
    expect(results).toHaveLength(2);
    expect(results[0].content).toContain('today');
    expect(results[0].rank).toBeLessThan(results[1].rank);
  });

  it('keeps recent explicit memories above older explicit memories', () => {
    insertMemoryEntry({
      group_folder: 'test_group',
      scope: 'group',
      kind: 'proj',
      content: 'microclaw runtime uses local models older',
      source: 'explicit',
      created_at: new Date(Date.now() - 45 * 86_400_000).toISOString(),
    });
    insertMemoryEntry({
      group_folder: 'test_group',
      scope: 'group',
      kind: 'proj',
      content: 'microclaw runtime uses local models recent',
      source: 'explicit',
      created_at: new Date().toISOString(),
    });

    const results = queryMemoryFts({
      groupFolder: 'test_group',
      keywords: ['microclaw', 'runtime', 'local'],
    });
    expect(results).toHaveLength(2);
    expect(results[0].content).toContain('recent');
    expect(results[0].source).toBe('explicit');
  });

  it('documents the negative-rank decay math explicitly', () => {
    insertMemoryEntry({
      group_folder: 'test_group',
      scope: 'group',
      kind: 'fact',
      content: 'api token is stored in env old copy',
      source: 'explicit',
      created_at: new Date(Date.now() - 90 * 86_400_000).toISOString(),
    });
    insertMemoryEntry({
      group_folder: 'test_group',
      scope: 'group',
      kind: 'fact',
      content: 'api token is stored in env fresh copy',
      source: 'explicit',
      created_at: new Date().toISOString(),
    });

    const results = queryMemoryFts({
      groupFolder: 'test_group',
      keywords: ['token', 'stored', 'env'],
    });
    expect(results).toHaveLength(2);
    // BM25 rank is negative. Old rank * decayFactor(<1) becomes less negative,
    // so it sorts lower in ascending order. That drop is the intended behavior.
    expect(results[0].content).toContain('fresh');
    expect(results[1].content).toContain('old');
    expect(results[1].rank).toBeGreaterThan(results[0].rank);
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      memEntry({
        content: `project note about cooking number ${i}`,
        kind: 'proj',
      });
    }
    const results = queryMemoryFts({
      groupFolder: 'test_group',
      keywords: ['cooking'],
      limit: 3,
    });
    expect(results).toHaveLength(3);
  });

  it('returns empty gracefully when no entries match', () => {
    memEntry({ content: 'user prefers dark mode' });
    const results = queryMemoryFts({
      groupFolder: 'test_group',
      keywords: ['completely', 'unrelated', 'term'],
    });
    expect(results).toHaveLength(0);
  });

  it('handles FTS5 special characters in keywords without throwing', () => {
    memEntry({ content: 'test entry for special chars' });
    // These chars would break raw FTS5 MATCH — our sanitizer should handle them
    expect(() =>
      queryMemoryFts({
        groupFolder: 'test_group',
        keywords: ['"quoted"', 'star*', 'caret^'],
      }),
    ).not.toThrow();
  });
});

describe('getPinnedMemoryEntries', () => {
  it('returns only pinned entries for a group', () => {
    memEntry({ content: 'not pinned', kind: 'fact' });
    memEntry({
      content: 'pinned fact',
      kind: 'fact',
      source: 'explicit',
      pinned: true,
    });
    const pinned = getPinnedMemoryEntries('test_group');
    expect(pinned).toHaveLength(1);
    expect(pinned[0].content).toBe('pinned fact');
  });

  it('caps results at 5 regardless of how many are pinned', () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 8; i++) {
      insertMemoryEntry({
        group_folder: 'test_group',
        scope: 'group',
        kind: 'fact',
        content: `pinned entry unique text ${i}`,
        source: 'explicit',
        created_at: now,
        pinned: true,
      });
    }
    const pinned = getPinnedMemoryEntries('test_group');
    expect(pinned).toHaveLength(5);
  });

  it('returns empty array when no pinned entries exist', () => {
    memEntry({ content: 'regular entry', kind: 'fact' });
    expect(getPinnedMemoryEntries('test_group')).toHaveLength(0);
  });

  it('does not return pinned entries from other groups', () => {
    memEntry({
      group_folder: 'group_a',
      content: 'pinned for group a',
      source: 'explicit',
      pinned: true,
    });
    expect(getPinnedMemoryEntries('group_b')).toHaveLength(0);
  });
});
