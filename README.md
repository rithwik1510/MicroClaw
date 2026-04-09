# MicroClaw

MicroClaw is a local-runtime-first assistant platform designed to complete real work, not just chat.

It is built on top of NanoClaw, with a stronger runtime stack, better operational control, and deeper execution tooling. NanoClaw remains the core foundation and compatibility base.

## Why MicroClaw

- Strong host orchestration with clear tool boundaries
- OpenAI-compatible local runtime support (LM Studio, Ollama, and similar endpoints)
- Browser and web workflows for current-info and interactive tasks
- Continuity and memory shaping for long-running conversations
- Command-center style operations for setup, health checks, and debugging

## Built On NanoClaw

MicroClaw is a NanoClaw-derived project. If you know NanoClaw, the architecture will feel familiar:

- host orchestrator
- runtime manager
- tool registry
- channel routing
- continuity and persistence

This keeps migration and maintenance practical while allowing MicroClaw to evolve independently.

## Architecture Snapshot

Each turn follows a controlled host flow:

```text
Message In
  -> Context + continuity assembly
  -> Runtime/profile resolution
  -> Capability routing (plain, web, browser, escalate)
  -> Tool loop execution
  -> Host-governed actions (container/browser)
  -> Response Out
```

## Key Capabilities

- Multi-channel message routing
- Runtime profile selection and failover
- Container-based runner execution
- Browser operator tooling
- Adaptive web lookup
- Skill-driven customization
- Persistent SQLite state for sessions, groups, and metadata

## Install

```bash
git clone https://github.com/rithwik1510/MicroClaw.git
cd MicroClaw
npm install
npm --prefix container/agent-runner install
```

## Run

```bash
npm run dev
```

## CLI

Primary command:

```bash
microclaw
```

Compatibility alias:

```bash
nanoclaw
```

Examples:

```bash
microclaw onboard
microclaw status
microclaw doctor
microclaw logs --lines 200
```

## Project Layout

- `src/` host orchestration, routing, execution, and persistence
- `container/agent-runner/` container-side model runtime and tool bridge
- `setup/` onboarding, service setup, and environment validation
- `scripts/` utility scripts and diagnostics
- `skills-engine/` deterministic skill application and rebase helpers

## Notes

- MicroClaw is tuned for local/private deployments.
- Keep privileged actions host-controlled.
- Prefer one strong implementation path per feature over overlapping systems.

## License

MIT
