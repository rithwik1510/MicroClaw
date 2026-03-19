import { ToolExecutionContext } from '../types.js';
import { SearchResultContext } from './playwright-executor.js';
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
export declare function searchWithSearxng(query: string, ctx: ToolExecutionContext): Promise<SearchResult[]>;
export declare function searchWithDuckDuckGoHtml(query: string, ctx: ToolExecutionContext): Promise<SearchResult[]>;
export declare function searchWithPlaywrightProvider(query: string, ctx: ToolExecutionContext): Promise<{
    results: SearchResult[];
    evidence: SearchResultContext[];
    providerText: string;
}>;
export declare function performSearch(query: string, ctx: ToolExecutionContext): Promise<{
    provider: string;
    results: SearchResult[];
    evidence: SearchResultContext[];
    degradedSummary?: string;
}>;
export declare function fetchWithHttp(url: string, ctx: ToolExecutionContext, maxChars?: number): Promise<FetchedDocument>;
export declare function fetchWithPlaywrightProvider(url: string, ctx: ToolExecutionContext, maxChars?: number): Promise<FetchedDocument>;
export declare function performFetch(url: string, ctx: ToolExecutionContext, maxChars?: number): Promise<{
    provider: string;
    document: FetchedDocument;
}>;
//# sourceMappingURL=providers.d.ts.map