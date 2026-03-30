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
  const subscriptions = new Map<WebSocket, Set<string>>();

  // Wire dashboard channel's send function to broadcast to subscribed WS clients
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

              // Route through the dashboard channel -> AppCore pipeline
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
