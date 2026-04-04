/**
 * Test: Dashboard message pipeline
 * Verifies that when a message comes through WebSocket,
 * processGroupMessages can pick it up and find the channel.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  _initTestDatabase,
  storeMessageDirect,
  storeChatMetadata,
  getMessagesSince,
  setRegisteredGroup,
} from '../src/db.js';
import { DashboardChannel } from '../src/channels/dashboard.js';

describe('dashboard message pipeline', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('stored dashboard message is found by getMessagesSince', () => {
    const jid = 'dashboard:test-1234';
    const timestamp = new Date().toISOString();

    // Step 1: store chat metadata (what WS handler does)
    storeChatMetadata(jid, timestamp, undefined, 'dashboard', false);

    // Step 2: store a user message (what WS handler does)
    storeMessageDirect({
      id: 'dash-msg-1',
      chat_jid: jid,
      sender: 'user',
      sender_name: 'User',
      content: 'hello',
      timestamp,
      is_from_me: true,
    });

    // Step 3: processGroupMessages calls getMessagesSince with empty cursor
    const messages = getMessagesSince(jid, '', 'Andy');
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe('hello');
  });

  it('dashboard channel ownsJid for dashboard: prefixed JIDs', () => {
    const channel = new DashboardChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });

    expect(channel.ownsJid('dashboard:test-123')).toBe(true);
    expect(channel.ownsJid('tg:12345')).toBe(false);
    expect(channel.ownsJid('discord:guild:channel')).toBe(false);
  });

  it('registered dashboard group is found by processGroupMessages prerequisites', () => {
    const jid = 'dashboard:test-1234';

    // Register group (what POST /api/chats does via core.registerGroup)
    setRegisteredGroup(jid, {
      name: 'Test',
      folder: 'dashboard_test',
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    });

    // Store message
    const timestamp = new Date().toISOString();
    storeChatMetadata(jid, timestamp, 'Test', 'dashboard', false);
    storeMessageDirect({
      id: 'dash-msg-2',
      chat_jid: jid,
      sender: 'user',
      sender_name: 'User',
      content: 'test message',
      timestamp,
      is_from_me: true,
    });

    // Verify message is retrievable
    const messages = getMessagesSince(jid, '', 'Andy');
    expect(messages.length).toBe(1);

    // Verify dashboard channel would own this JID
    const channel = new DashboardChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    expect(channel.ownsJid(jid)).toBe(true);
  });

  it('agent response reaches sendFn when client is subscribed to correct JID', () => {
    const jid = 'dashboard:sam-1234';
    const sent: Array<{ jid: string; text: string }> = [];

    const channel = new DashboardChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });

    // Set send function (what WS handler does)
    channel.setSendFn((j, t) => sent.push({ jid: j, text: t }));

    // Agent sends reply via channel.sendMessage (what processGroupMessages does)
    channel.sendMessage(jid, 'Hello from the agent!');

    // The sendFn should be called with the correct JID
    expect(sent.length).toBe(1);
    expect(sent[0].jid).toBe(jid);
    expect(sent[0].text).toBe('Hello from the agent!');
  });
});
