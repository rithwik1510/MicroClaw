# GitHub Push Plan

This file is the planned split for pushing the current NanoClaw work in separate batches.

## Important rules

- Target at least 20 separate commits/push groups.
- Push 5 groups dated March 14.
- Push 5 groups dated March 13.
- Keep the remaining groups stored here for later.
- Do not push the unfinished latest heartbeat work yet.
- Do not push unfinished cron/task-scheduler work yet.

## Exclude for now

Leave these out of the first push batches until they are complete:

- `src/heartbeat.ts`
- `src/heartbeat.test.ts`
- `src/task-scheduler.ts`

If "cran" meant anything beyond cron/task scheduling, review that group again before pushing.

## March 14 pushes

### Push 1

**Message:** `feat: add database foundation for runtime state`

Files:

- `src/db.ts`
- `src/db.test.ts`

### Push 2

**Message:** `feat: add group queue persistence and tests`

Files:

- `src/group-queue.ts`
- `src/group-queue.test.ts`

### Push 3

**Message:** `feat: add IPC and routing primitives`

Files:

- `src/ipc.ts`
- `src/router.ts`
- `src/routing.test.ts`
- `src/types.ts`

### Push 4

**Message:** `feat: improve container runner and runtime integration`

Files:

- `src/container-runner.ts`
- `src/container-runner.test.ts`
- `src/container-runtime.ts`
- `src/container-runtime.test.ts`

### Push 5

**Message:** `feat: extend agent runner entrypoint and runtime hooks`

Files:

- `container/agent-runner/src/index.ts`
- `container/agent-runner/src/runtime/`
- `container/agent-runner/tsconfig.json`
- `container/agent-runner/package.json`
- `container/agent-runner/package-lock.json`

## March 13 pushes

### Push 6

**Message:** `feat: add Discord channel support`

Files:

- `src/channels/discord.ts`
- `src/channels/discord.test.ts`
- `src/channels/index.ts`

### Push 7

**Message:** `feat: add browser toolchain scaffolding`

Files:

- `src/browser/`
- `scripts/probe-browser-tool-calling.ts`
- `scripts/probe-browser-runtime.ts`
- `scripts/probe-web.ts`

### Push 8

**Message:** `feat: add auth module and related wiring`

Files:

- `src/auth/`
- `src/index.ts`

### Push 9

**Message:** `feat: add command center CLI flow`

Files:

- `src/cli/`
- `setup/command-center.ts`
- `package.json`

### Push 10

**Message:** `feat: add runtime context and execution plumbing`

Files:

- `src/context/`
- `src/execution/`
- `src/runtime/`

## Remaining stored groups

### Push 11

**Message:** `feat: add reusable tool modules`

Files:

- `src/tools/`
- `container/agent-runner/src/tools/`

### Push 12

**Message:** `feat: add skills integration layer`

Files:

- `src/skills/`
- `skills-engine/customize.ts`
- `skills-engine/path-remap.ts`
- `skills-engine/rebase.ts`
- `skills-engine/__tests__/apply.test.ts`
- `skills-engine/__tests__/run-migrations.test.ts`

### Push 13

**Message:** `feat: add continuity support`

Files:

- `src/continuity.ts`
- `src/continuity.test.ts`

### Push 14

**Message:** `feat: add process locking safeguards`

Files:

- `src/process-lock.ts`
- `src/process-lock.test.ts`

### Push 15

**Message:** `chore: improve setup verification and platform checks`

Files:

- `setup/environment.ts`
- `setup/groups.ts`
- `setup/index.ts`
- `setup/platform.ts`
- `setup/verify.ts`

### Push 16

**Message:** `feat: add migration runner updates`

Files:

- `scripts/run-migrations.ts`

### Push 17

**Message:** `chore: expand config and logging support`

Files:

- `src/config.ts`
- `src/logger.ts`

### Push 18

**Message:** `chore: update router startup wiring`

Files:

- `src/index.ts`

Note:

- Only do this as a separate commit if the remaining `src/index.ts` changes are cleanly separable after earlier grouped commits.

### Push 19

**Message:** `chore: add type declarations for terminal integration`

Files:

- `src/neo-blessed.d.ts`

### Push 20

**Message:** `docs: update README and environment example`

Files:

- `README.md`
- `.env.example`

### Push 21

**Message:** `chore: refresh root dependencies and test config`

Files:

- `package-lock.json`
- `vitest.config.ts`

### Push 22

**Message:** `docs: add local planning notes`

Files:

- `features we need to add.md`
- `overall plan.md`

## Notes before actual pushing

- Some files, especially `src/index.ts` and `package.json`, may belong to multiple feature groups.
- Before making real commits, split overlapping hunks carefully with `git add -p`.
- If any group depends on the unfinished heartbeat or cron/task-scheduler work, hold that group back too.
- The cleanest outcome is logical commits, not artificially tiny commits.
