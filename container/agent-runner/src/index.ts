/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import { createRuntimeAdapter } from './runtime/factory.js';
import { resolveExternalRuntimeBudgets } from './runtime/budgets.js';
import {
  ConversationMessage,
  RuntimeConfig,
  RuntimeProvider,
  RuntimeUsageMetrics,
} from './runtime/types.js';
import type { RuntimeAdapter } from './runtime/types.js';

/**
 * Persistent state for a warm OpenAI-compatible session.
 * Lives across multiple turns in the main query loop — created before the
 * while(true) loop and reused on every follow-up IPC message.
 */
interface ExternalSessionState {
  /** Reused adapter instance (same HTTP client, same config). */
  adapter: RuntimeAdapter;
  /** System prompt built once from containerInput — stable across turns. */
  systemPrompt: string | undefined;
  /** Accumulated user+assistant+tool messages from all prior turns. */
  priorMessages: ConversationMessage[];
  /** Session ID carried across turns for consistent host tracking. */
  sessionId: string | undefined;
}

interface ContainerInput {
  prompt: string;
  systemPrompt?: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  singleTurn?: boolean;
  isScheduledTask?: boolean;
  isHeartbeat?: boolean;
  assistantName?: string;
  runtimeProfileId?: string;
  runtimeConfig?: RuntimeConfig;
  retryPolicy?: {
    maxAttempts: number;
    backoffMs: number;
    retryableErrors: string[];
    timeoutMs: number;
  };
  secrets?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  usage?: RuntimeUsageMetrics;
  isPartial?: boolean;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = process.env.NANOCLAW_IPC_INPUT_DIR || '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = Math.max(
  50,
  Number.parseInt(process.env.NANOCLAW_AGENT_IPC_POLL_MS || '100', 10) || 100,
);

// Maximum warm-session history to keep in memory. Prevents unbounded context
// growth which increases TTFT linearly with conversation length.
// Each "pair" is one user turn + one assistant turn.
const MAX_PRIOR_PAIRS = Math.max(
  1,
  Number.parseInt(process.env.OPENAI_MAX_PRIOR_TURNS || '10', 10) || 10,
);
const MAX_PRIOR_CHARS = Math.max(
  2000,
  Number.parseInt(process.env.OPENAI_MAX_PRIOR_CHARS || '16000', 10) || 16000,
);

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getRuntimeConfig(input: ContainerInput): RuntimeConfig {
  const cfg = input.runtimeConfig;
  if (cfg?.provider && cfg.model) {
    return cfg;
  }
  return {
    provider: 'claude',
    model: 'claude-sonnet-4-5',
  };
}

function loadLegacySystemPrompt(containerInput: ContainerInput): string[] {
  if (containerInput.systemPrompt?.trim()) {
    return [containerInput.systemPrompt.trim()];
  }

  const prompts: string[] = [];
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  const localClaudeMdPath = '/workspace/group/CLAUDE.md';

  if (fs.existsSync(globalClaudeMdPath)) {
    prompts.push(fs.readFileSync(globalClaudeMdPath, 'utf-8').trim());
  }
  if (fs.existsSync(localClaudeMdPath)) {
    prompts.push(fs.readFileSync(localClaudeMdPath, 'utf-8').trim());
  }
  return prompts.filter(Boolean);
}

function buildSystemPrompt(containerInput: ContainerInput): string | undefined {
  const prompts = loadLegacySystemPrompt(containerInput);
  if (containerInput.runtimeConfig?.plannerCritic?.enabled !== false) {
    prompts.push(
      'For complex multi-step tasks: Think through your approach step-by-step before acting. ' +
        'After completing the task, briefly self-evaluate whether the response is complete and accurate before finishing.',
    );
  }
  if (prompts.length === 0) return undefined;
  return prompts.join('\n\n');
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

// Secrets to strip from Bash tool subprocess environments.
// These are needed by claude-code for API auth but should never
// be visible to commands Kit runs.
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMd = buildSystemPrompt(containerInput);

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
        : undefined,
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*'
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [createSanitizeBashHook()] }],
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId
      });
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

/**
 * Create the initial ExternalSessionState before the query loop.
 * The adapter and system prompt are built once and reused across all turns.
 */
function createExternalSessionState(
  containerInput: ContainerInput,
  sessionId: string | undefined,
): ExternalSessionState {
  const runtimeConfig = getRuntimeConfig(containerInput);
  return {
    adapter: createRuntimeAdapter(runtimeConfig),
    systemPrompt: buildSystemPrompt(containerInput),
    priorMessages: [],
    sessionId,
  };
}

async function runExternalRuntimeQuery(
  prompt: string,
  containerInput: ContainerInput,
  sessionState: ExternalSessionState,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  if (shouldClose()) {
    log('Close sentinel detected before non-Claude query');
    return { newSessionId: sessionState.sessionId, closedDuringQuery: true };
  }

  const runtimeConfig = getRuntimeConfig(containerInput);
  const retry = containerInput.retryPolicy || {
    maxAttempts: 1,
    backoffMs: 0,
    timeoutMs: 90000,
  };
  const retryablePatterns: string[] = Array.isArray(
    (retry as { retryableErrors?: unknown }).retryableErrors,
  )
    ? ((retry as { retryableErrors?: unknown[] }).retryableErrors as unknown[])
        .map((x) => String(x))
    : [];
  const maxAttempts = Math.max(1, retry.maxAttempts || 1);
  const totalRuntimeBudgetMs = Math.max(10_000, retry.timeoutMs || 90_000);
  const runtimeStartedAt = Date.now();
  const configuredRequestTimeoutMs = Number.parseInt(
    containerInput.secrets?.OPENAI_REQUEST_TIMEOUT_MS || '',
    10,
  );
  const configuredToolLoopBudgetMs = Number.parseInt(
    containerInput.secrets?.WEB_TOOL_LOOP_BUDGET_MS || '',
    10,
  );

  const isRetryableError = (message: string): boolean => {
    if (retryablePatterns.length === 0) return false;
    const lower = message.toLowerCase();
    return retryablePatterns.some((p) => lower.includes(p.toLowerCase()));
  };

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const elapsedMs = Date.now() - runtimeStartedAt;
    const remainingBudgetMs = totalRuntimeBudgetMs - elapsedMs;
    if (remainingBudgetMs <= 0) {
      lastError = new Error(
        `Runtime timeout after ${totalRuntimeBudgetMs}ms`,
      );
      break;
    }

    const budgets = resolveExternalRuntimeBudgets({
      capabilityRoute: containerInput.runtimeConfig?.capabilityRoute,
      configuredRequestTimeoutMs,
      configuredToolLoopBudgetMs,
      remainingRuntimeBudgetMs: remainingBudgetMs,
      webTotalBudgetMs:
        containerInput.runtimeConfig?.toolPolicy?.web?.totalBudgetMs,
      browserTotalBudgetMs:
        containerInput.runtimeConfig?.toolPolicy?.browser?.totalBudgetMs,
    });

    const boundedSecrets = {
      ...(containerInput.secrets || {}),
      OPENAI_REQUEST_TIMEOUT_MS: String(
        budgets.effectiveRequestTimeoutMs,
      ),
      WEB_TOOL_LOOP_BUDGET_MS: String(
        budgets.effectiveToolLoopBudgetMs,
      ),
    };

    try {
      const response = await sessionState.adapter.run({
        prompt,
        systemPrompt: sessionState.systemPrompt,
        config: runtimeConfig,
        secrets: boundedSecrets,
        priorMessages: sessionState.priorMessages.length > 0
          ? sessionState.priorMessages
          : undefined,
        onPartialText: async (text) => {
          if (!text) return;
          writeOutput({
            status: 'success',
            result: text,
            newSessionId: sessionState.sessionId,
            isPartial: true,
          });
        },
      });

      // Accumulate conversation history (user + assistant pairs) for the next warm turn.
      // Tool call internals are omitted for simplicity — the assistant's textual response
      // is sufficient for follow-up conversational context.
      sessionState.priorMessages = [
        ...sessionState.priorMessages,
        { role: 'user', content: prompt },
        { role: 'assistant', content: response.result },
      ];

      // Trim priorMessages to prevent unbounded context growth.
      // Keep the most recent MAX_PRIOR_PAIRS pairs, staying within the char budget.
      // Remove oldest pairs first (always in user+assistant units of 2).
      while (sessionState.priorMessages.length > MAX_PRIOR_PAIRS * 2) {
        sessionState.priorMessages.splice(0, 2);
      }
      let priorChars = sessionState.priorMessages.reduce(
        (sum, m) => sum + m.content.length,
        0,
      );
      while (priorChars > MAX_PRIOR_CHARS && sessionState.priorMessages.length >= 2) {
        const removed = sessionState.priorMessages.splice(0, 2);
        priorChars -= removed[0].content.length + removed[1].content.length;
      }

      // Carry the session ID forward so it stays stable across warm turns.
      if (response.sessionId) {
        sessionState.sessionId = response.sessionId;
      }

      writeOutput({
        status: 'success',
        result: response.result,
        newSessionId: sessionState.sessionId,
        usage: response.usage,
        isPartial: false,
      });
      return {
        newSessionId: sessionState.sessionId,
        closedDuringQuery: false,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      log(
        `Non-Claude runtime attempt ${attempt}/${maxAttempts} failed: ${lastError.message}`,
      );
      const canRetry =
        attempt < maxAttempts &&
        isRetryableError(lastError.message) &&
        Date.now() - runtimeStartedAt < totalRuntimeBudgetMs;
      if (canRetry) {
        const remaining = totalRuntimeBudgetMs - (Date.now() - runtimeStartedAt);
        const delay = Math.max(0, Math.min(retry.backoffMs || 0, remaining));
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } else {
        break;
      }
    }
  }

  writeOutput({
    status: 'error',
    result: null,
    newSessionId: sessionState.sessionId,
    error: lastError?.message || 'Unknown runtime error',
  });
  return {
    newSessionId: sessionState.sessionId,
    closedDuringQuery: false,
  };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  const runtimeConfig = getRuntimeConfig(containerInput);
  const runtimeProvider: RuntimeProvider = runtimeConfig.provider;
  log(
    `Runtime selected: profile=${containerInput.runtimeProfileId || 'builtin'} provider=${runtimeProvider} model=${runtimeConfig.model} toolPolicy=${JSON.stringify(runtimeConfig.toolPolicy || {})}`,
  );
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isHeartbeat) {
    prompt = `[HEARTBEAT CHECK - This is an automated diagnostic check, NOT a user message. Do NOT schedule new tasks or register new watches. Review the checklist below and respond ONLY if something needs the user's attention. If nothing needs attention, respond with exactly: HEARTBEAT_OK]\n\n${prompt}`;
  } else if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK EXECUTION - This task was already scheduled and is now firing. DO NOT call schedule_task, schedule_once_task, schedule_recurring_task, schedule_interval_task, or register_watch. Simply execute the task described below and return the result directly.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Create session state once before the loop so the adapter and conversation
  // history are reused across warm follow-up turns (OpenAI-compatible only).
  const externalSessionState =
    runtimeProvider !== 'claude'
      ? createExternalSessionState(containerInput, sessionId)
      : null;

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult =
        runtimeProvider === 'claude'
          ? await runQuery(
              prompt,
              sessionId,
              mcpServerPath,
              containerInput,
              sdkEnv,
              resumeAt,
            )
          : await runExternalRuntimeQuery(prompt, containerInput, externalSessionState!);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      // Keep externalSessionState.sessionId in sync with the loop-level sessionId.
      if (externalSessionState && externalSessionState.sessionId) {
        sessionId = externalSessionState.sessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      if (containerInput.singleTurn) {
        log('Single-turn mode enabled, exiting after first query');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
