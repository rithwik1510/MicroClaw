import { Router } from 'express';
import { createAgent, getAgent, getAllAgents, updateAgent, deleteAgent } from '../../src/db.js';

export function agentsRouter(): Router {
  const router = Router();

  router.get('/agents', (_req, res) => {
    res.json(getAllAgents());
  });

  router.post('/agents', (req, res) => {
    const { name, model, provider, personality, tools } = req.body;
    if (!name || !model) {
      res.status(400).json({ error: 'name and model are required' });
      return;
    }
    const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agent = {
      id,
      name,
      model,
      provider: provider || 'openai_compatible',
      personality: personality || null,
      tools: JSON.stringify(tools || []),
      created_at: new Date().toISOString(),
    };
    createAgent(agent);
    res.status(201).json(agent);
  });

  router.get('/agents/:id', (req, res) => {
    const agent = getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json(agent);
  });

  router.put('/agents/:id', (req, res) => {
    const agent = getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    const { name, model, provider, personality, tools } = req.body;
    updateAgent(req.params.id, {
      ...(name !== undefined && { name }),
      ...(model !== undefined && { model }),
      ...(provider !== undefined && { provider }),
      ...(personality !== undefined && { personality }),
      ...(tools !== undefined && { tools: JSON.stringify(tools) }),
    });
    res.json(getAgent(req.params.id));
  });

  router.delete('/agents/:id', (req, res) => {
    const agent = getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    deleteAgent(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
