<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="MicroClaw" width="420">
</p>

<h1 align="center">MicroClaw</h1>

<p align="center">
  ⚡ Local-runtime-first AI assistant platform with host-controlled tools, browser operations, planning, and strong operator ergonomics.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="README_ja.md">日本語</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

---

## 🧬 What This Project Is

MicroClaw is built on top of NanoClaw.

Think of it as a powered-up evolution:

- same practical foundation
- stronger execution architecture
- better runtime routing
- deeper browser and tool workflows
- improved operational control

NanoClaw is still the foundation. MicroClaw is the upgraded system we shaped for higher real-world completion.

---

## 🚀 Why MicroClaw Is More Powerful Than NanoClaw

### 1) Better runtime intelligence

- Profile-driven runtime selection
- Capability-aware route decisions
- Safer fallback behavior for local/compatible endpoints

### 2) Stronger execution control

- Host-governed privileged actions
- Cleaner container-runner contracts
- Better execution backend boundaries

### 3) Real browser operations, not just "search"

- Managed browser sessions
- Snapshot + ref interaction model
- Action-level control and policy shaping

### 4) Better continuity and memory outcomes

- Structured context building
- Retrieval-aware memory shaping
- Explicit memory tools for long workflows

### 5) Operator-grade workflow

- Command-center style CLI
- Setup and diagnostics flow
- Better observability and operational ergonomics

---

## 🧩 Exactly What Changed From NanoClaw

Here is the direct technical delta.

| Area | NanoClaw Base | MicroClaw Upgrade |
|---|---|---|
| Runtime | Basic profile compatibility | Expanded runtime manager, capability routing, safer fallback paths |
| Tooling | Core tools | Richer tool registry, better tool exposure rules per route |
| Browser | Limited interaction pattern | Host-managed browser operator stack with structured action flow |
| Context | General continuity | Layered context pipeline with stronger memory relevance behavior |
| CLI/Ops | Core setup | Command-center flow for onboarding, health, debug, and control |
| Execution | Core container loop | Cleaner host/runner split and execution backend wiring |
| Channel Surface | Foundation channels | Expanded channel handling plus integration scaffolding |

---

## 🛠 Build Story (How We Made It)

This is the chapter that matters most.

### Phase 1: Small assistant core

We started with a minimal orchestrator around:

- message routing
- SQLite state
- isolated execution

Goal: keep the code understandable and safe.

### Phase 2: Local-runtime foundation

We evolved into local-runtime-first architecture with:

- runtime profiles
- local endpoint support
- capability probing
- fallback logic

### Phase 3: Command center operations

As complexity grew, operations had to get easier.

We added CLI-centered flows for:

- onboarding
- auth/runtime management
- diagnostics
- logs and debugging

### Phase 4: Adaptive web layer

Web access was made adaptive, not always-on.

The assistant uses it only when a task truly requires current information or verification.

### Phase 5: Browser operator foundation

This was a major leap.

We added host-managed browser operations with:

- centralized manager
- session ownership
- action boundaries
- snapshot/ref workflow

### Phase 6: Planner-critic integration

For complex tasks, one-pass responses were not enough.

Planner/critic tooling was introduced for multi-step reliability.

### Phase 7: Memory and continuity upgrades

We improved how memory is collected, ranked, and reused so long-running tasks stay accurate.

---

## 🧠 System Flow

```text
User message
  -> continuity/context assembly
  -> runtime profile selection
  -> capability route selection
  -> tool exposure for that route
  -> model tool loop and/or response
  -> host-managed execution for privileged actions
  -> final response
```

Capability routes:

- `plain_response`
- `web_lookup`
- `browser_operation`
- `deny_or_escalate`

```bash
gh repo fork qwibitai/nanoclaw --clone
cd nanoclaw
claude
```

<details>
<summary>Without GitHub CLI</summary>

1. Fork [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) on GitHub (click the Fork button)
2. `git clone https://github.com/<your-username>/nanoclaw.git`
3. `cd nanoclaw`
4. `claude`

</details>

Then run `/setup`. Claude Code handles everything: dependencies, authentication, container setup and service configuration.

> **Note:** Commands prefixed with `/` (like `/setup`, `/add-whatsapp`) are [Claude Code skills](https://code.claude.com/docs/en/skills). Type them inside the `claude` CLI prompt, not in your regular terminal. If you don't have Claude Code installed, get it at [claude.com/product/claude-code](https://claude.com/product/claude-code).

---

## 🔧 Tool Families

Web:

- `web_search`
- `web_fetch`
- `web_open_url`
- `web_extract_text`
- `web_get_links`
- `web_close`

Browser:

- `browser_open_url`
- `browser_snapshot`
- `browser_click`
- `browser_type`
- `browser_select`
- `browser_extract_text`
- `browser_screenshot`
- `browser_tabs`
- `browser_close`

Meta:

- `create_plan`
- `critique_response`

Memory:

- `remember_this`
- `memory_search`

Features:

- **Multi-channel messaging** - Talk to your assistant from WhatsApp, Telegram, Discord, Slack, or Gmail. Add channels with skills like `/add-whatsapp` or `/add-telegram`. Run one or many at the same time.
- **Isolated group context** - Each group has its own `CLAUDE.md` memory, isolated filesystem, and runs in its own container sandbox with only that filesystem mounted to it.
- **Main channel** - Your private channel (self-chat) for admin control; every group is completely isolated
- **Scheduled tasks** - Recurring jobs that run Claude and can message you back
- **Web access** - Search and fetch content from the Web
- **Container isolation** - Agents are sandboxed in Docker (macOS/Linux), [Docker Sandboxes](docs/docker-sandboxes.md) (micro VM isolation), or Apple Container (macOS)
- **Agent Swarms** - Spin up teams of specialized agents that collaborate on complex tasks
- **Optional integrations** - Add Gmail (`/add-gmail`) and more via skills

---

## 📁 Repository Guide

- `src/index.ts`: host orchestrator entrypoint
- `src/runtime/`: runtime selection and capability routing
- `src/browser/`: browser manager and IPC pathway
- `src/context/`: continuity and memory assembly
- `src/db.ts`: persistence
- `src/cli/`: command-center interface
- `container/agent-runner/`: runtime adapter and tool bridge

---

## ⚙️ Quick Start

### Requirements

- macOS or Linux
- Node.js 20+
- A local/remote OpenAI-compatible endpoint (LM Studio, Ollama, etc.)
- Optional channel credentials for extra integrations

### Install

## Architecture

```
Channels --> SQLite --> Polling loop --> Container (Claude Agent SDK) --> Response
```

Single Node.js process. Channels are added via skills and self-register at startup — the orchestrator connects whichever ones have credentials present. Agents execute in isolated Linux containers with filesystem isolation. Only mounted directories are accessible. Per-group message queue with concurrency control. IPC via filesystem.

For the full architecture details, see [docs/SPEC.md](docs/SPEC.md).

Key files:
- `src/index.ts` - Orchestrator: state, message loop, agent invocation
- `src/channels/registry.ts` - Channel registry (self-registration at startup)
- `src/ipc.ts` - IPC watcher and task processing
- `src/router.ts` - Message formatting and outbound routing
- `src/group-queue.ts` - Per-group queue with global concurrency limit
- `src/container-runner.ts` - Spawns streaming agent containers
- `src/task-scheduler.ts` - Runs scheduled tasks
- `src/db.ts` - SQLite operations (messages, groups, sessions, state)
- `groups/*/CLAUDE.md` - Per-group memory

## FAQ

**Why Docker?**

Docker provides cross-platform support (macOS, Linux and even Windows via WSL2) and a mature ecosystem. On macOS, you can optionally switch to Apple Container via `/convert-to-apple-container` for a lighter-weight native runtime. For additional isolation, [Docker Sandboxes](docs/docker-sandboxes.md) run each container inside a micro VM.

**Can I run this on Linux?**

Yes. Docker is the default runtime and works on both macOS and Linux. Just run `/setup`.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. You should still review what you're running, but the codebase is small enough that you actually can. See [docs/SECURITY.md](docs/SECURITY.md) for the full security model.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize NanoClaw so that the code does exactly what they want, rather than configuring a generic system. If you prefer having config files, you can tell Claude to add them.

**Can I use third-party or open-source models?**

Yes. NanoClaw supports any Claude API-compatible model endpoint. Set these environment variables in your `.env` file:

```bash
git clone https://github.com/rithwik1510/MicroClaw.git
cd MicroClaw
npm install
npm --prefix container/agent-runner install
```

### First-Time Setup

```bash
npm run dev -- onboard
```

### CLI

Primary command:

```bash
microclaw
```

Compatibility alias:

```bash
nanoclaw
```

Common commands:

```bash
microclaw status
microclaw doctor
microclaw models list
microclaw debug
microclaw logs --lines 200
```

---

## 📚 More Reading

- [docs/SPEC.md](docs/SPEC.md)
- [docs/SECURITY.md](docs/SECURITY.md)
- [overall plan.md](overall%20plan.md)
- [features we need to add.md](features%20we%20need%20to%20add.md)

---

## 📄 License

MIT
