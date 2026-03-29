# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Run `onecli --help`.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Tool Design for Local Models — Hard-Learned Lessons

These rules come from real failures. Do not skip them.

### Use `exec` over custom tools for filesystem operations

Local models (7-13B) cannot reliably do multi-step custom tool calling. They call the same discovery tool in a loop, ignore `tool_choice=required`, and hallucinate success. OpenClaw's approach is correct: use `read` + `write` + `edit` + `exec` with path guards. Models already know `mv`, `cp`, `mkdir`, `ls`, `find`, `grep`. Use `exec_host_command` for file management — not 10 bespoke tools that require multi-step orchestration.

### Never build multi-step tool chains for local models

If a task requires: discover → list → act, it will fail. Local models can do ONE tool call reliably. Design tools so one call completes the task. If discovery is needed, auto-inject it before the model sees the prompt (bootstrap pattern).

### Always check the capability router with real message formats

The router parses the current message from XML-wrapped continuity prompts. Test with `<message from="..." timestamp="...">actual user text</message>` format, not raw strings. Referential follow-ups like "move it" or "do it" need explicit patterns in the router — local models can't infer intent from context alone.

### `fs.renameSync` fails on OneDrive (Windows)

OneDrive-synced folders throw EPERM on `fs.renameSync`. Always use bash `mv` via `exec_host_command` or fall back to `cpSync` + `rmSync`. Never use bare `renameSync` without error handling.

### Warm sessions poison subsequent turns

When a tool-loop turn fails, prior messages (tool results, retry instructions, assistant tool_calls) stay in the warm session. On the next plain conversational turn, the model pattern-matches on this garbage and outputs raw JSON. Fix: strip `tool` role messages and assistant `tool_calls` from prior messages on non-tool-loop streaming turns.

### Always build then restart

The agent-runner runs from `container/agent-runner/dist/`. Source changes don't take effect until `cd container/agent-runner && npm run build`. The orchestrator (`src/`) uses tsx hot-reload but the agent-runner does NOT. After any agent-runner change: build, then restart `npm run dev`.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
