# MicroClaw Dashboard — Backend Design Spec

**Date:** 2026-03-29
**Status:** Approved
**Scope:** Backend architecture, API, data model, packaging. UI design is deferred to a separate spec.

---

## Overview

Add a web dashboard to MicroClaw as its **primary interface**. A single command (`npx microclaw`) starts the server, opens the browser, and presents an onboarding wizard (first run) or the dashboard (subsequent runs). Messaging channels (Telegram, Discord, WhatsApp, etc.) become optional secondary interfaces configurable from the dashboard.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Architecture | Integrated — single process | Existing orchestrator stays intact; Express + WebSocket added to the same Node.js process. No coordination overhead. SQLite stays happy (single writer). |
| Primary interface | Dashboard (browser) | Messaging channels are optional add-ons. Users who never touch a terminal or set up Telegram can still use MicroClaw fully. |
| Onboarding | 100% browser-side | `npx microclaw` does zero CLI prompts. Starts server, opens browser. First visit shows onboarding wizard. Subsequent visits go straight to dashboard. |
| Container requirement | Optional | If Docker/Podman available, use containers. If not, run agents as host child processes. Personal local tool — host execution is acceptable. |
| Agent model | Single agent first | Start with one configurable agent. Multi-agent and teams are future phases — no schema or API for them until single-agent dashboard chat is solid. |
| Chat model | Thread-based | Channels on the left, threaded conversations, agents respond in-line. Mirrors Slack/Discord patterns. |
| Real-time | WebSocket for chat, polling for rest | Chat messages stream via WebSocket. Agent status, tasks, logs poll every few seconds. |
| Database | Extend existing tables, not parallel stores | Dashboard is another channel/transport. Messages go into the existing `chats` + `messages` tables with `source` metadata. No separate dashboard message store. |
| Storage paths | Repo-local (existing) | Keep current `groups/`, `data/` paths for v1. No migration to `~/.microclaw/` yet. |
| Auth | None (local_trusted) | Single user, localhost only. No login, no sessions, no tokens. |
| Packaging | Single npm package via npx | `"bin": { "microclaw": "dist/cli/index.js" }`. Pre-built UI bundled as static assets. |

---

## Phase 0: App Core Extraction

**Problem:** `src/index.ts` is currently a ~700-line monolith that tightly couples channel initialization, message polling, state management, prompt building, and agent execution. It assumes at least one messaging channel exists to function. The dashboard can't drive the runtime without going through a messaging channel's code path.

**Solution:** Extract an `AppCore` service layer from `src/index.ts` that owns the runtime lifecycle and can be driven by any transport — CLI, HTTP, or messaging channel.

### What AppCore owns

```typescript
// src/core.ts
export class AppCore {
  // Lifecycle
  async start(): Promise<void>       // init db, load state, start scheduler
  async stop(): Promise<void>        // save state, close db, cleanup

  // Message processing (transport-agnostic)
  async handleMessage(msg: InboundMessage): Promise<AgentResponse>

  // State
  getRegisteredGroups(): Record<string, RegisteredGroup>
  registerGroup(jid: string, group: RegisteredGroup): void

  // Agent execution
  async executeAgent(opts: ExecuteOpts): Promise<AgentResponse>

  // Accessors for subsystems (used by API routes)
  get db(): DatabaseAccessor
  get scheduler(): TaskScheduler
  get channels(): ChannelRegistry
}

interface InboundMessage {
  chatJid: string
  content: string
  sender: string
  senderName: string
  source: 'dashboard' | 'telegram' | 'discord' | 'whatsapp' | 'slack' | 'gmail'
  timestamp: string
}
```

### What stays in `src/index.ts`

The file becomes thin startup glue:
1. Create `AppCore` instance
2. Register messaging channels (if configured)
3. Start the message polling loop for messaging channels
4. Start the Express server (dashboard)

### What this enables

- Dashboard calls `core.handleMessage()` directly — no fake channel adapter needed
- CLI can call `core.handleMessage()` for headless operation
- Messaging channels continue to work exactly as before
- The runtime can start with **zero external channels** and be fully functional via the dashboard alone

---

## System Architecture

```
npx microclaw
    |
    v
+--------------------------------------------------+
|              MicroClaw Process                    |
|                                                   |
|  +---------+                                      |
|  | AppCore | ---- owns runtime lifecycle          |
|  +---------+                                      |
|       |                                           |
|  +----+-------+----------+------------------+     |
|  |            |          |                  |     |
|  | Express    | Channel  | Container /      |     |
|  | Server     | Registry | Host Runtime     |     |
|  |            |          |                  |     |
|  | REST API   | Telegram | Agent exec       |     |
|  | WebSocket  | Discord  | Tool loop        |     |
|  | Static UI  | WhatsApp | Sandboxed or     |     |
|  |            | (opt.)   | direct host      |     |
|  +------------+----------+------------------+     |
|       |              |              |             |
|       +--------------+--------------+             |
|                   SQLite                          |
+--------------------------------------------------+
         |                          |
    Browser (UI)              Messaging Apps
    port 3100                 (optional)
```

The Express server and messaging channels are peers — both drive `AppCore`. Neither is special.

---

## Browser as a Channel

The dashboard is implemented as a **first-class channel** in the existing channel registry, not as a parallel subsystem. It follows the same `Channel` interface as Telegram, Discord, etc.

### Registration

```typescript
// src/channels/dashboard.ts
import { registerChannel } from './registry.js';

registerChannel('dashboard', (opts) => {
  // Returns a Channel implementation backed by WebSocket
  return new DashboardChannel(opts);
});
```

### How it fits

| Concern | Telegram | Dashboard |
|---------|----------|-----------|
| Receives messages | Telegram Bot API | WebSocket from browser |
| Sends responses | Telegram Bot API | WebSocket to browser |
| Stores messages | `chats` + `messages` tables | Same `chats` + `messages` tables |
| JID format | Telegram chat ID | `dashboard:channel-name` |
| Identifies source | `channel: 'telegram'` | `channel: 'dashboard'` |
| Typing indicator | `sendChatAction` | WS `{type: "status", status: "thinking"}` |

### Existing schema extension (not new tables)

Add `source` and `thread_id` columns to the existing `messages` table:

```sql
ALTER TABLE messages ADD COLUMN source TEXT DEFAULT 'whatsapp';
ALTER TABLE messages ADD COLUMN thread_id TEXT;
```

Add `source` column to existing `chats` table:

```sql
ALTER TABLE chats ADD COLUMN source TEXT DEFAULT 'whatsapp';
```

This lets every transport write to the same store. The dashboard UI queries messages with `WHERE chat_jid = ? AND source = 'dashboard'` or shows all sources for a unified view.

### Agents table (v1 — single agent, extensible later)

```sql
CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    model TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'openai_compatible',
    personality TEXT,
    tools TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE setup (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

No teams tables. No separate dashboard_channels or dashboard_messages tables. Teams, multi-agent, and delegation are future work — they get designed when single-agent chat is solid.

---

## Entry Point: `npx microclaw`

### Startup Sequence

1. Check Node.js >= 20. Fail with install link if missing.
2. Use existing repo-local paths (no `~/.microclaw/` migration):
   - `data/` — SQLite database (existing)
   - `groups/` — per-group memory and files (existing)
   - `logs/` — log files (existing)
3. First run? (no setup record in DB)
   - YES: initialize SQLite, start server, open browser to `/onboarding`
   - NO: load config, start server, open browser to `/`
4. Express server starts on port 3100 (auto-detect next available if taken via `detect-port`).
5. AppCore starts (channels connect if configured, scheduler resumes, runtime initializes). Works fine with zero messaging channels.
6. Browser opens automatically (via `open` npm package).

### Terminal Output

Minimal. No interactive prompts.

```
MicroClaw v1.3.0
Dashboard: http://localhost:3100
Press Ctrl+C to stop
```

### Graceful Shutdown

Ctrl+C cleanly: stop Express, disconnect channels, save state, close SQLite, exit.

---

## API Routes

### Setup & Health

```
GET  /api/health                    Server status, uptime, model connection
GET  /api/setup                     Onboarding state (completed or not)
POST /api/setup                     Save initial config (provider, model, API key)
POST /api/setup/test-connection     Test model endpoint, return success/error
```

### Agents (v1: single agent CRUD)

```
GET    /api/agents                  List all agents
POST   /api/agents                  Create agent {name, model, provider, personality, tools}
GET    /api/agents/:id              Agent details
PUT    /api/agents/:id              Update agent config
DELETE /api/agents/:id              Delete agent
```

### Chat (reads/writes existing messages table)

```
GET    /api/chats                   List chats (filter by source=dashboard)
POST   /api/chats                   Create chat (registers a group internally)
GET    /api/chats/:jid/messages     Message history (paginated, ?limit=50&before=timestamp)
POST   /api/chats/:jid/messages     Send message (calls AppCore.handleMessage)
```

### Tasks

```
GET    /api/tasks                   List scheduled tasks
POST   /api/tasks                   Create task
PUT    /api/tasks/:id               Update / pause / resume
DELETE /api/tasks/:id               Cancel task
GET    /api/tasks/:id/runs          Task run history
```

### Memory

```
GET    /api/memory                  Search memories (?q=query)
POST   /api/memory                  Create memory entry
DELETE /api/memory/:id              Delete memory
```

### Tools

```
GET    /api/tools                   List available tool families & individual tools
PUT    /api/tools/config            Update tool config (e.g. allowed host directories)
```

### External Messaging Channels

```
GET    /api/messaging-channels              List external channels (Telegram, Discord, etc.)
POST   /api/messaging-channels              Add external channel
DELETE /api/messaging-channels/:id          Remove external channel
GET    /api/messaging-channels/:id/status   Connection status
```

### Settings

```
GET    /api/settings                Current configuration
PUT    /api/settings                Update configuration
```

---

## WebSocket Protocol

**Endpoint:** `/api/chat/ws`

The WebSocket is the transport layer for the dashboard channel. When a message comes in over WS, the dashboard channel adapter writes it to the existing `messages` table and calls `AppCore.handleMessage()` — the same path any other channel takes.

### Client to Server

```json
{ "type": "message", "chatJid": "...", "content": "..." }
{ "type": "subscribe", "chatJid": "..." }
{ "type": "unsubscribe", "chatJid": "..." }
```

### Server to Client

```json
{ "type": "message", "chatJid": "...", "from": "agent-name", "content": "...", "timestamp": "..." }
{ "type": "stream", "chatJid": "...", "from": "agent-name", "delta": "..." }
{ "type": "stream_end", "chatJid": "...", "from": "agent-name" }
{ "type": "status", "agentId": "...", "status": "thinking|idle|error" }
```

Chat messages stream token-by-token via `stream`/`stream_end`. The server taps into the same IPC output stream the orchestrator uses for container agent responses.

---

## Data Flow

### Dashboard Message (same path as any channel)

```
Browser ---- WS: {message} ----> Dashboard Channel Adapter
                                        |
                                        +-- Write to messages table (source='dashboard')
                                        |
                                        +-- AppCore.handleMessage()
                                        |
                                        +-- Orchestrator resolves agent, builds context
                                        |
                                        +-- Container-runner (or host process)
                                        |
Browser <-- WS: {status:thinking} ------+
                                        |
                                        |   IPC stream: tokens from agent
                                        |
Browser <-- WS: {stream, delta} --------+
                                        |
Browser <-- WS: {stream_end} -----------+
                                        |
                                        +-- Save response to messages table (source='dashboard')
```

### External Channel Message (existing path, unchanged)

```
Telegram --> Channel Registry --> SQLite Queue --> Orchestrator
                                                      |
                                                 Container/Host
                                                      |
                                                 Response saved to messages table
                                                      |
                                              +-------+--------+
                                              |                |
                                         Telegram          Dashboard
                                         (reply)        (WS broadcast
                                                         if subscribed)
```

Messages from external channels appear in the dashboard because they're in the same `messages` table. The dashboard can query all messages for a chat regardless of source.

---

## Project Structure

```
microclaw/
  src/
    core.ts                       # NEW -- AppCore service layer
    index.ts                      # REFACTORED -- thin startup glue
    channels/
      dashboard.ts                # NEW -- dashboard as a channel
      telegram.ts                 # existing
      discord.ts                  # existing
      registry.ts                 # existing
    ...                           # existing files untouched
  container/                      # existing agent runner (untouched)
  ui/                             # NEW -- React + Vite app
    src/
    index.html
    vite.config.ts
    package.json
    dist/                         # pre-built at publish time
  server/                         # NEW -- Express API layer
    index.ts                      # create Express app, mount routes, serve UI
    api/                          # route handlers
      agents.ts
      chats.ts
      tasks.ts
      memory.ts
      tools.ts
      settings.ts
      setup.ts
      messaging-channels.ts
    ws.ts                         # WebSocket handler
    middleware.ts                  # error handling, logging
  groups/                         # existing (repo-local, unchanged)
  package.json                    # updated: bin, dependencies
```

### New Dependencies

```
express          HTTP server
ws               WebSocket
open             auto-open browser
detect-port      find available port
```

### Build & Packaging

```json
{
  "bin": { "microclaw": "dist/cli/index.js" },
  "scripts": {
    "build:ui": "cd ui && npm run build",
    "build:server": "tsc",
    "build:all": "npm run build:ui && npm run build:server",
    "start:dashboard": "node dist/cli/index.js"
  }
}
```

At publish time:
1. `tsc` compiles server + cli to `dist/`
2. `vite build` compiles UI to `ui/dist/`
3. `npm publish` includes compiled JS + pre-built UI assets
4. `express.static('ui/dist')` serves the SPA with catch-all fallback to `index.html`

---

## Implementation Order

This is a large system. Build incrementally:

**Phase 0 — App Core Extraction**
- Extract `AppCore` from `src/index.ts`
- `AppCore` owns: db init, state load/save, group registration, message handling, agent execution
- `src/index.ts` becomes thin startup glue that wires channels + server to AppCore
- Runtime starts and works with zero messaging channels
- All existing tests still pass

**Phase 1 — Foundation**
- Express server serving static UI placeholder
- `src/channels/dashboard.ts` — dashboard as a registered channel
- Setup API (onboarding wizard backend)
- `source` and `thread_id` columns added to existing `messages`/`chats` tables
- `agents` table (single agent v1)
- `setup` table (KV for onboarding state)
- Health endpoint
- CLI entry point: `npx microclaw` → start server → open browser

**Phase 2 — Single Agent Chat**
- WebSocket handler (dashboard channel transport)
- Chat API (reads/writes existing messages table)
- Agent CRUD API
- Streaming agent responses via WebSocket
- Connect to existing container-runner / host process execution via AppCore

**Phase 3 — Full Dashboard APIs**
- Tasks API (wrapping existing task-scheduler)
- Memory API
- Tools API
- Settings API
- External messaging channels API (add/remove Telegram/Discord from dashboard)

**Phase 4 — Cross-Channel & Polish**
- Cross-channel message visibility (Telegram messages visible in dashboard)
- Agent status monitoring
- Error recovery and reconnection
- PostgreSQL optional backend

**Future — Teams (separate spec)**
- Multi-agent support
- Teams CRUD API + schema
- Delegation protocol
- Team-aware context building

---

## Out of Scope (This Spec)

- UI design and component architecture (separate spec)
- Multi-agent / teams (separate spec after single-agent is solid)
- Authentication / multi-user support
- Cloud deployment
- Storage path migration to `~/.microclaw/`
- Mobile app
- Plugin system
