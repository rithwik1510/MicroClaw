import type { ChannelOpts } from './registry.js';
import type { Channel, ChannelMessageRef, NewMessage } from '../types.js';

export type DashboardSendFn = (jid: string, text: string) => void;

export class DashboardChannel implements Channel {
  name = 'dashboard';
  private opts: ChannelOpts;
  private sendFn: DashboardSendFn | null = null;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  setSendFn(fn: DashboardSendFn): void {
    this.sendFn = fn;
  }

  async connect(): Promise<void> {
    // Dashboard is always connected — it's local
  }

  async sendMessage(
    jid: string,
    text: string,
  ): Promise<ChannelMessageRef | null> {
    if (this.sendFn) {
      this.sendFn(jid, text);
      return { id: `dash-out-${Date.now()}`, jid };
    }
    return null;
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

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Handled via WebSocket status messages — no-op here
  }

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
