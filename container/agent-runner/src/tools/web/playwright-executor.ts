import { chromium, Browser, BrowserContext, Page } from 'playwright-core';
import { looksLikeChallengePage } from './policy.js';

interface WebSessionState {
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
  activeUrl?: string;
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export interface SearchResultContext extends SearchResultItem {
  pageTitle: string;
  finalUrl: string;
  excerpt: string;
}

export interface WebSearchResult {
  state: WebSessionState;
  providerUrl: string;
  providerTitle: string;
  providerText: string;
  results: SearchResultItem[];
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function buildQueryVariants(query: string): string[] {
  const normalized = normalizeText(decodeHtmlEntities(query));
  if (!normalized) return [];

  const tokens =
    normalized.match(/[A-Za-z0-9][A-Za-z0-9+.#/-]*/g)?.map((token) => token) || [];
  const stopWords = new Set([
    'a',
    'an',
    'and',
    'are',
    'as',
    'at',
    'be',
    'can',
    'could',
    'do',
    'does',
    'for',
    'from',
    'give',
    'how',
    'i',
    'in',
    'is',
    'it',
    'latest',
    'me',
    'of',
    'on',
    'or',
    'recent',
    'recently',
    'releases',
    'show',
    'tell',
    'the',
    'their',
    'there',
    'these',
    'this',
    'to',
    'was',
    'what',
    'which',
    'who',
    'world',
  ]);

  const compactTokens = tokens.filter((token) => {
    const lower = token.toLowerCase();
    if (/^(gpt|grok|claude|gemini|qwen|deepseek|llama|openai|anthropic)([-./#]?\w+)*$/i.test(token)) {
      return true;
    }
    if (/\d/.test(token)) return true;
    if (token.length >= 4 && !stopWords.has(lower)) return true;
    return false;
  });
  const compact = normalizeText(compactTokens.join(' '));

  return Array.from(
    new Set([normalized, compact].filter((value) => value && value.length >= 3)),
  );
}

function queryTerms(query: string): string[] {
  return (
    normalizeText(query)
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9+.#/-]*/g) || []
  ).filter((token) => token.length >= 3);
}

function scoreSearchResult(
  query: string,
  item: SearchResultItem,
  index: number,
): number {
  const haystack = `${item.title} ${item.snippet} ${item.url}`.toLowerCase();
  const tokens = queryTerms(query);
  let score = Math.max(0, 60 - index * 4);
  let overlap = 0;

  for (const token of tokens) {
    if (!haystack.includes(token)) continue;
    overlap += 1;
    score += item.title.toLowerCase().includes(token) ? 10 : 4;
  }

  if (tokens.includes('coding') || tokens.includes('code')) {
    if (/\b(coding|code|developer|programming|swe-bench|benchmark)\b/i.test(haystack)) {
      score += 14;
    } else {
      score -= 18;
    }
  }

  if (tokens.includes('model')) {
    if (/\b(model|llm|ai|gpt|claude|gemini|qwen|deepseek)\b/i.test(haystack)) {
      score += 12;
    } else {
      score -= 14;
    }
  }

  if (/\b(openai|anthropic|google|github|artificialanalysis|livebench|swe-bench)\b/i.test(
    item.source,
  )) {
    score += 10;
  }

  if (/\b(reddit|youtube|facebook|instagram|kalshi)\b/i.test(item.source)) {
    score -= 16;
  }

  if (overlap === 0) score -= 20;
  return score;
}

function rerankSearchResults(query: string, results: SearchResultItem[]): SearchResultItem[] {
  return [...results]
    .map((item, index) => ({
      item,
      score: scoreSearchResult(query, item, index),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}

function trimBoilerplate(text: string): string {
  return normalizeText(
    text
      .replace(/\b(privacy policy|terms of service|cookie policy|all rights reserved)\b/gi, ' ')
      .replace(/\b(sign in|log in|subscribe|advertisement|sponsored)\b/gi, ' '),
  );
}

function asSession(state: unknown): WebSessionState {
  if (!state || typeof state !== 'object') return {};
  return state as WebSessionState;
}

export function getWebSession(state: unknown): WebSessionState {
  return asSession(state);
}

export async function ensurePage(input: {
  state: unknown;
  timeoutMs: number;
}): Promise<{ state: WebSessionState; page: Page }> {
  const state = asSession(input.state);
  if (state.page && !state.page.isClosed()) {
    return { state, page: state.page };
  }

  if (!state.browser) {
    state.browser = await chromium.launch({
      headless: true,
      timeout: input.timeoutMs,
    });
  }
  if (!state.context) {
    state.context = await state.browser.newContext({
      javaScriptEnabled: true,
      // Reduce search-engine anti-bot challenges from obvious headless fingerprints.
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
  }

  state.page = await state.context.newPage();
  return { state, page: state.page };
}

export async function openUrl(input: {
  state: unknown;
  url: string;
  timeoutMs: number;
}): Promise<{ state: WebSessionState; title: string; url: string }> {
  const ensured = await ensurePage({
    state: input.state,
    timeoutMs: input.timeoutMs,
  });
  await ensured.page.goto(input.url, {
    waitUntil: 'domcontentloaded',
    timeout: input.timeoutMs,
  });
  const title = normalizeText(
    await withTimeout(ensured.page.title(), input.timeoutMs, 'page.title'),
  );
  ensured.state.activeUrl = ensured.page.url();
  return {
    state: ensured.state,
    title,
    url: ensured.state.activeUrl || input.url,
  };
}

export async function searchWeb(input: {
  state: unknown;
  query: string;
  timeoutMs: number;
}): Promise<WebSearchResult> {
  const queryVariants = buildQueryVariants(input.query);
  const providers = [
    (query: string) => `https://search.brave.com/search?q=${encodeURIComponent(query)}`,
    (query: string) => `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
  ];
  let last: WebSearchResult | null = null;

  for (const variant of queryVariants) {
    for (const provider of providers) {
      const opened = await openUrl({
        state: input.state,
        url: provider(variant),
        timeoutMs: input.timeoutMs,
      });
      const text = await extractPageText({
        state: opened.state,
        timeoutMs: input.timeoutMs,
        maxChars: 7000,
      });
      const results = rerankSearchResults(
        variant,
        await extractSearchResults({
          state: opened.state,
          timeoutMs: input.timeoutMs,
          limit: 10,
        }),
      );
      const candidate: WebSearchResult = {
        state: opened.state,
        providerTitle: opened.title,
        providerUrl: opened.url,
        providerText: text,
        results,
      };
      last = candidate;
      if (!looksLikeChallengePage(text) && results.length > 0) {
        return candidate;
      }
    }
  }

  return (
    last || {
      state: asSession(input.state),
      providerTitle: '(search unavailable)',
      providerUrl: '',
      providerText: '',
      results: [],
    }
  );
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export async function extractSearchResults(input: {
  state: unknown;
  timeoutMs: number;
  limit?: number;
}): Promise<SearchResultItem[]> {
  const ensured = await ensurePage({
    state: input.state,
    timeoutMs: input.timeoutMs,
  });
  const pageUrl = ensured.page.url();
  const host = hostFromUrl(pageUrl);
  const limit = Math.max(1, Math.min(15, input.limit ?? 8));
  const rawResults = await withTimeout(
    ensured.page.evaluate((maxItems: number) => {
    const seen = new Set<string>();
    const results: Array<{
      title: string;
      url: string;
      snippet: string;
      source: string;
    }> = [];

    const selectors = [
      'a[data-testid="result-title-a"]',
      'h2 a',
      '.result__title a',
      '.snippet a',
      'a[href]',
    ];
    for (const selector of selectors) {
      if (results.length >= maxItems) break;
      const anchors = Array.from(document.querySelectorAll(selector));
      for (const anchor of anchors) {
        if (results.length >= maxItems) break;
        const href =
          (anchor as HTMLAnchorElement).href ||
          anchor.getAttribute('href') ||
          '';
        if (!/^https?:\/\//i.test(href)) continue;
        if (seen.has(href)) continue;

        const title = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
        if (title.length < 12) continue;

        const container =
          anchor.closest('article, li, div.result, div[data-testid], .result, .fdb') ||
          anchor.parentElement;
        const containerText = (container?.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
        const snippet = containerText
          .replace(title, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 320);

        let source = '';
        try {
          source = new URL(href).hostname.toLowerCase();
        } catch {
          source = '';
        }
        seen.add(href);
        results.push({
          title: title.slice(0, 180),
          url: href,
          snippet,
          source,
        });
        if (results.length >= maxItems) break;
      }
    }

    return results;
    }, limit),
    input.timeoutMs,
    'extractSearchResults',
  );

  const blockedHosts = new Set([
    host,
    'duckduckgo.com',
    'search.brave.com',
    'www.google.com',
    'google.com',
    'bing.com',
    'www.bing.com',
  ]);
  return rawResults.filter(
    (item) => !blockedHosts.has(hostFromUrl(item.url) || item.source || ''),
  );
}

export async function extractPageText(input: {
  state: unknown;
  timeoutMs: number;
  maxChars?: number;
}): Promise<string> {
  const ensured = await ensurePage({
    state: input.state,
    timeoutMs: input.timeoutMs,
  });
  const raw = await withTimeout(
    ensured.page.evaluate(() => {
      const roots = Array.from(
        document.querySelectorAll('article, main, [role="main"], .article, .post'),
      );
      const preferred = roots
        .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
        .filter((text) => text.length >= 200)
        .join(' ');
      return preferred || document.body?.innerText || '';
    }),
    input.timeoutMs,
    'extractPageText',
  );
  const text = trimBoilerplate(raw);
  if (!text) return '';
  if (looksLikeChallengePage(text)) return text;
  const max = Math.max(200, input.maxChars ?? 5000);
  return text.slice(0, max);
}

export async function fetchSearchResultContexts(input: {
  state: unknown;
  results: SearchResultItem[];
  timeoutMs: number;
  maxResults?: number;
  maxCharsPerPage?: number;
}): Promise<SearchResultContext[]> {
  const ensured = await ensurePage({
    state: input.state,
    timeoutMs: input.timeoutMs,
  });
  const context = ensured.state.context;
  if (!context) return [];

  const maxResults = Math.max(1, Math.min(4, input.maxResults ?? 2));
  const pageBudgetMs = Math.max(1500, Math.floor(input.timeoutMs / maxResults));
  const maxChars = Math.max(300, Math.min(2000, input.maxCharsPerPage ?? 900));
  const collected: SearchResultContext[] = [];

  for (const result of input.results.slice(0, maxResults)) {
    const page = await context.newPage();
    try {
      await page.goto(result.url, {
        waitUntil: 'domcontentloaded',
        timeout: pageBudgetMs,
      });
      const title =
        normalizeText(
          (await withTimeout(page.title(), pageBudgetMs, 'result page title')) || '',
        ) || result.title;
      const raw = await withTimeout(
        page.evaluate(() => {
          const roots = Array.from(
            document.querySelectorAll('article, main, [role="main"], .article, .post'),
          );
          const preferred = roots
            .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
            .filter((text) => text.length >= 200)
            .join(' ');
          return preferred || document.body?.innerText || '';
        }),
        pageBudgetMs,
        'result page extract',
      );
      const excerpt = trimBoilerplate(raw).slice(0, maxChars);
      if (!excerpt || looksLikeChallengePage(excerpt)) continue;
      collected.push({
        ...result,
        pageTitle: title,
        finalUrl: page.url() || result.url,
        excerpt,
      });
    } catch {
      // best effort; skip weak pages
    } finally {
      await page.close({ runBeforeUnload: false }).catch(() => undefined);
    }
  }

  return collected;
}

export async function extractLinks(input: {
  state: unknown;
  timeoutMs: number;
  limit?: number;
}): Promise<Array<{ href: string; text: string }>> {
  const ensured = await ensurePage({
    state: input.state,
    timeoutMs: input.timeoutMs,
  });
  const limit = Math.max(1, Math.min(50, input.limit ?? 10));
  const links = await ensured.page.evaluate((maxLinks: number) => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    return anchors
      .map((a) => {
        const href = (a as HTMLAnchorElement).href || '';
        const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
        return { href, text };
      })
      .filter((x) => x.href)
      .slice(0, maxLinks);
  }, limit);
  return links;
}

export async function closeWebSession(state: unknown): Promise<void> {
  const s = asSession(state);
  const page = s.page;
  const context = s.context;
  const browser = s.browser;

  s.page = undefined;
  s.context = undefined;
  s.browser = undefined;
  s.activeUrl = undefined;

  try {
    if (page && !page.isClosed()) {
      await withTimeout(
        page.close({ runBeforeUnload: false }),
        1500,
        'page.close',
      ).catch(() => undefined);
    }
  } catch {
    // ignore cleanup failures
  }
  try {
    if (context) {
      await withTimeout(context.close(), 1500, 'context.close').catch(
        () => undefined,
      );
    }
  } catch {
    // ignore cleanup failures
  }
  try {
    if (browser) {
      await withTimeout(browser.close(), 1500, 'browser.close').catch(
        () => undefined,
      );
    }
  } catch {
    // ignore cleanup failures
  }
}
