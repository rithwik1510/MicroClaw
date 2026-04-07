import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from '../../src/config.js';

const ALLOWED_FILES = [
  'SOUL.md',
  'STYLE.md',
  'IDENTITY.md',
  'USER.md',
  'TOOLS.md',
  'MOPUS.md',
  'HEARTBEAT.md',
];

const FILE_DESCRIPTIONS: Record<string, string> = {
  'SOUL.md': 'Who you are',
  'STYLE.md': 'How you write',
  'IDENTITY.md': 'Role & mission',
  'USER.md': 'About the user',
  'TOOLS.md': 'Tool usage',
  'MOPUS.md': 'Operating pattern',
  'HEARTBEAT.md': 'Periodic checks',
};

export function personaRouter(): Router {
  const router = Router();
  const globalDir = path.join(GROUPS_DIR, 'global');

  router.get('/persona', (_req, res) => {
    const files = ALLOWED_FILES.map(filename => {
      const filePath = path.join(globalDir, filename);
      let content = '';
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        // File doesn't exist yet — return empty
      }
      return {
        filename,
        description: FILE_DESCRIPTIONS[filename] || filename,
        content,
      };
    });
    res.json(files);
  });

  router.put('/persona/:filename', (req, res) => {
    const { filename } = req.params;
    const { content } = req.body;

    if (!ALLOWED_FILES.includes(filename)) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    if (typeof content !== 'string') {
      res.status(400).json({ error: 'Content must be a string' });
      return;
    }

    if (content.length > 50_000) {
      res.status(400).json({ error: 'Content too large (max 50KB)' });
      return;
    }

    const filePath = path.join(globalDir, filename);
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');

    res.json({ ok: true });
  });

  return router;
}
