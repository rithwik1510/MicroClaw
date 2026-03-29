import { Router } from 'express';
import type { AppCore } from '../../src/core.js';

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
