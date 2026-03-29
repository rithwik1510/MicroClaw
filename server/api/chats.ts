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

  // List groups for the dashboard sidebar — deduplicated by folder
  router.get('/chats/groups', (_req, res) => {
    const groups = core.getRegisteredGroups();
    const seen = new Set<string>();
    const list: Array<{ jid: string; name: string; folder: string; isMain: boolean }> = [];

    for (const [jid, group] of Object.entries(groups)) {
      // Skip if we already have this folder (prefer non-dashboard JIDs)
      if (seen.has(group.folder)) continue;
      seen.add(group.folder);

      // Skip empty/orphan dashboard groups with no real data
      if (jid.startsWith('dashboard:') && !Object.values(groups).some(
        g => !g.folder.startsWith('dashboard_') || g.folder === group.folder,
      )) continue;

      list.push({
        jid,
        name: group.name,
        folder: group.folder,
        isMain: group.isMain || false,
      });
    }

    res.json(list);
  });

  router.post('/chats', (req, res) => {
    const { name, existingFolder } = req.body;
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

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
