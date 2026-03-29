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

  // List existing registered groups — so the dashboard can show them in the sidebar
  router.get('/chats/groups', (_req, res) => {
    const groups = core.getRegisteredGroups();
    const list = Object.entries(groups).map(([jid, group]) => ({
      jid,
      name: group.name,
      folder: group.folder,
      isMain: group.isMain || false,
      requiresTrigger: group.requiresTrigger ?? true,
    }));
    res.json(list);
  });

  router.post('/chats', (req, res) => {
    const { name, existingFolder } = req.body;
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    // If linking to an existing group folder (e.g., discord_dm), use that folder
    const folder = existingFolder || `dashboard_${name.toLowerCase().replace(/\s+/g, '_')}`;

    // Reuse existing dashboard JID for this folder
    const groups = core.getRegisteredGroups();
    const existingJid = Object.keys(groups).find(
      jid => jid.startsWith('dashboard:') && groups[jid].folder === folder,
    );

    if (existingJid) {
      res.status(200).json({ jid: existingJid, name, folder });
      return;
    }

    const jid = `dashboard:${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;

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
