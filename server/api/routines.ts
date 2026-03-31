import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { detectRoutinePatterns, dismissRoutine } from '../../src/db.js';
import { GROUPS_DIR } from '../../src/config.js';

export function routinesRouter(): Router {
  const router = Router();

  router.get('/routines/:groupFolder', (req, res) => {
    const patterns = detectRoutinePatterns(req.params.groupFolder);
    res.json(patterns);
  });

  router.post('/routines/:groupFolder/automate', (req, res) => {
    const { groupFolder } = req.params;
    const { description } = req.body as { description: string };
    const filePath = path.join(GROUPS_DIR, groupFolder, 'HEARTBEAT.md');

    let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '# Heartbeat Checklist\n';

    if (!content.includes('## Automated')) {
      content += '\n## Automated\n';
    }
    content += `- ${description}\n`;

    const dirPath = path.join(GROUPS_DIR, groupFolder);
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    res.json({ ok: true });
  });

  router.post('/routines/:groupFolder/dismiss', (req, res) => {
    const { groupFolder } = req.params;
    const { keywords } = req.body as { keywords: string };
    dismissRoutine(groupFolder, keywords);
    res.json({ ok: true });
  });

  return router;
}
