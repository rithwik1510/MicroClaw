import fs from 'fs';
import path from 'path';

import { postJson, makeSessionId } from './http.js';
import { RuntimeAdapter, RuntimeRequest, RuntimeResponse } from './types.js';
import {
  buildToolRegistry,
  filterToolRegistry,
  findTool,
  toOpenAITools,
} from '../tools/registry.js';
import { ToolExecutionContext } from '../tools/types.js';
import {
  executeBrowserOpenUrl,
  executeBrowserSnapshot,
  closeBrowserSessionFromContext,
} from '../tools/browser/actions.js';
import {
  closeWebSessionFromContext,
  executeWebSearch,
} from '../tools/web/actions.js';
import {
  buildPlannerCriticTools,
  buildPlanProgressNote,
  createPlannerCriticState,
  resolveAdaptedBudgets,
  updateStepProgress,
} from '../tools/planner-critic.js';

function extractOpenAIText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';

  const p = payload as Record<string, unknown>;
  const outputText = p.output_text;
  if (typeof outputText === 'string' && outputText.trim()) {
    return outputText;
  }

  const output = p.output;
  if (!Array.isArray(output)) return '';

  const chunks: string[] = [];
  for (const item of output as Array<Record<string, unknown>>) {
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as Array<Record<string, unknown>>) {
      if (part.type === 'output_text' && typeof part.text === 'string') {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join('\n').trim();
}

function stripThinkBlocks(text: string): string {
  if (!text) return '';
  const withoutBlocks = text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, ' ')
    .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, ' ');
  const withoutDanglingBlocks = withoutBlocks
    .replace(/<think\b[^>]*>[\s\S]*$/gi, ' ')
    .replace(/<thinking\b[^>]*>[\s\S]*$/gi, ' ');
  return withoutDanglingBlocks.replace(/\n{3,}/g, '\n\n').trim();
}

function visibleText(text: string): string {
  return stripThinkBlocks(text).trim();
}

type StoredSources = {
  query: string;
  sources: string[];
  updatedAt: string;
};

type BrowserBootstrap = {
  targetUrl?: string;
};

type BrowserBootstrapState = {
  used: boolean;
  openedUrl?: string;
};

type PlanningIntensity = 'off' | 'optional' | 'recommended';
type SchedulingMode = 'none' | 'once' | 'interval' | 'cron' | 'watch';

const MEMORY_FLUSH_TRIGGER_STEPS = 6;
const MEMORY_FLUSH_BUDGET_RATIO = 0.65;
const MEMORY_FLUSH_ADVISORY =
  '[Memory advisory] You have completed many tool steps. Before continuing, if you discovered any facts, preferences, or project details worth remembering across sessions, call remember_this now. Then proceed with the task.';

export class OpenAIRuntimeAdapter implements RuntimeAdapter {
  provider: RuntimeAdapter['provider'] = 'openai_compatible';

  private static readonly DEFAULT_LOCAL_CONTEXT_WINDOW_TOKENS = 4096;
  private static readonly LOCAL_TOOL_RESERVE_TOKENS = 900;
  private static readonly LOCAL_NON_TOOL_RESERVE_TOKENS = 250;
  private static readonly MIN_INPUT_BUDGET_TOKENS = 700;

  private decodeXmlEntities(input: string): string {
    return input
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  private currentTurnPrompt(prompt: string): string {
    const marker = '[Current message - respond to this]';
    const index = prompt.lastIndexOf(marker);
    if (index === -1) return prompt.trim();
    return prompt.slice(index + marker.length).trim();
  }

  private shouldPrefixNoThink(model: string): boolean {
    return /\bqwen3\b/i.test(model);
  }

  private sanitizeRuntimeSystemPrompt(systemPrompt: string | undefined): string | undefined {
    if (!systemPrompt?.trim()) return undefined;

    const blockedHeadings = new Set([
      'what you can do',
      'your workspace',
      'admin context',
      'container mounts',
      'managing groups',
      'global memory',
      'scheduling for other groups',
      'development',
      'troubleshooting',
      'container build cache',
      'skills',
    ]);

    const blockedLinePatterns = [
      /agent-browser/i,
      /\bbash\b/i,
      /mcp__/i,
      /schedule_task/i,
      /\/workspace\//i,
      /container/i,
      /docker/i,
      /sqlite3/i,
      /register_group/i,
    ];

    const sanitized: string[] = [];
    let skipSection = false;

    for (const rawLine of systemPrompt.split('\n')) {
      const line = rawLine.trimEnd();
      const trimmed = line.trim();

      if (/^##\s+/.test(trimmed)) {
        const heading = trimmed.replace(/^##\s+/, '').trim().toLowerCase();
        skipSection = blockedHeadings.has(heading);
        continue;
      }

      if (skipSection) continue;
      if (!trimmed) {
        if (sanitized[sanitized.length - 1] !== '') sanitized.push('');
        continue;
      }
      if (trimmed.startsWith('|')) continue;
      if (trimmed.startsWith('```')) continue;
      if (blockedLinePatterns.some((pattern) => pattern.test(trimmed))) continue;

      sanitized.push(line);
    }

    const joined = sanitized.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return joined || undefined;
  }

  private prepareUserPrompt(
    prompt: string,
    model: string,
    options?: { allowNoThinkPrefix?: boolean },
  ): string {
    if (options?.allowNoThinkPrefix === false) return prompt;
    if (!this.shouldPrefixNoThink(model)) return prompt;
    if (/^\s*\/no_think\b/i.test(prompt)) return prompt;
    return `/no_think\n${prompt}`;
  }

  private looksLikeTransientRuntimeError(message: string): boolean {
    const lower = message.toLowerCase();
    return (
      lower.includes('timeout') ||
      lower.includes('timed out') ||
      lower.includes('fetch failed') ||
      lower.includes('network request failed') ||
      lower.includes('econnrefused') ||
      lower.includes('socket hang up') ||
      lower.includes('no text output')
    );
  }

  private browserBootstrap(prompt: string): BrowserBootstrap {
    const current = this.currentTurnPrompt(prompt);
    if (this.shouldTreatAsExplanatoryCodePaste(current)) {
      return {};
    }
    const explicitUrl = current.match(/https?:\/\/[^\s)<>"']+/i)?.[0];
    if (explicitUrl) {
      return { targetUrl: explicitUrl.replace(/[),.;]+$/, '') };
    }

    const domainMatch = current.match(
      /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/i,
    );
    if (!domainMatch) return {};

    const domain = domainMatch[0].replace(/[),.;]+$/, '');
    return { targetUrl: `https://${domain}` };
  }

  private appendSyntheticToolResult(input: {
    messages: Array<Record<string, unknown>>;
    toolName: string;
    args: Record<string, unknown>;
    result: { ok: boolean; content: string };
    idSuffix: string;
  }): void {
    const toolCallId = `bootstrap-${input.idSuffix}`;
    input.messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: toolCallId,
          type: 'function',
          function: {
            name: input.toolName,
            arguments: JSON.stringify(input.args),
          },
        },
      ],
    });
    input.messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: JSON.stringify(input.result),
    });
  }

  private pickSearchBootstrapUrl(sources: string[]): string | null {
    for (const source of sources) {
      try {
        const parsed = new URL(source);
        const hostname = parsed.hostname.toLowerCase();
        if (
          hostname.includes('duckduckgo.com') ||
          hostname.includes('google.com') ||
          hostname.includes('bing.com') ||
          hostname.includes('search.yahoo.com')
        ) {
          continue;
        }
        return parsed.toString();
      } catch {
        continue;
      }
    }
    return null;
  }

  private async maybeBootstrapBrowserTurn(input: {
    req: RuntimeRequest;
    toolCtx: ToolExecutionContext;
    messages: Array<Record<string, unknown>>;
    webEnabled: boolean;
  }): Promise<BrowserBootstrapState> {
    const bootstrap = this.browserBootstrap(input.req.prompt);

    const openAndSnapshot = async (url: string): Promise<BrowserBootstrapState> => {
      const openResult = await executeBrowserOpenUrl({ url }, input.toolCtx);
      this.appendSyntheticToolResult({
        messages: input.messages,
        toolName: 'browser_open_url',
        args: { url },
        result: openResult,
        idSuffix: 'browser-open',
      });
      if (!openResult.ok) {
        console.error(`[openai-runtime] browser bootstrap open failed url=${url} detail=${openResult.content}`);
        return { used: true };
      }

      const snapshotResult = await executeBrowserSnapshot({ limit: 18 }, input.toolCtx);
      this.appendSyntheticToolResult({
        messages: input.messages,
        toolName: 'browser_snapshot',
        args: { limit: 18 },
        result: snapshotResult,
        idSuffix: 'browser-snapshot',
      });
      console.error(
        `[openai-runtime] browser bootstrap opened url=${url} snapshotOk=${snapshotResult.ok}`,
      );
      return { used: true, openedUrl: url };
    };

    if (bootstrap.targetUrl) {
      return openAndSnapshot(bootstrap.targetUrl);
    }

    if (!input.webEnabled) return { used: false };

    const query = this.normalizeWebQuery(input.req.prompt);
    if (!query) return { used: false };

    const searchResult = await executeWebSearch({ query }, input.toolCtx);
    this.appendSyntheticToolResult({
      messages: input.messages,
      toolName: 'web_search',
      args: { query },
      result: searchResult,
      idSuffix: 'web-search',
    });
    if (!searchResult.ok) {
      console.error(
        `[openai-runtime] browser bootstrap search failed query=${query} detail=${searchResult.content}`,
      );
      return { used: true };
    }

    const bootstrapUrl = this.pickSearchBootstrapUrl(
      this.extractSources(searchResult.content),
    );
    if (!bootstrapUrl) {
      console.error(`[openai-runtime] browser bootstrap search found no usable url query=${query}`);
      return { used: true };
    }

    return openAndSnapshot(bootstrapUrl);
  }

  private normalizeWebQuery(prompt: string): string {
    const trimmed = this.currentTurnPrompt(prompt).trim();
    if (!trimmed) return '';

    const messageMatches = Array.from(
      trimmed.matchAll(/<message\b[^>]*>([\s\S]*?)<\/message>/gi),
    );
    if (messageMatches.length > 0) {
      const lastBody = messageMatches[messageMatches.length - 1]?.[1] || '';
      const decoded = this.decodeXmlEntities(lastBody)
        .replace(/\s+/g, ' ')
        .trim();
      if (decoded) return decoded;
    }

    const stripped = this.decodeXmlEntities(trimmed.replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    const plain = stripped || trimmed;
    const tokens =
      plain.match(/[A-Za-z0-9][A-Za-z0-9+.#/-]*/g)?.map((token) => token) || [];
    if (tokens.length <= 4) return plain;

    const stopWords = new Set([
      'a',
      'an',
      'and',
      'are',
      'as',
      'at',
      'be',
      'best',
      'can',
      'for',
      'from',
      'give',
      'how',
      'i',
      'in',
      'is',
      'latest',
      'me',
      'of',
      'on',
      'recent',
      'releases',
      'tell',
      'the',
      'to',
      'what',
      'which',
      'world',
    ]);

    const compact = tokens
      .filter((token) => {
        const lower = token.toLowerCase();
        if (/^(gpt|grok|claude|gemini|qwen|deepseek|llama|openai|anthropic)([-./#]?\w+)*$/i.test(token)) {
          return true;
        }
        if (/\d/.test(token)) return true;
        return token.length >= 4 && !stopWords.has(lower);
      })
      .join(' ')
      .trim();

    return compact.length >= 8 ? compact : plain;
  }

  private looksLikeEmbeddedCodeOrMarkup(text: string): boolean {
    const scriptLike =
      /<script\b|<\/script>|<noscript\b|<\/noscript>|<body\b|<\/body>/i.test(
        text,
      );
    const denseMarkup =
      (text.match(/<[^>]+>/g) || []).length >= 4 ||
      (text.match(/https?:\/\//gi) || []).length >= 2;
    const codeLikePunctuation =
      /[_$][a-z0-9_]+\s*=|window\.[a-z0-9_]+|document\.[a-z0-9_]+|function\s*\(/i.test(
        text,
      );
    return scriptLike || (denseMarkup && codeLikePunctuation);
  }

  private asksForExplanation(text: string): boolean {
    return /\b(what is this|what does this do|explain|help me understand|what work is this|what exactly is this|i don't know|dont know|understand this)\b/i.test(
      text.toLowerCase(),
    );
  }

  private shouldTreatAsExplanatoryCodePaste(text: string): boolean {
    return (
      this.looksLikeEmbeddedCodeOrMarkup(text) &&
      this.asksForExplanation(text)
    );
  }

  private parsePositiveInt(raw: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(raw || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private tryParsePositiveInt(raw: string | undefined): number | null {
    const parsed = Number.parseInt(raw || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  private isLikelyLocalBaseUrl(baseUrl: string): boolean {
    try {
      const parsed = new URL(baseUrl);
      return (
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === 'localhost' ||
        parsed.hostname === 'host.docker.internal'
      );
    } catch {
      return /127\.0\.0\.1|localhost|host\.docker\.internal/i.test(baseUrl);
    }
  }

  private resolveInputBudgetChars(input: {
    req: RuntimeRequest;
    baseUrl: string;
    maxOutputTokens: number;
    toolsEnabled: boolean;
  }): number {
    const explicitChars = this.tryParsePositiveInt(
      input.req.secrets?.OPENAI_INPUT_BUDGET_CHARS,
    );
    if (explicitChars) return explicitChars;

    const explicitTokens = this.tryParsePositiveInt(
      input.req.secrets?.OPENAI_INPUT_BUDGET_TOKENS,
    );
    if (explicitTokens) {
      return explicitTokens * 4;
    }

    const explicitContextWindow = this.tryParsePositiveInt(
      input.req.secrets?.OPENAI_CONTEXT_WINDOW_TOKENS,
    );
    const contextWindowTokens =
      explicitContextWindow ||
      (this.isLikelyLocalBaseUrl(input.baseUrl)
        ? OpenAIRuntimeAdapter.DEFAULT_LOCAL_CONTEXT_WINDOW_TOKENS
        : 0);

    if (contextWindowTokens <= 0) return 0;

    const outputReserveTokens = Math.max(
      256,
      Math.min(input.maxOutputTokens, Math.floor(contextWindowTokens * 0.35)),
    );
    const toolReserveTokens = input.toolsEnabled
      ? OpenAIRuntimeAdapter.LOCAL_TOOL_RESERVE_TOKENS
      : OpenAIRuntimeAdapter.LOCAL_NON_TOOL_RESERVE_TOKENS;
    const inputBudgetTokens = Math.max(
      OpenAIRuntimeAdapter.MIN_INPUT_BUDGET_TOKENS,
      contextWindowTokens - outputReserveTokens - toolReserveTokens,
    );
    return inputBudgetTokens * 4;
  }

  private trimKeepStart(text: string, maxChars: number): string {
    if (maxChars <= 0) return '';
    if (text.length <= maxChars) return text;
    if (maxChars <= 16) return text.slice(0, maxChars);
    return `${text.slice(0, maxChars - 16).trimEnd()}\n\n[truncated]`;
  }

  private trimKeepEnd(text: string, maxChars: number): string {
    if (maxChars <= 0) return '';
    if (text.length <= maxChars) return text;
    if (maxChars <= 16) return text.slice(text.length - maxChars);
    return `[truncated]\n\n${text.slice(text.length - (maxChars - 16)).trimStart()}`;
  }

  private trimUserPromptToBudget(prompt: string, maxChars: number): string {
    if (maxChars <= 0 || prompt.length <= maxChars) return prompt;

    const marker = '[Current message - respond to this]';
    const index = prompt.lastIndexOf(marker);
    if (index === -1) {
      return this.trimKeepEnd(prompt, maxChars);
    }

    const currentSection = prompt.slice(index).trim();
    const currentOnly = `${marker}\n${this.currentTurnPrompt(prompt)}`.trim();
    const notice = '[Earlier conversation trimmed for local context budget]';

    if (currentSection.length + notice.length + 4 <= maxChars) {
      const earlier = prompt.slice(0, index).trim();
      const remaining = maxChars - currentSection.length - notice.length - 4;
      const preservedEarlier =
        remaining > 80 ? this.trimKeepEnd(earlier, remaining) : '';
      return [preservedEarlier, notice, currentSection].filter(Boolean).join(
        '\n\n',
      );
    }

    if (currentOnly.length + notice.length + 4 <= maxChars) {
      return `${notice}\n\n${currentOnly}`;
    }

    return this.trimKeepEnd(currentOnly, maxChars);
  }

  private fitPromptPairWithinBudget(input: {
    systemPrompt?: string;
    userPrompt: string;
    budgetChars: number;
  }): { systemPrompt?: string; userPrompt: string } {
    if (input.budgetChars <= 0) {
      return {
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
      };
    }

    const originalSystem = input.systemPrompt?.trim() || '';
    let systemPrompt = originalSystem;
    let userPrompt = input.userPrompt;
    const totalChars = () => systemPrompt.length + userPrompt.length;

    if (totalChars() <= input.budgetChars) {
      return {
        systemPrompt: systemPrompt || undefined,
        userPrompt,
      };
    }

    const targetSystemBudget = systemPrompt
      ? Math.min(
          systemPrompt.length,
          Math.max(1000, Math.floor(input.budgetChars * 0.38)),
        )
      : 0;
    const targetUserBudget = Math.max(
      800,
      input.budgetChars - targetSystemBudget,
    );

    userPrompt = this.trimUserPromptToBudget(userPrompt, targetUserBudget);
    if (systemPrompt) {
      systemPrompt = this.trimKeepStart(
        systemPrompt,
        Math.max(400, input.budgetChars - userPrompt.length),
      );
    }

    if (totalChars() > input.budgetChars) {
      userPrompt = this.trimUserPromptToBudget(
        userPrompt,
        Math.max(400, input.budgetChars - systemPrompt.length),
      );
    }

    if (systemPrompt && totalChars() > input.budgetChars) {
      systemPrompt = this.trimKeepStart(
        systemPrompt,
        Math.max(200, input.budgetChars - userPrompt.length),
      );
    }

    return {
      systemPrompt: systemPrompt || undefined,
      userPrompt,
    };
  }

  private availableTools(req: RuntimeRequest): {
    registry: ReturnType<typeof buildToolRegistry>;
    tools: Array<Record<string, unknown>>;
    webEnabled: boolean;
    browserEnabled: boolean;
  } {
    const route = this.effectiveCapabilityRoute(req);
    const providerToggle = (
      req.secrets?.WEB_SEARCH_PROVIDER ||
      req.secrets?.WEB_TOOL_PRIMARY ||
      'auto'
    )
      .trim()
      .toLowerCase();
    const webEnabledByPolicy =
      req.config.toolPolicy?.web?.enabled === true
      && providerToggle !== 'off'
      && (route === 'web_lookup' || route === 'browser_operation');
    const browserEnabledByPolicy =
      req.config.toolPolicy?.browser?.enabled === true
      && route === 'browser_operation';
    let registry = filterToolRegistry(
      buildToolRegistry(),
      {
        ...req.config.toolPolicy,
        web: {
          ...req.config.toolPolicy?.web,
          enabled: webEnabledByPolicy,
        },
        browser: {
          ...req.config.toolPolicy?.browser,
          enabled: browserEnabledByPolicy,
        },
      },
    );
    if (route === 'browser_operation') {
      registry = registry.filter(
        (tool) =>
          tool.family === 'browser' ||
          tool.family === 'meta' ||
          tool.name === 'web_search',
      );
    }
    return {
      registry,
      tools: toOpenAITools(registry),
      webEnabled: webEnabledByPolicy,
      browserEnabled: browserEnabledByPolicy,
    };
  }

  private hasExecutionTools(
    registry: ReturnType<typeof buildToolRegistry>,
  ): boolean {
    return registry.some(
      (tool) => tool.family === 'web' || tool.family === 'browser',
    );
  }

  private shouldUseToolLoop(
    req: RuntimeRequest,
    input: {
      webEnabled: boolean;
      browserEnabled: boolean;
      safeToolsPresent: boolean;
      metaToolsPresent: boolean;
    },
  ): boolean {
    const route = this.effectiveCapabilityRoute(req);
    if (route === 'deny_or_escalate') return false;
    if (route === 'plain_response') return input.safeToolsPresent;
    if (input.browserEnabled) return true;
    if (input.webEnabled) return true;
    return input.metaToolsPresent;
  }

  private isExplicitPlanningRequest(prompt: string): boolean {
    const current = this.currentTurnPrompt(prompt).toLowerCase();
    return /\b(plan first|make a plan|create a plan|step by step|analyze first|think through|review carefully|investigate carefully)\b/.test(
      current,
    );
  }

  private classifySchedulingMode(prompt: string): SchedulingMode {
    const current = this.currentTurnPrompt(prompt).toLowerCase();
    const taskCue =
      /\b(remind|send|check|read|look up|lookup|watch|monitor|notify|message|summarize|summary)\b/.test(current);
    if (!taskCue) return 'none';

    if (
      /\b(keep an eye on|watch for|monitor|let me know if|notify me if|tell me if)\b/.test(
        current,
      )
    ) {
      return 'watch';
    }

    if (
      /\bevery\s+\d+\s+(?:minute|minutes|hour|hours)\b|\bevery\s+few\s+(?:minutes|hours)\b/.test(
        current,
      )
    ) {
      return 'interval';
    }

    if (
      /\b(every\s+(?:day|weekday|weekdays|week|weekend|weekends|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|daily|weekly|each\s+(?:day|week)|every morning|every evening)\b/.test(
        current,
      )
    ) {
      return 'cron';
    }

    if (
      /\b(at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|tomorrow|today|tonight|later today|later tonight|in\s+\d+\s+(?:minute|minutes|hour|hours)|on\s+\d{4}-\d{2}-\d{2})\b/.test(
        current,
      )
    ) {
      return 'once';
    }

    return 'none';
  }

  private resolvePlanningIntensity(
    req: RuntimeRequest,
    input: {
      route: 'plain_response' | 'web_lookup' | 'browser_operation' | 'deny_or_escalate';
      webEnabled: boolean;
      browserEnabled: boolean;
      hasNonMetaTools: boolean;
    },
  ): PlanningIntensity {
    if (!input.hasNonMetaTools || input.route === 'deny_or_escalate') {
      return 'off';
    }

    if (this.isExplicitPlanningRequest(req.prompt)) {
      return 'recommended';
    }

    if (input.route === 'browser_operation') return 'optional';
    return 'off';
  }

  private plannerGuidance(intensity: PlanningIntensity): string {
    if (intensity === 'recommended') {
      return [
        'Planning tools:',
        '- This task looks structurally multi-step. Start by calling create_plan before acting.',
        '- Keep the plan short and action-oriented, then follow it in order.',
        '- After completing the planned work, use critique_response to verify completeness before answering.',
      ].join('\n');
    }
    if (intensity === 'optional') {
      return [
        'Planning tools:',
        '- If this task expands into multiple dependent steps, you may call create_plan before acting.',
        '- If you create a plan, follow it in order and use critique_response before the final answer.',
        '- If the task stays simple after initial inspection, act directly without planning.',
      ].join('\n');
    }
    return '';
  }

  private plannerToolsForTurn(
    state: ReturnType<typeof createPlannerCriticState> | null,
    intensity: PlanningIntensity,
    sawToolCalls: boolean,
  ) {
    if (!state || intensity === 'off') return [];
    return buildPlannerCriticTools(state).filter((tool) => {
      if (tool.name === 'create_plan') {
        return state.plan === null;
      }
      if (tool.name === 'critique_response') {
        return state.plan !== null || sawToolCalls;
      }
      return true;
    });
  }

  private shouldForceCreatePlan(
    state: ReturnType<typeof createPlannerCriticState> | null,
    intensity: PlanningIntensity,
  ): boolean {
    return intensity === 'recommended' && state !== null && state.plan === null;
  }

  private activeToolsForTurn(input: {
    baseRegistry: ReturnType<typeof buildToolRegistry>;
    baseTools: Array<Record<string, unknown>>;
    plannerState: ReturnType<typeof createPlannerCriticState> | null;
    planningIntensity: PlanningIntensity;
    sawToolCalls: boolean;
    schedulingMode: SchedulingMode;
    schedulingIntent: boolean;
    watchIntent: boolean;
  }): {
    registry: ReturnType<typeof buildToolRegistry>;
    tools: Array<Record<string, unknown>>;
  } {
    if (!input.sawToolCalls && (input.schedulingIntent || input.watchIntent)) {
      const preferredTool =
        input.schedulingIntent && !input.watchIntent
          ? this.expectedScheduleToolName(input.schedulingMode)
          : input.watchIntent && !input.schedulingIntent
            ? 'register_watch'
            : null;
      const schedulingTools = input.baseRegistry.filter(
        (tool) =>
          preferredTool
            ? tool.name === preferredTool
            : tool.name === 'schedule_task' ||
              tool.name === 'schedule_once_task' ||
              tool.name === 'schedule_recurring_task' ||
              tool.name === 'schedule_interval_task' ||
              tool.name === 'register_watch',
      );
      return {
        registry: schedulingTools,
        tools: toOpenAITools(schedulingTools),
      };
    }

    const plannerTools = this.plannerToolsForTurn(
      input.plannerState,
      input.planningIntensity,
      input.sawToolCalls,
    );

    if (this.shouldForceCreatePlan(input.plannerState, input.planningIntensity)) {
      const createPlanTool = plannerTools.filter((tool) => tool.name === 'create_plan');
      return {
        registry: createPlanTool,
        tools: toOpenAITools(createPlanTool),
      };
    }

    return {
      registry: [...input.baseRegistry, ...plannerTools],
      tools: [...input.baseTools, ...toOpenAITools(plannerTools)],
    };
  }

  private resolveToolChoice(input: {
    usingBrowserFlow: boolean;
    sawToolCalls: boolean;
    bootstrapUsed: boolean;
    prompt: string;
    planningIntensity: PlanningIntensity;
    plannerState: ReturnType<typeof createPlannerCriticState> | null;
    schedulingIntent: boolean;
    watchIntent: boolean;
  }): 'auto' | 'required' {
    if (!input.sawToolCalls && (input.schedulingIntent || input.watchIntent)) {
      return 'required';
    }
    if (this.shouldForceCreatePlan(input.plannerState, input.planningIntensity)) {
      return 'required';
    }
    if (
      input.usingBrowserFlow &&
      !input.sawToolCalls &&
      (!input.bootstrapUsed || this.browserTaskNeedsFollowUp(input.prompt))
    ) {
      return 'required';
    }

    return 'auto';
  }

  private webConfig(req: RuntimeRequest): ToolExecutionContext {
    const webPolicy = req.config.toolPolicy?.web;
    return {
      secrets: req.secrets,
      maxSearchCallsPerTurn: this.parsePositiveInt(
        webPolicy?.maxSearchCalls?.toString() ||
          req.secrets?.WEB_TOOL_MAX_SEARCH_CALLS,
        2,
      ),
      maxToolSteps: this.parsePositiveInt(
        webPolicy?.maxSteps?.toString() || req.secrets?.WEB_TOOL_MAX_STEPS,
        6,
      ),
      searchTimeoutMs: this.parsePositiveInt(
        req.secrets?.WEB_TOOL_SEARCH_TIMEOUT_MS,
        6000,
      ),
      pageFetchTimeoutMs: this.parsePositiveInt(
        req.secrets?.WEB_TOOL_PAGE_FETCH_TIMEOUT_MS,
        8000,
      ),
      totalWebBudgetMs: this.parsePositiveInt(
        webPolicy?.totalBudgetMs?.toString() ||
          req.secrets?.WEB_TOOL_TOTAL_BUDGET_MS,
        30000,
      ),
      startedAtMs: Date.now(),
      stepCount: 0,
      searchCount: 0,
    };
  }

  private browserConfig(req: RuntimeRequest): ToolExecutionContext {
    const browserPolicy = req.config.toolPolicy?.browser;
    const maxBrowserActions = this.parsePositiveInt(
      browserPolicy?.maxSteps?.toString() || req.secrets?.BROWSER_TOOL_MAX_STEPS,
      6,
    );
    return {
      secrets: req.secrets,
      maxSearchCallsPerTurn: 0,
      maxToolSteps: maxBrowserActions,
      searchTimeoutMs: 0,
      pageFetchTimeoutMs: 0,
      totalWebBudgetMs: 0,
      maxBrowserActionsPerTurn: maxBrowserActions,
      totalBrowserBudgetMs: this.parsePositiveInt(
        browserPolicy?.totalBudgetMs?.toString() ||
          req.secrets?.BROWSER_TOOL_TOTAL_BUDGET_MS,
        90_000,
      ),
      startedAtMs: Date.now(),
      stepCount: 0,
      searchCount: 0,
      browserActionCount: 0,
      browserPolicy: {
        allowPersistentSessions:
          browserPolicy?.allowPersistentSessions !== false,
        allowAttachedSessions:
          browserPolicy?.allowAttachedSessions === true,
        allowDesktopControl:
          browserPolicy?.allowDesktopControl === true,
        maxTabsPerSession:
          browserPolicy?.maxTabsPerSession || 3,
        idleTimeoutMs:
          browserPolicy?.idleTimeoutMs || 300_000,
        requireApprovalForBrowserMutations:
          browserPolicy?.requireApprovalForBrowserMutations === true,
        allowFormSubmission:
          browserPolicy?.allowFormSubmission !== false,
        allowFileUpload:
          browserPolicy?.allowFileUpload === true,
      },
    };
  }

  private browserToolContext(
    req: RuntimeRequest,
    input: { webEnabled: boolean },
  ): ToolExecutionContext {
    const browserCtx = this.browserConfig(req);
    if (!input.webEnabled) return browserCtx;
    const webCtx = this.webConfig(req);
    return {
      ...webCtx,
      ...browserCtx,
      startedAtMs: Date.now(),
      stepCount: 0,
      searchCount: 0,
      browserActionCount: 0,
      browserSession: undefined,
      webSession: undefined,
    };
  }

  private looksLikeNoRealtimeDisclaimer(text: string): boolean {
    const t = text.toLowerCase();
    return (
      t.includes("don't have access to real-time") ||
      t.includes('do not have access to real-time') ||
      t.includes("can't provide real-time") ||
      t.includes('cannot provide real-time') ||
      t.includes('unable to access real-time') ||
      t.includes('outside of my training data') ||
      t.includes('up to 2023') ||
      t.includes('up to my last update') ||
      t.includes('cannot browse the internet') ||
      t.includes("can't access the web") ||
      t.includes('cannot access the web') ||
      t.includes("i'm unable to access the web") ||
      t.includes('web search function is not available') ||
      t.includes('reached the web search limit') ||
      t.includes('web search limit') ||
      t.includes('search limit for today') ||
      t.includes('search quota') ||
      t.includes('quota exceeded') ||
      t.includes('budget exhaustion')
    );
  }

  private looksLikeWebToolFailure(text: string): boolean {
    const t = text.toLowerCase();
    return (
      t.includes('restricted source') ||
      t.includes('web lookup') ||
      t.includes('search call budget exhausted') ||
      t.includes('web total budget exhausted') ||
      t.includes('web step budget exhausted') ||
      t.includes('web access challenge detected')
    );
  }

  private looksLikeBrowserDeflection(text: string): boolean {
    const t = text.toLowerCase();
    return (
      t.includes('let me guide you') ||
      t.includes('step-by-step') ||
      t.includes('try a different approach') ||
      t.includes('would you like me to') ||
      t.includes('i can help you with that') ||
      t.includes('issue accessing the website') ||
      t.includes('issue accessing the site') ||
      t.includes('issue accessing the site externally') ||
      t.includes('issue with the web search') ||
      t.includes('unable to access the website') ||
      t.includes('tools for accessing external websites are currently limited') ||
      t.includes('accessing external websites are currently limited') ||
      t.includes('my tools for accessing external websites are currently limited') ||
      t.includes('simplest path is to') ||
      t.includes('proceed manually') ||
      t.includes('manually') ||
      t.includes('follow these steps')
    );
  }

  private browserTaskNeedsFollowUp(prompt: string): boolean {
    const current = this.currentTurnPrompt(prompt).toLowerCase();
    return /\b(log in|login|sign in|dashboard|portal|fill (out )?the form|submit|click|navigate|tab|see for yourself|check for yourself|inspect|look around)\b/.test(
      current,
    );
  }

  private browserRecoveryInstruction(input: {
    prompt: string;
    bootstrapState: BrowserBootstrapState;
    assistantContent: string;
  }): string {
    const openedNote =
      input.bootstrapState.used && input.bootstrapState.openedUrl
        ? `The browser is already open at ${input.bootstrapState.openedUrl} and the current page snapshot is already in the conversation.`
        : '';
    const deflection = this.looksLikeBrowserDeflection(input.assistantContent);
    const firstLine = deflection
      ? 'This is still a browser-operation turn. Do not say the tools are limited, do not suggest manual steps, and do not switch to an alternative approach.'
      : 'This is still a browser-operation turn. Continue by using the available browser tools now.';
    const followUpNote = this.browserTaskNeedsFollowUp(input.prompt)
      ? 'Because the user asked for an interactive site task, take another browser action instead of stopping after the first page load.'
      : 'If the current snapshot already answers the task, you may explain the result after grounding it in the tool output.';
    return [firstLine, openedNote, followUpNote]
      .filter(Boolean)
      .join(' ');
  }

  private schedulingRecoveryInstruction(input: {
    schedulingMode: SchedulingMode;
  }): string {
    if (input.schedulingMode === 'watch') {
      return [
        'This request is a watch-registration turn.',
        'Do not perform the monitored check right now.',
        'Call register_watch now so NanoClaw can monitor it later and notify the user when it matters.',
        'Do not call schedule_task for this kind of ongoing monitoring request.',
      ].join(' ');
    }

    const scheduleType =
      input.schedulingMode === 'cron'
        ? 'cron'
        : input.schedulingMode === 'interval'
          ? 'interval'
          : 'once';
    const scheduleTool =
      input.schedulingMode === 'cron'
        ? 'schedule_recurring_task'
        : input.schedulingMode === 'interval'
          ? 'schedule_interval_task'
          : 'schedule_once_task';
    return [
      'This request is a scheduling turn.',
      'Do not answer the future task right now.',
      `Call ${scheduleTool} now.`,
      `The required schedule type for this request is "${scheduleType}".`,
      'Pass the timing phrase naturally instead of inventing a rigid timestamp when possible.',
      'For one-time future work, use the field "when" with phrases like "today at 6 PM", "tomorrow at 9 AM", or "in 2 hours".',
      'For recurring calendar work, use the field "recurrence" with phrases like "every weekday at 8 AM".',
      'For elapsed interval work, use the field "every" with phrases like "every 5 minutes" or "every 2 hours".',
      'Do not call register_watch for a fixed-time or recurring timed task.',
    ].join(' ');
  }

  private expectedScheduleTypeForMode(
    mode: SchedulingMode,
  ): 'once' | 'interval' | 'cron' | null {
    if (mode === 'once' || mode === 'interval' || mode === 'cron') {
      return mode;
    }
    return null;
  }

  private expectedScheduleToolName(mode: SchedulingMode): string {
    if (mode === 'once') return 'schedule_once_task';
    if (mode === 'cron') return 'schedule_recurring_task';
    if (mode === 'interval') return 'schedule_interval_task';
    return 'schedule_task';
  }

  private shouldForceWebFallback(input: {
    assistantText: string;
    sawToolCalls: boolean;
  }): boolean {
    if (
      this.looksLikeNoRealtimeDisclaimer(input.assistantText) ||
      this.looksLikeWebToolFailure(input.assistantText)
    ) {
      return true;
    }
    return !input.sawToolCalls;
  }

  private extractSources(context: string): string[] {
    const sources: string[] = [];
    for (const raw of context.split('\n')) {
      const line = raw.trim();
      if (!/^\d+\.\s/.test(line)) continue;
      const match = line.match(/https?:\/\/\S+/i);
      if (!match) continue;
      const url = match[0].replace(/[),.;]+$/, '');
      if (!sources.includes(url)) sources.push(url);
      if (sources.length >= 5) break;
    }
    return sources;
  }

  private sourceCacheFilePath(): string | null {
    const inputDir = process.env.NANOCLAW_IPC_INPUT_DIR;
    if (!inputDir) return null;
    return path.join(path.resolve(inputDir, '..'), 'last_web_sources.json');
  }

  private saveSources(query: string, sources: string[]): void {
    const file = this.sourceCacheFilePath();
    if (!file || sources.length === 0) return;
    try {
      fs.writeFileSync(
        file,
        JSON.stringify(
          { query, sources, updatedAt: new Date().toISOString() },
          null,
          2,
        ) + '\n',
      );
    } catch {
      // best effort
    }
  }

  private loadSources(): StoredSources | null {
    const file = this.sourceCacheFilePath();
    if (!file || !fs.existsSync(file)) return null;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as {
        query?: unknown;
        sources?: unknown;
        updatedAt?: unknown;
      };
      const query = typeof parsed.query === 'string' ? parsed.query : '';
      const updatedAt =
        typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '';
      const sources = Array.isArray(parsed.sources)
        ? parsed.sources.filter((s): s is string => typeof s === 'string')
        : [];
      if (!query || sources.length === 0) return null;
      return { query, sources, updatedAt };
    } catch {
      return null;
    }
  }

  private isShowSourcesRequest(prompt: string): boolean {
    const normalized = this.normalizeWebQuery(prompt).toLowerCase().trim();
    return (
      normalized === 'show sources' ||
      normalized === 'sources' ||
      normalized === 'show the sources' ||
      normalized === 'list sources' ||
      normalized === 'show source links'
    );
  }

  private formatSourceDetailsReply(stored: StoredSources): string {
    return [
      `Sources for: ${stored.query}`,
      ...stored.sources.map((url, idx) => `${idx + 1}. <${url}>`),
    ].join('\n');
  }

  private buildWebFallbackSummary(prefetchContent: string): string {
    const lines = prefetchContent
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const evidenceExcerpts = lines
      .filter((line) => /^\d+\.\s.+\|\shttps?:\/\//i.test(line))
      .map((line) => {
        const parts = line.split('|').map((part) => part.trim()).filter(Boolean);
        return parts.length >= 3 ? parts[parts.length - 1] : '';
      })
      .filter((line) => line.length >= 40);

    const providerSummary = lines
      .filter((line) => /^search page summary:/i.test(line))
      .map((line) => line.replace(/^search page summary:\s*/i, '').trim())
      .concat(
        lines
          .filter((line) => /^provider note/i.test(line))
          .map((line) => line.replace(/^provider note(?: \([^)]+\))?:\s*/i, '').trim()),
      )
      .find(Boolean);

    const plainLines = lines.filter(
      (line) =>
        !/^query:/i.test(line) &&
        !/^sources:$/i.test(line) &&
        !/^search results:$/i.test(line) &&
        !/^fetched source excerpts:$/i.test(line) &&
        !/^fetched pages:$/i.test(line) &&
        !/^search provider:/i.test(line) &&
        !/^fetch provider:/i.test(line) &&
        !/^document:/i.test(line) &&
        !/^search page summary:/i.test(line) &&
        !/^provider note/i.test(line) &&
        !/^\d+\.\s.+\|\shttps?:\/\//i.test(line),
    );

    const summary = [providerSummary, ...evidenceExcerpts.slice(0, 2), ...plainLines]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 850);

    const out: string[] = [];
    if (summary) out.push(summary);
    return out.join('\n').trim();
  }

  private formatAnswerWithSources(answer: string, context: string): string {
    const cleanAnswer = visibleText(answer).replace(/\s+\n/g, '\n').trim();
    return cleanAnswer;
  }

  private webToolGuidance(route: RuntimeRequest['config']['capabilityRoute']): string {
    if (route === 'plain_response') {
      return [
        'Conversation policy:',
        '- Answer directly when no tool is needed.',
        '- Safe memory and scheduling tools may still be available on this turn.',
        '- Use schedule_once_task for one-time future times, schedule_recurring_task for recurring calendar times, and schedule_interval_task only for elapsed intervals.',
        '- Exact-time or recurring timed jobs include: "at 12 PM", "today at 6", "tomorrow morning", "in 2 hours", "every day at 9 AM", and "every weekday at noon".',
        '- Schedule mapping: use the once tool for one-time times like "at 12 PM today" or "tomorrow at 9" and pass the phrase in "when"; use the recurring tool for calendar patterns like "every weekday at 8 AM" and pass the phrase in "recurrence"; use the interval tool only for repeating elapsed intervals like "every 5 minutes" or "every 2 hours" and pass the phrase in "every".',
        '- For those timed requests, do not do the task now and do not answer with the requested result now. Schedule it.',
        '- Use register_watch only for ongoing monitoring instructions such as "keep an eye on this", "watch for changes", or "notify me if X happens".',
        '- Do not use register_watch as a fallback when schedule_task fails. Report the scheduling problem instead.',
        '- Use remember_this only for durable user facts, preferences, or long-term project context.',
        '- Do not reach for web or browser work unless this turn explicitly allows it.',
      ].join('\n');
    }
    if (route === 'browser_operation') {
      return [
        'Browser operator policy:',
        '- You have browser tools for this turn because the task needs interactive browser work.',
        '- You also have lightweight web lookup tools available to support the browser task when needed.',
        '- If the user names a site or product but does not give a URL, use web_search first to find the official site or login page, then use browser_open_url.',
        '- Use browser_open_url to start once you have the target URL.',
        '- Always use browser_snapshot before browser_click, browser_type, or browser_select.',
        '- Prefer browser_extract_text to read page content after navigation.',
        '- Use browser_tabs for tab management and browser_screenshot only when visual debugging is helpful.',
        '- Do not reply with manual instructions, alternative research plans, or "try a different approach" before using the available tools.',
        '- Only claim there was an access problem if a browser or web tool actually returned an error, and mention which tool failed.',
        '- Do not ask the user to guide you through the site when the browser tools can do the work directly.',
      ].join('\n');
    }
    return [
      'Web lookup policy:',
      '- You have web tools for this turn because the task needs live or external information.',
      '- If the user asks you to do that live/external work at a future time or on a recurring schedule, do not do it now. Use the correct scheduling tool instead.',
      '- Exact-time examples: "at 12 PM", "today at 6", "tomorrow at 9", "in 30 minutes", "every weekday at 8 AM".',
      '- Schedule mapping: use schedule_once_task for one-time times and pass the phrase in "when"; use schedule_recurring_task for recurring calendar times and pass the phrase in "recurrence"; use schedule_interval_task only for repeated elapsed intervals like "every 5 minutes" and pass the phrase in "every".',
      '- For those timed requests, do not answer with current search results now.',
      '- If the user asks you to keep watching something over time and notify only when it matters, call register_watch instead of doing a one-off lookup now.',
      '- Do not call register_watch for a fixed-time reminder or a timed recurring job.',
      '- Use web_search for current or external facts.',
      '- Use web_fetch when you have a URL or a search result to read.',
      '- Use browser tools only on browser-operation turns, not on web-lookup turns.',
      '- Base the final answer on fetched page content or structured search results, never raw search engine chrome.',
    ].join('\n');
  }

  private looksLikeContextRefusal(text: string): boolean {
    const t = text.toLowerCase();
    return (
      t.includes("can't provide a specific answer") ||
      t.includes('cannot provide a specific answer') ||
      t.includes('based on the given web context') ||
      t.includes('context does not contain any information') ||
      t.includes('does not contain any information') ||
      t.includes('related to an error message from duckduckgo') ||
      t.includes('unable to answer from the provided context')
    );
  }

  private looksLikeStaleKnowledgeFallback(text: string): boolean {
    const t = text.toLowerCase();
    return (
      t.includes('knowledge cutoff') ||
      t.includes('as of my knowledge cutoff') ||
      t.includes('as of my last update') ||
      t.includes('up to 2024') ||
      t.includes('up to my last update') ||
      t.includes('based on available context') ||
      t.includes('check official sources') ||
      t.includes('visit anthropic') ||
      t.includes('official blog') ||
      t.includes('github repository')
    );
  }

  private isStrongWebIntent(prompt: string): boolean {
    const current = this.currentTurnPrompt(prompt).toLowerCase();
    if (this.shouldTreatAsExplanatoryCodePaste(current)) return false;
    return (
      /https?:\/\//.test(current) ||
      /\b(latest|current|today|recent|news|look up|lookup|search|web|browse|source|sources|release|releases|update|updates)\b/.test(
        current,
      )
    );
  }

  private isStrongBrowserIntent(prompt: string): boolean {
    const current = this.currentTurnPrompt(prompt).toLowerCase();
    if (this.shouldTreatAsExplanatoryCodePaste(current)) return false;
    return (
      /\b(browser|open the site|open website|log in|login|sign in|dashboard|portal|fill (out )?the form|submit the form|click|navigate|tab|website)\b/.test(
        current,
      ) || /https?:\/\//.test(current) && /\b(click|log in|sign in|fill|submit|browser)\b/.test(current)
    );
  }

  private async runBestEffortKnowledgeAnswer(input: {
    userQuery: string;
    model: string;
    baseUrl: string;
    authHeaders: Record<string, string>;
    requestTimeoutMs: number;
    maxOutputTokens: number;
    reason: string;
  }): Promise<string> {
    try {
      const payload = (await postJson(
        `${input.baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          model: input.model,
          messages: [
            {
              role: 'system',
              content:
                'Web retrieval is unavailable or low-quality. Give a direct best-effort answer from model knowledge. Do not say you cannot answer from provided context. If uncertain, state uncertainty briefly.',
            },
            {
              role: 'user',
              content: this.prepareUserPrompt(
                `Question: ${input.userQuery}\n\nWeb issue: ${input.reason}\n\nProvide the most useful best-effort answer now.`,
                input.model,
              ),
            },
          ],
          max_tokens: Math.min(input.maxOutputTokens, 260),
        },
        input.authHeaders,
        Math.min(input.requestTimeoutMs, 15_000),
      )) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = payload.choices?.[0]?.message?.content?.trim() || '';
      const visible = visibleText(text);
      if (visible) return visible;
    } catch {
      // fall through to static fallback below
    }
    return 'I could not complete live web retrieval right now, but generally the strongest coding models are the newest top-tier GPT and Claude families; if you want, ask me to compare speed vs quality and I will give a practical pick.';
  }

  private async runFinalToolSynthesis(input: {
    messages: Array<Record<string, unknown>>;
    model: string;
    baseUrl: string;
    authHeaders: Record<string, string>;
    requestTimeoutMs: number;
    maxOutputTokens: number;
  }): Promise<string | null> {
    const followUpPrompt = this.prepareUserPrompt(
      'Summarize the completed tool results for the user in 2-4 sentences. If the task is incomplete, clearly state what page or step was reached and what blocked further progress. Do not mention hidden reasoning.',
      input.model,
    );
    const recentMessages = input.messages
      .filter((message) => message.role !== 'system')
      .slice(-8);

    try {
      const payload = (await postJson(
        `${input.baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          model: input.model,
          messages: [
            {
              role: 'system',
              content:
                'You are finalizing a completed tool-assisted turn. Answer directly from the recent tool results. Do not call tools. Do not emit hidden reasoning.',
            },
            ...recentMessages,
            {
              role: 'user',
              content: followUpPrompt,
            },
          ],
          max_tokens: Math.min(input.maxOutputTokens, 500),
        },
        input.authHeaders,
        Math.min(input.requestTimeoutMs, 20_000),
      )) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = payload.choices?.[0]?.message?.content || '';
      const visible = visibleText(text);
      return visible || null;
    } catch {
      return null;
    }
  }

  private latestToolContentSummary(
    messages: Array<Record<string, unknown>>,
  ): string | null {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role !== 'tool') continue;
      const rawContent =
        typeof message.content === 'string' ? message.content : '';
      if (!rawContent) continue;
      try {
        const parsed = JSON.parse(rawContent) as {
          ok?: boolean;
          content?: unknown;
        };
        if (typeof parsed.content === 'string' && parsed.content.trim()) {
          return visibleText(parsed.content).slice(0, 1400) || parsed.content.slice(0, 1400);
        }
      } catch {
        return visibleText(rawContent).slice(0, 1400) || rawContent.slice(0, 1400);
      }
    }
    return null;
  }

  private async runForcedWebPrefetch(input: {
    req: RuntimeRequest;
    toolCtx: ToolExecutionContext;
    model: string;
    baseUrl: string;
    authHeaders: Record<string, string>;
    requestTimeoutMs: number;
    maxOutputTokens: number;
  }): Promise<string> {
    try {
      const searchQuery = this.normalizeWebQuery(input.req.prompt);
      const prefetch = await executeWebSearch({ query: searchQuery }, input.toolCtx);

      if (prefetch.restricted) {
        return "I can't access that source because it is restricted.";
      }
      if (!prefetch.ok) {
        const reason = prefetch.content.replace(/\s+/g, ' ').trim().slice(0, 180);
        if (
          /no structured results|duckduckgo|search engine|error page|context/i.test(
            reason.toLowerCase(),
          )
        ) {
          return this.runBestEffortKnowledgeAnswer({
            userQuery: searchQuery,
            model: input.model,
            baseUrl: input.baseUrl,
            authHeaders: input.authHeaders,
            requestTimeoutMs: input.requestTimeoutMs,
            maxOutputTokens: input.maxOutputTokens,
            reason,
          });
        }
        return `Live web lookup failed: ${reason || 'temporary tool error'}.`;
      }

      const webContext = prefetch.content.slice(0, 7000);
      const extractedSources = this.extractSources(prefetch.content);
      this.saveSources(searchQuery, extractedSources);
      const fallbackSummary = this.buildWebFallbackSummary(prefetch.content);
      try {
        const payload = (await postJson(
          `${input.baseUrl.replace(/\/$/, '')}/chat/completions`,
          {
            model: input.model,
            messages: [
              {
                role: 'system',
                content:
                  'Use the provided web context to answer factually and concisely. Return a clean final answer (no XML).',
              },
              {
                role: 'user',
                content: this.prepareUserPrompt(
                  `User request:\n${searchQuery}\n\nWeb context:\n${webContext}\n\nAnswer using this context.`,
                  input.model,
                ),
              },
            ],
            max_tokens: input.maxOutputTokens,
          },
          input.authHeaders,
          input.requestTimeoutMs,
        )) as {
          choices?: Array<{ message?: { content?: string } }>;
        };

        const text = payload.choices?.[0]?.message?.content?.trim() || '';
        const visible = visibleText(text);
        if (!visible) {
          if (fallbackSummary) return stripThinkBlocks(fallbackSummary);
          return this.runBestEffortKnowledgeAnswer({
            userQuery: searchQuery,
            model: input.model,
            baseUrl: input.baseUrl,
            authHeaders: input.authHeaders,
            requestTimeoutMs: input.requestTimeoutMs,
            maxOutputTokens: input.maxOutputTokens,
            reason: 'empty synthesis output',
          });
        }
        if (this.looksLikeContextRefusal(text)) {
          return this.runBestEffortKnowledgeAnswer({
            userQuery: searchQuery,
            model: input.model,
            baseUrl: input.baseUrl,
            authHeaders: input.authHeaders,
            requestTimeoutMs: input.requestTimeoutMs,
            maxOutputTokens: input.maxOutputTokens,
            reason: 'context-only refusal from synthesis',
          });
        }
        return this.formatAnswerWithSources(visible, prefetch.content);
      } catch {
        if (fallbackSummary) return stripThinkBlocks(fallbackSummary);
        return this.runBestEffortKnowledgeAnswer({
          userQuery: searchQuery,
          model: input.model,
          baseUrl: input.baseUrl,
          authHeaders: input.authHeaders,
          requestTimeoutMs: input.requestTimeoutMs,
          maxOutputTokens: input.maxOutputTokens,
          reason: 'summarization failure',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const reason = msg.replace(/\s+/g, ' ').trim().slice(0, 180);
      return `Live web lookup failed due runtime error: ${reason || 'unknown error'}.`;
    }
  }

  async run(req: RuntimeRequest): Promise<RuntimeResponse> {
    const currentTurnPrompt = this.currentTurnPrompt(req.prompt);
    req = {
      ...req,
      secrets: {
        ...(req.secrets || {}),
        NANOCLAW_ORIGINAL_PROMPT: currentTurnPrompt,
        NANOCLAW_CURRENT_TIME_ISO:
          req.secrets?.NANOCLAW_CURRENT_TIME_ISO || new Date().toISOString(),
        NANOCLAW_TIMEZONE:
          req.secrets?.NANOCLAW_TIMEZONE ||
          process.env.NANOCLAW_TIMEZONE ||
          process.env.TZ ||
          Intl.DateTimeFormat().resolvedOptions().timeZone ||
          'UTC',
      },
    };
    const model = req.config.model;
    const baseUrl =
      req.config.baseUrl ||
      req.secrets?.OPENAI_BASE_URL ||
      'https://api.openai.com/v1';

    const apiKey = req.secrets?.OPENAI_API_KEY;
    const requiresApiKey = req.config.capabilities?.requiresApiKey === true;
    if (requiresApiKey && !apiKey) {
      throw new Error(
        'OPENAI_API_KEY is required for this local OpenAI-compatible runtime',
      );
    }

    const sanitizedSystemPrompt = this.sanitizeRuntimeSystemPrompt(req.systemPrompt);
    const combinedInput = sanitizedSystemPrompt
      ? `${sanitizedSystemPrompt}\n\n${req.prompt}`
      : req.prompt;
    const preparedCombinedInput = this.prepareUserPrompt(combinedInput, model);
    const parsedTimeout = Number.parseInt(
      req.secrets?.OPENAI_REQUEST_TIMEOUT_MS || '',
      10,
    );
    const requestTimeoutMs =
      Number.isFinite(parsedTimeout) && parsedTimeout > 0
        ? parsedTimeout
        : 600_000;
    const parsedMaxTokens = Number.parseInt(
      req.secrets?.OPENAI_MAX_OUTPUT_TOKENS || '',
      10,
    );
    const maxOutputTokens =
      Number.isFinite(parsedMaxTokens) && parsedMaxTokens > 0
        ? parsedMaxTokens
        : 1400;
    const authHeaders: Record<string, string> = {};
    if (apiKey && apiKey.length > 0) {
      authHeaders.Authorization = `Bearer ${apiKey}`;
    }
    const hasToolCapability =
      req.config.capabilities?.supportsTools !== false;
    const route = this.effectiveCapabilityRoute(req);
    const inputBudgetChars = this.resolveInputBudgetChars({
      req,
      baseUrl,
      maxOutputTokens,
      toolsEnabled: hasToolCapability,
    });

    if (route === 'deny_or_escalate') {
      return {
        result:
          'That request needs a more privileged or longer-running browser workflow than this session allows right now. Please narrow the task or enable the required browser mode first.',
        sessionId: makeSessionId('openai_compatible'),
      };
    }

    if (this.isShowSourcesRequest(req.prompt)) {
      const stored = this.loadSources();
          return {
            result: stripThinkBlocks(
              stored
          ? this.formatSourceDetailsReply(stored)
          : 'No recent web sources found for this chat yet. Ask a web question first, then use "show sources".',
            ),
        sessionId: makeSessionId('openai_compatible'),
      };
    }

    const { registry: baseRegistry, tools: baseTools, webEnabled, browserEnabled } = this.availableTools(req);

    // Initialize planner-critic state and inject meta tools
    const plannerConfig = req.config.plannerCritic ?? {
      enabled: req.secrets?.PLANNER_CRITIC_ENABLED !== 'false',
      maxRevisionCycles: Number.parseInt(req.secrets?.PLANNER_CRITIC_MAX_REVISIONS || '2', 10) || 2,
    };
    const plannerState = plannerConfig.enabled
      ? createPlannerCriticState(plannerConfig.maxRevisionCycles)
      : null;
    const hasExecutionTools = this.hasExecutionTools(baseRegistry);
    const schedulingMode = this.classifySchedulingMode(req.prompt);
    const schedulingIntent =
      schedulingMode === 'once' ||
      schedulingMode === 'interval' ||
      schedulingMode === 'cron';
    const watchIntent = schedulingMode === 'watch';
    const planningIntensity = plannerState
      ? this.resolvePlanningIntensity(req, {
          route,
          webEnabled,
          browserEnabled,
          hasNonMetaTools: hasExecutionTools,
        })
      : 'off';
    const plannerTools = this.plannerToolsForTurn(
      plannerState,
      planningIntensity,
      false,
    );
    const registry = [...baseRegistry, ...plannerTools];
    const tools = [...baseTools, ...toOpenAITools(plannerTools)];

    // Only force the tool loop for meta tools when there are also functional (non-meta) tools.
    // Without functional tools, entering the tool loop provides no execution capability.
    const metaToolsPresent =
      plannerState !== null && plannerTools.length > 0 && hasExecutionTools;
    const safeToolsPresent = baseRegistry.some(
      (tool) => tool.family === 'memory' || tool.family === 'meta',
    );
    const shouldUseToolLoop =
      req.config.capabilities?.supportsTools !== false &&
      tools.length > 0 &&
      this.shouldUseToolLoop(req, {
        webEnabled,
        browserEnabled,
        safeToolsPresent,
        metaToolsPresent,
      });

    if (shouldUseToolLoop) {
      const usingBrowserFlow =
        browserEnabled && route === 'browser_operation';
      const toolCtx = usingBrowserFlow
        ? this.browserToolContext(req, { webEnabled })
        : this.webConfig(req);
      const messages: Array<Record<string, unknown>> = [];
      const bootstrap = usingBrowserFlow
        ? this.browserBootstrap(req.prompt)
        : {};
      const browserBootstrapNote =
        usingBrowserFlow && bootstrap.targetUrl
          ? `Resolved target URL for this turn: ${bootstrap.targetUrl}\nStart with browser_open_url for this URL unless the page proves it is incorrect.`
          : '';
      const plannerGuidance = this.plannerGuidance(planningIntensity);
      const preparedSystemPrompt = sanitizedSystemPrompt
        ? `${sanitizedSystemPrompt}\n\n${this.webToolGuidance(route)}${browserBootstrapNote ? `\n${browserBootstrapNote}` : ''}${plannerGuidance}`
        : `${this.webToolGuidance(route)}${browserBootstrapNote ? `\n${browserBootstrapNote}` : ''}${plannerGuidance}`;
      const preparedUserPrompt = this.prepareUserPrompt(req.prompt, model, {
        allowNoThinkPrefix: route === 'plain_response',
      });
      const fittedPrompts = this.fitPromptPairWithinBudget({
        systemPrompt: preparedSystemPrompt,
        userPrompt: preparedUserPrompt,
        budgetChars: inputBudgetChars,
      });
      console.error(
        `[openai-runtime] tool-policy=${JSON.stringify(req.config.toolPolicy || {})} tools=${registry.map((tool) => tool.name).join(',') || '-'}`,
      );
      if (fittedPrompts.systemPrompt) {
        messages.push({
          role: 'system',
          content: fittedPrompts.systemPrompt,
        });
      }
      messages.push({
        role: 'user',
        content: fittedPrompts.userPrompt,
      });

      let sawToolCalls = false;
      let lastAssistantContent = '';
      let browserRecoveryPrompted = false;
      let schedulingRecoveryPrompted = false;
      let memoryFlushInjected = false;
      let terminalSchedulingResult: { ok: boolean; content: string } | null = null;
      let schedulingResolved = !schedulingIntent && !watchIntent;
      const bootstrapState = usingBrowserFlow
        ? await this.maybeBootstrapBrowserTurn({
            req,
            toolCtx,
            messages,
            webEnabled,
          })
        : { used: false };
      let toolLoopBudgetMs = this.parsePositiveInt(
        usingBrowserFlow
          ? req.secrets?.BROWSER_TOOL_LOOP_BUDGET_MS ||
              req.secrets?.WEB_TOOL_LOOP_BUDGET_MS
          : req.secrets?.WEB_TOOL_LOOP_BUDGET_MS,
        90_000,
      );
      const toolLoopStartedAt = Date.now();

      try {
        try {
          for (let i = 0; i <= toolCtx.maxToolSteps; i++) {
            const remainingLoopMs =
              toolLoopBudgetMs - (Date.now() - toolLoopStartedAt);
            if (remainingLoopMs <= 0) break;

            const perRequestTimeoutMs = Math.max(
              1500,
              Math.min(requestTimeoutMs, remainingLoopMs),
            );
            const {
              registry: activeRegistry,
              tools: activeTools,
            } = this.activeToolsForTurn({
              baseRegistry,
              baseTools,
              plannerState,
              planningIntensity,
              sawToolCalls: sawToolCalls && schedulingResolved,
              schedulingMode,
              schedulingIntent,
              watchIntent,
            });

            const payload = (await postJson(
              `${baseUrl.replace(/\/$/, '')}/chat/completions`,
              {
                model,
                messages,
                tools: activeTools,
                tool_choice: this.resolveToolChoice({
                  usingBrowserFlow,
                  sawToolCalls: sawToolCalls && schedulingResolved,
                  bootstrapUsed: bootstrapState.used,
                  prompt: req.prompt,
                  planningIntensity,
                  plannerState,
                  schedulingIntent,
                  watchIntent,
                }),
                max_tokens: sawToolCalls ? Math.min(maxOutputTokens, 700) : Math.min(maxOutputTokens, 280),
              },
              authHeaders,
              perRequestTimeoutMs,
            )) as {
              choices?: Array<{
                message?: {
                  content?: string;
                  tool_calls?: Array<{
                    id?: string;
                    type?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
              }>;
            };

            const choice = payload.choices?.[0]?.message;
            const content = choice?.content?.trim() || '';
            const toolCalls = choice?.tool_calls || [];
            if (content) lastAssistantContent = content;
            if (toolCalls.length === 0) {
              if (
                !sawToolCalls &&
                (schedulingIntent || watchIntent) &&
                !schedulingRecoveryPrompted
              ) {
                schedulingRecoveryPrompted = true;
                messages.push({
                  role: 'system',
                  content: this.schedulingRecoveryInstruction({ schedulingMode }),
                });
                lastAssistantContent = '';
                continue;
              }
              if (
                usingBrowserFlow &&
                !sawToolCalls &&
                !browserRecoveryPrompted &&
                (
                  !bootstrapState.used ||
                  this.browserTaskNeedsFollowUp(req.prompt) ||
                  this.looksLikeBrowserDeflection(content)
                )
              ) {
                browserRecoveryPrompted = true;
                if (content) {
                  messages.push({
                    role: 'assistant',
                    content,
                  });
                }
                messages.push({
                  role: 'user',
                  content: this.browserRecoveryInstruction({
                    prompt: req.prompt,
                    bootstrapState,
                    assistantContent: content,
                  }),
                });
                lastAssistantContent = '';
                continue;
              }
              break;
            }

            sawToolCalls = true;
            messages.push({
              role: 'assistant',
              content: content || null,
              tool_calls: toolCalls,
            });

            for (const call of toolCalls) {
              const toolName = call.function?.name || '';
              console.error(`[openai-runtime] tool call: ${toolName}`);
              const handler = findTool(activeRegistry, toolName);
              const argsText = call.function?.arguments || '{}';
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(argsText) as Record<string, unknown>;
              } catch {
                args = {};
              }

              const result = handler
                ? await handler.execute(args, toolCtx)
                : { ok: false, content: `Unknown tool: ${toolName}` };
              const isSchedulingMetaTool =
                toolName === 'schedule_task' ||
                toolName === 'schedule_once_task' ||
                toolName === 'schedule_recurring_task' ||
                toolName === 'schedule_interval_task' ||
                toolName === 'register_watch';
              let schedulingToolResult = result;
              if (
                (toolName === 'schedule_task' ||
                  toolName === 'schedule_once_task' ||
                  toolName === 'schedule_recurring_task' ||
                  toolName === 'schedule_interval_task') &&
                schedulingIntent &&
                !watchIntent
              ) {
                const expectedScheduleType =
                  this.expectedScheduleTypeForMode(schedulingMode);
                const chosenScheduleType = (() => {
                  if (toolName === 'schedule_once_task') return 'once';
                  if (toolName === 'schedule_recurring_task') return 'cron';
                  if (toolName === 'schedule_interval_task') return 'interval';
                  return typeof args.schedule_type === 'string'
                    ? args.schedule_type.trim().toLowerCase()
                    : '';
                })();
                if (
                  expectedScheduleType &&
                  chosenScheduleType !== expectedScheduleType
                ) {
                  schedulingToolResult = {
                    ok: false,
                    content: `Wrong schedule_type for this request. Use schedule_type="${expectedScheduleType}" instead of "${chosenScheduleType || 'missing'}".`,
                  };
                }
              }
              if (
                toolName === 'register_watch' &&
                schedulingIntent &&
                !watchIntent
              ) {
                schedulingToolResult = {
                  ok: false,
                  content:
                    'Wrong tool for this request. This is a timed task, so use schedule_task instead of register_watch.',
                };
              }
              if (
                isSchedulingMetaTool &&
                (schedulingIntent || watchIntent)
              ) {
                if (schedulingToolResult.ok) {
                  terminalSchedulingResult = schedulingToolResult;
                  schedulingResolved = true;
                } else {
                  schedulingResolved = false;
                }
              }
              if (toolName === 'web_search' && result.ok) {
                const query =
                  typeof args.query === 'string'
                    ? args.query
                    : this.normalizeWebQuery(req.prompt);
                const sources = this.extractSources(result.content);
                this.saveSources(query, sources);
              }
              // Adapt budgets when create_plan is called
              if (toolName === 'create_plan' && plannerState?.plan) {
                const adapted = resolveAdaptedBudgets(
                  plannerState,
                  toolCtx.maxToolSteps,
                  toolLoopBudgetMs,
                );
                toolCtx.maxToolSteps = adapted.maxToolSteps;
                toolLoopBudgetMs = adapted.toolLoopBudgetMs;
              }
              // Track plan step progress for non-meta tool calls
              if (
                plannerState?.plan &&
                toolName !== 'create_plan' &&
                toolName !== 'critique_response'
              ) {
                updateStepProgress(plannerState, toolName);
              }
              messages.push({
                role: 'tool',
                tool_call_id: call.id || '',
                content: JSON.stringify(schedulingToolResult),
              });
              if (terminalSchedulingResult) {
                break;
              }
            }
            if (terminalSchedulingResult) {
              break;
            }
            // Inject plan progress note after all tool results for this turn
            if (plannerState?.plan) {
              const progress = buildPlanProgressNote(plannerState);
              if (progress) {
                messages.push({ role: 'user', content: progress });
              }
            }
            const totalMessageChars = messages.reduce(
              (sum, message) => sum + JSON.stringify(message).length,
              0,
            );
            if (
              !memoryFlushInjected &&
              i >= MEMORY_FLUSH_TRIGGER_STEPS &&
              inputBudgetChars > 0 &&
              totalMessageChars > inputBudgetChars * MEMORY_FLUSH_BUDGET_RATIO
            ) {
              messages.push({
                role: 'system',
                content: MEMORY_FLUSH_ADVISORY,
              });
              memoryFlushInjected = true;
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isToolProtocolIssue = /tool|function|unsupported|invalid_request/i.test(
            msg,
          );
          const isTransientToolRuntimeIssue =
            /timeout|network request failed|fetch failed|aborted|econnrefused|enotfound/i.test(
              msg.toLowerCase(),
            );
          if (!sawToolCalls && !lastAssistantContent) {
            throw err;
          }
          if (!isToolProtocolIssue && !isTransientToolRuntimeIssue) {
            throw err;
          }
        }

        const visibleAssistantContent = visibleText(lastAssistantContent);
        if (terminalSchedulingResult) {
          return {
            result: terminalSchedulingResult.content,
            sessionId: makeSessionId('openai_compatible'),
          };
        }
        if (sawToolCalls && !visibleAssistantContent) {
          const synthesized = await this.runFinalToolSynthesis({
            messages,
            model,
            baseUrl,
            authHeaders,
            requestTimeoutMs,
            maxOutputTokens,
          });
          if (synthesized) {
            return {
              result: synthesized,
              sessionId: makeSessionId('openai_compatible'),
            };
          }
          const latestToolSummary = this.latestToolContentSummary(messages);
          if (latestToolSummary) {
            return {
              result: latestToolSummary,
              sessionId: makeSessionId('openai_compatible'),
            };
          }
        }
        const explicitWebIntent =
          !schedulingIntent &&
          !watchIntent &&
          (route === 'web_lookup' || route === 'browser_operation');
        const shouldAttemptForcedPrefetch =
          !usingBrowserFlow &&
          webEnabled &&
          (
            (
              sawToolCalls &&
              (!visibleAssistantContent ||
                this.shouldForceWebFallback({
                  assistantText: visibleAssistantContent || lastAssistantContent,
                  sawToolCalls,
                }))
            ) ||
            (
              !sawToolCalls &&
              explicitWebIntent &&
              (
                !visibleAssistantContent ||
                this.looksLikeStaleKnowledgeFallback(
                  visibleAssistantContent || lastAssistantContent,
                )
              )
            )
          );

        if (shouldAttemptForcedPrefetch) {
          const prefetched = await this.runForcedWebPrefetch({
            req,
            toolCtx,
            model,
            baseUrl,
            authHeaders,
            requestTimeoutMs: Math.min(requestTimeoutMs, 20_000),
            maxOutputTokens: Math.min(maxOutputTokens, 280),
          });
          if (this.looksLikeContextRefusal(prefetched)) {
            const rescue = await this.runBestEffortKnowledgeAnswer({
              userQuery: this.normalizeWebQuery(req.prompt),
              model,
              baseUrl,
              authHeaders,
              requestTimeoutMs,
              maxOutputTokens,
              reason: 'final prefetch output matched refusal pattern',
            });
            return {
              result: rescue,
              sessionId: makeSessionId('openai_compatible'),
            };
          }
          return {
            result: stripThinkBlocks(prefetched),
            sessionId: makeSessionId('openai_compatible'),
          };
        }

        if (lastAssistantContent) {
          if (!visibleAssistantContent && !sawToolCalls) {
            // All model output was stripped as internal reasoning (e.g. dangling think blocks).
            // Treat this the same as the simple path's "no text output" error.
            throw new Error(
              'OpenAI-compatible runtime returned no text output from supported endpoints',
            );
          }
          console.error(
            `[openai-runtime] completed turn path=${sawToolCalls ? 'tool-assisted' : 'conversational'} finalText=${visibleAssistantContent.length}`,
          );
          if (usingBrowserFlow && !sawToolCalls) {
            console.error(
              '[openai-runtime] browser-operation turn completed without any tool calls',
            );
            if (this.looksLikeBrowserDeflection(lastAssistantContent)) {
              return {
                result:
                  "I couldn't complete the browser task because the model never used the available browser tools after entering browser mode. Please retry.",
                sessionId: makeSessionId('openai_compatible'),
              };
            }
          }
          if ((schedulingIntent || watchIntent) && !sawToolCalls) {
            return {
              result:
                "I couldn't schedule that yet because the model didn't use the scheduling tool on this turn. Please retry.",
              sessionId: makeSessionId('openai_compatible'),
            };
          }
          if (this.looksLikeContextRefusal(lastAssistantContent)) {
            const rescue = await this.runBestEffortKnowledgeAnswer({
              userQuery: this.normalizeWebQuery(req.prompt),
              model,
              baseUrl,
              authHeaders,
              requestTimeoutMs,
              maxOutputTokens,
              reason: 'tool-loop assistant output matched refusal pattern',
            });
            return {
              result: rescue,
              sessionId: makeSessionId('openai_compatible'),
            };
          }
          return {
            result: visibleAssistantContent,
            sessionId: makeSessionId('openai_compatible'),
          };
        }

        return {
          result: "I couldn't get a final model response in time. Please retry.",
          sessionId: makeSessionId('openai_compatible'),
        };
      } finally {
        await closeBrowserSessionFromContext(toolCtx).catch(() => undefined);
        await closeWebSessionFromContext(toolCtx).catch(() => undefined);
      }
    }

    try {
      const supportsResponses = req.config.capabilities?.supportsResponses !== false;
      const fittedSimplePrompts = this.fitPromptPairWithinBudget({
        systemPrompt: undefined,
        userPrompt: preparedCombinedInput,
        budgetChars: inputBudgetChars,
      });
      if (supportsResponses) {
        try {
          const response = await postJson(
            `${baseUrl.replace(/\/$/, '')}/responses`,
            {
              model,
              input: fittedSimplePrompts.userPrompt,
            },
            authHeaders,
            requestTimeoutMs,
          );

          const text = extractOpenAIText(response);
          const visible = visibleText(text);
          if (visible) {
            return {
              result: visible,
              sessionId: makeSessionId('openai_compatible'),
            };
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const hardAuthError = /HTTP 401/i.test(msg) || /HTTP 403/i.test(msg);
          if (hardAuthError) throw err;
        }
      }

      const chatPayload = (await postJson(
        `${baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          model,
          messages: [{ role: 'user', content: fittedSimplePrompts.userPrompt }],
          max_tokens: maxOutputTokens,
        },
        authHeaders,
        requestTimeoutMs,
      )) as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const chatText = chatPayload.choices?.[0]?.message?.content?.trim() || '';
      const visibleChatText = visibleText(chatText);
      if (!visibleChatText) {
        throw new Error(
          'OpenAI-compatible runtime returned no text output from supported endpoints',
        );
      }

      return {
        result: visibleChatText,
        sessionId: makeSessionId('openai_compatible'),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.looksLikeTransientRuntimeError(message)) {
        throw new Error(message);
      }
      throw err;
    }
  }

  private effectiveCapabilityRoute(req: RuntimeRequest):
    | 'plain_response'
    | 'web_lookup'
    | 'browser_operation'
    | 'deny_or_escalate' {
    if (this.classifySchedulingMode(req.prompt) !== 'none') {
      return 'plain_response';
    }
    return req.config.capabilityRoute ?? 'plain_response';
  }
}
