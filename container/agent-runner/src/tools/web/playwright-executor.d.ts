import { Browser, BrowserContext, Page } from 'playwright-core';
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
export declare function getWebSession(state: unknown): WebSessionState;
export declare function ensurePage(input: {
    state: unknown;
    timeoutMs: number;
}): Promise<{
    state: WebSessionState;
    page: Page;
}>;
export declare function openUrl(input: {
    state: unknown;
    url: string;
    timeoutMs: number;
}): Promise<{
    state: WebSessionState;
    title: string;
    url: string;
}>;
export declare function searchWeb(input: {
    state: unknown;
    query: string;
    timeoutMs: number;
}): Promise<WebSearchResult>;
export declare function extractSearchResults(input: {
    state: unknown;
    timeoutMs: number;
    limit?: number;
}): Promise<SearchResultItem[]>;
export declare function extractPageText(input: {
    state: unknown;
    timeoutMs: number;
    maxChars?: number;
}): Promise<string>;
export declare function fetchSearchResultContexts(input: {
    state: unknown;
    results: SearchResultItem[];
    timeoutMs: number;
    maxResults?: number;
    maxCharsPerPage?: number;
}): Promise<SearchResultContext[]>;
export declare function extractLinks(input: {
    state: unknown;
    timeoutMs: number;
    limit?: number;
}): Promise<Array<{
    href: string;
    text: string;
}>>;
export declare function closeWebSession(state: unknown): Promise<void>;
export {};
//# sourceMappingURL=playwright-executor.d.ts.map