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

  it('sendMessage calls sendFn and returns ref', async () => {
    const channel = new DashboardChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    const sendFn = vi.fn();
    channel.setSendFn(sendFn);

    const ref = await channel.sendMessage('dashboard:test', 'hello');
    expect(sendFn).toHaveBeenCalledWith('dashboard:test', 'hello');
    expect(ref).toEqual(expect.objectContaining({ jid: 'dashboard:test' }));
  });

  it('sendMessage returns null when no sendFn', async () => {
    const channel = new DashboardChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });

    const ref = await channel.sendMessage('dashboard:test', 'hello');
    expect(ref).toBeNull();
  });

  it('handleIncomingMessage calls onMessage', () => {
    const onMessage = vi.fn();
    const channel = new DashboardChannel({
      onMessage,
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });

    channel.handleIncomingMessage('dashboard:test', 'hello world');
    expect(onMessage).toHaveBeenCalledWith(
      'dashboard:test',
      expect.objectContaining({
        chat_jid: 'dashboard:test',
        content: 'hello world',
        sender: 'user',
      }),
    );
  });

  it('disconnect clears sendFn', async () => {
    const channel = new DashboardChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    const sendFn = vi.fn();
    channel.setSendFn(sendFn);

    await channel.disconnect();

    const ref = await channel.sendMessage('dashboard:test', 'hello');
    expect(sendFn).not.toHaveBeenCalled();
    expect(ref).toBeNull();
  });
});
