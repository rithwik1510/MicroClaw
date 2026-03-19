import { ToolExecutionContext, ToolExecutionResult } from '../types.js';
import {
  getRestrictedDomains,
  isRestrictedUrl,
  looksLikeChallengePage,
} from './policy.js';
import {
  closeWebSession,
  extractSearchResults,
  extractLinks,
  extractPageText,
  getWebSession,
  openUrl,
} from './playwright-executor.js';
import {
  performFetch,
  performSearch,
  SearchResult,
  FetchedDocument,
} from './providers.js';
import { runAgentBrowserFallback } from './fallback-agent-browser.js';

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function remainingBudgetMs(ctx: ToolExecutionContext): number {
  const elapsed = Date.now() - ctx.startedAtMs;
  return Math.max(0, ctx.totalWebBudgetMs - elapsed);
}

function markStep(
  ctx: ToolExecutionContext,
  isSearch: boolean,
): ToolExecutionResult | null {
  if (ctx.stepCount >= ctx.maxToolSteps) {
    return { ok: false, content: 'web step budget exhausted' };
  }
  if (remainingBudgetMs(ctx) <= 0) {
    return { ok: false, content: 'web total budget exhausted' };
  }
  if (isSearch) {
    if (ctx.searchCount >= ctx.maxSearchCallsPerTurn) {
      return { ok: false, content: 'search call budget exhausted' };
    }
    ctx.searchCount += 1;
  }
  ctx.stepCount += 1;
  return null;
}

function actionTimeoutMs(
  ctx: ToolExecutionContext,
  action: 'search' | 'fetch',
): number {
  const stepTimeout =
    action === 'search' ? ctx.searchTimeoutMs : ctx.pageFetchTimeoutMs;
  return Math.max(300, Math.min(stepTimeout, remainingBudgetMs(ctx)));
}

function fallbackMode(ctx: ToolExecutionContext): string {
  return (ctx.secrets?.WEB_TOOL_FALLBACK || 'none').trim().toLowerCase();
}

function isFallbackEnabled(ctx: ToolExecutionContext): boolean {
  return fallbackMode(ctx) === 'agent-browser';
}

function toSourceList(
  sources: Array<{ title: string; url: string; snippet?: string; source?: string }>,
): string {
  if (sources.length === 0) return '';
  const lines = ['Search results:'];
  for (let i = 0; i < sources.length; i++) {
    const item = sources[i];
    const snippet = item.snippet ? ` | ${item.snippet}` : '';
    lines.push(
      `${i + 1}. ${item.title || '(untitled)'} | ${item.url}${snippet}`.slice(
        0,
        520,
      ),
    );
  }
  return lines.join('\n');
}

function makeSearchContextBlock(input: {
  sources: SearchResult[];
  fetched?: FetchedDocument[];
  provider: string;
  providerText?: string;
}): string {
  const top = input.sources.slice(0, 5);
  const sourceList = toSourceList(top);
  const evidenceBlock =
    input.fetched && input.fetched.length > 0
      ? [
          'Fetched pages:',
          ...input.fetched.slice(0, 3).map((item, index) =>
            `${index + 1}. ${item.title || '(untitled)'} | ${item.finalUrl || item.url}\n${item.excerpt}`.slice(0, 2500),
          ),
        ].join('\n\n')
      : '';
  const providerSummary =
    input.providerText && input.providerText.trim()
      ? `Provider note (${input.provider}): ${input.providerText.replace(/\s+/g, ' ').slice(0, 500)}`
      : '';
  const parts = [`Search provider: ${input.provider}`, sourceList, evidenceBlock, providerSummary].filter(Boolean);
  return parts.join('\n\n');
}

function makeFetchContextBlock(input: {
  provider: string;
  document: FetchedDocument;
}): string {
  return [
    `Fetch provider: ${input.provider}`,
    `Document: ${input.document.title} | ${input.document.finalUrl}`,
    input.document.content,
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 9000);
}

function setSession(ctx: ToolExecutionContext, state: Record<string, unknown>): void {
  ctx.webSession = state;
}

function challengeResult(): ToolExecutionResult {
  return {
    ok: false,
    content:
      'Web access challenge detected (captcha/login wall). Please retry or use a direct source URL.',
  };
}

async function reuseCurrentPageSnapshot(
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult | null> {
  if (!ctx.webSession) return null;
  try {
    const text = await extractPageText({
      state: ctx.webSession,
      timeoutMs: actionTimeoutMs(ctx, 'fetch'),
      maxChars: 5000,
    });
    setSession(ctx, getWebSession(ctx.webSession) as Record<string, unknown>);
    if (!text) return null;
    if (looksLikeChallengePage(text)) {
      return challengeResult();
    }
    return {
      ok: true,
      usedFallback: true,
      content: `Search budget reached for this turn. Reusing current page context:\n${text}`,
    };
  } catch {
    return null;
  }
}

export async function executeWebSearch(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const budget = markStep(ctx, true);
  if (budget) {
    if (budget.content === 'search call budget exhausted') {
      const fallback = await reuseCurrentPageSnapshot(ctx);
      if (fallback) return fallback;
    }
    return budget;
  }

  const query = asString(args.query);
  if (!query) return { ok: false, content: 'Missing required arg: query' };

  try {
    const result = await performSearch(query, ctx);

    if (result.results.length > 0) {
      const fetched: FetchedDocument[] = [];
      for (const item of result.results.slice(0, 3)) {
        try {
          const fetchResult = await performFetch(item.url, ctx, 4000);
          fetched.push(fetchResult.document);
        } catch {
          // best effort; search results are still useful
        }
      }
      return {
        ok: true,
        content: makeSearchContextBlock({
          sources: result.results,
          fetched,
          provider: result.provider,
          providerText: fetched.length === 0 ? result.degradedSummary : '',
        }),
      };
    }

    const fallbackSearch = isFallbackEnabled(ctx)
      ? await runAgentBrowserFallback({
          action: 'search',
          query,
          timeoutMs: actionTimeoutMs(ctx, 'search'),
        })
      : null;
    if (fallbackSearch?.ok) {
      return {
        ok: true,
        usedFallback: true,
        content: `Query: ${query}\n\n${fallbackSearch.content.slice(0, 4500)}`,
      };
    }

    return {
      ok: false,
      content:
        'Web search returned no structured results. Try a more specific query or direct URL.',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isFallbackEnabled(ctx)) {
      const fallback = await runAgentBrowserFallback({
        action: 'search',
        query,
        timeoutMs: actionTimeoutMs(ctx, 'search'),
      });
      if (fallback.ok) {
        return {
          ok: true,
          usedFallback: true,
          content: `Query: ${query}\n\n${fallback.content.slice(0, 4500)}`,
        };
      }
    }
    return { ok: false, content: `Web search failed: ${msg}` };
  }
}

export async function executeWebFetch(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const budget = markStep(ctx, false);
  if (budget) return budget;

  const url = asString(args.url);
  if (!url) return { ok: false, content: 'Missing required arg: url' };

  if (isRestrictedUrl(url, getRestrictedDomains(ctx.secrets))) {
    return {
      ok: false,
      restricted: true,
      content: 'Restricted source: domain policy prevents access',
    };
  }

  const maxChars = Math.max(300, Math.min(12000, asInt(args.max_chars, 6000)));
  try {
    const result = await performFetch(
      url,
      ctx,
      maxChars,
    );
    return {
      ok: true,
      usedFallback: result.document.usedFallback,
      content: makeFetchContextBlock({
        provider: result.provider,
        document: result.document,
      }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, content: `Web fetch failed: ${msg}` };
  }
}

export async function executeWebOpenUrl(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const budget = markStep(ctx, false);
  if (budget) return budget;

  const url = asString(args.url);
  if (!url) return { ok: false, content: 'Missing required arg: url' };

  if (isRestrictedUrl(url, getRestrictedDomains(ctx.secrets))) {
    return {
      ok: false,
      restricted: true,
      content: 'Restricted source: domain policy prevents access',
    };
  }

  try {
    const opened = await openUrl({
      state: ctx.webSession,
      url,
      timeoutMs: actionTimeoutMs(ctx, 'fetch'),
    });
    setSession(ctx, opened.state as Record<string, unknown>);

    const links = await extractSearchResults({
      state: ctx.webSession,
      timeoutMs: actionTimeoutMs(ctx, 'fetch'),
      limit: 8,
    }).catch(() => []);
    const structuredLinks = links.length > 0 ? `\n${toSourceList(links.slice(0, 4))}` : '';
    return {
      ok: true,
      content: `Opened URL: ${opened.url}\nTitle: ${opened.title || '(untitled)'}${structuredLinks}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isFallbackEnabled(ctx)) {
      const fallback = await runAgentBrowserFallback({
        action: 'open',
        url,
        timeoutMs: actionTimeoutMs(ctx, 'fetch'),
      });
      if (fallback.ok) {
        return {
          ok: true,
          usedFallback: true,
          content: `Opened URL: ${url}\n${fallback.content.slice(0, 4500)}`,
        };
      }
    }
    return { ok: false, content: `Web open failed: ${msg}` };
  }
}

export async function executeWebExtractText(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const budget = markStep(ctx, false);
  if (budget) return budget;

  const maxChars = Math.max(200, Math.min(12000, asInt(args.max_chars, 5000)));
  try {
    const text = await extractPageText({
      state: ctx.webSession,
      timeoutMs: actionTimeoutMs(ctx, 'fetch'),
      maxChars,
    });
    setSession(ctx, getWebSession(ctx.webSession) as Record<string, unknown>);
    if (!text) {
      return { ok: false, content: 'No page text available. Open a URL first.' };
    }
    if (looksLikeChallengePage(text)) {
      return challengeResult();
    }
    return { ok: true, content: text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, content: `Web extract_text failed: ${msg}` };
  }
}

export async function executeWebGetLinks(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const budget = markStep(ctx, false);
  if (budget) return budget;

  const limit = Math.max(1, Math.min(30, asInt(args.limit, 10)));
  try {
    const links = await extractLinks({
      state: ctx.webSession,
      timeoutMs: actionTimeoutMs(ctx, 'fetch'),
      limit,
    });
    setSession(ctx, getWebSession(ctx.webSession) as Record<string, unknown>);
    if (links.length === 0) {
      return { ok: true, content: 'No links found on current page.' };
    }
    const lines = links.map((l, idx) => {
      const label = l.text ? ` (${l.text.slice(0, 120)})` : '';
      return `${idx + 1}. ${l.href}${label}`;
    });
    return { ok: true, content: lines.join('\n') };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, content: `Web get_links failed: ${msg}` };
  }
}

export async function executeWebClose(
  _args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  try {
    await closeWebSession(ctx.webSession);
    ctx.webSession = undefined;
    return { ok: true, content: 'Closed web session.' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, content: `Web close failed: ${msg}` };
  }
}

export async function closeWebSessionFromContext(
  ctx: ToolExecutionContext,
): Promise<void> {
  await closeWebSession(ctx.webSession);
  ctx.webSession = undefined;
}
