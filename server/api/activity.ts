import { Router } from 'express';
import { getActivityFeed, getDailySummary } from '../../src/db.js';

export function activityRouter(): Router {
  const router = Router();

  router.get('/activity', (req, res) => {
    const group = req.query.group as string | undefined;
    const type = req.query.type ? (req.query.type as string).split(',') : undefined;
    const status = req.query.status as string | undefined;
    const since = req.query.since as string | undefined;
    const until = req.query.until as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const entries = getActivityFeed({ group, type, status, since, until, limit, offset });
    res.json(entries);
  });

  router.get('/activity/summary', (req, res) => {
    const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
    const summary = getDailySummary(date);
    res.json(summary);
  });

  return router;
}
