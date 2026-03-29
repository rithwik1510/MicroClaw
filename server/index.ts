import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import type { AppCore } from '../src/core.js';
import { healthRouter } from './api/health.js';
import { agentsRouter } from './api/agents.js';
import { chatsRouter } from './api/chats.js';
import { errorHandler } from './middleware.js';
import { DashboardChannel } from '../src/channels/dashboard.js';
import { setupWebSocket } from './ws.js';
import { storeMessage, storeChatMetadata } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(core: AppCore): {
  app: express.Express;
  httpServer: ReturnType<typeof createServer>;
  dashboardChannel: DashboardChannel;
} {
  const app = express();
  app.use(express.json());

  // API routes
  app.use('/api', healthRouter(core));
  app.use('/api', agentsRouter());
  app.use('/api', chatsRouter(core));

  // Serve static UI (pre-built React app)
  const uiDistPath = path.resolve(__dirname, '../ui/dist');
  app.use(express.static(uiDistPath));

  // SPA fallback — serve index.html for all non-API routes
  app.get('*', (_req, res) => {
    const indexPath = path.join(uiDistPath, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) {
        res.status(200).send('MicroClaw Dashboard - UI not built yet. Run: cd ui && npm run build');
      }
    });
  });

  app.use(errorHandler);

  // Create dashboard channel and register it with the core
  const dashboardChannel = new DashboardChannel({
    onMessage: (_chatJid, msg) => {
      storeMessage(msg);
    },
    onChatMetadata: (chatJid, timestamp, name, channel, isGroup) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => core.getRegisteredGroups(),
  });
  core.getChannels().push(dashboardChannel);

  const httpServer = createServer(app);

  // Wire WebSocket handler for real-time dashboard chat
  setupWebSocket(httpServer, core, dashboardChannel);

  return { app, httpServer, dashboardChannel };
}

export async function startServer(core: AppCore, port: number): Promise<ReturnType<typeof createServer>> {
  const { httpServer } = createApp(core);

  return new Promise((resolve) => {
    httpServer.listen(port, '127.0.0.1', () => {
      resolve(httpServer);
    });
  });
}
