# Living Agent: Proactive Autonomy + Compounding Intelligence

**Date:** 2026-03-31
**Status:** Approved
**Branch:** feat/dashboard-backend

## Goal

Make NanoClaw feel alive. The agent acts on its own, learns from failures, detects routines, and surfaces everything through a minimal dashboard Activity tab. The user opens the dashboard and sees what happened overnight without asking.

## Guiding Principle

The frontier model is already smart. The gap is making it act without being asked and compound knowledge over time. Every feature here serves daily usefulness over raw capability.

---

## Existing Infrastructure (No Work Needed)

These systems are fully built. The new work builds on top of them.

| System | State | Key Files |
|--------|-------|-----------|
| Heartbeat loop | Production-ready. 30-min polling, HEARTBEAT.md checklists, repeat suppression, tool isolation | `src/heartbeat.ts`, `src/config.ts` |
| Memory (FTS5 + BM25) | Full hybrid retrieval, 30-day temporal decay, pinning, conflict resolution, daily notes | `src/context/memory.ts`, `src/db.ts`, `src/context/builder.ts` |
| Scheduled tasks | Cron, interval, one-time. Full agent capabilities | `src/task-scheduler.ts` |
| Activity logging | 4 DB tables populated: `runtime_events`, `task_run_logs`, `heartbeat_run_logs`, `runtime_usage_logs` | `src/db.ts` |
| Dashboard | React SPA, Express server, WebSocket chat, dark theme with golden-orange accent | `ui/`, `server/` |

---

## Feature 1: Activity Feed API

Expose all existing logging to the dashboard via new API endpoints.

### Endpoints

**`GET /api/activity`** — Unified reverse-chronological feed.

Pulls from all 4 log tables, merges by timestamp. Each entry normalized to:

```typescript
interface ActivityEntry {
  id: string;
  type: 'heartbeat' | 'task' | 'runtime' | 'usage';
  groupFolder: string;
  timestamp: string;       // ISO-8601
  status: 'ok' | 'acted' | 'success' | 'error';
  summary: string;         // One-line human description
  durationMs?: number;
  detail?: string;         // Full agent output or error trace
  tokenCount?: number;
  costUsd?: number;
}
```

Query params:
- `?group=` — filter by group folder
- `?type=` — filter by entry type (comma-separated)
- `?status=` — filter by status
- `?since=` / `?until=` — date range (ISO-8601)
- `?limit=` / `?offset=` — pagination (default limit 50)

**`GET /api/activity/summary`** — Daily rollup for the stats bar.

```typescript
interface DailySummary {
  date: string;
  heartbeats: { total: number; acted: number; errors: number };
  tasks: { total: number; succeeded: number; failed: number };
  tokens: { input: number; output: number; total: number };
  costUsd: number;
}
```

Query params: `?date=` (defaults to today), `?days=` (for multi-day rollup)

### Implementation

Add routes to `server/routes.ts`. Each route queries existing DB functions in `src/db.ts` — most query functions already exist (`getLastHeartbeatRun`, `getRecentTaskFailuresForGroup`, `getRuntimeEvents`). New: a unified query that joins across tables with UNION ALL, sorted by timestamp.

### WebSocket Extension

New broadcast event when heartbeat or task completes:

```typescript
{ type: "activity", entry: ActivityEntry }
```

Added to the broadcast logic in `src/heartbeat.ts` (after `logHeartbeatRun`) and `src/task-scheduler.ts` (after `logTaskRun`). The WebSocket handler in `server/ws.ts` broadcasts to all connected clients (activity events are global, not per-chat).

---

## Feature 2: Heartbeat Manager

View, edit, add, and trigger heartbeat checklists from the dashboard.

### Endpoints

**`GET /api/heartbeats`** — List all heartbeat configs.

```typescript
interface HeartbeatConfig {
  groupFolder: string;
  groupName: string;
  hasChecklist: boolean;
  intervalMs: number;         // from HTML comment override or global default
  timeoutMs: number;
  lastRun?: {
    timestamp: string;
    status: 'ok' | 'acted' | 'error';
    actionsTaken?: string;
  };
  recentRuns: Array<{         // last 5
    timestamp: string;
    status: 'ok' | 'acted' | 'error';
  }>;
}
```

Returns one entry per registered group. Groups without a HEARTBEAT.md have `hasChecklist: false`.

**`GET /api/heartbeats/:groupFolder`** — Full detail including file content.

```typescript
interface HeartbeatDetail extends HeartbeatConfig {
  content: string;            // raw HEARTBEAT.md markdown
  runHistory: Array<{         // last 20 runs
    timestamp: string;
    status: string;
    actionsTaken?: string;
    durationMs: number;
    error?: string;
  }>;
}
```

**`PUT /api/heartbeats/:groupFolder`** — Save checklist.

Body: `{ content: string, intervalMs?: number }`

Writes to `groups/{groupFolder}/HEARTBEAT.md`. If `intervalMs` provided, injects/updates the `<!-- heartbeat-interval: {ms} -->` HTML comment at the top of the file. Creates the file if it doesn't exist.

**`POST /api/heartbeats/:groupFolder/run`** — Trigger immediate execution.

Enqueues a heartbeat run for the group, bypassing the interval/gap checks. Returns `{ queued: true }`. Result arrives via WebSocket activity event.

**`DELETE /api/heartbeats/:groupFolder`** — Disable heartbeat.

Deletes `groups/{groupFolder}/HEARTBEAT.md`. Returns `{ deleted: true }`.

### Implementation

New file: `server/heartbeat-routes.ts`. File I/O uses `fs.readFileSync` / `fs.writeFileSync` on the HEARTBEAT.md paths (already resolved via `GROUPS_DIR` in config). The "run now" endpoint calls the existing `runHeartbeatForGroup()` function from `src/heartbeat.ts`.

---

## Feature 3: Routine Detection

Fingerprint user request patterns. After 3+ similar requests, suggest automation.

### Data Model

New table: `routine_signals`

```sql
CREATE TABLE routine_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_folder TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  hour_bucket INTEGER NOT NULL,        -- 0-23
  day_of_week INTEGER NOT NULL,        -- 0-6 (Sun-Sat)
  capability TEXT NOT NULL,            -- plain_response, web_lookup, browser_operation, host_file_operation
  intent_keywords TEXT NOT NULL,       -- 2-3 extracted keywords, comma-separated
  message_hash TEXT NOT NULL           -- short hash to deduplicate exact repeats
);
CREATE INDEX idx_routine_signals_group ON routine_signals(group_folder, timestamp);
```

### Signal Collection

In the message processing path (`src/core.ts`), after capability routing resolves, insert one row per user-triggered message. Keywords extracted from the same keyword extraction already used by memory retrieval in `builder.ts`. Cost: one INSERT per message, negligible.

### Pattern Analysis

Runs during heartbeat (no new loop). New function: `detectRoutinePatterns(groupFolder)`.

Algorithm:
1. Query signals from last 14 days for the group
2. GROUP BY `capability, intent_keywords, hour_bucket` (allow +/- 1 hour tolerance by bucketing into 2-hour windows)
3. Filter clusters with COUNT >= 3
4. Exclude patterns already in HEARTBEAT.md (keyword overlap check)
5. Exclude patterns dismissed in the last 30 days

Returns `Array<{ keywords: string, capability: string, timeWindow: string, occurrences: number }>`.

### Suggestion Surfacing

Two paths:
1. **Dashboard** — Suggested Routines section in the Activity tab. Shows pattern description, occurrence count, time window. One-click "Automate" writes a checklist item to HEARTBEAT.md. "Dismiss" adds to `dismissed_routines` table with 30-day TTL.
2. **Agent prompt injection** — During heartbeat, if patterns detected, append to the heartbeat prompt: "Detected routine: user checks [X] around [time] — consider mentioning this." Agent decides whether to surface it in its response.

### Endpoints

**`GET /api/routines/:groupFolder`** — Get detected patterns for a group.

**`POST /api/routines/:groupFolder/automate`** — Convert a pattern to a heartbeat checklist item.

Body: `{ keywords: string, timeWindow: string, description: string }`

Appends to HEARTBEAT.md under a `## Automated` section.

**`POST /api/routines/:groupFolder/dismiss`** — Suppress a pattern for 30 days.

Body: `{ keywords: string }`

### Data Model for Dismissals

```sql
CREATE TABLE dismissed_routines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_folder TEXT NOT NULL,
  keywords TEXT NOT NULL,
  dismissed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
```

---

## Feature 4: Structured Lessons

When a task or heartbeat fails, extract a lesson and inject it into future prompts.

### Lesson Extraction

After a task or heartbeat logs a failure (status = 'error'), queue a lightweight lesson extraction. This is a single LLM call with a tight prompt:

```
Given this task failure:
- Task: {task prompt or heartbeat checklist}
- Error: {error message}
- Duration: {duration_ms}ms

Write a 2-3 sentence structured lesson in this format:
**Trigger:** what caused the failure
**Root cause:** why it failed
**Lesson:** what to do differently next time

Be specific and actionable. No generic advice.
```

Use the cheapest available runtime profile (or skip if no cheap profile exists — lessons are not critical path).

### Storage

New table: `lessons`

```sql
CREATE TABLE lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_folder TEXT NOT NULL,
  created_at TEXT NOT NULL,
  trigger_type TEXT NOT NULL,          -- 'task' | 'heartbeat'
  trigger_id TEXT,                     -- task_id or null
  error_summary TEXT NOT NULL,         -- one-line error
  lesson_text TEXT NOT NULL,           -- full structured lesson
  keywords TEXT NOT NULL,              -- extracted keywords for retrieval
  times_injected INTEGER DEFAULT 0,   -- how often this lesson was used
  dismissed INTEGER DEFAULT 0         -- user can dismiss stale lessons
);
CREATE INDEX idx_lessons_group ON lessons(group_folder, created_at);
```

### Injection into Context

In `src/context/builder.ts`, add a new context layer: "Lessons". During context assembly:

1. Extract keywords from the current user prompt (reuse existing extraction)
2. Query lessons table: match by group_folder + keyword overlap, ORDER BY created_at DESC, LIMIT 5
3. Format as a compact block (max 2,000 chars):

```
## Relevant Lessons
- [2026-03-30] GitHub API rate limited during morning briefing. Space API calls across heartbeat runs.
- [2026-03-28] Disk full during backup. Check disk space before large writes.
```

4. Increment `times_injected` for matched lessons

### Endpoints

**`GET /api/lessons/:groupFolder`** — List lessons for a group. Includes `times_injected` to show usefulness.

**`DELETE /api/lessons/:id`** — Dismiss a stale lesson.

---

## Feature 5: Memory Improvements

Three targeted upgrades to the existing memory system.

### 5a. Episodic Tagging

Add column to `memory_entries`:

```sql
ALTER TABLE memory_entries ADD COLUMN episode_id TEXT;
```

When multiple memories are extracted from the same agent turn, they share an `episode_id` (generated as `{group_folder}:{timestamp}`). During retrieval, if one memory from an episode matches, boost the others from the same episode by -0.5 rank.

Implementation: in `src/context/memory.ts` `extractMemoryCandidates()`, pass through a shared episode_id. In `src/db.ts` `queryMemoryFts()`, add a post-retrieval step that pulls sibling entries.

### 5b. Proactive Memory Surfacing

In `src/context/builder.ts`, after memory retrieval, if any result has:
- confidence >= 0.85
- BM25 rank in top 3
- last_confirmed_at within 30 days

Inject a hint line in the context: `Note: You previously learned: "{content}". This may be relevant.`

Cap at 1 surfaced memory per turn. Only for `fact` and `pref` kinds (not `loop` or `proj` which are more transient).

### 5c. Memory Dashboard Page

New page accessible from the sidebar. Features:
- Browse memories by group, kind (fact/pref/proj/loop), sorted by recency
- Search across all groups (uses existing FTS5 index)
- Inline edit memory content
- Delete individual entries
- Pin/unpin toggle
- Visual decay indicator (opacity or progress bar showing freshness)
- Bulk select + delete for cleanup

Endpoints:
- `GET /api/memories?group=&kind=&q=&limit=&offset=` — paginated memory list
- `PUT /api/memories/:id` — edit content
- `DELETE /api/memories/:id` — remove entry
- `PATCH /api/memories/:id/pin` — toggle pin status

---

## Feature 6: Dashboard Activity Tab UI

### Layout

The Activity tab lives in the sidebar alongside the existing chat list. Clicking it replaces the chat view with the activity view.

```
Sidebar                          Main Content
+---------------------------+    +------------------------------------------+
| [M] NanoClaw         [=]  |    |                                          |
+---------------------------+    |  Heartbeats                    [+ Add]   |
| Chats    Activity  Memory |    |                                          |
+---------------------------+    |  +------------------------------------+  |
|                           |    |  | Global          every 30m    * 2m  |  |
| (tab content changes      |    |  | Discord Main    every 1hr    * ok  |  |
|  based on selected tab)   |    |  | Sam             no heartbeat  [+]  |  |
|                           |    |  +------------------------------------+  |
|                           |    |                                          |
|                           |    |  Suggested Routines                      |
|                           |    |  +------------------------------------+  |
|                           |    |  | "Check GitHub PRs" - 4x this week |  |
|                           |    |  | [Automate]  [Dismiss]              |  |
|                           |    |  +------------------------------------+  |
|                           |    |                                          |
|                           |    |  Recent Activity                         |
|                           |    |  +------------------------------------+  |
|                           |    |  | 10:30  * Heartbeat: checked GitHub |  |
|                           |    |  | 10:00  * Task: briefing sent       |  |
|                           |    |  | 09:45  * Heartbeat: all clear      |  |
|                           |    |  | 09:00  x Task: backup failed       |  |
|                           |    |  |        > Lesson: disk space low    |  |
|                           |    |  +------------------------------------+  |
|                           |    |                                          |
|                           |    |  Today          12 hb  5 tasks  45k tkn |
|                           |    +------------------------------------------+
+---------------------------+
```

### Design Tokens (Matching Existing Theme)

All new UI uses the existing CSS custom properties. No new colors introduced.

| Element | Token | Value |
|---------|-------|-------|
| Page background | `--bg-primary` | `#0a0a0a` |
| Card background | `--bg-secondary` | `#111111` |
| Heartbeat card bg | `--bg-tertiary` | `#1a1a1a` |
| Card border | `--border` | `#222222` |
| Card hover border | `--border-hover` | `#333333` |
| Primary text | `--text-primary` | `#f5f5f5` |
| Secondary text | `--text-secondary` | `#a0a0a0` |
| Muted text | `--text-muted` | `#666666` |
| Accent (CTAs, active) | `--accent` | `#E8613A` |
| Accent hover | `--accent-hover` | `#F5A07A` |
| Success dot | `#22c55e` | green |
| Error dot | `#ef4444` | red |
| Acted dot | `--accent` | `#E8613A` (orange) |

### Typography

- Section headers: `Cormorant Garamond`, 1.15rem, weight 500, `--text-primary`
- Activity entry text: `DM Sans`, 0.87rem, `--text-primary`
- Timestamps: `DM Sans`, 0.75rem, `--text-muted`
- Stats bar numbers: `DM Sans`, 0.8rem, weight 600, `--text-secondary`
- Heartbeat card title: `DM Sans`, 0.9rem, weight 500
- Heartbeat card meta: `DM Sans`, 0.8rem, `--text-muted`

### Component Specifications

**Tab Bar (Chats | Activity | Memory)**
- Sits below the sidebar header, replacing the "Agents" section label
- Each tab: `DM Sans`, 0.8rem, weight 500, uppercase, letter-spacing 0.03em
- Inactive: `--text-muted`, no border
- Active: `--accent`, border-bottom 2px solid `--accent`
- Padding: 10px 0, gap between tabs: 20px
- Transition: color 0.2s, border-color 0.2s

**Heartbeat Card**
- Background: `--bg-tertiary`
- Border: 1px solid `--border`
- Border-radius: `--radius-sm` (8px)
- Padding: 12px 16px
- Layout: flex row, space-between, align-center
- Left side: group name (weight 500) + interval text (muted, 0.8rem)
- Right side: status dot (8px circle) + relative time ("2m ago", muted)
- Hover: border-color `--border-hover`, subtle translateY(-1px)
- Click: expands into editor panel (slide-down animation, 0.3s ease)
- Transition: all 0.2s

**Heartbeat Editor (Expanded Card)**
- Textarea: `--bg-primary` background, `--border` border, monospace font 0.85rem
- Min-height: 200px, max-height: 400px, resize vertical
- Interval picker: row of pill buttons (15m | 30m | 1hr | 2hr | custom)
  - Pill style matches existing persona chips: `--bg-tertiary`, border, 0.8rem
  - Active pill: `--accent` border, `--accent-glow-subtle` background
- Actions row: "Save" (primary button, small), "Run Now" (secondary), "Delete" (text button, `#ef4444` on hover)
- Run history: 5 small status dots (8px each, color-coded) below the interval picker, tooltip on hover showing timestamp + status

**Activity Entry**
- Layout: flex row, gap 12px, padding 10px 0
- Left: timestamp (0.75rem, muted, 50px fixed width, right-aligned)
- Center: status dot (8px, vertically centered)
- Right: flex column
  - Summary line: 0.87rem, `--text-primary`
  - Detail (if expanded): 0.8rem, `--text-secondary`, top-border `--border`, padding-top 8px
  - Lesson sub-entry: 0.8rem, `--text-muted`, indented 20px, prefixed with subtle arrow
- Hover: background `--bg-hover` (`#252525`), border-radius 8px
- Click: toggles detail expansion (slide-down, 0.2s)
- Separator: none (spacing-based, not line-based)

**Suggested Routine Card**
- Background: `--bg-tertiary` with left border 3px solid `--accent`
- Border-radius: 8px
- Padding: 12px 16px
- Description: 0.87rem, `--text-primary`
- Occurrence count: 0.8rem, `--text-muted`
- Buttons: "Automate" (small primary, `--accent`), "Dismiss" (text button, `--text-muted`)
- Gap between buttons: 12px
- Animation on appear: fade-in + slide from left (0.3s)

**Stats Bar**
- Bottom of activity view, sticky
- Background: `--bg-secondary`, top-border `--border`
- Padding: 12px 16px
- Layout: flex row, space-between
- Left: date label ("Today", 0.8rem, muted)
- Right: 3 stat groups separated by centered dot
- Each stat: number (weight 600, `--text-secondary`) + label (muted)
- No glow, no accent — understated

**Memory Page**
- Accessed via "Memory" tab in sidebar
- Search bar at top: same style as chat input but single-line, with search icon
- Filter pills below search: kind filters (All | Facts | Preferences | Projects | Loops)
  - Pill style: same as persona chips / heartbeat interval pills
- Memory list: each entry is a compact card
  - Background: `--bg-tertiary`, border, border-radius 8px
  - Left side: kind badge (4px colored left border: fact=blue, pref=purple, proj=green, loop=orange)
  - Content: 0.87rem, max 2 lines, overflow ellipsis
  - Meta row: group name, age ("3 days ago"), decay bar (thin 40px bar, fill proportional to freshness)
  - Hover: show edit/delete/pin icons (0.8rem, muted, appear on hover)
  - Pin indicator: small filled circle icon next to pinned entries, `--accent` color
- Bulk mode: checkbox appears on left of each card, bottom action bar with "Delete Selected"

### Animations

All animations use `motion/react` (Framer Motion) consistent with existing patterns.

**Tab switching:**
- Content fade: exit `{ opacity: 0, y: -8 }`, enter `{ opacity: 1, y: 0 }`, 0.2s

**Heartbeat card expand:**
- Height auto-animate via `layout` prop
- Content: `{ opacity: 0, height: 0 }` to `{ opacity: 1, height: 'auto' }`, 0.3s, ease `[0.16, 1, 0.3, 1]`

**Activity entry appear (real-time):**
- New entries slide in: `{ opacity: 0, y: -12 }` to `{ opacity: 1, y: 0 }`, 0.3s
- Existing entries shift down smoothly via `layout` animation

**Suggested routine appear:**
- `{ opacity: 0, x: -20 }` to `{ opacity: 1, x: 0 }`, 0.3s

**Status dots:**
- Pulse animation on latest dot: scale 1 to 1.3 to 1, 2s, once on mount

---

## Implementation Order

Build in this order, each step independently shippable:

1. **Activity Feed API** — `GET /api/activity`, `GET /api/activity/summary`, WebSocket broadcast
2. **Heartbeat Manager API** — CRUD endpoints for HEARTBEAT.md files + run trigger
3. **Activity Tab UI** — Tab bar, activity feed view, heartbeat cards, stats bar
4. **Heartbeat Editor UI** — Expand card, markdown editor, interval picker, run now
5. **Routine Detection Backend** — `routine_signals` table, signal collection, pattern analyzer
6. **Suggested Routines UI** — Cards with automate/dismiss actions
7. **Structured Lessons Backend** — Lesson extraction on failure, storage, context injection
8. **Lessons UI** — Show lessons inline with failed activity entries, lessons page
9. **Memory Improvements Backend** — Episodic tagging, proactive surfacing
10. **Memory Dashboard Page** — Browse, search, edit, pin, bulk delete

---

## Out of Scope

These are explicitly deferred:

- Approval flows for risky actions (Feature 2 territory)
- Job queue with kill/retry/fork (Feature 2 territory)
- Webhook inbound HTTP triggers
- Self-extending skills (agent writing its own skill files)
- Session JSONL branching / rewind
- Sandboxed code execution beyond container bash
- Cross-group memory sharing
- Semantic embeddings / vector search (BM25 + FTS5 is sufficient for now)

---

## Database Migrations

Three new tables, one altered table:

```sql
-- routine_signals
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

-- dismissed_routines
CREATE TABLE IF NOT EXISTS dismissed_routines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_folder TEXT NOT NULL,
  keywords TEXT NOT NULL,
  dismissed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- lessons
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

-- episodic tagging
ALTER TABLE memory_entries ADD COLUMN episode_id TEXT;
```

---

## Testing Strategy

- **API endpoints**: Integration tests hitting Express routes with test DB (follows existing pattern in `server/*.test.ts`)
- **Routine detection**: Unit test the pattern analyzer with synthetic signal data
- **Lesson extraction**: Unit test prompt building; mock LLM call in tests
- **Context injection**: Unit test that lessons and episodic memories appear in built context
- **Dashboard UI**: Manual testing against running dev server (consistent with existing approach)
