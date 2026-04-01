import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import type { AppCore } from '../src/core.js';
import { healthRouter } from './api/health.js';
import { errorHandler } from './middleware.js';

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
    const indexPath = path.join(uiDistPath, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) {
        res.status(200).send('MicroClaw Dashboard - UI not built yet. Run: cd ui && npm run build');
      }
    });
  });

  app.use(errorHandler);

  const httpServer = createServer(app);
  return { app, httpServer };
}

export async function startServer(core: AppCore, port: number): Promise<ReturnType<typeof createServer>> {
  const { httpServer } = createApp(core);

  return new Promise((resolve) => {
    httpServer.listen(port, '127.0.0.1', () => {
      resolve(httpServer);
    });
  });
}
