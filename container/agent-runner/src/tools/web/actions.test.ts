import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { ToolExecutionContext } from '../types.js';
import {
  closeWebSessionFromContext,
  executeWebClose,
  executeWebFetch,
  executeWebOpenUrl,
  executeWebSearch,
} from './actions.js';
import { runAgentBrowserFallback } from './fallback-agent-browser.js';
import { performFetch, performSearch } from './providers.js';

vi.mock('./playwright-executor.js', () => ({
  openUrl: vi.fn(async () => ({
    state: { marker: 'open' },
    title: 'Opened',
    url: 'https://example.com',
  })),
  extractSearchResults: vi.fn(async () => []),
  extractPageText: vi.fn(async () => 'Body text'),
  extractLinks: vi.fn(async () => []),
  closeWebSession: vi.fn(async () => undefined),
  getWebSession: vi.fn((value: unknown) => (value || {}) as Record<string, unknown>),
}));

vi.mock('./providers.js', () => ({
  performSearch: vi.fn(async () => ({
    provider: 'searxng',
    results: [
      {
        title: 'OpenAI news',
        url: 'https://openai.com/news',
        snippet: 'Latest OpenAI updates',
        source: 'openai.com',
        rank: 1,
      },
    ],
    evidence: [],
  })),
  performFetch: vi.fn(async () => ({
    provider: 'http',
    document: {
      url: 'https://openai.com/news',
      finalUrl: 'https://openai.com/news',
      title: 'Introducing GPT updates',
      content: 'OpenAI published a detailed update about model performance and coding benchmarks.',
      excerpt: 'OpenAI published a detailed update about model performance and coding benchmarks.',
      contentType: 'text/html',
    },
  })),
}));

vi.mock('./fallback-agent-browser.js', () => ({
  runAgentBrowserFallback: vi.fn(async () => ({
    ok: true,
    content: 'agent-browser snapshot',
  })),
}));

function makeCtx(): ToolExecutionContext {
  return {
    maxSearchCallsPerTurn: 1,
    maxToolSteps: 3,
    searchTimeoutMs: 1500,
    pageFetchTimeoutMs: 1500,
    totalWebBudgetMs: 8000,
    startedAtMs: Date.now(),
    stepCount: 0,
    searchCount: 0,
    secrets: {
      WEB_RESTRICTED_DOMAINS: 'linkedin.com',
    },
  };
}

describe('web actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reuses current page context when search budget is exhausted', async () => {
    const ctx = makeCtx();
    const first = await executeWebSearch({ query: 'test' }, ctx);
    ctx.webSession = { marker: 'page' };
    const second = await executeWebSearch({ query: 'test 2' }, ctx);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.usedFallback).toBe(true);
    expect(second.content).toContain('Reusing current page context');
    expect(second.content).toContain('Body text');
    expect(first.content).toContain('Search results:');
    expect(first.content).toContain('Fetched pages:');
  });

  it('returns budget exhaustion when no session exists to reuse', async () => {
    const ctx = makeCtx();
    ctx.searchCount = 1;
    const res = await executeWebSearch({ query: 'test 2' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.content).toContain('search call budget exhausted');
  });

  it('blocks restricted domains on open_url', async () => {
    const ctx = makeCtx();
    const res = await executeWebOpenUrl(
      { url: 'https://www.linkedin.com/in/foo' },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.restricted).toBe(true);
  });

  it('uses configured agent-browser fallback when search fails', async () => {
    const ctx = makeCtx();
    ctx.secrets = {
      ...ctx.secrets,
      WEB_TOOL_FALLBACK: 'agent-browser',
    };

    vi.mocked(runAgentBrowserFallback).mockResolvedValueOnce({
      ok: true,
      content: 'fallback snapshot',
    });

    vi.mocked(performSearch).mockResolvedValueOnce({
      provider: 'duckduckgo',
      results: [],
      evidence: [],
    });

    const res = await executeWebSearch({ query: 'test fallback' }, ctx);
    expect(res.ok).toBe(true);
    expect(res.usedFallback).toBe(true);
    expect(res.content).toContain('fallback snapshot');
  });

  it('degrades to provider summary when no structured results are extracted', async () => {
    const ctx = makeCtx();
    vi.mocked(performSearch).mockRejectedValueOnce(
      new Error(
        'Result page text with enough details to be useful even if cards are missing.',
      ),
    );

    const res = await executeWebSearch({ query: 'test query' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.content).toContain('Web search failed');
  });

  it('fetches a URL through the http-first fetch tool', async () => {
    const ctx = makeCtx();
    const res = await executeWebFetch({ url: 'https://openai.com/news' }, ctx);
    expect(res.ok).toBe(true);
    expect(res.content).toContain('Fetch provider: http');
    expect(res.content).toContain('OpenAI published a detailed update');
  });

  it('closes session via web_close', async () => {
    const ctx = makeCtx();
    ctx.webSession = { marker: 'x' };
    const res = await executeWebClose({}, ctx);
    expect(res.ok).toBe(true);
    expect(ctx.webSession).toBeUndefined();
  });

  it('closeWebSessionFromContext clears state', async () => {
    const ctx = makeCtx();
    ctx.webSession = { marker: 'x' };
    await closeWebSessionFromContext(ctx);
    expect(ctx.webSession).toBeUndefined();
  });
});
