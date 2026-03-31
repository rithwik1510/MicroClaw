# Claude Code Source Lessons

Lessons extracted from the leaked Claude Code TypeScript source (instructkr/claude-code, March 31 2026). ~512K lines, Bun runtime, React+Ink terminal UI.

---

## Architecture

### 1. Parallel Prefetch at Startup

Before heavy module imports even begin (~135ms), Claude Code fires off side-effects:
- MDM settings read (plutil/reg query subprocesses)
- Keychain prefetch (macOS OAuth + legacy API key)
- API preconnect (TCP handshake to api.anthropic.com)

All run as import-time side-effects, not awaited. By the time the main module finishes evaluating, these are already resolved. **Lesson:** Cold-start latency matters. Move I/O-bound initialization to import-time side-effects so they overlap with module evaluation.

### 2. Dead Code Elimination via Feature Flags

Uses Bun's `feature()` macro from `bun:bundle`. Unreleased features (KAIROS, PROACTIVE, DAEMON, VOICE_MODE, etc.) are gated so the compiler strips entire code paths at build time. Not runtime checks — the code literally doesn't exist in the binary.

```typescript
if (feature('KAIROS')) {
  // This entire block is removed in non-KAIROS builds
}
```

**Lesson:** Feature flags that compile away > runtime feature flags. No dead code overhead, no accidental activation. NanoClaw could use similar approach with build-time constants.

### 3. Branded Types for Safety

System prompt is `readonly string[]` branded type — not a plain string. Prevents accidentally passing a raw string where a structured prompt array is expected. Similarly, `AgentId` is a branded string type preventing mix-ups with session IDs.

**Lesson:** Brand critical types to prevent subtle bugs. A `GroupFolder` branded type in NanoClaw would prevent folder/JID mix-ups.

---

## Query Loop

### 4. State-Transition-Reason Pattern

The core query loop carries a mutable `State` object. Instead of ad-hoc retry logic, each `continue` writes a full state object with a `transition` field explaining WHY the loop continued:

```typescript
state = {
  ...state,
  transition: { reason: 'reactive_compact_retry' },
  hasAttemptedReactiveCompact: true,
}
continue
```

**Lesson:** Every retry should record its reason. Makes debugging recovery paths trivial. NanoClaw's message loop has retry logic scattered across multiple catch blocks — consolidating into a state-transition pattern would help.

### 5. Streaming Tool Execution

Tools start executing **while the model is still streaming**. When the model emits a complete tool_use block mid-stream, execution begins immediately rather than waiting for the full response. Completed tool results are yielded inline.

**Lesson:** Don't wait for the full model response before starting tool work. This is a significant latency win, especially for multi-tool turns. NanoClaw's container agent runner processes tools sequentially after the full response.

### 6. Withheld Error Pattern

When a recoverable error occurs (e.g., prompt-too-long), it's pushed to `assistantMessages` for recovery logic but NOT yielded to the SDK stream until recovery is exhausted. Only if all recovery paths fail does the error surface to the user.

```
Error happens → buffer it → try compact → try context collapse → try truncation → if all fail, THEN show error
```

**Lesson:** Buffer errors and attempt recovery before showing them. Users should only see errors that are genuinely unrecoverable. NanoClaw surfaces container errors immediately — adding a recovery buffer would reduce noise.

### 7. Max Output Token Recovery

When the model hits the output token limit mid-response, Claude Code injects a meta-message: "Output token limit hit. Resume directly from where you left off." This happens up to 3 times. It also escalates the token budget (8K → 16K → 64K) progressively.

**Lesson:** Don't treat output limits as failures. Inject a continuation prompt and retry. NanoClaw's container runner could adopt this for long agent outputs.

---

## Context & Memory

### 8. Nine-Section Structured Compact Prompt

When conversations get too long, compaction uses a structured 9-section format:

1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections (with full code snippets)
4. Errors and fixes
5. Problem Solving
6. **ALL user messages** (critical — prevents intent drift)
7. Pending Tasks
8. Current Work
9. Optional Next Step (with direct quotes to prevent task drift)

Uses an `<analysis>` scratchpad that's stripped before the summary enters context — chain-of-thought without wasting context tokens.

**Lesson:** NanoClaw's conversation summaries are unstructured. This 9-section format with the analysis scratchpad would dramatically improve summary quality. The "ALL user messages" requirement is crucial — without it, the model loses track of what the user actually asked for.

### 9. Post-Compact File Restoration

After compaction, Claude Code re-reads the 5 most recently accessed files (capped at 50K tokens total, 5K per file) and re-injects invoked skills. This restores working context that was lost during summarization.

**Lesson:** Compaction destroys file context. Re-reading recent files after compact is cheap and prevents the "agent forgot what file we were working on" problem. NanoClaw should add this.

### 10. DANGEROUS_ Prefix for Cache-Breaking Operations

System prompt sections that recompute every turn (breaking the prompt cache) are named `DANGEROUS_uncachedSystemPromptSection()` — forcing developers to explicitly acknowledge the cache cost:

```typescript
DANGEROUS_uncachedSystemPromptSection('date', () => `Today is ${date}`, 'changes daily')
```

**Lesson:** Make expensive operations visually obvious. The naming convention prevents accidental cache-busting. NanoClaw's context builder doesn't distinguish cached vs uncached sections.

### 11. Memory System (memdir)

File-based memory at `~/.claude/projects/<slug>/memory/`:
- `MEMORY.md` is the index file (capped at 200 lines / 25KB)
- Topic files have YAML frontmatter with `name`, `description`, `type`
- Four types: user, feedback, project, reference
- Two-step saving: write file, then add pointer to MEMORY.md
- Tells the model "This directory already exists — write to it directly" (prevents wasted mkdir calls)

**KAIROS daily-log mode:** Append-only daily log files at `memory/logs/YYYY/MM/YYYY-MM-DD.md`, with a nightly `/dream` skill that distills logs into durable memories.

**Lesson:** NanoClaw's memory is more sophisticated (FTS5, decay, pinning), but the KAIROS daily-log + dream distillation pattern is interesting. A nightly job that reviews daily notes and promotes the important ones to durable memory would improve NanoClaw's memory quality.

---

## Tools & Permissions

### 12. Deferred Tool Loading (ToolSearch)

When MCP tools exceed a percentage of the context window, tools are sent with `defer_loading: true`. The API excludes them from token counting. Tools are discovered on-demand via `ToolSearchTool` keyword search.

```
Many MCP tools installed → auto-enable deferred mode → tools get one-line stubs → model discovers via ToolSearch when needed
```

**Lesson:** As NanoClaw's container tools grow, context overhead becomes real. Deferred loading with on-demand discovery prevents tool descriptions from eating the context budget.

### 13. Two-Stage Auto-Mode Classifier

The "yolo mode" classifier uses two stages:
1. **Fast binary check** (64 max tokens, stop sequences) — most calls pass here
2. **Slow reasoning** (only fires when stage 1 blocks) — reduces false positives

This is a general pattern: fast path for the common case (approve), slow path only for edge cases (potential block).

**Lesson:** Any AI-based safety check should be two-stage. NanoClaw's container isolation is the primary security boundary, but if approval workflows are added, the two-stage pattern minimizes latency for safe operations.

### 14. Bash Security via Tree-Sitter AST

~2600 lines of bash security checks in layers:
- **Pattern rejection:** Command substitution (`$()`), dangerous variables (`$IFS`, `$BASH_ENV`), control characters, unicode whitespace
- **Command-specific validators:** git commit message injection, jq `system()` calls, git force-push to main
- **Tree-sitter AST analysis:** Heredocs inside command substitutions, backslash-escaped operators, comment/quote desync attacks

Each check has a numeric ID for telemetry without leaking security details:
```typescript
const BASH_SECURITY_CHECK_IDS = {
  INCOMPLETE_COMMANDS: 1,
  JQ_SYSTEM_FUNCTION: 2,
  // ...22 total
}
```

**Lesson:** NanoClaw relies on container isolation for bash security. But defense-in-depth matters — the command-specific validators (blocking `git push --force` to main, blocking `$()` in git commit messages) are cheap to add and catch accidental damage even inside a sandbox.

### 15. Tool Result Budget / Disk Persistence

When tool output exceeds `maxResultSizeChars`, it's persisted to disk and the model receives a preview + file path instead of the full result. This prevents a single large tool output from blowing the context.

Exception: `FileReadTool` sets `maxResultSizeChars: Infinity` to avoid circular Read→file→Read loops.

**Lesson:** NanoClaw's container tool outputs go directly into context. Capping tool result size and offloading large outputs to disk would prevent a single `grep` result from consuming the entire context budget.

---

## Scheduling & Automation

### 16. Deterministic Jitter for Cron Tasks

When recurring tasks fire, a deterministic jitter (seeded by task ID hash) prevents all tasks from firing at exactly `:00`. For one-shot tasks, backward jitter fires slightly early on round times.

```typescript
jitteredNextCronRunMs(cron, fromMs, taskId, cfg)
```

**Lesson:** NanoClaw's heartbeat fires all groups at the same interval. Adding per-group jitter would spread the load and prevent simultaneous container spawns.

### 17. Cross-Session Lock for Cron

File-based lock prevents two sessions from double-firing the same task. Non-owning sessions probe periodically to take over if the owner crashes.

**Lesson:** NanoClaw uses a process lock but doesn't have per-task locking. If multiple NanoClaw instances ever run (e.g., service + dev mode), tasks could double-fire.

### 18. Missed Task Detection

On startup, one-shot tasks whose fire time has passed are surfaced to the user: "Do NOT execute these prompts yet. First ask the user whether to run each one now."

**Lesson:** NanoClaw's scheduler runs missed tasks silently on startup. Surfacing them for user confirmation (especially for time-sensitive tasks) would be more correct.

### 19. Session-Only Tasks (durable: false)

Tasks created by teammates/subagents with `durable: false` are never written to disk. They die with the process. Prevents subagent-created tasks from accumulating.

**Lesson:** NanoClaw's scheduled tasks are all durable. Adding a `durable: false` option for ephemeral/one-off tasks created by heartbeat or automation would reduce task table bloat.

---

## Subagents & Delegation

### 20. Fork vs Fresh Subagents

Two subagent paradigms:
- **Fresh agents** (`subagent_type` specified): Start with zero context, need full briefing in the prompt. Independent.
- **Fork agents** (no `subagent_type`): Inherit full conversation context. Share prompt cache with parent. Much cheaper (cache hits).

Fork guidelines: "Don't peek" (don't read the fork's output file mid-flight), "Don't race" (never fabricate fork results).

**Lesson:** NanoClaw spawns fresh containers per task. The "fork" concept (sharing parent context) could apply to follow-up tasks within the same group — reuse the conversation context rather than rebuilding it.

### 21. Verification Agent Nudge

When closing 3+ tasks with no verification step, the todo tool injects: "spawn the verification agent. You cannot self-assign PARTIAL by listing caveats — only the verifier issues a verdict."

**Lesson:** Auto-spawning a verifier prevents the "I'm done!" problem where the agent claims completion without checking. NanoClaw could adopt this for multi-step tasks.

### 22. Agent Name Registry for Routing

Subagents register names in `agentNameRegistry`. `SendMessage` routes by name, not ID. This enables human-readable inter-agent communication: "send a message to researcher-agent."

**Lesson:** NanoClaw's IPC is file-based. Named routing would make multi-agent communication cleaner.

---

## UX / CLI Patterns

### 23. React + Ink for Terminal UI

The entire CLI is a React application rendered via Ink. State management uses Zustand-style stores. This means:
- Components re-render on state changes
- Terminal output is declarative
- Rich interactive UI (progress bars, tables, modals) with React patterns

**Lesson:** NanoClaw's TUI uses neo-blessed (imperative). React + Ink is more maintainable for complex terminal UIs. Not necessarily worth migrating, but worth knowing for new CLI features.

### 24. Anti-Debugging Protection

External builds exit immediately if `--inspect`, `--debug`, or `inspector.url()` is detected. Internal (`ant`) builds skip this check.

```typescript
if (USER_TYPE !== 'ant' && (hasInspectorArg || inspectorActive)) {
  process.exit(1)
}
```

**Lesson:** Defense-in-depth for commercial products. Not directly relevant to NanoClaw (open source), but interesting.

### 25. Undercover Mode

Anthropic-internal feature that hides model identity in commit messages and attribution. Used when employees don't want to reveal they're using Claude.

**Lesson:** Attribution flexibility is a real need. NanoClaw's commit messages always include "Co-Authored-By: Claude" — an option to suppress this might be useful.

---

## Unreleased Features (What's Coming)

The feature flags reveal Claude Code's roadmap:

| Feature | What it suggests |
|---------|-----------------|
| **KAIROS** | Full autonomous daemon mode — persistent sessions, channels, webhooks, push notifications, daily dream/reflection |
| **KAIROS_DREAM** | Background "dreaming" — reflective processing during idle time, distilling daily logs into durable memories |
| **KAIROS_CHANNELS** | MCP-based messaging channels (Slack, Discord via MCP) |
| **KAIROS_GITHUB_WEBHOOKS** | GitHub webhook-triggered autonomous agent actions |
| **DAEMON** | Background daemon process for persistent agents |
| **COORDINATOR_MODE** | Multi-agent orchestration (partially shipped as Teams) |
| **VOICE_MODE** | Voice interaction |
| **VERIFICATION_AGENT** | Automatic verification spawning after task completion |
| **TOKEN_BUDGET** | Auto-continuation beyond single response to use allocated budget |
| **WORKFLOW_SCRIPTS** | Script-based workflow automation |
| **TEMPLATES** | Job templates with state classification |
| **CHICAGO_MCP** | Computer use (screenshots, clicks) via MCP |
| **BUDDY** | Companion creature — full gacha system with species, rarities, hats, stats, seeded PRNG |

**Lesson:** Claude Code is evolving toward exactly what NanoClaw already is — a persistent, autonomous, multi-channel agent. NanoClaw has a head start on messaging channels, heartbeat, and container isolation. Claude Code's advantage is the prompt cache optimization, compact quality, and the massive engineering team behind the query loop resilience.

---

## Top 10 Most Actionable Patterns for NanoClaw

1. **Streaming tool execution** — Start tool work while model streams. Latency win.
2. **9-section structured compact** — Replace unstructured summaries with the 9-section format + analysis scratchpad.
3. **Post-compact file restoration** — Re-read recent files after compaction.
4. **Verification agent nudge** — Auto-spawn verifier when closing 3+ tasks.
5. **Withheld error + recovery buffer** — Try recovery before surfacing errors to user.
6. **Tool result size cap** — Persist large tool outputs to disk, send preview to model.
7. **Deterministic cron jitter** — Spread heartbeat load with per-group hash-seeded jitter.
8. **Missed task detection on startup** — Ask user before running overdue tasks.
9. **State-transition-reason pattern** — Make the message loop debuggable.
10. **KAIROS dream distillation** — Nightly job that reviews daily notes and promotes important ones to durable memory.
