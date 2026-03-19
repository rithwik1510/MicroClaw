# NanoClaw Evolution Plan: Local-AI-First, Top-Tier Personal Assistant

## Summary
We will evolve NanoClaw into a local-AI-first assistant platform while preserving its strongest advantage: secure container isolation and small understandable architecture.
The plan implements your selected features only, without model arena/manual chooser workflows.
The user experience will follow a hybrid model: terminal command center for setup/control/debug, and connected channels for day-to-day assistant interaction.
Core product intent: squeeze the maximum practical intelligence, capability, and performance out of local models (LM Studio/Ollama/OpenAI-compatible), while staying lean on token usage.

## Confirmed Scope
1. Support local OpenAI-compatible endpoints as primary runtime: LM Studio/Ollama/vLLM-compatible servers.
2. Implement the 12 core priority features from `features we need to add.md`.
3. Implement extra features: 15, 16, 17, 19, 20 only.
4. Keep deferred: model arena/demo, manual model chooser UX, experimental cost-heavy model routing.
5. Add a terminal command center UX for setup, status, debugging, policy management, and channel connection workflows.
6. Keep external channels (WhatsApp/Discord/etc.) as the primary day-to-day interaction surface.
7. Keep Claude integration optional/future-facing, but not a required default path.

## Non-Goals (Explicit)
1. No run-multiple-models comparison mode in production path.
2. No user-facing per-message model picker.
3. No architecture rewrite into many microservices.

## Architecture Decisions (Locked)
1. Keep single host orchestrator pattern in `src/index.ts`.
2. Keep container security boundary and mount model in `src/container-runner.ts`.
3. Add a runtime abstraction layer so local engines are plug-compatible and future providers remain optional.
4. Default runtime behavior is practical and lean: no unnecessary extra agents or sub-agents.
5. All agentic intelligence features are orchestrator features first, not model-specific hacks.
6. Product UX is hybrid by design: command center in terminal + messaging channels for assistant usage.
7. Command center remains intentionally lightweight and operationally focused, not a heavy full desktop app.
8. Intelligence optimization is model-agnostic: orchestration quality, memory quality, and tool quality must amplify weaker models and unlock stronger models.
9. Token efficiency is a build principle, not a heavy policy system: avoid unnecessary fanout, avoid redundant context, and avoid duplicate reasoning loops.

## Intelligence and Performance Philosophy
1. Any configured model should benefit from the same high-quality orchestration stack (planning, delegation, retries, memory retrieval, quality checks).
2. We optimize for capability per token, not just raw output volume.
3. Agentic behavior must feel powerful (proactive, reliable, contextual), but execution paths should remain lean by default.
4. Multi-agent/sub-agent paths are used intentionally for complexity, not as default behavior for simple requests.
5. Every major feature should improve at least one of: answer quality, completion reliability, task autonomy, or user trust.

## Additional Must-Have Features (Confirmed)
1. DM pairing + sender allowlists by default.
2. Explicit retry policy layer (timeouts, retryable errors, bounded backoff).
3. Presence/activity feedback (typing, progress, running/completed states).
4. Deterministic channel/account/group routing rules.
5. Update/rollback + migration tooling for safe upgrades.

## Web Tool Execution Policy (PinchTab Primary)
1. Web tool usage is adaptive, not always-on.
2. Default mode is `web_search=off` unless intent requires external verification.
3. Trigger web tool calls only when at least one condition holds:
   a. User asks for latest/current/news/today/recent/price/score-like information.
   b. User asks for links/sources/verification.
   c. User provides a URL for inspection.
   d. Model explicitly flags uncertainty and requests verification.
4. Primary web tool is PinchTab; fallback is `agent-browser` for non-restricted operational failures only.
5. Restricted-site policy is strict and honest:
   a. Pre-block known restricted domains (including LinkedIn family domains).
   b. Detect runtime anti-bot/login challenges dynamically.
   c. Return explicit restricted-access response instead of retry loops.
6. Tooling speed constraints are hard budgets, not soft suggestions:
   a. `max_search_calls_per_turn=1`
   b. `max_tool_steps=2`
   c. `search_timeout_ms=2500`
   d. `page_fetch_timeout_ms=3000`
   e. `total_web_budget_ms=7000`
7. If total web budget is exceeded, stop tool execution and return best-effort answer with transparency.
8. Maintain a short-lived query/domain cache (TTL 5-15 minutes) to reduce repeat latency and token cost.
9. Reuse browser/session context for warm-path speed; avoid cold-starting web stack per turn.
10. If PinchTab health degrades, fail fast to fallback path or explicit temporary unavailability response.

## Hybrid UX Strategy (Command Center + Channels)
1. First-time setup starts in terminal: install, init, local model endpoint config, runtime profile setup, channel connection.
2. Daily assistant usage happens in connected channels (WhatsApp/Discord/Telegram/etc.).
3. Admin and troubleshooting return to terminal command center (status, logs, model health, tasks, permissions, diagnostics).
4. Sensitive changes (tool policies, approvals, elevated actions, auth profile changes) are managed only through command center workflows.
5. Control UI/dashboard remains part of roadmap, but terminal command center is the primary operator surface from day one.

## Public Interfaces and Type Additions
1. Add `AgentRuntime` contract.
2. Add `RuntimeManager` for profile selection, failover, retry, and health-aware routing.
3. Add `ExecutionPolicy` and `ToolPolicyProfile`.
4. Add `SessionDelegation` APIs for spawn/send/history/list.
5. Add `MemoryTier` and `KnowledgeGraph` interfaces for long-term intelligence.
6. Add `QualityGatePolicy` and `SLOPolicy`.
7. Add `CommandCenterCLI` commands and command handlers.
8. Add `RetryPolicy` and `PresenceState` interfaces.
9. Add `PairingPolicy` and `SenderAllowlist` interfaces.
10. Add `RoutingRuleSet` for deterministic multi-channel routing.
11. Add `UpgradePlan` and `RollbackPlan` interfaces for safe migrations.

## Proposed New Core Types (Decision Complete)
1. `AgentRuntime`: `run(input)`, `resume(input)`, `supports(features)`, `healthCheck()`.
2. `RuntimeProfile`: `id`, `provider`, `baseUrl`, `authRef`, `model`, `enabled`, `priority`, `costTier`.
3. `RoutingPolicy`: `primaryProfileId`, `fallbackProfileIds`, `maxFallbackHops`, `retryPolicy`.
4. `ToolPolicyProfile`: `id`, `allowedTools`, `blockedTools`, `approvalRequiredTools`.
5. `SessionWorker`: `id`, `parentSessionId`, `groupFolder`, `status`, `assignedTask`.
6. `MemoryRecord`: `scope`, `tier`, `source`, `confidence`, `ttl`, `embeddingRef`.
7. `QualityGate`: `name`, `checkType`, `threshold`, `onFailureAction`.
8. `SLOConfig`: `p95LatencyMs`, `errorRatePct`, `fallbackAction`, `degradeMode`.
9. `CommandCenterCommand`: `name`, `argsSchema`, `handler`, `permissionLevel`.
10. `CommandCenterContext`: `activeProfile`, `runtimeHealth`, `connectedChannels`, `pendingApprovals`.
11. `PairingPolicy`: `mode`, `allowUnknownDm`, `requirePairingCode`, `allowedSenders`.
12. `RetryPolicy`: `maxAttempts`, `backoffMs`, `retryableErrors`, `timeoutMs`.
13. `PresenceState`: `state`, `detail`, `startedAt`, `updatedAt`.
14. `RoutingRule`: `match`, `targetProfile`, `targetPersona`, `priority`.
15. `UpgradePlan`: `fromVersion`, `toVersion`, `migrations`, `rollbackSteps`.

## Command Center Command Set (Initial)
1. `nanoclaw init` for first-time guided setup.
2. `nanoclaw connect <channel>` for channel onboarding/auth.
3. `nanoclaw models` for profile list/add/set-primary/set-fallback/test-health.
4. `nanoclaw skills` for enable/disable/list skill modules.
5. `nanoclaw status` for runtime health, active local profile, queue depth, task status.
6. `nanoclaw logs` for filtered operational logs.
7. `nanoclaw doctor` for diagnostics and auto-fix recommendations.
8. `nanoclaw policy` for tool profile and approval/elevated configuration.
9. `nanoclaw tasks` for scheduler inspection and control.
10. `nanoclaw pair` for DM pairing and allowlist management.
11. `nanoclaw upgrade` for safe update + migration execution.
12. `nanoclaw rollback` for reverting failed updates.

## Data Model / Migration Plan
1. Add table `runtime_profiles` for local endpoint/runtime configs.
2. Add table `group_runtime_policy` mapping group to routing policy and tool profile.
3. Add table `session_workers` for delegated sub-agents.
4. Add table `runtime_events` for failover/retry/health telemetry.
5. Add table `memory_graph_nodes` and `memory_graph_edges` for persistent knowledge.
6. Add table `routine_templates` and `routine_runs` for teach-once automations.
7. Add table `quality_gate_logs` for pre-send validation outcomes.
8. Add table `slo_state` for rolling reliability metrics and auto-healing state.

## Implementation Phases

## Phase 0: Hybrid UX Foundation (Command Center First)
1. Build command center CLI entrypoint and command registry.
2. Implement `init`, `status`, `logs`, and `doctor` baseline commands.
3. Implement `connect` command flow for channel setup.
4. Implement command center permission boundaries for sensitive operations.
5. Integrate runtime and channel health snapshots into command center.

Acceptance criteria:
1. New user can install, initialize, and connect at least one channel entirely from terminal flows.
2. Operator can inspect runtime/local-endpoint/channel/task health without editing files manually.
3. Diagnostics produce actionable errors and recommended fixes.

## Phase 1: Local Runtime Foundation (Must ship first)
1. Introduce runtime abstraction with local OpenAI-compatible path as primary.
2. Harden `OpenAICompatibleRuntimeAdapter` for LM Studio/Ollama/vLLM-compatible servers.
3. Implement profile-based local endpoint/auth handling (including optional key/no-key modes).
4. Implement failover chain with explicit retry policies and cool-down.
5. Wire orchestrator execution path to runtime manager.
6. Preserve existing streaming output protocol compatibility.
7. Expose runtime profile configuration and failover controls through command center commands.
8. Implement deterministic routing rules for channel/account/group -> runtime/profile mapping.
9. Add runtime-level prompt/tool/memory adapters so the same request structure performs consistently across local engines.

Acceptance criteria:
1. A group can run on configured primary local profile and fail over to fallback on endpoint failure.
2. Existing optional Claude path remains backward compatible if enabled.
3. No increase in duplicate replies or cursor regression behavior.
4. Baseline tasks run across supported local engines with consistent behavior and acceptable output quality.

## Phase 2: Agentic Orchestration Core
1. Add session delegation tools: spawn/send/list/history.
2. Add background process engine for long-running tasks with status callbacks.
3. Add hooks and webhooks framework.
4. Add tool policy profiles and enforce them at runtime.
5. Add advanced session routing controls (identity/session mapping across channels).
6. Add DM pairing + sender allowlist enforcement for private-channel safety.
7. Add presence/activity signals for all supported channels.
8. Add execution-shaping rules that keep simple tasks single-agent and escalate to delegated flows only when task complexity demands it.

Acceptance criteria:
1. Parent agent can delegate tasks to worker sessions and aggregate responses.
2. Hooks can trigger workflows safely without bypassing policy checks.
3. Tool restrictions are enforced per group/profile.
4. Simple requests do not trigger unnecessary delegation or extra agent passes.

## Phase 3: Intelligence and Memory Layer
1. Implement planner-critic loop for high-complexity requests.
2. Implement personal knowledge graph with memory tiers.
3. Implement routine learning from repeated user patterns.
4. Implement quality gates before final user-facing outputs.
5. Implement session compaction/pruning/memory flush pipeline.
6. Add retrieval-quality tuning so memory injection is relevance-first and minimal-token.

Acceptance criteria:
1. Complex tasks show fewer factual/logic regressions under gated workflows.
2. Memory recall improves across long horizons without context bloat.
3. Learned routines can replay with user confirmations where required.
4. Capability gains are measurable without default token growth spikes for routine tasks.

## Phase 4: Reliability, UX, and Safe Power
1. Add streaming/chunked response UX improvements.
2. Add approvals and elevated mode for risky actions.
3. Add control UI/dashboard and secure device pairing.
4. Add doctor/diagnostics suite.
5. Add SLO-based self-healing runtime with graceful degrade modes.
6. Add media understanding preprocessing (image/audio/video) before main reasoning.
7. Keep terminal command center as the required fallback operator interface even after control UI ships.
8. Add versioned update/rollback/migration flows with validation gates before apply.

Acceptance criteria:
1. Users get faster perceived response and clearer progress feedback.
2. Risky operations require explicit approvals.
3. Runtime auto-heals on local endpoint outages and meets SLO targets.

## Testing and Validation Plan
1. Adapter contract tests: local runtime adapters must pass identical behavior suite.
2. Failover tests: simulate timeout, 429, auth failure, partial streaming failure.
3. Session delegation tests: parent-worker lifecycle, cancellation, orphan handling.
4. Policy tests: blocked tools cannot execute; approval tools enforce flow.
5. Memory tests: tier write/read consistency, compaction correctness, pruning safety.
6. Quality gate tests: failure actions trigger retry/escalate/block paths correctly.
7. SLO tests: degradation and recovery transitions under synthetic load.
8. Security regression tests: mount isolation, secret redaction, IPC auth boundaries.
9. End-to-end scenario tests: multi-channel, scheduled tasks, fallback, background jobs.
10. Pairing/allowlist tests: unknown DM behavior, pairing code flow, sender restrictions.
11. Deterministic routing tests: same input context always maps to same routing target.
12. Upgrade/rollback tests: migrate forward and recover backward without data loss.
13. Capability-per-token benchmarks: track task success quality versus token consumption across local engines.
14. Delegation-threshold tests: verify simple tasks stay single-agent and complex tasks escalate correctly.
15. Context-efficiency tests: verify compaction and retrieval reduce unnecessary prompt size while preserving task quality.
16. Web-intent gate tests: verify tool calls do not run for ordinary non-web requests.
17. Web-latency budget tests: verify hard cutoffs at per-step and total budget thresholds.
18. Restricted-domain tests: verify blocklist and challenge-detection produce honest restricted responses.
19. Fallback tests: verify PinchTab failure routes to `agent-browser` once for non-restricted targets only.

## Rollout Strategy
1. Feature flags per phase with default-off except compatibility-safe internals.
2. Migrate existing installs with runtime default pinned to local OpenAI-compatible behavior.
3. Enable one local endpoint profile at a time in production and expand cautiously.
4. Observe runtime events and SLOs before enabling next phase.
5. Provide rollback switches for each major capability.

## Defaults and Assumptions (Chosen)
1. Default runtime: local OpenAI-compatible profile first, single fallback hop.
2. Default implementation style: avoid unnecessary multi-agent/sub-agent fanout.
3. Default tool profile: conservative for non-main groups, broader for main.
4. Default quality gates apply only to high-impact outputs first.
5. Default routine learning is suggestion-first, not auto-execute-first.
6. Default local model usage is allowed only when endpoint health passes checks.
7. Existing channel architecture and scheduler remain in place and are extended, not replaced.
8. Default DM policy: unknown direct senders require pairing before full assistant access.
9. Default execution path: single-agent first, escalate only when complexity or failure recovery requires it.
10. Default memory path: inject only the most relevant context, not full conversation dumps.
11. Default web mode: adaptive (off by default, enabled by intent gate).
12. Default web stack: PinchTab primary, `agent-browser` single-attempt fallback.
13. Default web performance envelope: strict per-step and per-turn latency budgets as defined above.

## Recap of What We Are Doing
1. Move from Claude-centric runtime to local-AI-first runtime with local endpoint profiles and optional future provider support.
2. Add orchestration intelligence (delegation, policies, hooks, background workflows).
3. Add memory intelligence (graph + tiers + routine learning + compaction).
4. Add reliability intelligence (retry policies + routing rules + quality gates + SLO self-healing + diagnostics).
5. Add safe usability improvements (streaming UX, approvals/elevated mode, control dashboard).
6. Ship a hybrid operator experience: terminal command center for setup/control/debug + messaging channels for daily assistant usage.
7. Maximize intelligence and performance from local user-selected models while keeping runtime behavior lean and practical by default.

## Implementation Snapshot (Current)
1. Added auth profile metadata + encrypted credential vault (`store/auth/credentials.enc.json`).
2. Added runtime-to-auth binding (`authProfileId`) and endpoint classification (`endpointKind`) in runtime profiles.
3. Added local endpoint profiles + provider capability cache for OpenAI-compatible probing.
4. Added command center CLI foundation: `init`, `auth`, `models`, `local`, `status`, `doctor`, `logs`, `tui`.
5. Added setup bridge step (`commandCenter`) so setup can invoke command-center workflows.
6. Added runtime execution secret resolution through auth profiles with `.env` fallback for backward compatibility.
7. Added OpenAI-compatible adapter fallback from `/v1/responses` to `/v1/chat/completions` and optional API key behavior for local engines.
