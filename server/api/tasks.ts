import { Router } from 'express';
import { getAllTasks, updateTask, deleteTask } from '../../src/db.js';

export function tasksRouter(): Router {
  const router = Router();

  router.get('/tasks', (req, res) => {
    const group = req.query.group as string | undefined;
    let tasks = getAllTasks();
    if (group) {
      tasks = tasks.filter(t => t.group_folder === group);
    }
    res.json(tasks);
  });

  router.patch('/tasks/:id/status', (req, res) => {
    const { status } = req.body as { status: string };
    if (!['active', 'paused', 'cancelled'].includes(status)) {
      res.status(400).json({ error: 'Invalid status. Must be active, paused, or cancelled.' });
      return;
    }
    updateTask(req.params.id, { status: status as any });
    res.json({ ok: true });
  });

  router.delete('/tasks/:id', (req, res) => {
    deleteTask(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
