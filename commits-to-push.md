# Commits to Push (Later)

24 unpushed commits before the host-file work. These are NOT yet pushed to origin/main.

| Hash | Date | Message |
|------|------|---------|
| `5603460` | 2026-03-22 | fix: fire forced web prefetch on non-tool-loop streaming path |
| `dc7ffcd` | 2026-03-22 | fix(web-search): proper synthesis prompt — stop model echoing raw results |
| `2bf8f60` | 2026-03-22 | fix(web-search): use system Chrome when PLAYWRIGHT_EXECUTABLE_PATH is set |
| `3423b5b` | 2026-03-20 | fix(discord): stop live-editing messages during streaming |
| `0a9b08b` | 2026-03-21 | chore: update local Claude Code session permissions |
| `f3682c3` | 2026-03-21 | perf(runtime): intent-aware tool pruning, cloud budget caps, streaming bypass |
| `d28ce0b` | 2026-03-21 | perf(agent): cap warm-session prior messages to bound context size |
| `fcb081d` | 2026-03-21 | feat(discord): add rate-limited updateMessage and deleteMessage |
| `a33157c` | 2026-03-21 | perf: halve poll and IPC intervals for lower message latency |
| `d2ba3eb` | 2026-03-21 | Force web lookup tool use on first OpenAI search step |
| `151b0d9` | 2026-03-19 | Format queue and memory code for readability |
| `149be09` | 2026-03-19 | Improve warm session runtime and memory context handling |
| `46679ac` | 2026-03-17 | Fix runtime env override and context builder guards |
| `8f5f685` | 2026-03-15 | docs: redesign README with MicroClaw story and technical delta |
| `6fa9237` | 2026-03-13 | feat: add runtime context and execution plumbing |
| `80b60de` | 2026-03-13 | feat: add command center CLI flow |
| `02afbe0` | 2026-03-13 | feat: add auth module and related wiring |
| `5d53375` | 2026-03-13 | feat: add browser toolchain scaffolding |
| `5e90efa` | 2026-03-13 | feat: add Discord channel support |
| `4d7bbff` | 2026-03-14 | feat: extend agent runner entrypoint and runtime hooks |
| `effac00` | 2026-03-14 | feat: improve container runner and runtime integration |
| `4750f95` | 2026-03-14 | feat: add IPC and routing primitives |
| `4bb0da3` | 2026-03-14 | feat: add group queue persistence and tests |
| `77f9ff9` | 2026-03-14 | feat: add database foundation for runtime state |

## Note
These sit between `origin/main` (at `f375dd5`) and the host-file commits. They need to be pushed before or alongside the host-file work since git requires linear history.
