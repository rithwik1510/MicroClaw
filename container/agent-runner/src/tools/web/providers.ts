import fs from 'fs';
import os from 'os';
import path from 'path';

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

import { ToolExecutionContext } from '../types.js';
import { getRestrictedDomains, isRestrictedUrl } from './policy.js';
import {
  SearchResultContext,
  SearchResultItem,
  extractPageText,
  fetchSearchResultContexts,
  getWebSession,
  openUrl,
  searchWeb as searchWithPlaywright,
} from './playwright-executor.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  publishedAt?: string;
  rank: number;
}

export interface FetchedDocument {
  url: string;
  finalUrl: string;
  title: string;
  content: string;
  excerpt: string;
  contentType: string;
  usedFallback?: boolean;
}

type CacheShape = {
  search: Record<string, CachedValue<SearchResult[]>>;
  fetch: Record<string, CachedValue<FetchedDocument>>;
};

type CachedValue<T> = {
  expiresAt: number;
  value: T;
};

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function searchProvider(ctx: ToolExecutionContext): string {
  const explicit = (ctx.secrets?.WEB_SEARCH_PROVIDER || '').trim().toLowerCase();
  if (explicit) return explicit;
  const legacy = (ctx.secrets?.WEB_TOOL_PRIMARY || '').trim().toLowerCase();
  if (legacy === 'off') return 'off';
  return 'auto';
}

function fetchProvider(ctx: ToolExecutionContext): string {
  const explicit = (ctx.secrets?.WEB_FETCH_PROVIDER || '').trim().toLowerCase();
  if (explicit) return explicit;
  return 'auto';
}

function browserFallbackEnabled(ctx: ToolExecutionContext): boolean {
  const explicit = (ctx.secrets?.WEB_BROWSER_FALLBACK || '').trim().toLowerCase();
  if (explicit) return explicit === 'playwright';
  const legacy = (ctx.secrets?.WEB_TOOL_PRIMARY || '').trim().toLowerCase();
  if (legacy === 'off') return false;
  return true;
}

function getSearxngBaseUrl(ctx: ToolExecutionContext): string {
  return (
    ctx.secrets?.SEARXNG_BASE_URL ||
    process.env.SEARXNG_BASE_URL ||
    'http://127.0.0.1:8888'
  )
    .trim()
    .replace(/\/$/, '');
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function maxSearchResults(ctx: ToolExecutionContext): number {
  return Math.max(
    1,
    Math.min(10, positiveInt(ctx.secrets?.WEB_SEARCH_MAX_RESULTS, 5)),
  );
}

function searchCacheTtlMs(ctx: ToolExecutionContext): number {
  return positiveInt(ctx.secrets?.WEB_SEARCH_CACHE_TTL_MINUTES, 15) * 60_000;
}

function fetchCacheTtlMs(ctx: ToolExecutionContext): number {
  return positiveInt(ctx.secrets?.WEB_FETCH_CACHE_TTL_MINUTES, 15) * 60_000;
}

function fetchMaxChars(ctx: ToolExecutionContext): number {
  return Math.max(
    500,
    Math.min(50_000, positiveInt(ctx.secrets?.WEB_FETCH_MAX_CHARS, 12_000)),
  );
}

function fetchMaxBytes(ctx: ToolExecutionContext): number {
  return Math.max(
    20_000,
    Math.min(5_000_000, positiveInt(ctx.secrets?.WEB_FETCH_MAX_RESPONSE_BYTES, 2_000_000)),
  );
}

function cacheFilePath(): string {
  const inputDir = process.env.NANOCLAW_IPC_INPUT_DIR;
  if (inputDir) {
    return path.join(path.resolve(inputDir, '..'), 'web-cache.json');
  }
  return path.join(os.tmpdir(), 'nanoclaw-web-cache.json');
}

function readCache(): CacheShape {
  const file = cacheFilePath();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CacheShape>;
    return {
      search: parsed.search || {},
      fetch: parsed.fetch || {},
    };
  } catch {
    return { search: {}, fetch: {} };
  }
}

function writeCache(cache: CacheShape): void {
  const file = cacheFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache, null, 2) + '\n');
}

function pruneExpired<T>(store: Record<string, CachedValue<T>>): void {
  const now = Date.now();
  for (const [key, value] of Object.entries(store)) {
    if (!value || value.expiresAt <= now) delete store[key];
  }
}

function cacheKey(prefix: string, provider: string, target: string, options = ''): string {
  const normalized = normalizeText(target).toLowerCase();
  return `v2|${prefix}|${provider}|${normalized}|${options}`;
}

function getCachedSearch(
  provider: string,
  query: string,
): SearchResult[] | null {
  const cache = readCache();
  pruneExpired(cache.search);
  const hit = cache.search[cacheKey('search', provider, query)];
  if (!hit) return null;
  return hit.value;
}

function setCachedSearch(
  provider: string,
  query: string,
  results: SearchResult[],
  ttlMs: number,
): void {
  if (results.length === 0) return;
  const cache = readCache();
  pruneExpired(cache.search);
  cache.search[cacheKey('search', provider, query)] = {
    expiresAt: Date.now() + ttlMs,
    value: results,
  };
  writeCache(cache);
}

function getCachedFetch(
  provider: string,
  url: string,
  maxChars: number,
): FetchedDocument | null {
  const cache = readCache();
  pruneExpired(cache.fetch);
  const hit = cache.fetch[cacheKey('fetch', provider, url, String(maxChars))];
  if (!hit) return null;
  return hit.value;
}

function setCachedFetch(
  provider: string,
  url: string,
  maxChars: number,
  document: FetchedDocument,
  ttlMs: number,
): void {
  if (!document.content) return;
  const cache = readCache();
  pruneExpired(cache.fetch);
  cache.fetch[cacheKey('fetch', provider, url, String(maxChars))] = {
    expiresAt: Date.now() + ttlMs,
    value: document,
  };
  writeCache(cache);
}

async function fetchText(input: {
  url: string;
  timeoutMs: number;
  maxBytes: number;
  headers?: Record<string, string>;
}): Promise<{ text: string; finalUrl: string; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const res = await fetch(input.url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        ...input.headers,
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const finalUrl = res.url || input.url;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > input.maxBytes) {
      throw new Error(`response exceeded ${input.maxBytes} bytes`);
    }
    return {
      text: buffer.toString('utf8'),
      finalUrl,
      contentType,
    };
  } finally {
    clearTimeout(timer);
  }
}

function rankResults(results: SearchResult[]): SearchResult[] {
  return results
    .filter((item) => /^https?:\/\//i.test(item.url))
    .slice(0, 10)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

function htmlToSearchResults(html: string): SearchResult[] {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const cards = Array.from(
    document.querySelectorAll('.result, .web-result'),
  ) as Array<{
    querySelector: (selector: string) => Element | null;
  }>;
  const results: SearchResult[] = [];

  for (const card of cards) {
    const link =
      (card.querySelector('.result__title a, .result__a') as { href?: string; textContent?: string } | null) ||
      (card.querySelector('a[href]') as { href?: string; textContent?: string } | null);
    const href = normalizeSearchHref(link?.href || '');
    const title = normalizeText(link?.textContent || '');
    if (!href || !title) continue;
    const snippet = normalizeText(
      card.querySelector('.result__snippet, .result-snippet')?.textContent || '',
    );
    let source = '';
    try {
      source = new URL(href).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      source = '';
    }
    results.push({
      title: decodeEntities(title).slice(0, 180),
      url: href,
      snippet: decodeEntities(snippet).slice(0, 300),
      source,
      rank: results.length + 1,
    });
  }

  return rankResults(results);
}

function normalizeSearxngResults(payload: unknown): SearchResult[] {
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as { results?: Array<Record<string, unknown>> };
  if (!Array.isArray(p.results)) return [];
  const out: SearchResult[] = [];
  for (const item of p.results) {
    const url = typeof item.url === 'string' ? item.url : '';
    const title = typeof item.title === 'string' ? item.title : '';
    const snippet =
      typeof item.content === 'string'
        ? item.content
        : typeof item.snippet === 'string'
          ? item.snippet
          : '';
    if (!url || !title) continue;
    let source = '';
    try {
      source = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      source = '';
    }
    out.push({
      title: normalizeText(title).slice(0, 180),
      url,
      snippet: normalizeText(snippet).slice(0, 300),
      source,
      publishedAt:
        typeof item.publishedDate === 'string'
          ? item.publishedDate
          : typeof item.published_date === 'string'
            ? item.published_date
            : undefined,
      rank: out.length + 1,
    });
  }
  return rankResults(out);
}

function normalizeSearchHref(href: string): string {
  if (!href) return '';
  const absolute = href.startsWith('//') ? `https:${href}` : href;
  try {
    const parsed = new URL(absolute);
    if (parsed.hostname.includes('duckduckgo.com')) {
      const redirected = parsed.searchParams.get('uddg');
      if (redirected) return decodeURIComponent(redirected);
    }
    return parsed.toString();
  } catch {
    return absolute;
  }
}

function keepAllowedResults(
  ctx: ToolExecutionContext,
  results: SearchResult[],
): SearchResult[] {
  const restricted = getRestrictedDomains(ctx.secrets);
  return results.filter((item) => !isRestrictedUrl(item.url, restricted));
}

export async function searchWithSearxng(
  query: string,
  ctx: ToolExecutionContext,
): Promise<SearchResult[]> {
  const cached = getCachedSearch('searxng', query);
  if (cached) return cached;

  const baseUrl = getSearxngBaseUrl(ctx);
  const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&language=en&safe_search=0`;
  const payload = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(ctx.searchTimeoutMs),
  }).then(async (res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
  const results = keepAllowedResults(ctx, normalizeSearxngResults(payload)).slice(
    0,
    maxSearchResults(ctx),
  );
  setCachedSearch('searxng', query, results, searchCacheTtlMs(ctx));
  return results;
}

export async function searchWithDuckDuckGoHtml(
  query: string,
  ctx: ToolExecutionContext,
): Promise<SearchResult[]> {
  const cached = getCachedSearch('duckduckgo', query);
  if (cached) return cached;
  const { text } = await fetchText({
    url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    timeoutMs: ctx.searchTimeoutMs,
    maxBytes: 800_000,
  });
  const results = keepAllowedResults(ctx, htmlToSearchResults(text)).slice(
    0,
    maxSearchResults(ctx),
  );
  setCachedSearch('duckduckgo', query, results, searchCacheTtlMs(ctx));
  return results;
}

export async function searchWithPlaywrightProvider(
  query: string,
  ctx: ToolExecutionContext,
): Promise<{ results: SearchResult[]; evidence: SearchResultContext[]; providerText: string }> {
  const result = await searchWithPlaywright({
    state: ctx.webSession,
    query,
    timeoutMs: ctx.searchTimeoutMs,
  });
  ctx.webSession = result.state as Record<string, unknown>;
  const results = keepAllowedResults(
    ctx,
    result.results.map((item, index) => ({
      ...item,
      rank: index + 1,
    })),
  ).slice(0, maxSearchResults(ctx));
  const evidence = await fetchSearchResultContexts({
    state: ctx.webSession,
    results: result.results,
    timeoutMs: ctx.pageFetchTimeoutMs,
    maxResults: 2,
    maxCharsPerPage: 1000,
  }).catch(() => []);
  return { results, evidence, providerText: result.providerText };
}

export async function performSearch(
  query: string,
  ctx: ToolExecutionContext,
): Promise<{
  provider: string;
  results: SearchResult[];
  evidence: SearchResultContext[];
  degradedSummary?: string;
}> {
  const provider = searchProvider(ctx);
  const chain =
    provider === 'searxng'
      ? ['searxng']
      : provider === 'duckduckgo'
        ? ['duckduckgo']
        : provider === 'playwright'
          ? ['playwright']
          : provider === 'off'
            ? []
            : ['searxng', 'duckduckgo'];

  let lastError = '';
  for (const name of chain) {
    try {
      if (name === 'searxng') {
        const results = await searchWithSearxng(query, ctx);
        if (results.length > 0) return { provider: 'searxng', results, evidence: [] };
      }
      if (name === 'duckduckgo') {
        const results = await searchWithDuckDuckGoHtml(query, ctx);
        if (results.length > 0) return { provider: 'duckduckgo', results, evidence: [] };
      }
      if (name === 'playwright' && browserFallbackEnabled(ctx)) {
        const fallback = await searchWithPlaywrightProvider(query, ctx);
        if (fallback.results.length > 0 || fallback.evidence.length > 0) {
          return {
            provider: 'playwright',
            results: fallback.results,
            evidence: fallback.evidence,
            degradedSummary: fallback.providerText,
          };
        }
        lastError = fallback.providerText || lastError;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  if (provider !== 'playwright' && browserFallbackEnabled(ctx)) {
    try {
      const fallback = await searchWithPlaywrightProvider(query, ctx);
      if (fallback.results.length > 0 || fallback.evidence.length > 0) {
        return {
          provider: 'playwright',
          results: fallback.results,
          evidence: fallback.evidence,
          degradedSummary: fallback.providerText,
        };
      }
      lastError = fallback.providerText || lastError;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  throw new Error(lastError || 'no search results');
}

function stripBoilerplate(text: string): string {
  return normalizeText(
    text
      .replace(/\b(enable javascript|skip to content|privacy policy|terms of service)\b/gi, ' ')
      .replace(/\b(advertisement|sponsored|sign in|log in|cookie policy)\b/gi, ' '),
  );
}

function extractReadableDocument(html: string, url: string, maxChars: number): FetchedDocument | null {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  const title = normalizeText(article?.title || dom.window.document.title || '');
  const text = stripBoilerplate(
    article?.textContent ||
      dom.window.document.querySelector('main, article')?.textContent ||
      dom.window.document.body?.textContent ||
      '',
  );
  if (text.length < 180) return null;
  return {
    url,
    finalUrl: url,
    title: title || '(untitled)',
    content: text.slice(0, maxChars),
    excerpt: text.slice(0, Math.min(400, maxChars)),
    contentType: 'text/html',
  };
}

export async function fetchWithHttp(
  url: string,
  ctx: ToolExecutionContext,
  maxChars = fetchMaxChars(ctx),
): Promise<FetchedDocument> {
  const cached = getCachedFetch('http', url, maxChars);
  if (cached) return cached;

  if (isRestrictedUrl(url, getRestrictedDomains(ctx.secrets))) {
    throw new Error('Restricted source: domain policy prevents access');
  }

  const response = await fetchText({
    url,
    timeoutMs: ctx.pageFetchTimeoutMs,
    maxBytes: fetchMaxBytes(ctx),
  });
  const contentType = response.contentType || 'text/html';
  if (!/(text\/html|text\/plain|application\/xhtml\+xml)/i.test(contentType)) {
    throw new Error(`unsupported content type ${contentType}`);
  }

  const textDocument = /(text\/plain)/i.test(contentType)
    ? {
        url,
        finalUrl: response.finalUrl,
        title: response.finalUrl,
        content: stripBoilerplate(response.text).slice(0, maxChars),
        excerpt: stripBoilerplate(response.text).slice(0, Math.min(400, maxChars)),
        contentType,
      }
    : extractReadableDocument(response.text, response.finalUrl, maxChars);

  if (!textDocument || textDocument.content.length < 180) {
    throw new Error('weak HTTP extraction');
  }

  setCachedFetch('http', url, maxChars, textDocument, fetchCacheTtlMs(ctx));
  return textDocument;
}

export async function fetchWithPlaywrightProvider(
  url: string,
  ctx: ToolExecutionContext,
  maxChars = fetchMaxChars(ctx),
): Promise<FetchedDocument> {
  const opened = await openUrl({
    state: ctx.webSession,
    url,
    timeoutMs: ctx.pageFetchTimeoutMs,
  });
  ctx.webSession = opened.state as Record<string, unknown>;
  const content = await extractPageText({
    state: ctx.webSession,
    timeoutMs: ctx.pageFetchTimeoutMs,
    maxChars,
  });
  ctx.webSession = getWebSession(ctx.webSession) as Record<string, unknown>;
  return {
    url,
    finalUrl: opened.url,
    title: opened.title || '(untitled)',
    content,
    excerpt: content.slice(0, Math.min(400, maxChars)),
    contentType: 'text/html',
    usedFallback: true,
  };
}

export async function performFetch(
  url: string,
  ctx: ToolExecutionContext,
  maxChars?: number,
): Promise<{ provider: string; document: FetchedDocument }> {
  const provider = fetchProvider(ctx);
  const desiredChars = maxChars || fetchMaxChars(ctx);
  const chain =
    provider === 'http'
      ? ['http']
      : provider === 'playwright'
        ? ['playwright']
        : provider === 'off'
          ? []
          : ['http'];

  let lastError = '';
  for (const name of chain) {
    try {
      if (name === 'http') {
        return {
          provider: 'http',
          document: await fetchWithHttp(url, ctx, desiredChars),
        };
      }
      if (name === 'playwright' && browserFallbackEnabled(ctx)) {
        return {
          provider: 'playwright',
          document: await fetchWithPlaywrightProvider(url, ctx, desiredChars),
        };
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  if (browserFallbackEnabled(ctx)) {
    return {
      provider: 'playwright',
      document: await fetchWithPlaywrightProvider(url, ctx, desiredChars),
    };
  }

  throw new Error(lastError || 'fetch failed');
}
