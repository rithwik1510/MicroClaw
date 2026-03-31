import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import type { AppCore } from '../../src/core.js';
import { GROUPS_DIR, HEARTBEAT_INTERVAL, HEARTBEAT_TIMEOUT } from '../../src/config.js';
import { getLastHeartbeatRun, getRecentHeartbeatRuns } from '../../src/db.js';
import type { HeartbeatConfig, HeartbeatDetail } from '../../src/types.js';

function parseIntervalOverride(content: string): number | null {
  const match = content.match(/<!--\s*heartbeat-interval:\s*(\d+)\s*-->/);
  return match ? parseInt(match[1], 10) : null;
}

export function heartbeatsRouter(core: AppCore): Router {
  const router = Router();

  router.get('/heartbeats', (_req, res) => {
    const groups = core.getRegisteredGroups();
    const configs: HeartbeatConfig[] = [];

    for (const [, group] of Object.entries(groups)) {
      const filePath = path.join(GROUPS_DIR, group.folder, 'HEARTBEAT.md');
      const globalPath = path.join(GROUPS_DIR, 'global', 'HEARTBEAT.md');
      const hasChecklist = fs.existsSync(filePath) || fs.existsSync(globalPath);

      let intervalMs = HEARTBEAT_INTERVAL;
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        const override = parseIntervalOverride(content);
        if (override) intervalMs = override;
      }

      const lastRun = getLastHeartbeatRun(group.folder);
      const recentRuns = getRecentHeartbeatRuns(group.folder, 5);

      configs.push({
        groupFolder: group.folder,
        groupName: group.name,
        hasChecklist,
        intervalMs,
        timeoutMs: HEARTBEAT_TIMEOUT,
        lastRun: lastRun ? {
          timestamp: lastRun.run_at,
          status: lastRun.status as 'ok' | 'acted' | 'error',
          actionsTaken: lastRun.actions_taken || undefined,
        } : undefined,
        recentRuns: recentRuns.map(r => ({
          timestamp: r.timestamp,
          status: r.status as 'ok' | 'acted' | 'error',
        })),
      });
    }

    res.json(configs);
  });

  router.get('/heartbeats/:groupFolder', (req, res) => {
    const { groupFolder } = req.params;
    const filePath = path.join(GROUPS_DIR, groupFolder, 'HEARTBEAT.md');
    const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    const groups = core.getRegisteredGroups();
    const group = Object.values(groups).find(g => g.folder === groupFolder);

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    const lastRun = getLastHeartbeatRun(groupFolder);
    const recentRuns = getRecentHeartbeatRuns(groupFolder, 5);
    const runHistory = getRecentHeartbeatRuns(groupFolder, 20);
    const override = content ? parseIntervalOverride(content) : null;

    const detail: HeartbeatDetail = {
      groupFolder,
      groupName: group.name,
      hasChecklist: content.length > 0,
      intervalMs: override || HEARTBEAT_INTERVAL,
      timeoutMs: HEARTBEAT_TIMEOUT,
      lastRun: lastRun ? {
        timestamp: lastRun.run_at,
        status: lastRun.status as 'ok' | 'acted' | 'error',
        actionsTaken: lastRun.actions_taken || undefined,
      } : undefined,
      recentRuns: recentRuns.map(r => ({
        timestamp: r.timestamp,
        status: r.status as 'ok' | 'acted' | 'error',
      })),
      content,
      runHistory: runHistory.map(r => ({
        timestamp: r.timestamp,
        status: r.status,
        durationMs: r.durationMs,
        ...(r.actionsTaken != null ? { actionsTaken: r.actionsTaken } : {}),
        ...(r.error != null ? { error: r.error } : {}),
      })),
    };

    res.json(detail);
  });

  router.put('/heartbeats/:groupFolder', (req, res) => {
    const { groupFolder } = req.params;
    const { content, intervalMs } = req.body as { content: string; intervalMs?: number };
    const filePath = path.join(GROUPS_DIR, groupFolder, 'HEARTBEAT.md');

    const dirPath = path.join(GROUPS_DIR, groupFolder);
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

    let finalContent = content;
    if (intervalMs) {
      finalContent = finalContent.replace(/<!--\s*heartbeat-interval:\s*\d+\s*-->\n?/, '');
      finalContent = `<!-- heartbeat-interval: ${intervalMs} -->\n${finalContent}`;
    }

    fs.writeFileSync(filePath, finalContent, 'utf8');
    res.json({ ok: true });
  });

  router.post('/heartbeats/:groupFolder/run', (req, res) => {
    const { groupFolder } = req.params;
    const groups = core.getRegisteredGroups();
    const entry = Object.entries(groups).find(([, g]) => g.folder === groupFolder);

    if (!entry) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    const queued = core.triggerHeartbeat(entry[0]);
    if (!queued) {
      res.status(422).json({ error: 'No heartbeat checklist found for this group' });
      return;
    }

    res.json({ queued: true });
  });

  router.delete('/heartbeats/:groupFolder', (req, res) => {
    const { groupFolder } = req.params;
    const filePath = path.join(GROUPS_DIR, groupFolder, 'HEARTBEAT.md');
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.json({ deleted: true });
  });

  return router;
}
