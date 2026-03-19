import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  Partials,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  ChannelMessageRef,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

function splitDiscordMessage(text: string, maxLength = 2000): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  if (normalized.length <= maxLength) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLength);
    if (splitAt < Math.floor(maxLength * 0.5)) {
      splitAt = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitAt < Math.floor(maxLength * 0.5)) {
      splitAt = Math.max(
        remaining.lastIndexOf('. ', maxLength),
        remaining.lastIndexOf('! ', maxLength),
        remaining.lastIndexOf('? ', maxLength),
      );
      if (splitAt > 0) splitAt += 1;
    }
    if (splitAt < Math.floor(maxLength * 0.5)) {
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt <= 0) {
      splitAt = maxLength;
    }

    const nextChunk = remaining.slice(0, splitAt).trim();
    if (nextChunk) chunks.push(nextChunk);
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private unregisteredNoticeAt = new Map<string, number>();

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  private shouldSendUnregisteredNotice(chatJid: string): boolean {
    const now = Date.now();
    const last = this.unregisteredNoticeAt.get(chatJid) || 0;
    const cooldownMs = 5 * 60 * 1000;
    if (now - last < cooldownMs) return false;
    this.unregisteredNoticeAt.set(chatJid, now);
    return true;
  }

  private async warnIfMessageContentIntentLimited(): Promise<void> {
    try {
      const res = await fetch('https://discord.com/api/v10/applications/@me', {
        headers: {
          Authorization: `Bot ${this.botToken}`,
        },
      });
      if (!res.ok) return;
      const app = (await res.json()) as { flags?: number };
      const flags = app.flags || 0;
      const gatewayMessageContent = (flags & 262144) !== 0;
      const gatewayMessageContentLimited = (flags & 524288) !== 0;
      if (!gatewayMessageContent && gatewayMessageContentLimited) {
        logger.warn(
          'Discord Message Content intent is LIMITED. For reliable replies, @mention the bot in messages, or enable full Message Content intent in Discord Developer Portal.',
        );
      }
    } catch {
      // Non-fatal diagnostic check only.
    }
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      logger.info(
        {
          channelId: message.channelId,
          guildId: message.guildId,
          authorId: message.author.id,
          authorBot: message.author.bot,
          contentLength: message.content?.length || 0,
        },
        'Discord messageCreate received',
      );

      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Lightweight diagnostics commands that work before registration.
      let commandText = content.trim();
      if (this.client?.user) {
        const botId = this.client.user.id;
        commandText = commandText
          .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
          .trim();
      }
      const command = commandText.toLowerCase();
      if (command === '/chatid' || command === '!chatid') {
        const isRegistered = Boolean(this.opts.registeredGroups()[chatJid]);
        const payload = [
          `channel_id=${channelId}`,
          `jid=${chatJid}`,
          `registered=${isRegistered ? 'yes' : 'no'}`,
        ].join('\n');
        try {
          await message.reply(payload);
        } catch {
          try {
            await (message.channel as TextChannel).send(payload);
          } catch {
            // ignore
          }
        }
        return;
      }
      if (command === '/ping' || command === '!ping') {
        try {
          await message.reply('pong');
        } catch {
          try {
            await (message.channel as TextChannel).send('pong');
          } catch {
            // ignore
          }
        }
        return;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          },
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.warn(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        if (this.shouldSendUnregisteredNotice(chatJid)) {
          const help =
            'This Discord channel is not registered in MicroClaw yet. Run onboarding or register this channel ID, then try again.';
          try {
            await message.reply(help);
          } catch {
            try {
              await (message.channel as TextChannel).send(help);
            } catch {
              // ignore
            }
          }
        }
        return;
      }

      // When Message Content intent is limited, content can be empty for guild
      // messages. Reply immediately with guidance instead of forwarding a blank
      // placeholder to the model.
      if (!content.trim()) {
        const guidance =
          'I could not read that message content. Please @mention me in this channel, or enable Message Content intent in Discord Developer Portal.';
        try {
          await message.reply(guidance);
        } catch {
          try {
            await (message.channel as TextChannel).send(guidance);
          } catch {
            // ignore
          }
        }
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve, reject) => {
      const onReady = (readyClient: Client<true>) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        void this.warnIfMessageContentIntentLimited();
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      };

      this.client!.once(Events.ClientReady, onReady);
      this.client!.login(this.botToken).catch((err: unknown) => {
        this.client?.removeListener(Events.ClientReady, onReady);
        const msg = err instanceof Error ? err.message : String(err);
        const normalized = msg.toLowerCase();
        if (
          normalized.includes('invalid token') ||
          normalized.includes('tokeninvalid')
        ) {
          reject(
            new Error(
              'Discord authentication failed: DISCORD_BOT_TOKEN is invalid. Use the bot token from Discord Developer Portal (without "Bot " prefix), update .env, then restart MicroClaw.',
            ),
          );
          return;
        }
        reject(new Error(`Discord connection failed: ${msg}`));
      });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
  ): Promise<ChannelMessageRef | null> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return null;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return null;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed
      const chunks = splitDiscordMessage(text, 2000);
      let firstMessage: Message | null = null;
      for (const chunk of chunks) {
        const sent = await textChannel.send(chunk);
        firstMessage ||= sent;
      }
      logger.info(
        { jid, length: text.length, chunkCount: chunks.length },
        'Discord message sent',
      );
      return firstMessage ? { id: firstMessage.id, jid } : null;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
      return null;
    }
  }

  async updateMessage(
    jid: string,
    ref: ChannelMessageRef,
    text: string,
  ): Promise<void> {
    if (!this.client) return;
    if (text.length > 2000) {
      throw new Error('Discord message edit exceeds 2000 characters');
    }
    const channelId = jid.replace(/^dc:/, '');
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) {
      throw new Error('Discord channel not found for message edit');
    }
    const message = await (channel as TextChannel).messages.fetch(ref.id);
    await message.edit(text);
  }

  async deleteMessage(jid: string, ref: ChannelMessageRef): Promise<void> {
    if (!this.client) return;
    const channelId = jid.replace(/^dc:/, '');
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) return;
    const message = await (channel as TextChannel).messages.fetch(ref.id);
    await message.delete().catch(() => undefined);
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const rawToken =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  const token = rawToken.trim().replace(/^['"]|['"]$/g, '');
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  if (/\s/.test(token)) {
    logger.warn(
      'Discord: DISCORD_BOT_TOKEN contains whitespace; verify .env formatting.',
    );
  }
  return new DiscordChannel(token, opts);
});
