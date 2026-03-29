# Fix Host-File Tools for Local/Open Models

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 10 host-file tools work reliably end-to-end when driven by local/open models (LM Studio, Ollama, vLLM, etc.) through the OpenAI-compatible runtime.

**Architecture:** The tools exist and unit tests pass, but the OpenAI-compatible runtime has five bugs that prevent local models from actually using them: (1) first-call discovery gates the model to a single tool then prematurely satisfies the route contract, (2) the capability router misroutes non-file turns into host-file mode, (3) the max_tokens cap of 280 on first iteration is too small for local models to emit a valid tool call, (4) the confirmation flow doesn't work with tool-call arguments, and (5) the skill prompt is too vague for weaker models. All code changes are in the OpenAI-compatible runtime path — nothing touches the Claude SDK or MCP server.

**Tech Stack:** TypeScript, Node.js, Vitest

---

## Diagnosis: Why Local Models Fail at File Tasks

**Bug 1 — Discovery gates out all action tools, then contract satisfied prematurely.**
In `openai.ts:1268-1280`, when `hostFileNeedsDirectoryDiscovery()` is true, `activeToolsForTurn()` returns ONLY `list_host_directories`. The model calls it. Then at `openai.ts:3081-3087`, the contract check `handler?.family === 'host_files'` marks the contract as satisfied — because `list_host_directories` IS a host_files tool. The loop ends. The model never gets `read_host_file`, `list_host_entries`, or any action tool.

**Bug 2 — Capability router false positives steal web/conversational turns.**
`hasHostFileRequest()` in `capability-router.ts:29-37` matches generic combos like "find" + "files" or "search" + "directory". A message like "find the latest news sources" triggers `host_file_operation` mode, stripping web tools. The user's web query silently fails.

**Bug 3 — max_tokens=280 on first tool-loop iteration for local models.**
At `openai.ts:2780-2783`, local models get `max_tokens: 280` before any tool call (`!sawToolCalls`). Many local models need 150+ tokens just for reasoning before emitting a tool call JSON. 280 is often too tight — the model truncates mid-tool-call, producing invalid JSON. The loop dies on parse failure.

**Bug 4 — Confirmation check ignores tool arguments.**
`hasExplicitConfirmation()` in `host-files.ts:133-143` only checks `ctx.secrets.NANOCLAW_ORIGINAL_PROMPT` for keywords like "yes". In a tool-call flow, the model sets `mode: "overwrite"` but can't pass confirmation. The write silently fails with "needs explicit user confirmation."

**Bug 5 — Skill prompt too vague for weaker models.**
The host-files SKILL.md says "call list_host_directories first" and lists tool names, but gives no parameter examples or workflow sequences. Local models (especially 7-13B) need concrete parameter examples to emit correct tool calls.

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `container/agent-runner/src/runtime/openai.ts` | Modify | Fix discovery gating, contract check, max_tokens cap |
| `container/agent-runner/src/runtime/openai.test.ts` | Modify | Add regression tests for discovery + contract + tokens |
| `src/runtime/capability-router.ts` | Modify | Tighten `hasHostFileRequest` to reduce false positives |
| `src/runtime/capability-router.test.ts` | Modify | Add false-positive regression tests |
| `container/agent-runner/src/tools/host-files.ts` | Modify | Add `confirm` arg to confirmation check |
| `container/agent-runner/src/tools/host-files.test.ts` | Modify | Add test for `confirm` parameter |
| `container/agent-runner/src/tools/registry.ts` | Modify | Add `confirm` to write/move tool schemas |
| `container/skills/host-files/SKILL.md` | Modify | Add concrete parameter examples for local models |

---

## Task 1: Fix Discovery Gating and Contract Satisfaction

This is the highest-impact bug. The model calls `list_host_directories`, gets directory info back, but the turn ends because the contract is already satisfied. The model never reaches `read_host_file` or any action tool.

**Files:**
- Modify: `container/agent-runner/src/runtime/openai.ts:1268-1280, 2119-2128, 3081-3087`
- Modify: `container/agent-runner/src/runtime/openai.test.ts`

- [ ] **Step 1: Write failing test — list_host_directories must not satisfy the contract**

Add to `container/agent-runner/src/runtime/openai.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('host_file_operation contract', () => {
  it('list_host_directories is not in the textual contract matcher regex', () => {
    // The textual matcher is used when streaming parses a tool call from text.
    // list_host_directories must NOT satisfy the contract.
    const contractRegex = /^(list_host_entries|read_host_file|write_host_file|edit_host_file|glob_host_files|grep_host_files|make_host_directory|move_host_path|copy_host_path)$/;
    expect(contractRegex.test('list_host_directories')).toBe(false);
    expect(contractRegex.test('read_host_file')).toBe(true);
    expect(contractRegex.test('list_host_entries')).toBe(true);
    expect(contractRegex.test('write_host_file')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (this defines the target behavior)**

Run: `npx vitest run container/agent-runner/src/runtime/openai.test.ts --reporter=verbose`
Expected: PASS (this is a spec test for the regex we'll apply).

- [ ] **Step 3: Fix discovery — give all host-file tools, not just list_host_directories**

In `container/agent-runner/src/runtime/openai.ts`, find the discovery block (around line 1268-1280):

```typescript
    if (
      !input.sawToolCalls &&
      input.route === 'host_file_operation' &&
      this.hostFileNeedsDirectoryDiscovery(input.prompt)
    ) {
      const discoveryTools = input.baseRegistry.filter(
        (tool) => tool.name === 'list_host_directories',
      );
      return {
        registry: discoveryTools,
        tools: toOpenAITools(discoveryTools),
      };
    }
```

Replace with:

```typescript
    if (
      !input.sawToolCalls &&
      input.route === 'host_file_operation' &&
      this.hostFileNeedsDirectoryDiscovery(input.prompt)
    ) {
      // Give all host-file tools so the model can discover AND act in one turn.
      // tool_choice='required' on the first iteration already nudges the model
      // to call list_host_directories before action tools.
      const allHostFileTools = input.baseRegistry.filter(
        (tool) => tool.family === 'host_files' || tool.family === 'memory',
      );
      return {
        registry: allHostFileTools,
        tools: toOpenAITools(allHostFileTools),
      };
    }
```

- [ ] **Step 4: Fix contract satisfaction — exclude list_host_directories**

In the same file, find the contract satisfaction block (around line 3081-3087):

```typescript
              if (
                routeContract.label === 'host_file_operation' &&
                handler?.family === 'host_files'
              ) {
                contractSatisfied = true;
                contractSatisfiedThisIteration = true;
              }
```

Replace with:

```typescript
              if (
                routeContract.label === 'host_file_operation' &&
                handler?.family === 'host_files' &&
                toolName !== 'list_host_directories'
              ) {
                contractSatisfied = true;
                contractSatisfiedThisIteration = true;
              }
```

- [ ] **Step 5: Fix textual contract matcher — remove list_host_directories from regex**

Find the `textualToolCallMatchesContract` method (around line 2119-2128):

```typescript
    if (contract.requiredFamilies.includes('host_files')) {
      return /^(list_host_directories|list_host_entries|read_host_file|write_host_file|edit_host_file|glob_host_files|grep_host_files|make_host_directory|move_host_path|copy_host_path)$/.test(
        toolName,
      );
    }
```

Replace with:

```typescript
    if (contract.requiredFamilies.includes('host_files')) {
      return /^(list_host_entries|read_host_file|write_host_file|edit_host_file|glob_host_files|grep_host_files|make_host_directory|move_host_path|copy_host_path)$/.test(
        toolName,
      );
    }
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run container/agent-runner/src/runtime/openai.test.ts --reporter=verbose`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add container/agent-runner/src/runtime/openai.ts container/agent-runner/src/runtime/openai.test.ts
git commit -m "fix: discovery no longer gates out action tools, list_host_directories alone cannot satisfy contract"
```

---

## Task 2: Raise max_tokens Cap for Local Model Tool Calls

Local models get `max_tokens: 280` before any tool call. Many 7-13B models need ~200 tokens for chain-of-thought before the tool call JSON. A tool call with path arguments is easily 80-120 tokens. 280 is too tight and causes truncated JSON.

**Files:**
- Modify: `container/agent-runner/src/runtime/openai.ts:2780-2783`

- [ ] **Step 1: Find the local model max_tokens cap**

In `container/agent-runner/src/runtime/openai.ts`, find (around line 2780-2783):

```typescript
              max_tokens: isLocal
                ? sawToolCalls
                  ? Math.min(maxOutputTokens, 700)
                  : Math.min(maxOutputTokens, 280)
                : this.resolveCloudToolLoopMaxTokens({
```

- [ ] **Step 2: Raise the pre-tool-call cap from 280 to 512**

Replace with:

```typescript
              max_tokens: isLocal
                ? sawToolCalls
                  ? Math.min(maxOutputTokens, 700)
                  : Math.min(maxOutputTokens, 512)
                : this.resolveCloudToolLoopMaxTokens({
```

512 gives local models enough room for reasoning + tool call JSON without wasting budget. The post-tool-call cap (700) stays — that's for synthesis after tool results.

- [ ] **Step 3: Build to verify**

Run: `cd container/agent-runner && npm run build`
Expected: Clean compile.

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/runtime/openai.ts
git commit -m "fix: raise local model pre-tool-call max_tokens from 280 to 512"
```

---

## Task 3: Fix Capability Router False Positives

`hasHostFileRequest()` triggers on common word combos that aren't file-related, hijacking web turns into `host_file_operation` mode where web tools are stripped.

**Files:**
- Modify: `src/runtime/capability-router.ts:29-37`
- Modify: `src/runtime/capability-router.test.ts`

- [ ] **Step 1: Write failing tests for false-positive cases**

Add to `src/runtime/capability-router.test.ts`:

```typescript
  it('does not route "find the latest news sources" to host_file_operation', () => {
    const prompt = [
      '[Current message - respond to this]',
      'Find the latest news sources about the AI regulation bill.',
    ].join('\n');

    const route = resolveCapabilityRoute({
      prompt,
      toolPolicy: { web: { enabled: true }, browser: { enabled: true } },
    });

    expect(route).not.toBe('host_file_operation');
  });

  it('does not route "search for project updates online" to host_file_operation', () => {
    const prompt = [
      '[Current message - respond to this]',
      'Search for updates on the project timeline online.',
    ].join('\n');

    const route = resolveCapabilityRoute({
      prompt,
      toolPolicy: { web: { enabled: true }, browser: { enabled: true } },
    });

    expect(route).not.toBe('host_file_operation');
  });

  it('routes explicit Windows paths to host_file_operation', () => {
    const prompt = [
      '[Current message - respond to this]',
      'Read C:\\Users\\posan\\Documents\\notes.txt and summarize it.',
    ].join('\n');

    const route = resolveCapabilityRoute({
      prompt,
      toolPolicy: { web: { enabled: true }, browser: { enabled: true } },
    });

    expect(route).toBe('host_file_operation');
  });

  it('routes "organize my Desktop folder" to host_file_operation', () => {
    const prompt = [
      '[Current message - respond to this]',
      'Organize my Desktop folder by moving old files into an archive subfolder.',
    ].join('\n');

    const route = resolveCapabilityRoute({
      prompt,
      toolPolicy: { web: { enabled: true }, browser: { enabled: true } },
    });

    expect(route).toBe('host_file_operation');
  });

  it('does not route "what is the current status of my files" with web context to host_file_operation', () => {
    const prompt = [
      '[Current message - respond to this]',
      'What is the current status of my files I uploaded to the website?',
    ].join('\n');

    const route = resolveCapabilityRoute({
      prompt,
      toolPolicy: { web: { enabled: true }, browser: { enabled: true } },
    });

    expect(route).not.toBe('host_file_operation');
  });
```

- [ ] **Step 2: Run tests to see which fail**

Run: `npx vitest run src/runtime/capability-router.test.ts --reporter=verbose`
Expected: Some new tests FAIL due to false positives.

- [ ] **Step 3: Tighten `hasHostFileRequest` — strong vs weak signals**

In `src/runtime/capability-router.ts`, replace `hasHostFileRequest` (lines 29-37):

```typescript
function hasHostFileRequest(text: string): boolean {
  const fileNouns =
    /\b(file|files|folder|folders|directory|directories|desktop|documents|downloads|onedrive|path|paths|workspace|computer files|my computer)\b/i;
  const visibilityOrAccess =
    /\b(see|view|show me|what(?:'s| is) in|check|look at|access|open|inspect|browse)\b/i;
  const fileOperations =
    /\b(list|show|open|read|write|edit|create|make|save|update|change|rename|move|copy|search|find|grep|glob|organize)\b/i;
  return fileNouns.test(text) && (visibilityOrAccess.test(text) || fileOperations.test(text));
}
```

With:

```typescript
function hasHostFileRequest(text: string): boolean {
  // Strong signals: folder names that unambiguously mean local filesystem
  const strongFileNouns =
    /\b(desktop|documents|downloads|onedrive|my computer|computer files|home folder|home directory)\b/i;
  // Weak signals: generic words that need a clear file-action verb
  const weakFileNouns =
    /\b(file|files|folder|folders|directory|directories)\b/i;
  // Verbs that clearly mean local file operations (not "search", "find", "update")
  const fileActions =
    /\b(list|open|read|write|edit|create|make|save|rename|move|copy|organize|sort|clean up|archive|glob|grep)\b/i;
  const visibilityActions =
    /\b(see|view|show me|what(?:'s| is) in|check|look at|access|inspect|browse)\b/i;
  // Web signals that override weak file nouns
  const webSignal =
    /\b(latest|current|today|recent|news|online|web|internet|source|sources|website|uploaded|cloud)\b/i;

  // Strong noun + any action = definitely file
  if (strongFileNouns.test(text) && (fileActions.test(text) || visibilityActions.test(text))) {
    return true;
  }
  // Weak noun + file-specific action, only if no competing web signal
  if (weakFileNouns.test(text) && fileActions.test(text) && !webSignal.test(text)) {
    return true;
  }
  // Weak noun + visibility, only if no competing web signal
  if (weakFileNouns.test(text) && visibilityActions.test(text) && !webSignal.test(text)) {
    return true;
  }
  return false;
}
```

- [ ] **Step 4: Run all capability router tests**

Run: `npx vitest run src/runtime/capability-router.test.ts --reporter=verbose`
Expected: All tests PASS — both new false-positive tests and existing routing tests.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/capability-router.ts src/runtime/capability-router.test.ts
git commit -m "fix: tighten capability router to prevent false-positive host-file routing"
```

---

## Task 4: Add `confirm` Parameter to Write/Move Tools

The model can't pass confirmation through tool arguments. `hasExplicitConfirmation` only parses the raw user prompt, which doesn't work in tool-call flows.

**Files:**
- Modify: `container/agent-runner/src/tools/host-files.ts:133-143, 325, 467`
- Modify: `container/agent-runner/src/tools/host-files.test.ts`
- Modify: `container/agent-runner/src/tools/registry.ts:305-310, 390-395`

- [ ] **Step 1: Write failing test for `confirm` parameter**

Add to `container/agent-runner/src/tools/host-files.test.ts`, inside the `host file tools` describe block:

```typescript
  it('allows overwrite when confirm arg is true without prompt keywords', async () => {
    const root = tmp;
    const file = path.join(root, 'existing.txt');
    fs.writeFileSync(file, 'old content');

    process.env.NANOCLAW_HOST_DIRECTORIES = JSON.stringify({
      directories: [{ path: root, label: 'Test', readonly: false }],
    });

    const result = await executeWriteHostFile(
      { path: file, content: 'new content', mode: 'overwrite', confirm: true },
      {
        secrets: {},
        maxSearchCallsPerTurn: 0,
        maxToolSteps: 0,
        searchTimeoutMs: 0,
        pageFetchTimeoutMs: 0,
        totalWebBudgetMs: 0,
        startedAtMs: Date.now(),
        stepCount: 0,
        searchCount: 0,
      },
    );

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('new content');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run container/agent-runner/src/tools/host-files.test.ts --reporter=verbose`
Expected: FAIL — the new test fails because `hasExplicitConfirmation` ignores `args.confirm`.

- [ ] **Step 3: Add `confirm` arg support to `hasExplicitConfirmation`**

In `container/agent-runner/src/tools/host-files.ts`, replace `hasExplicitConfirmation` (line 133):

```typescript
function hasExplicitConfirmation(ctx: ToolExecutionContext): boolean {
  const prompt = (
    ctx.secrets?.NANOCLAW_ORIGINAL_PROMPT ||
    ctx.secrets?.NANOCLAW_CURRENT_PROMPT ||
    ''
  ).trim();
  if (!prompt) return false;
  return /\b(confirm|confirmed|yes|go ahead|proceed|overwrite|replace it|do it|move it|rename it)\b/i.test(
    prompt,
  );
}
```

With:

```typescript
function hasExplicitConfirmation(ctx: ToolExecutionContext, args?: Record<string, unknown>): boolean {
  if (args?.confirm === true) return true;
  const prompt = (
    ctx.secrets?.NANOCLAW_ORIGINAL_PROMPT ||
    ctx.secrets?.NANOCLAW_CURRENT_PROMPT ||
    ''
  ).trim();
  if (!prompt) return false;
  return /\b(confirm|confirmed|yes|go ahead|proceed|overwrite|replace it|do it|move it|rename it)\b/i.test(
    prompt,
  );
}
```

- [ ] **Step 4: Update call sites to pass `args`**

In `executeWriteHostFile` (around line 325), change:

```typescript
  if (mode === 'overwrite' && exists && !hasExplicitConfirmation(ctx)) {
```

To:

```typescript
  if (mode === 'overwrite' && exists && !hasExplicitConfirmation(ctx, args)) {
```

In `executeMoveHostPath` (around line 467), change:

```typescript
  if (fs.existsSync(destination.path) && !hasExplicitConfirmation(ctx)) {
```

To:

```typescript
  if (fs.existsSync(destination.path) && !hasExplicitConfirmation(ctx, args)) {
```

- [ ] **Step 5: Add `confirm` to tool schemas in registry**

In `container/agent-runner/src/tools/registry.ts`, in the `write_host_file` schema properties (around line 307), add after the `mode` property:

```typescript
          confirm: { type: 'boolean', description: 'Set true after the user confirmed the overwrite.' },
```

In the `move_host_path` schema properties (around line 393), add after `destination_path`:

```typescript
          confirm: { type: 'boolean', description: 'Set true after the user confirmed replacing the destination.' },
```

- [ ] **Step 6: Run tests to verify the fix**

Run: `npx vitest run container/agent-runner/src/tools/host-files.test.ts --reporter=verbose`
Expected: All tests PASS including the new `confirm` test.

- [ ] **Step 7: Commit**

```bash
git add container/agent-runner/src/tools/host-files.ts container/agent-runner/src/tools/host-files.test.ts container/agent-runner/src/tools/registry.ts
git commit -m "feat: add confirm parameter to write/move tools for local model tool-call flow"
```

---

## Task 5: Improve Tool Descriptions for Local Models

Local 7-13B models struggle with vague descriptions. They need to see the exact parameter names and common use patterns in the description itself — not in a separate skill file they may not have in context.

**Files:**
- Modify: `container/agent-runner/src/tools/registry.ts:254-415`

- [ ] **Step 1: Improve host-file tool descriptions with parameter hints**

In `container/agent-runner/src/tools/registry.ts`, update the descriptions for all host-file tools. Replace each tool's `description` field:

For `list_host_directories` (around line 257):
```typescript
      description:
        'List the allowed directories on the user\'s computer. Returns paths, read/write status, and a preview of contents. ALWAYS call this first before other host-file tools.',
```

For `list_host_entries` (around line 269):
```typescript
      description:
        'List files and folders inside a directory. Requires "path" (absolute). Optional: "recursive" (true to descend into subfolders), "limit" (max entries, default 50).',
```

For `read_host_file` (around line 286):
```typescript
      description:
        'Read text content of a file. Requires "path" (absolute). Optional: "start_line" (1-based), "max_lines" (default 200), "max_chars" (default 12000).',
```

For `write_host_file` (around line 301):
```typescript
      description:
        'Create or overwrite a text file. Requires "path" (absolute) and "content" (text). To overwrite an existing file, set "mode" to "overwrite" and "confirm" to true.',
```

For `edit_host_file` (around line 318):
```typescript
      description:
        'Edit a file by finding and replacing exact text. Requires "path", "search" (exact text to find), and "replace" (replacement text). Optional: "replace_all" (true to replace every occurrence).',
```

For `glob_host_files` (around line 338):
```typescript
      description:
        'Find files matching a pattern. Requires "base_path" (directory to search) and "pattern" (e.g. "*.txt", "**/*.md"). Optional: "limit" (max results).',
```

For `grep_host_files` (around line 356):
```typescript
      description:
        'Search for text inside files. Requires "base_path" (directory to search) and "query" (text to find). Returns matching file paths with line numbers.',
```

For `make_host_directory` (around line 374):
```typescript
      description:
        'Create a new directory. Requires "path" (absolute path for the new folder). Creates parent directories automatically.',
```

For `move_host_path` (around line 386):
```typescript
      description:
        'Move or rename a file or folder. Requires "source_path" and "destination_path" (both absolute). Set "confirm" to true if the destination already exists.',
```

For `copy_host_path` (around line 401):
```typescript
      description:
        'Copy a file or folder. Requires "source_path" and "destination_path" (both absolute). Copies recursively for folders.',
```

- [ ] **Step 2: Build to verify TypeScript compiles**

Run: `cd container/agent-runner && npm run build`
Expected: Clean compile.

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/tools/registry.ts
git commit -m "fix: improve host-file tool descriptions with parameter hints for local models"
```

---

## Task 6: Rewrite Host-Files Skill Prompt for Local Models

The container skill needs concrete parameter examples and step-by-step sequences that local models can follow mechanically.

**Files:**
- Modify: `container/skills/host-files/SKILL.md`

- [ ] **Step 1: Rewrite with concrete examples**

Replace the full contents of `container/skills/host-files/SKILL.md`:

```markdown
# Host Files — Local File Access Tools

You have tools to read, write, edit, search, and organize files on the user's computer.

## Step 1 — Always Do This First

Call `list_host_directories` (no arguments needed) to see which directories you can access.

Example tool call:
```json
{"name": "list_host_directories", "arguments": {}}
```

This returns the allowed paths, their access mode (read-only or read-write), and a preview of contents.

If it returns "No host directories configured", tell the user to run `/add-host-files`.

## Available Tools

### Reading
- `list_host_entries` — list files in a folder
  ```json
  {"name": "list_host_entries", "arguments": {"path": "C:/Users/me/Documents"}}
  ```
- `read_host_file` — read a file
  ```json
  {"name": "read_host_file", "arguments": {"path": "C:/Users/me/Documents/notes.txt"}}
  ```
- `glob_host_files` — find files by pattern
  ```json
  {"name": "glob_host_files", "arguments": {"base_path": "C:/Users/me/Documents", "pattern": "**/*.md"}}
  ```
- `grep_host_files` — search text in files
  ```json
  {"name": "grep_host_files", "arguments": {"base_path": "C:/Users/me/Documents", "query": "TODO"}}
  ```

### Writing
- `write_host_file` — create a new file
  ```json
  {"name": "write_host_file", "arguments": {"path": "C:/Users/me/Documents/new.txt", "content": "Hello world"}}
  ```
- `write_host_file` — overwrite existing (needs user confirmation first)
  ```json
  {"name": "write_host_file", "arguments": {"path": "C:/Users/me/Documents/old.txt", "content": "Updated", "mode": "overwrite", "confirm": true}}
  ```
- `edit_host_file` — find and replace in a file
  ```json
  {"name": "edit_host_file", "arguments": {"path": "C:/Users/me/Documents/notes.txt", "search": "old text", "replace": "new text"}}
  ```

### Organizing
- `make_host_directory` — create a folder
  ```json
  {"name": "make_host_directory", "arguments": {"path": "C:/Users/me/Documents/archive"}}
  ```
- `move_host_path` — move or rename
  ```json
  {"name": "move_host_path", "arguments": {"source_path": "C:/Users/me/Documents/old.txt", "destination_path": "C:/Users/me/Documents/archive/old.txt"}}
  ```
- `copy_host_path` — copy
  ```json
  {"name": "copy_host_path", "arguments": {"source_path": "C:/Users/me/Documents/notes.txt", "destination_path": "C:/Users/me/Desktop/notes-backup.txt"}}
  ```

## Rules

1. Only use paths inside directories returned by `list_host_directories`.
2. Do not write to read-only directories.
3. Always use absolute paths (e.g. `C:/Users/me/Documents/file.txt`).
4. Before overwriting, ask the user to confirm. Then set `"confirm": true`.
5. When the user asks to do something with files, USE THE TOOLS. Do not just describe what you would do.
```

- [ ] **Step 2: Commit**

```bash
git add container/skills/host-files/SKILL.md
git commit -m "docs: rewrite host-files skill prompt with concrete tool-call examples for local models"
```

---

## Task 7: Full Verification

**Files:** None (verification only)

- [ ] **Step 1: Run all affected tests**

Run: `npx vitest run container/agent-runner/src/tools/host-files.test.ts container/agent-runner/src/host-dirs.test.ts src/runtime/capability-router.test.ts container/agent-runner/src/runtime/openai.test.ts --reporter=verbose`
Expected: All tests PASS.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: All tests PASS (or only pre-existing failures).

- [ ] **Step 3: Build the agent-runner**

Run: `cd container/agent-runner && npm run build`
Expected: Clean compile.

- [ ] **Step 4: Verify tool schema size is reasonable**

Run: `cd container/agent-runner && node -e "const {buildToolRegistry,filterToolRegistry,toOpenAITools}=require('./dist/tools/registry.js');const r=filterToolRegistry(buildToolRegistry(),{web:{enabled:false},browser:{enabled:false}});const hf=r.filter(t=>t.family==='host_files'||t.family==='memory');console.log('host_file tools:',hf.length);console.log('schema chars:',JSON.stringify(toOpenAITools(hf)).length)"`
Expected: 12 tools (10 host_files + 2 memory), schema size under 6000 chars.

---

## Summary of Changes

| Bug | Fix | File |
|-----|-----|------|
| Discovery gates out action tools | Give all host-file tools on discovery turns | `openai.ts:1268-1280` |
| `list_host_directories` satisfies contract | Exclude it from contract satisfaction check | `openai.ts:3081-3087, 2119-2128` |
| max_tokens=280 too small for tool calls | Raise to 512 for pre-tool-call iterations | `openai.ts:2780-2783` |
| Router false positives | Strong vs weak noun separation, web signal exclusion | `capability-router.ts:29-37` |
| Confirmation ignores tool args | Add `confirm` parameter to write/move | `host-files.ts:133-143` |
| Tool descriptions too vague | Add parameter names and usage hints | `registry.ts:254-415` |
| Skill prompt lacks examples | Add JSON tool-call examples per tool | `host-files/SKILL.md` |
