<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="MicroClaw" width="420">
</p>

<h1 align="center">MicroClaw</h1>

<p align="center">
  ⚡ Local-runtime-first AI assistant platform with host-controlled tools, browser operations, planning, and strong operator ergonomics.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">Website</a> ·
  <a href="README_zh.md">中文</a> ·
  <a href="https://discord.gg/VDdww8qS42">Discord</a>
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

### 3) Real browser operations, not just “search”

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

- Node.js 20+
- A local/remote OpenAI-compatible endpoint (LM Studio, Ollama, etc.)
- Optional channel credentials for extra integrations

### Install

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
