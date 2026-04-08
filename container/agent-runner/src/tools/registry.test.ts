import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { ToolExecutionContext } from './types.js';
import { buildToolRegistry, findTool } from './registry.js';

const mockExecuteWebSearch = vi.fn();
const mockExecuteWebFetch = vi.fn();
const mockExecuteWebOpenUrl = vi.fn();
const mockExecuteWebExtractText = vi.fn();
const mockExecuteWebGetLinks = vi.fn();
const mockExecuteWebClose = vi.fn();

vi.mock('./web/actions.js', () => ({
  executeWebSearch: (...args: unknown[]) => mockExecuteWebSearch(...args),
  executeWebFetch: (...args: unknown[]) => mockExecuteWebFetch(...args),
  executeWebOpenUrl: (...args: unknown[]) => mockExecuteWebOpenUrl(...args),
  executeWebExtractText: (...args: unknown[]) =>
    mockExecuteWebExtractText(...args),
  executeWebGetLinks: (...args: unknown[]) => mockExecuteWebGetLinks(...args),
  executeWebClose: (...args: unknown[]) => mockExecuteWebClose(...args),
}));

function makeCtx(): ToolExecutionContext {
  return {
    maxSearchCallsPerTurn: 1,
    maxToolSteps: 3,
    searchTimeoutMs: 1000,
    pageFetchTimeoutMs: 1000,
    totalWebBudgetMs: 5000,
    startedAtMs: Date.now(),
    stepCount: 0,
    searchCount: 0,
  };
}

describe('tool registry compatibility aliases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteWebOpenUrl.mockResolvedValue({
      ok: true,
      content: 'opened',
    });
  });

  it('routes web_browse open to web_open_url semantics', async () => {
    const registry = buildToolRegistry();
    const webBrowse = findTool(registry, 'web_browse');
    expect(webBrowse).toBeDefined();

    const ctx = makeCtx();
    const res = await webBrowse!.execute(
      {
        action: 'open',
        url: 'https://example.com',
      },
      ctx,
    );

    expect(mockExecuteWebOpenUrl).toHaveBeenCalledTimes(1);
    expect(mockExecuteWebOpenUrl).toHaveBeenCalledWith(
      {
        action: 'open',
        url: 'https://example.com',
      },
      ctx,
    );
    expect(mockExecuteWebFetch).not.toHaveBeenCalled();
    expect(res).toEqual({
      ok: true,
      content: 'opened',
    });
  });
});
