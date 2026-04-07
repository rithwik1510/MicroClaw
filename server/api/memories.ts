import { Router } from 'express';
import { getMemoryEntries, updateMemoryContent, deleteMemoryEntry, toggleMemoryPin } from '../../src/db.js';

export function memoriesRouter(): Router {
  const router = Router();

  router.get('/memories', (req, res) => {
    const group = req.query.group as string | undefined;
    const kind = req.query.kind as string | undefined;
    const query = req.query.q as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const entries = getMemoryEntries({ group, kind, query, limit, offset });
    res.json(entries);
  });

  router.put('/memories/:id', (req, res) => {
    const { content } = req.body as { content: string };
    updateMemoryContent(parseInt(req.params.id, 10), content);
    res.json({ ok: true });
  });

  router.delete('/memories/:id', (req, res) => {
    deleteMemoryEntry(parseInt(req.params.id, 10));
    res.json({ ok: true });
  });

  router.patch('/memories/:id/pin', (req, res) => {
    const { pinned } = req.body as { pinned: boolean };
    toggleMemoryPin(parseInt(req.params.id, 10), pinned);
    res.json({ ok: true });
  });

  return router;
}
