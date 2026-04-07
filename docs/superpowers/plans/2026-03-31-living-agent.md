# Living Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make NanoClaw feel alive — the dashboard shows what the agent did autonomously, lets you manage heartbeats, detects routines, learns from failures, and gives you full memory visibility.

**Architecture:** New Express API routes expose existing DB logs + heartbeat files. New `routine_signals` and `lessons` tables power pattern detection and failure learning. A `lessons` context layer injects past learnings into future prompts. The React dashboard gets a tabbed layout (Chats | Activity | Memory) with all new views.

**Tech Stack:** Express 5 routes, better-sqlite3, React 18 + Framer Motion, WebSocket broadcast, existing CSS custom properties (dark theme, `#E8613A` accent)

**Spec:** `docs/superpowers/specs/2026-03-31-living-agent-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `server/api/activity.ts` | Activity feed + daily summary API routes |
| `server/api/heartbeats.ts` | Heartbeat CRUD + trigger API routes |
| `server/api/routines.ts` | Routine detection + automate/dismiss routes |
| `server/api/lessons.ts` | Lessons CRUD API routes |
| `server/api/memories.ts` | Memory browse/edit/pin/delete API routes |
| `ui/src/ActivityPage.tsx` | Activity tab: feed, heartbeat manager, routines, stats |
| `ui/src/MemoryPage.tsx` | Memory tab: browse, search, edit, pin, bulk delete |

### Modified Files

| File | Changes |
|------|---------|
| `src/db.ts` | New tables (`routine_signals`, `dismissed_routines`, `lessons`), new query functions, `episode_id` column on `memory_entries` |
| `src/types.ts` | New interfaces: `ActivityEntry`, `DailySummary`, `HeartbeatConfig`, `Lesson`, `RoutineSignal` |
| `src/context/types.ts` | Add `'lessons'` to `ContextSourceKind` union |
| `src/context/config.ts` | Add `CONTEXT_MAX_LESSONS_CHARS` |
| `src/context/builder.ts` | Add `buildLessonsLayer()`, call it in `buildContextBundle()` |
| `src/core.ts` | Insert routine signal collection after capability routing |
| `src/heartbeat.ts` | Call routine detection during heartbeat, queue lesson extraction on failure |
| `src/task-scheduler.ts` | Queue lesson extraction on task failure |
| `server/index.ts` | Mount new routers |
| `server/ws.ts` | Add `activity` broadcast type, export broadcast function |
| `ui/src/api.ts` | Add API client functions for all new endpoints |
| `ui/src/Dashboard.tsx` | Add tab bar (Chats / Activity / Memory), route to new pages |
| `ui/src/styles.css` | Add styles for tabs, activity entries, heartbeat cards, memory cards |

---

## Task 1: Database Schema — New Tables + Migration

**Files:**
- Modify: `src/db.ts` (in `createSchema()`, around line 200)
- Modify: `src/types.ts` (add new interfaces)

- [ ] **Step 1: Add new interfaces to types.ts**

Add after the existing `HeartbeatRunLog` interface (around line 89):

```typescript
export interface ActivityEntry {
  id: string;
  type: 'heartbeat' | 'task' | 'runtime' | 'usage';
  groupFolder: string;
  timestamp: string;
  status: 'ok' | 'acted' | 'success' | 'error';
  summary: string;
  durationMs?: number;
  detail?: string;
  tokenCount?: number;
  costUsd?: number;
}

export interface DailySummary {
  date: string;
  heartbeats: { total: number; acted: number; errors: number };
  tasks: { total: number; succeeded: number; failed: number };
  tokens: { input: number; output: number; total: number };
  costUsd: number;
}

export interface HeartbeatConfig {
  groupFolder: string;
  groupName: string;
  hasChecklist: boolean;
  intervalMs: number;
  timeoutMs: number;
  lastRun?: {
    timestamp: string;
    status: 'ok' | 'acted' | 'error';
    actionsTaken?: string;
  };
  recentRuns: Array<{
    timestamp: string;
    status: 'ok' | 'acted' | 'error';
  }>;
}

export interface HeartbeatDetail extends HeartbeatConfig {
  content: string;
  runHistory: Array<{
    timestamp: string;
    status: string;
    actionsTaken?: string;
    durationMs: number;
    error?: string;
  }>;
}

export interface RoutineSignal {
  id: number;
  groupFolder: string;
  timestamp: string;
  hourBucket: number;
  dayOfWeek: number;
  capability: string;
  intentKeywords: string;
  messageHash: string;
}

export interface DetectedRoutine {
  keywords: string;
  capability: string;
  timeWindow: string;
  occurrences: number;
}

export interface Lesson {
  id: number;
  groupFolder: string;
  createdAt: string;
  triggerType: 'task' | 'heartbeat';
  triggerId?: string;
  errorSummary: string;
  lessonText: string;
  keywords: string;
  timesInjected: number;
  dismissed: boolean;
}
```

- [ ] **Step 2: Add new tables to createSchema() in db.ts**

Add after the existing `heartbeat_run_logs` table definition (around line 94 in the schema):

```sql
CREATE TABLE IF NOT EXISTS routine_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_folder TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  hour_bucket INTEGER NOT NULL,
  day_of_week INTEGER NOT NULL,
  capability TEXT NOT NULL,
  intent_keywords TEXT NOT NULL,
  message_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routine_signals_group
  ON routine_signals(group_folder, timestamp);

CREATE TABLE IF NOT EXISTS dismissed_routines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_folder TEXT NOT NULL,
  keywords TEXT NOT NULL,
  dismissed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_folder TEXT NOT NULL,
  created_at TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_id TEXT,
  error_summary TEXT NOT NULL,
  lesson_text TEXT NOT NULL,
  keywords TEXT NOT NULL,
  times_injected INTEGER DEFAULT 0,
  dismissed INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lessons_group
  ON lessons(group_folder, created_at);
```

- [ ] **Step 3: Add episode_id column migration**

Add a safe migration in `createSchema()` after existing migrations (the pattern used is `ALTER TABLE ... ADD COLUMN` wrapped in try/catch):

```typescript
try {
  db.exec(`ALTER TABLE memory_entries ADD COLUMN episode_id TEXT`);
} catch { /* column already exists */ }
```

- [ ] **Step 4: Add query functions to db.ts**

Add these functions at the end of db.ts (before the closing of the file):

```typescript
// ── Activity feed ──────────────────────────────────────────────
export function getActivityFeed(opts: {
  group?: string;
  type?: string[];
  status?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}): ActivityEntry[] {
  const limit = opts.limit || 50;
  const offset = opts.offset || 0;
  const conditions: string[] = [];
  const params: any[] = [];

  if (opts.group) { conditions.push('group_folder = ?'); params.push(opts.group); }
  if (opts.since) { conditions.push('timestamp >= ?'); params.push(opts.since); }
  if (opts.until) { conditions.push('timestamp <= ?'); params.push(opts.until); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // UNION across all 4 log tables
  const sql = `
    SELECT id, 'heartbeat' as type, group_folder, run_at as timestamp,
           status, COALESCE(actions_taken, 'Silent check — all clear') as summary,
           duration_ms, error as detail, NULL as token_count, NULL as cost_usd
    FROM heartbeat_run_logs ${where}
    UNION ALL
    SELECT trl.id, 'task' as type, st.group_folder, trl.run_at as timestamp,
           trl.status, COALESCE(st.prompt, 'Scheduled task') as summary,
           trl.duration_ms, COALESCE(trl.error, trl.result) as detail,
           NULL as token_count, NULL as cost_usd
    FROM task_run_logs trl JOIN scheduled_tasks st ON trl.task_id = st.id
    ${where ? where.replace(/group_folder/g, 'st.group_folder').replace(/timestamp/g, 'trl.run_at') : ''}
    UNION ALL
    SELECT id, 'usage' as type, group_folder, started_at as timestamp,
           'success' as status,
           model || ' — ' || total_tokens || ' tokens' as summary,
           duration_ms, notes as detail, total_tokens as token_count,
           total_cost_usd as cost_usd
    FROM runtime_usage_logs ${where ? where.replace(/timestamp/g, 'started_at') : ''}
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `;

  params.push(limit, offset);
  return db.prepare(sql).all(...params) as ActivityEntry[];
}

export function getDailySummary(date: string): DailySummary {
  const nextDate = new Date(new Date(date).getTime() + 86400000).toISOString().slice(0, 10);

  const hb = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN status = 'acted' THEN 1 ELSE 0 END) as acted,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
    FROM heartbeat_run_logs WHERE run_at >= ? AND run_at < ?
  `).get(date, nextDate) as any;

  const tasks = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as succeeded,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failed
    FROM task_run_logs WHERE run_at >= ? AND run_at < ?
  `).get(date, nextDate) as any;

  const usage = db.prepare(`
    SELECT COALESCE(SUM(input_tokens), 0) as input,
           COALESCE(SUM(output_tokens), 0) as output,
           COALESCE(SUM(total_tokens), 0) as total,
           COALESCE(SUM(total_cost_usd), 0) as cost
    FROM runtime_usage_logs WHERE started_at >= ? AND started_at < ?
  `).get(date, nextDate) as any;

  return {
    date,
    heartbeats: { total: hb.total, acted: hb.acted || 0, errors: hb.errors || 0 },
    tasks: { total: tasks.total, succeeded: tasks.succeeded || 0, failed: tasks.failed || 0 },
    tokens: { input: usage.input, output: usage.output, total: usage.total },
    costUsd: usage.cost,
  };
}

// ── Routine signals ────────────────────────────────────────────
export function insertRoutineSignal(signal: Omit<RoutineSignal, 'id'>): void {
  db.prepare(`
    INSERT INTO routine_signals (group_folder, timestamp, hour_bucket, day_of_week, capability, intent_keywords, message_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(signal.groupFolder, signal.timestamp, signal.hourBucket, signal.dayOfWeek,
         signal.capability, signal.intentKeywords, signal.messageHash);
}

export function detectRoutinePatterns(groupFolder: string, days = 14): DetectedRoutine[] {
  const since = new Date(Date.now() - days * 86400000).toISOString();

  // Get dismissed keywords to exclude
  const dismissed = db.prepare(`
    SELECT keywords FROM dismissed_routines
    WHERE group_folder = ? AND expires_at > ?
  `).all(groupFolder, new Date().toISOString()) as Array<{ keywords: string }>;
  const dismissedSet = new Set(dismissed.map(d => d.keywords));

  const patterns = db.prepare(`
    SELECT capability, intent_keywords,
           CAST(hour_bucket / 2 AS INTEGER) as time_window,
           COUNT(*) as occurrences
    FROM routine_signals
    WHERE group_folder = ? AND timestamp >= ?
    GROUP BY capability, intent_keywords, time_window
    HAVING COUNT(*) >= 3
    ORDER BY occurrences DESC
    LIMIT 10
  `).all(groupFolder, since) as Array<{
    capability: string;
    intent_keywords: string;
    time_window: number;
    occurrences: number;
  }>;

  return patterns
    .filter(p => !dismissedSet.has(p.intent_keywords))
    .map(p => ({
      keywords: p.intent_keywords,
      capability: p.capability,
      timeWindow: `${p.time_window * 2}:00-${p.time_window * 2 + 2}:00`,
      occurrences: p.occurrences,
    }));
}

export function dismissRoutine(groupFolder: string, keywords: string, days = 30): void {
  const now = new Date();
  const expires = new Date(now.getTime() + days * 86400000);
  db.prepare(`
    INSERT INTO dismissed_routines (group_folder, keywords, dismissed_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(groupFolder, keywords, now.toISOString(), expires.toISOString());
}

// ── Lessons ────────────────────────────────────────────────────
export function insertLesson(lesson: Omit<Lesson, 'id' | 'timesInjected' | 'dismissed'>): void {
  db.prepare(`
    INSERT INTO lessons (group_folder, created_at, trigger_type, trigger_id, error_summary, lesson_text, keywords)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(lesson.groupFolder, lesson.createdAt, lesson.triggerType, lesson.triggerId || null,
         lesson.errorSummary, lesson.lessonText, lesson.keywords);
}

export function getLessonsForGroup(groupFolder: string, limit = 20): Lesson[] {
  return db.prepare(`
    SELECT * FROM lessons
    WHERE group_folder = ? AND dismissed = 0
    ORDER BY created_at DESC LIMIT ?
  `).all(groupFolder, limit) as Lesson[];
}

export function queryLessonsByKeywords(groupFolder: string, keywords: string[], limit = 5): Lesson[] {
  if (keywords.length === 0) return [];
  const likeConditions = keywords.map(() => `keywords LIKE ?`).join(' OR ');
  const params = keywords.map(k => `%${k}%`);
  return db.prepare(`
    SELECT * FROM lessons
    WHERE group_folder = ? AND dismissed = 0 AND (${likeConditions})
    ORDER BY created_at DESC LIMIT ?
  `).all(groupFolder, ...params, limit) as Lesson[];
}

export function incrementLessonInjections(ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE lessons SET times_injected = times_injected + 1 WHERE id IN (${placeholders})`).run(...ids);
}

export function dismissLesson(id: number): void {
  db.prepare(`UPDATE lessons SET dismissed = 1 WHERE id = ?`).run(id);
}

// ── Heartbeat runs (extended queries) ──────────────────────────
export function getRecentHeartbeatRuns(groupFolder: string, limit = 5): Array<{
  timestamp: string;
  status: string;
  actionsTaken: string | null;
  durationMs: number;
  error: string | null;
}> {
  return db.prepare(`
    SELECT run_at as timestamp, status, actions_taken as actionsTaken,
           duration_ms as durationMs, error
    FROM heartbeat_run_logs
    WHERE group_folder = ?
    ORDER BY run_at DESC LIMIT ?
  `).all(groupFolder, limit) as any[];
}

// ── Memory (extended queries for dashboard) ────────────────────
export function getMemoryEntries(opts: {
  group?: string;
  kind?: string;
  query?: string;
  limit?: number;
  offset?: number;
}): Array<{ id: number; group_folder: string; kind: string; content: string; pinned: boolean; confidence: number; created_at: string; last_confirmed_at: string }> {
  const limit = opts.limit || 50;
  const offset = opts.offset || 0;
  const conditions: string[] = ['superseded_at IS NULL'];
  const params: any[] = [];

  if (opts.group) { conditions.push('group_folder = ?'); params.push(opts.group); }
  if (opts.kind) { conditions.push('kind = ?'); params.push(opts.kind); }
  if (opts.query) { conditions.push('content LIKE ?'); params.push(`%${opts.query}%`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);

  return db.prepare(`
    SELECT id, group_folder, kind, content, pinned, confidence, created_at, last_confirmed_at
    FROM memory_entries ${where}
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(...params) as any[];
}

export function updateMemoryContent(id: number, content: string): void {
  db.prepare(`UPDATE memory_entries SET content = ?, content_normalized = ? WHERE id = ?`)
    .run(content, content.toLowerCase().trim(), id);
}

export function deleteMemoryEntry(id: number): void {
  db.prepare(`DELETE FROM memory_entries WHERE id = ?`).run(id);
}

export function toggleMemoryPin(id: number, pinned: boolean): void {
  db.prepare(`UPDATE memory_entries SET pinned = ?, durability = ? WHERE id = ?`)
    .run(pinned ? 1 : 0, pinned ? 'pinned' : 'durable', id);
}
```

- [ ] **Step 5: Build and verify no TypeScript errors**

Run: `npm run build`
Expected: Compiles successfully with no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/types.ts
git commit -m "feat(db): add routine_signals, lessons tables and activity feed queries"
```

---

## Task 2: Activity Feed API

**Files:**
- Create: `server/api/activity.ts`
- Modify: `server/index.ts` (line 31, add mount)

- [ ] **Step 1: Create activity route file**

Create `server/api/activity.ts`:

```typescript
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
```

- [ ] **Step 2: Mount the router in server/index.ts**

Add import at line 10 (after personaRouter import):

```typescript
import { activityRouter } from './api/activity.js';
```

Add mount at line 31 (after personaRouter):

```typescript
app.use('/api', activityRouter());
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: Compiles successfully.

- [ ] **Step 4: Commit**

```bash
git add server/api/activity.ts server/index.ts
git commit -m "feat(api): add activity feed and daily summary endpoints"
```

---

## Task 3: Heartbeat Manager API

**Files:**
- Create: `server/api/heartbeats.ts`
- Modify: `server/index.ts` (add mount)

- [ ] **Step 1: Create heartbeats route file**

Create `server/api/heartbeats.ts`:

```typescript
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
      runHistory,
    };

    res.json(detail);
  });

  router.put('/heartbeats/:groupFolder', (req, res) => {
    const { groupFolder } = req.params;
    const { content, intervalMs } = req.body as { content: string; intervalMs?: number };
    const filePath = path.join(GROUPS_DIR, groupFolder, 'HEARTBEAT.md');

    // Ensure group directory exists
    const dirPath = path.join(GROUPS_DIR, groupFolder);
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

    let finalContent = content;
    if (intervalMs) {
      // Remove existing interval comment if present
      finalContent = finalContent.replace(/<!--\s*heartbeat-interval:\s*\d+\s*-->\n?/, '');
      // Add new interval comment at top
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

    // Enqueue a heartbeat — the heartbeat system will pick it up
    core.queue.enqueueTask(entry[0], groupFolder, 'background');
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
```

- [ ] **Step 2: Mount the router in server/index.ts**

Add import:

```typescript
import { heartbeatsRouter } from './api/heartbeats.js';
```

Add mount after activityRouter:

```typescript
app.use('/api', heartbeatsRouter(core));
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: Compiles successfully.

- [ ] **Step 4: Commit**

```bash
git add server/api/heartbeats.ts server/index.ts
git commit -m "feat(api): add heartbeat CRUD and manual trigger endpoints"
```

---

## Task 4: Routines + Lessons + Memory API Routes

**Files:**
- Create: `server/api/routines.ts`
- Create: `server/api/lessons.ts`
- Create: `server/api/memories.ts`
- Modify: `server/index.ts` (add mounts)

- [ ] **Step 1: Create routines route file**

Create `server/api/routines.ts`:

```typescript
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

    // Append under ## Automated section
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
```

- [ ] **Step 2: Create lessons route file**

Create `server/api/lessons.ts`:

```typescript
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
```

- [ ] **Step 3: Create memories route file**

Create `server/api/memories.ts`:

```typescript
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
```

- [ ] **Step 4: Mount all three routers in server/index.ts**

Add imports:

```typescript
import { routinesRouter } from './api/routines.js';
import { lessonsRouter } from './api/lessons.js';
import { memoriesRouter } from './api/memories.js';
```

Add mounts:

```typescript
app.use('/api', routinesRouter());
app.use('/api', lessonsRouter());
app.use('/api', memoriesRouter());
```

- [ ] **Step 5: Build and verify**

Run: `npm run build`
Expected: Compiles successfully.

- [ ] **Step 6: Commit**

```bash
git add server/api/routines.ts server/api/lessons.ts server/api/memories.ts server/index.ts
git commit -m "feat(api): add routines, lessons, and memories endpoints"
```

---

## Task 5: WebSocket Activity Broadcast

**Files:**
- Modify: `server/ws.ts`
- Modify: `src/heartbeat.ts` (after logHeartbeatRun calls)
- Modify: `src/task-scheduler.ts` (after logTaskRun calls)

- [ ] **Step 1: Export a broadcast function from ws.ts**

Add a module-level broadcast reference and export it. At the top of `server/ws.ts`, add after the imports:

```typescript
type BroadcastFn = (event: any) => void;
let activityBroadcast: BroadcastFn = () => {};

export function getActivityBroadcast(): BroadcastFn {
  return activityBroadcast;
}
```

Inside `setupWebSocket()`, after the `subscriptions` Map is created (line 16), set the broadcast:

```typescript
activityBroadcast = (event: any) => {
  const message = JSON.stringify({ type: 'activity', entry: event });
  for (const [ws] of subscriptions) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
};
```

- [ ] **Step 2: Broadcast from heartbeat.ts after logging**

In `src/heartbeat.ts`, import the broadcast at the top:

```typescript
import { getActivityBroadcast } from '../server/ws.js';
```

After each `logHeartbeatRun()` call (there are two — one for success/acted, one for error), add:

```typescript
try {
  getActivityBroadcast()({
    id: String(Date.now()),
    type: 'heartbeat',
    groupFolder: group.folder,
    timestamp: new Date().toISOString(),
    status: log.status,
    summary: log.actions_taken || 'Silent check — all clear',
    durationMs: log.duration_ms,
  });
} catch { /* broadcast is best-effort */ }
```

- [ ] **Step 3: Broadcast from task-scheduler.ts after logging**

In `src/task-scheduler.ts`, import the broadcast at the top:

```typescript
import { getActivityBroadcast } from '../server/ws.js';
```

After each `logTaskRun()` call, add:

```typescript
try {
  getActivityBroadcast()({
    id: String(Date.now()),
    type: 'task',
    groupFolder: task.group_folder,
    timestamp: new Date().toISOString(),
    status: log.status,
    summary: task.prompt?.slice(0, 120) || 'Scheduled task',
    durationMs: log.duration_ms,
    detail: log.error || log.result || undefined,
  });
} catch { /* broadcast is best-effort */ }
```

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: Compiles successfully.

- [ ] **Step 5: Commit**

```bash
git add server/ws.ts src/heartbeat.ts src/task-scheduler.ts
git commit -m "feat(ws): broadcast activity events for heartbeat and task completions"
```

---

## Task 6: Routine Signal Collection

**Files:**
- Modify: `src/core.ts` (inside processGroupMessages, after capability routing)

- [ ] **Step 1: Add signal collection after capability routing**

In `src/core.ts`, import at the top:

```typescript
import { insertRoutineSignal } from './db.js';
import { createHash } from 'crypto';
```

After the capability route is resolved (around line 1540, after `resolveCapabilityRoute()`), add:

```typescript
// Collect routine signal for pattern detection
try {
  const now = new Date();
  const keywords = strongKeywords.slice(0, 3).join(',');
  if (keywords.length > 0) {
    insertRoutineSignal({
      groupFolder: group.folder,
      timestamp: now.toISOString(),
      hourBucket: now.getHours(),
      dayOfWeek: now.getDay(),
      capability: capabilityRoute,
      intentKeywords: keywords,
      messageHash: createHash('md5').update(promptText.slice(0, 200)).digest('hex').slice(0, 8),
    });
  }
} catch { /* signal collection is non-critical */ }
```

Note: `strongKeywords` and `promptText` come from the context building step earlier in the same function. Check they are in scope at the insertion point — if not, extract them to a wider scope.

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: Compiles successfully.

- [ ] **Step 3: Commit**

```bash
git add src/core.ts
git commit -m "feat: collect routine signals after capability routing for pattern detection"
```

---

## Task 7: Lessons Context Layer

**Files:**
- Modify: `src/context/types.ts` (add `'lessons'` to union)
- Modify: `src/context/config.ts` (add max chars constant)
- Modify: `src/context/builder.ts` (add `buildLessonsLayer()`, call in `buildContextBundle()`)

- [ ] **Step 1: Add lessons to ContextSourceKind**

In `src/context/types.ts`, line 3-13, add `'lessons'` to the union:

```typescript
export type ContextSourceKind =
  | 'soul'
  | 'mopus'
  | 'identity'
  | 'style'
  | 'user'
  | 'tools'
  | 'memory'
  | 'daily'
  | 'retrieved_memory'
  | 'lessons'
  | 'legacy_claude';
```

- [ ] **Step 2: Add config constant**

In `src/context/config.ts`, add at the end:

```typescript
// Lessons — injected when keywords match past failure learnings
export const CONTEXT_MAX_LESSONS_CHARS = 2_000;
```

- [ ] **Step 3: Add buildLessonsLayer in builder.ts**

Import at the top of `src/context/builder.ts`:

```typescript
import { queryLessonsByKeywords, incrementLessonInjections } from '../db.js';
import { CONTEXT_MAX_LESSONS_CHARS } from './config.js';
```

Add the function (before `buildContextBundle`):

```typescript
function buildLessonsLayer(
  groupFolder: string,
  strongKeywords: string[],
): ContextLayer {
  if (strongKeywords.length === 0) {
    return {
      kind: 'lessons',
      scope: 'group',
      label: 'Lessons from past failures',
      filePath: '',
      included: false,
      inclusionReason: 'no_strong_keywords',
      trimMode: 'tail',
      rawChars: 0,
      trimmedChars: 0,
      content: '',
    };
  }

  const lessons = queryLessonsByKeywords(groupFolder, strongKeywords, 5);
  if (lessons.length === 0) {
    return {
      kind: 'lessons',
      scope: 'group',
      label: 'Lessons from past failures',
      filePath: '',
      included: false,
      inclusionReason: 'no_matching_lessons',
      trimMode: 'tail',
      rawChars: 0,
      trimmedChars: 0,
      content: '',
    };
  }

  // Track which lessons were injected
  incrementLessonInjections(lessons.map(l => l.id));

  const lines = lessons.map(
    l => `- [${l.createdAt.slice(0, 10)}] ${l.lessonText}`,
  );
  let content = `## Relevant Lessons\n${lines.join('\n')}`;
  if (content.length > CONTEXT_MAX_LESSONS_CHARS) {
    content = content.slice(0, CONTEXT_MAX_LESSONS_CHARS);
  }

  return {
    kind: 'lessons',
    scope: 'group',
    label: 'Lessons from past failures',
    filePath: '',
    included: true,
    inclusionReason: `${lessons.length}_lessons_matched`,
    trimMode: 'tail',
    rawChars: content.length,
    trimmedChars: content.length,
    content,
  };
}
```

- [ ] **Step 4: Call buildLessonsLayer in buildContextBundle**

In `buildContextBundle()`, after line 1170 (`layers.push(buildRetrievedMemoryLayer(...))`), add:

```typescript
layers.push(buildLessonsLayer(input.groupFolder, strongKeywords));
```

- [ ] **Step 5: Build and verify**

Run: `npm run build`
Expected: Compiles successfully.

- [ ] **Step 6: Commit**

```bash
git add src/context/types.ts src/context/config.ts src/context/builder.ts
git commit -m "feat(context): add lessons layer — inject past failure learnings into prompts"
```

---

## Task 8: Lesson Extraction on Failure

**Files:**
- Modify: `src/heartbeat.ts` (after error logging)
- Modify: `src/task-scheduler.ts` (after error logging)

- [ ] **Step 1: Create a shared extractLesson helper**

Add to `src/db.ts` (or a new small file if preferred — but db.ts already has all the insert functions):

This is a lightweight function that builds a lesson from error context without an LLM call (V1 — we can add LLM extraction later):

In `src/types.ts`, the lesson types are already defined. In `src/db.ts`, `insertLesson` is already defined. The extraction happens at the call site.

- [ ] **Step 2: Add lesson extraction in heartbeat.ts**

After the error-path `logHeartbeatRun()` call in `src/heartbeat.ts`, add:

```typescript
// Extract a lesson from the failure
try {
  const keywords = checklist.content
    .split(/\s+/)
    .filter(w => w.length > 4)
    .slice(0, 5)
    .join(',');
  insertLesson({
    groupFolder: group.folder,
    createdAt: new Date().toISOString(),
    triggerType: 'heartbeat',
    errorSummary: String(error).slice(0, 200),
    lessonText: `Heartbeat failed: ${String(error).slice(0, 300)}. Check checklist items and ensure required services are reachable.`,
    keywords,
  });
} catch { /* lesson extraction is non-critical */ }
```

Import `insertLesson` from `../db.js` at the top if not already imported.

- [ ] **Step 3: Add lesson extraction in task-scheduler.ts**

After the error-path `logTaskRun()` call in `src/task-scheduler.ts`, add:

```typescript
try {
  insertLesson({
    groupFolder: task.group_folder,
    createdAt: new Date().toISOString(),
    triggerType: 'task',
    triggerId: task.id,
    errorSummary: String(error).slice(0, 200),
    lessonText: `Task "${task.prompt?.slice(0, 80)}" failed: ${String(error).slice(0, 300)}. Review task configuration and error context.`,
    keywords: (task.prompt || '').split(/\s+/).filter((w: string) => w.length > 4).slice(0, 5).join(','),
  });
} catch { /* lesson extraction is non-critical */ }
```

Import `insertLesson` from `./db.js` at the top if not already imported.

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: Compiles successfully.

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat.ts src/task-scheduler.ts
git commit -m "feat: extract structured lessons from heartbeat and task failures"
```

---

## Task 9: Frontend API Client Functions

**Files:**
- Modify: `ui/src/api.ts`

- [ ] **Step 1: Add all new API client functions**

Append to `ui/src/api.ts`:

```typescript
// ── Activity ───────────────────────────────────────────────────

export interface ActivityEntry {
  id: string;
  type: 'heartbeat' | 'task' | 'runtime' | 'usage';
  groupFolder: string;
  timestamp: string;
  status: 'ok' | 'acted' | 'success' | 'error';
  summary: string;
  durationMs?: number;
  detail?: string;
  tokenCount?: number;
  costUsd?: number;
}

export interface DailySummary {
  date: string;
  heartbeats: { total: number; acted: number; errors: number };
  tasks: { total: number; succeeded: number; failed: number };
  tokens: { input: number; output: number; total: number };
  costUsd: number;
}

export async function getActivity(params?: {
  group?: string;
  type?: string;
  limit?: number;
  offset?: number;
}): Promise<ActivityEntry[]> {
  const qs = new URLSearchParams();
  if (params?.group) qs.set('group', params.group);
  if (params?.type) qs.set('type', params.type);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  const res = await fetch(`${BASE}/activity?${qs}`);
  return res.json();
}

export async function getActivitySummary(date?: string): Promise<DailySummary> {
  const qs = date ? `?date=${date}` : '';
  const res = await fetch(`${BASE}/activity/summary${qs}`);
  return res.json();
}

// ── Heartbeats ─────────────────────────────────────────────────

export interface HeartbeatConfig {
  groupFolder: string;
  groupName: string;
  hasChecklist: boolean;
  intervalMs: number;
  timeoutMs: number;
  lastRun?: { timestamp: string; status: string; actionsTaken?: string };
  recentRuns: Array<{ timestamp: string; status: string }>;
}

export interface HeartbeatDetail extends HeartbeatConfig {
  content: string;
  runHistory: Array<{
    timestamp: string;
    status: string;
    actionsTaken?: string;
    durationMs: number;
    error?: string;
  }>;
}

export async function getHeartbeats(): Promise<HeartbeatConfig[]> {
  const res = await fetch(`${BASE}/heartbeats`);
  return res.json();
}

export async function getHeartbeatDetail(groupFolder: string): Promise<HeartbeatDetail> {
  const res = await fetch(`${BASE}/heartbeats/${encodeURIComponent(groupFolder)}`);
  return res.json();
}

export async function saveHeartbeat(groupFolder: string, content: string, intervalMs?: number): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/heartbeats/${encodeURIComponent(groupFolder)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, intervalMs }),
  });
  return res.json();
}

export async function triggerHeartbeat(groupFolder: string): Promise<{ queued: boolean }> {
  const res = await fetch(`${BASE}/heartbeats/${encodeURIComponent(groupFolder)}/run`, { method: 'POST' });
  return res.json();
}

export async function deleteHeartbeat(groupFolder: string): Promise<{ deleted: boolean }> {
  const res = await fetch(`${BASE}/heartbeats/${encodeURIComponent(groupFolder)}`, { method: 'DELETE' });
  return res.json();
}

// ── Routines ───────────────────────────────────────────────────

export interface DetectedRoutine {
  keywords: string;
  capability: string;
  timeWindow: string;
  occurrences: number;
}

export async function getRoutines(groupFolder: string): Promise<DetectedRoutine[]> {
  const res = await fetch(`${BASE}/routines/${encodeURIComponent(groupFolder)}`);
  return res.json();
}

export async function automateRoutine(groupFolder: string, description: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/routines/${encodeURIComponent(groupFolder)}/automate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  });
  return res.json();
}

export async function dismissRoutine(groupFolder: string, keywords: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/routines/${encodeURIComponent(groupFolder)}/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keywords }),
  });
  return res.json();
}

// ── Lessons ────────────────────────────────────────────────────

export interface Lesson {
  id: number;
  group_folder: string;
  created_at: string;
  trigger_type: string;
  error_summary: string;
  lesson_text: string;
  times_injected: number;
}

export async function getLessons(groupFolder: string): Promise<Lesson[]> {
  const res = await fetch(`${BASE}/lessons/${encodeURIComponent(groupFolder)}`);
  return res.json();
}

export async function deleteLesson(id: number): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/lessons/${id}`, { method: 'DELETE' });
  return res.json();
}

// ── Memories ───────────────────────────────────────────────────

export interface MemoryEntry {
  id: number;
  group_folder: string;
  kind: string;
  content: string;
  pinned: boolean;
  confidence: number;
  created_at: string;
  last_confirmed_at: string;
}

export async function getMemories(params?: {
  group?: string;
  kind?: string;
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<MemoryEntry[]> {
  const qs = new URLSearchParams();
  if (params?.group) qs.set('group', params.group);
  if (params?.kind) qs.set('kind', params.kind);
  if (params?.q) qs.set('q', params.q);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  const res = await fetch(`${BASE}/memories?${qs}`);
  return res.json();
}

export async function updateMemory(id: number, content: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/memories/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  return res.json();
}

export async function deleteMemory(id: number): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/memories/${id}`, { method: 'DELETE' });
  return res.json();
}

export async function toggleMemoryPin(id: number, pinned: boolean): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/memories/${id}/pin`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });
  return res.json();
}
```

- [ ] **Step 2: Build UI**

Run: `cd ui && npm run build`
Expected: Compiles successfully (no component changes yet, just types + functions).

- [ ] **Step 3: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(ui): add API client functions for activity, heartbeats, routines, lessons, memories"
```

---

## Task 10: Dashboard Tab Bar + Activity Page UI

**Files:**
- Create: `ui/src/ActivityPage.tsx`
- Modify: `ui/src/Dashboard.tsx` (add tab bar, route to ActivityPage)
- Modify: `ui/src/styles.css` (add tab + activity styles)

This is a large UI task. Use the `frontend-design` skill for implementation — it will produce the complete, themed React components and CSS. The spec below defines the requirements; the skill handles the design execution.

- [ ] **Step 1: Add tab bar and activity view to Dashboard.tsx**

Modify `Dashboard.tsx` state to add a `tab` state:

```typescript
const [activeTab, setActiveTab] = useState<'chats' | 'activity' | 'memory'>('chats');
```

Replace the current sidebar content section (below the header) with a tab bar:

```tsx
<div className="sidebar-tabs">
  <button
    className={`sidebar-tab ${activeTab === 'chats' ? 'active' : ''}`}
    onClick={() => setActiveTab('chats')}
  >Chats</button>
  <button
    className={`sidebar-tab ${activeTab === 'activity' ? 'active' : ''}`}
    onClick={() => setActiveTab('activity')}
  >Activity</button>
  <button
    className={`sidebar-tab ${activeTab === 'memory' ? 'active' : ''}`}
    onClick={() => setActiveTab('memory')}
  >Memory</button>
</div>
```

When `activeTab` is `'activity'`, render `<ActivityPage />` in the main content area instead of the chat view. When `activeTab` is `'memory'`, render `<MemoryPage />`.

- [ ] **Step 2: Create ActivityPage.tsx**

Create `ui/src/ActivityPage.tsx` with these sections (all using existing CSS variables):

1. **Heartbeats section** — fetches `getHeartbeats()`, shows cards per group. Each card shows group name, interval, last run status dot, relative time. Click expands to inline editor (textarea + interval picker + Save/Run Now/Delete buttons). "Add New" button at top.

2. **Suggested Routines section** — for each group, fetches `getRoutines(groupFolder)`. Shows cards with left accent border, pattern description, occurrence count, Automate + Dismiss buttons.

3. **Recent Activity section** — fetches `getActivity({ limit: 30 })`. Reverse-chronological list. Each entry shows timestamp, status dot (green=ok, orange=acted, red=error), summary text. Click expands to show detail + lesson (if failed).

4. **Stats bar** — sticky bottom, fetches `getActivitySummary()`. Shows today's counts: heartbeats, tasks, tokens.

5. **Real-time updates** — listen for `{ type: 'activity' }` WebSocket events, prepend new entries to the feed.

Design requirements (from spec):
- Heartbeat card: `--bg-tertiary`, `--border`, 8px radius, 12px 16px padding
- Status dots: 8px circle, `#22c55e` ok, `--accent` acted, `#ef4444` error
- Activity entries: flex row with timestamp (50px fixed, muted), dot, summary text
- Expand animation: Framer Motion `layout` prop, 0.3s ease
- Section headers: `Cormorant Garamond`, 1.15rem, weight 500
- All body text: `DM Sans`, 0.87rem

- [ ] **Step 3: Add CSS styles for tabs and activity components**

Append to `ui/src/styles.css`:

```css
/* ── Tab bar ──────────────────────────────────────────────── */
.sidebar-tabs {
  display: flex;
  gap: 0;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
}

.sidebar-tab {
  flex: 1;
  background: none;
  border: none;
  padding: 10px 0;
  font-family: var(--font-body);
  font-size: 0.8rem;
  font-weight: 500;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--text-muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.2s, border-color 0.2s;
}

.sidebar-tab:hover {
  color: var(--text-secondary);
}

.sidebar-tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

/* ── Activity page ────────────────────────────────────────── */
.activity-page {
  flex: 1;
  display: flex;
  flex-direction: column;
  max-width: 820px;
  margin: 0 auto;
  padding: 24px 32px;
  overflow-y: auto;
  gap: 28px;
}

.activity-section-title {
  font-family: var(--font-display);
  font-size: 1.15rem;
  font-weight: 500;
  color: var(--text-primary);
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* ── Heartbeat cards ──────────────────────────────────────── */
.heartbeat-card {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  transition: border-color 0.2s, transform 0.2s;
}

.heartbeat-card:hover {
  border-color: var(--border-hover);
  transform: translateY(-1px);
}

.heartbeat-name {
  font-family: var(--font-body);
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--text-primary);
}

.heartbeat-meta {
  font-family: var(--font-body);
  font-size: 0.8rem;
  color: var(--text-muted);
}

.heartbeat-editor {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px;
  margin-top: 8px;
}

.heartbeat-editor textarea {
  width: 100%;
  min-height: 200px;
  max-height: 400px;
  resize: vertical;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: 'SFMono-Regular', 'Consolas', monospace;
  font-size: 0.85rem;
  padding: 12px;
  line-height: 1.5;
}

.heartbeat-editor textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow-subtle);
}

/* ── Interval pills ───────────────────────────────────────── */
.interval-pills {
  display: flex;
  gap: 6px;
  margin: 10px 0;
}

.interval-pill {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 5px 14px;
  font-family: var(--font-body);
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s;
}

.interval-pill:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.interval-pill.active {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-glow-subtle);
}

/* ── Status dots ──────────────────────────────────────────── */
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-dot.ok { background: #22c55e; }
.status-dot.acted { background: var(--accent); }
.status-dot.success { background: #22c55e; }
.status-dot.error { background: #ef4444; }

/* ── Activity entries ─────────────────────────────────────── */
.activity-entry {
  display: flex;
  gap: 12px;
  padding: 10px 0;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background 0.2s;
}

.activity-entry:hover {
  background: var(--bg-hover);
}

.activity-time {
  font-family: var(--font-body);
  font-size: 0.75rem;
  color: var(--text-muted);
  width: 50px;
  text-align: right;
  flex-shrink: 0;
  padding-top: 2px;
}

.activity-summary {
  font-family: var(--font-body);
  font-size: 0.87rem;
  color: var(--text-primary);
  line-height: 1.5;
}

.activity-detail {
  font-family: var(--font-body);
  font-size: 0.8rem;
  color: var(--text-secondary);
  border-top: 1px solid var(--border);
  padding-top: 8px;
  margin-top: 6px;
}

.activity-lesson {
  font-family: var(--font-body);
  font-size: 0.8rem;
  color: var(--text-muted);
  padding-left: 20px;
  margin-top: 4px;
}

/* ── Suggested routines ───────────────────────────────────── */
.routine-card {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-sm);
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.routine-text {
  font-family: var(--font-body);
  font-size: 0.87rem;
  color: var(--text-primary);
}

.routine-count {
  font-family: var(--font-body);
  font-size: 0.8rem;
  color: var(--text-muted);
}

.routine-actions {
  display: flex;
  gap: 12px;
}

/* ── Stats bar ────────────────────────────────────────────── */
.stats-bar {
  background: var(--bg-secondary);
  border-top: 1px solid var(--border);
  padding: 12px 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  position: sticky;
  bottom: 0;
}

.stats-label {
  font-family: var(--font-body);
  font-size: 0.8rem;
  color: var(--text-muted);
}

.stats-value {
  font-family: var(--font-body);
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-secondary);
}
```

- [ ] **Step 4: Build UI**

Run: `cd ui && npm run build`
Expected: Compiles and builds successfully.

- [ ] **Step 5: Commit**

```bash
git add ui/src/ActivityPage.tsx ui/src/Dashboard.tsx ui/src/styles.css
git commit -m "feat(ui): add Activity tab with heartbeat manager, routines, and activity feed"
```

---

## Task 11: Memory Page UI

**Files:**
- Create: `ui/src/MemoryPage.tsx`
- Modify: `ui/src/styles.css` (add memory page styles)
- Modify: `ui/src/Dashboard.tsx` (import and route to MemoryPage)

- [ ] **Step 1: Create MemoryPage.tsx**

Create `ui/src/MemoryPage.tsx` with:

1. **Search bar** — text input at top, debounced 300ms, calls `getMemories({ q: searchTerm })`
2. **Filter pills** — All | Facts | Preferences | Projects | Loops (maps to `kind` param)
3. **Memory list** — each entry is a card with:
   - Left color border by kind (fact=`#3b82f6`, pref=`#a855f7`, proj=`#22c55e`, loop=`--accent`)
   - Content text (max 2 lines, overflow ellipsis)
   - Meta row: group name, relative age, decay indicator (thin bar, opacity proportional to freshness)
   - Pin icon (filled if pinned, `--accent` color)
   - Hover reveals edit/delete icons
4. **Inline edit** — click edit icon, content becomes textarea, Save/Cancel buttons
5. **Bulk mode** — checkbox on each card, bottom bar with "Delete Selected"

Design requirements:
- Search input: same style as chat input but single-line, with search icon placeholder
- Filter pills: same as heartbeat interval pills
- Memory card: `--bg-tertiary`, `--border`, 8px radius
- Kind border: 4px left border, color by kind
- Animations: cards fade in with stagger, inline edit slides open

- [ ] **Step 2: Add CSS for memory page**

Append to `ui/src/styles.css`:

```css
/* ── Memory page ──────────────────────────────────────────── */
.memory-page {
  flex: 1;
  display: flex;
  flex-direction: column;
  max-width: 820px;
  margin: 0 auto;
  padding: 24px 32px;
  overflow-y: auto;
  gap: 16px;
}

.memory-search {
  width: 100%;
  padding: 10px 16px 10px 40px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: var(--font-body);
  font-size: 0.9rem;
}

.memory-search:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow-subtle);
}

.memory-filters {
  display: flex;
  gap: 6px;
}

.memory-card {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px 16px;
  position: relative;
  transition: border-color 0.2s;
}

.memory-card:hover {
  border-color: var(--border-hover);
}

.memory-card.fact { border-left: 4px solid #3b82f6; }
.memory-card.pref { border-left: 4px solid #a855f7; }
.memory-card.proj { border-left: 4px solid #22c55e; }
.memory-card.loop { border-left: 4px solid var(--accent); }

.memory-content {
  font-family: var(--font-body);
  font-size: 0.87rem;
  color: var(--text-primary);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.memory-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  font-family: var(--font-body);
  font-size: 0.75rem;
  color: var(--text-muted);
}

.memory-decay-bar {
  width: 40px;
  height: 3px;
  background: var(--border);
  border-radius: 2px;
  overflow: hidden;
}

.memory-decay-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width 0.3s;
}

.memory-pin {
  position: absolute;
  top: 12px;
  right: 12px;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 0.9rem;
  transition: color 0.2s;
}

.memory-pin.pinned {
  color: var(--accent);
}

.memory-actions {
  position: absolute;
  top: 12px;
  right: 36px;
  display: flex;
  gap: 6px;
  opacity: 0;
  transition: opacity 0.2s;
}

.memory-card:hover .memory-actions {
  opacity: 1;
}

.memory-action-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 0.8rem;
  padding: 2px 4px;
  transition: color 0.2s;
}

.memory-action-btn:hover {
  color: var(--text-primary);
}

.memory-bulk-bar {
  position: sticky;
  bottom: 0;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border);
  padding: 10px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
```

- [ ] **Step 3: Import MemoryPage in Dashboard.tsx**

Add import:

```typescript
import { MemoryPage } from './MemoryPage';
```

In the main content area, add condition for `activeTab === 'memory'`:

```tsx
{activeTab === 'memory' && <MemoryPage />}
```

- [ ] **Step 4: Build UI**

Run: `cd ui && npm run build`
Expected: Compiles and builds successfully.

- [ ] **Step 5: Commit**

```bash
git add ui/src/MemoryPage.tsx ui/src/Dashboard.tsx ui/src/styles.css
git commit -m "feat(ui): add Memory tab with search, filter, edit, pin, and bulk delete"
```

---

## Task 12: Integration Test

**Files:**
- Modify: `server/server.test.ts` (add tests for new endpoints)

- [ ] **Step 1: Add integration tests for new API routes**

Append test cases to `server/server.test.ts`:

```typescript
describe('activity API', () => {
  it('GET /api/activity returns empty feed initially', async () => {
    const { app } = createApp(core as any);
    const res = await request(app).get('/api/activity');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('GET /api/activity/summary returns zeroed summary', async () => {
    const { app } = createApp(core as any);
    const res = await request(app).get('/api/activity/summary');
    expect(res.status).toBe(200);
    expect(res.body.heartbeats.total).toBe(0);
    expect(res.body.tasks.total).toBe(0);
    expect(res.body.tokens.total).toBe(0);
  });
});

describe('heartbeats API', () => {
  it('GET /api/heartbeats returns list', async () => {
    const { app } = createApp(core as any);
    const res = await request(app).get('/api/heartbeats');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('memories API', () => {
  it('GET /api/memories returns empty list initially', async () => {
    const { app } = createApp(core as any);
    const res = await request(app).get('/api/memories');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('lessons API', () => {
  it('GET /api/lessons/:group returns empty list', async () => {
    const { app } = createApp(core as any);
    const res = await request(app).get('/api/lessons/test_group');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All existing + new tests pass.

- [ ] **Step 3: Commit**

```bash
git add server/server.test.ts
git commit -m "test: add integration tests for activity, heartbeats, memories, lessons APIs"
```

---

## Task 13: Build All + Smoke Test

- [ ] **Step 1: Full build**

Run: `npm run build && cd ui && npm run build`
Expected: Both backend and frontend compile successfully.

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Manual smoke test**

Run: `npm run dev`

Verify in browser at `http://localhost:PORT`:
1. Tab bar (Chats | Activity | Memory) visible in sidebar
2. Activity tab shows heartbeat cards (even if empty)
3. Memory tab shows search + filter pills
4. Clicking a heartbeat card expands the editor
5. Stats bar shows at bottom of activity page
6. WebSocket connection still works for chat

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: Living Agent — activity feed, heartbeat manager, routines, lessons, memory dashboard"
```
