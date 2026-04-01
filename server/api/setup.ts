import { Router } from 'express';
import { getSetupValue, setSetupValue } from '../../src/db.js';

export function setupRouter(): Router {
  const router = Router();

  router.get('/setup', (_req, res) => {
    const completed = getSetupValue('onboarding_completed') === 'true';
    res.json({ completed });
  });

  router.post('/setup', (req, res) => {
    const { provider, model, apiKey, baseUrl } = req.body;

    if (!provider || !model) {
      res.status(400).json({ error: 'provider and model are required' });
      return;
    }

    setSetupValue('provider', provider);
    setSetupValue('model', model);
    if (apiKey) setSetupValue('api_key', apiKey);
    if (baseUrl) setSetupValue('base_url', baseUrl);
    setSetupValue('onboarding_completed', 'true');

    res.json({ ok: true });
  });

  router.post('/setup/test-connection', async (req, res) => {
    const { provider, model, apiKey, baseUrl } = req.body;

    if (!provider || !model) {
      res.status(400).json({ error: 'provider and model are required' });
      return;
    }

    try {
      const url = baseUrl || 'http://localhost:11434/v1';
      const response = await fetch(`${url}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        res.json({ ok: true, message: 'Connection successful' });
      } else {
        res.json({ ok: false, message: `Provider returned HTTP ${response.status}` });
      }
    } catch (err) {
      res.json({ ok: false, message: `Could not reach endpoint: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  return router;
}
