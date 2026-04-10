# Features We Need To Add

This file is the living checklist for NanoClaw. It has two jobs:

1. record what is already shipped so we do not re-plan finished work
2. keep the remaining roadmap short, honest, and easy to scan

Update this file whenever a meaningful feature lands or a planned item is deliberately deferred.

## Current Product Snapshot

NanoClaw is no longer just a Claude/container prototype. The current build is a local-runtime-first assistant platform with:

- a host orchestrator
- runtime profiles and failover
- encrypted auth profiles
- a command center CLI
- lightweight web tools
- a host-managed browser operator stack
- planner-critic meta tools for complex work

## Completed Foundations

Use this section as the "already done" checklist.

### Runtime And Orchestration

- [x] Local OpenAI-compatible runtime path for LM Studio / Ollama / compatible endpoints
- [x] Runtime profile storage and selection
- [x] Runtime failover and retry foundation
- [x] Capability routing with `plain_response`, `web_lookup`, `browser_operation`, `deny_or_escalate`
- [x] Native runner path for OpenAI-compatible models
- [x] Optional Claude-compatible path preserved separately

### Auth And Endpoint Management

- [x] Auth profile system
- [x] Encrypted host credential vault
- [x] Runtime-to-auth profile binding
- [x] Local endpoint profiles
- [x] Capability probing and cached provider compatibility metadata
- [x] Compatibility-safe `.env` fallback for older installs

### Command Center / Operator Surface

- [x] `nanoclaw onboard`
- [x] `nanoclaw init`
- [x] `nanoclaw auth`
- [x] `nanoclaw models`
- [x] `nanoclaw local`
- [x] `nanoclaw status`
- [x] `nanoclaw doctor`
- [x] `nanoclaw launch-check`
- [x] `nanoclaw debug`
- [x] `nanoclaw smoke`
- [x] `nanoclaw context`
- [x] `nanoclaw memory`
- [x] `nanoclaw tools`
- [x] `nanoclaw backend`
- [x] `nanoclaw skills`
- [x] `nanoclaw logs`
- [x] `nanoclaw tui`

### Installed Model Tooling

These are the tool families that exist in the runner today.

#### Browser operator tools

- [x] `browser_open_url`
- [x] `browser_snapshot`
- [x] `browser_click`
- [x] `browser_type`
- [x] `browser_select`
- [x] `browser_extract_text`
- [x] `browser_screenshot`
- [x] `browser_tabs`
- [x] `browser_close`

#### Lightweight web tools

- [x] `web_search`
- [x] `web_fetch`
- [x] `web_open_url`
- [x] `web_extract_text`
- [x] `web_get_links`
- [x] `web_close`
- [x] `web_browse` backward-compatibility shim

#### Planner / quality meta tools

- [x] `create_plan`
- [x] `critique_response`

#### Memory tools

- [x] `remember_this` — durable fact save with kind, pin, and explicit-source boosting
- [x] `memory_search` — active mid-task recall via bidirectional IPC to host FTS5 index

### Browser Operator Foundation

- [x] Central host-owned `BrowserManager`
- [x] Host-managed Playwright browser sessions
- [x] Session ownership model
- [x] Ephemeral and persistent session support
- [x] Attached session type declared and blocked by policy
- [x] Session caps and tab caps
- [x] Idle cleanup
- [x] Snapshot-plus-ref interaction model
- [x] Host IPC bridge between runner and browser manager
- [x] Browser budget and policy controls
- [x] Browser bootstrap flow from prompt/domain to managed browser

### Web / Browser Decision Logic

- [x] Host-first capability routing
- [x] Browser route only when policy allows
- [x] Web route remains separate from browser route
- [x] Browser turns can use supporting `web_search` when no URL is given
- [x] Recovery prompt when the model drifts out of tool use
- [x] Tool-loop time budgets increased for real-world browser work

### Planner-Critic

- [x] Per-turn planner state
- [x] Workload-based planning intensity (`off`, `optional`, `recommended`)
- [x] Planning exposed only for structurally multi-step work
- [x] Recommended planning turns force `create_plan` first using provider-safe `tool_choice: required`
- [x] `critique_response` only appears after planning or substantial work
- [x] Plan-progress note injection during execution
- [x] Adaptive budget expansion after plan creation

### Reliability / Quality Improvements

- [x] Continuity filtering to remove repeated low-signal assistant fallbacks
- [x] Local context trimming for smaller context windows
- [x] Runtime prompt sanitization for OpenAI-compatible path
- [x] Final synthesis pass when tools ran but visible final text is empty
- [x] Better timeout and budget alignment across host, runtime, and browser layers
- [x] Process lock hardening against stale PID reuse

## Partially Complete

These areas exist but are not fully finished.

- [~] Browser permission model
  - policy flags exist
  - approval UX and full revocation flow are not complete
- [~] Browser auditing / observability
  - logs exist
  - persistent browser audit model is not fully complete
- [x] Memory compaction and FTS5 retrieval
  - FTS5 index with BM25 ranking, explicit-source boost, temporal decay
  - pinned entries always injected, FTS retrieved per turn by keyword
  - `remember_this` writes to FTS5 immediately; `memory_search` reads on demand
  - compaction carry-forward preserves older durable facts across cycles
  - proactive memory-flush advisory injected mid-loop during long agentic tasks
- [~] Background task and browser reuse integration
  - task system exists
  - browser-task lifecycle is still limited

## Remaining High-Priority Features

These are the main items still worth building next.

### Proactive Autonomy (Inspired by OpenClaw)

- [ ] **Heartbeat loop** — agent wakes on a schedule, reads `HEARTBEAT.md` (plain English checklist), and acts without being triggered. The single biggest "alive" feeling feature. Zero RAM cost.
- [ ] **Webhooks (inbound HTTP triggers)** — expose HTTP endpoints so external services (GitHub, Stripe, smart home, etc.) can activate the agent without a user message.
- [ ] **Internal hooks** — event-driven scripts that fire on workspace events (tool used, file written, session ended). Deterministic enforcement without relying on model memory.
- [ ] **Self-extending skills** — agent can write new skill files itself to acquire capabilities it doesn't have yet. Makes the system appear self-improving over time.

### Core Product Work

- [ ] Tool policy profiles beyond current family toggles (`minimal/coding/messaging/full`)
- [ ] Advanced session routing controls (DM scope, identity/session mapping)
- [ ] Background process tooling with visible long-running job control
  - includes background shell session management (list, poll, log, kill background processes)
  - cron retry with exponential backoff for reliability on flaky local models
- [ ] Streaming/chunking response UX improvements — makes local model latency feel less painful
- [ ] Approval flows and elevated mode for risky actions
- [ ] Health tooling polish and deeper launch diagnostics
- [ ] Session JSONL + branching — inspectable, branchable session history (rewind/fork any point)
- [ ] Sandboxed code execution (Python/JS) — safe code running beyond bash, isolated from host

### Intelligence And Memory

- [ ] Personal knowledge graph + memory tiers
- [ ] Routine learning ("teach once, repeat forever")
- [ ] Quality gates for multi-agent or high-impact workflows
- [ ] SLO-based self-healing runtime
- [ ] Model fallback chains — named ordered fallback: e.g. `Llama → Mistral → Qwen → fail`, per capability

### Control And Visibility

- [ ] Control UI / dashboard
- [ ] Secure device pairing
- [ ] Browser session visibility commands and audit views in command center

## Explicitly Deferred

- [ ] Full desktop / computer-use mouse-keyboard control
- [ ] Silent attachment to the user's personal browser
- [ ] Multiple browser engines or parallel scraping stacks
- [ ] Embeddings / vector DB memory in v1
- [ ] Manual model chooser UX
- [ ] Arena / demo / compare-many-models product mode
- [ ] Session tools for delegation (`spawn/send/history/list`) — too RAM-heavy for local models

## Direction Reminder

Goal: make NanoClaw feel highly intelligent and highly useful through orchestration quality, memory quality, browser capability, reliability, and safe automation, while keeping the runtime lean enough for local models.
