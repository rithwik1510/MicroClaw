import { Router } from 'express';
import type { AppCore } from '../../src/core.js';
import { getAllChats, getRecentMessages } from '../../src/db.js';

export function chatsRouter(core: AppCore): Router {
  const router = Router();

  router.get('/chats', (req, res) => {
    const source = req.query.source as string | undefined;
    let chats = getAllChats();
    if (source) {
      chats = chats.filter((c: any) => c.channel === source || c.source === source);
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
