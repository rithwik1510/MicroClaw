import { Router } from 'express';
import { getLessonsForGroup, dismissLesson } from '../../src/db.js';

export function lessonsRouter(): Router {
  const router = Router();

  router.get('/lessons/:groupFolder', (req, res) => {
    const limit = parseInt(req.query.limit as string) || 20;
    const lessons = getLessonsForGroup(req.params.groupFolder, limit);
    res.json(lessons);
  });

  router.delete('/lessons/:id', (req, res) => {
    dismissLesson(parseInt(req.params.id, 10));
    res.json({ ok: true });
  });

  return router;
}
