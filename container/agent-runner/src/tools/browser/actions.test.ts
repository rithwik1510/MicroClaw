import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolExecutionContext } from '../types.js';
import {
  executeBrowserClick,
  executeBrowserClose,
  executeBrowserExtractText,
  executeBrowserOpenUrl,
  executeBrowserScreenshot,
  executeBrowserSnapshot,
  executeBrowserTabs,
  executeBrowserType,
} from './actions.js';

const sendBrowserBridgeRequest = vi.fn();

vi.mock('./host-bridge.js', () => ({
  sendBrowserBridgeRequest: (...args: unknown[]) => sendBrowserBridgeRequest(...args),
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
    maxBrowserActionsPerTurn: 4,
    totalBrowserBudgetMs: 10000,
    browserActionCount: 0,
    browserPolicy: {
      allowPersistentSessions: true,
      allowAttachedSessions: false,
      maxTabsPerSession: 3,
      idleTimeoutMs: 300000,
    },
    secrets: {
      NANOCLAW_GROUP_FOLDER: 'main',
      NANOCLAW_CHAT_JID: 'dc:test',
    },
  };
}

describe('browser actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a session and opens a URL through the host bridge', async () => {
    sendBrowserBridgeRequest
      .mockResolvedValueOnce({ sessionId: 'session-1' })
      .mockResolvedValueOnce({
        title: 'Example',
        url: 'https://example.com',
      });

    const ctx = makeCtx();
    const res = await executeBrowserOpenUrl(
      { url: 'https://example.com' },
      ctx,
    );

    expect(res.ok).toBe(true);
    expect(res.content).toContain('Opened URL');
    expect(ctx.browserSession?.id).toBe('session-1');
    expect(sendBrowserBridgeRequest.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        action: 'open_url',
        owner: {
          groupFolder: 'main',
          chatJid: 'dc:test',
          role: 'browser-operator',
        },
      }),
    );
  });

  it('renders snapshot refs compactly', async () => {
    sendBrowserBridgeRequest
      .mockResolvedValueOnce({ sessionId: 'session-1' })
      .mockResolvedValueOnce({
        title: 'Example',
        url: 'https://example.com',
        snapshotVersion: 1,
        elements: [{ ref: '1', role: 'button', tag: 'button', text: 'Submit' }],
        textPreview: 'Example preview',
      });

    const ctx = makeCtx();
    const res = await executeBrowserSnapshot({}, ctx);
    expect(res.ok).toBe(true);
    expect(res.content).toContain('[ref=1]');
    expect(res.content).toContain('Example preview');
  });

  it('uses the existing session for follow-up actions', async () => {
    sendBrowserBridgeRequest.mockResolvedValue({
      title: 'Next',
      url: 'https://example.com/next',
    });
    const ctx = makeCtx();
    ctx.browserSession = { id: 'session-1', mode: 'ephemeral', snapshotVersion: 3 };

    const click = await executeBrowserClick({ ref: '1' }, ctx);
    ctx.browserSession = { id: 'session-1', mode: 'ephemeral', snapshotVersion: 3 };
    const type = await executeBrowserType({ ref: '2', text: 'hello' }, ctx);

    expect(click.ok).toBe(true);
    expect(type.ok).toBe(true);
    expect(sendBrowserBridgeRequest).toHaveBeenCalledTimes(2);
    expect(sendBrowserBridgeRequest.mock.calls[0][0]).toEqual(
      expect.objectContaining({ action: 'click', sessionId: 'session-1' }),
    );
  });

  it('extracts text and lists tabs', async () => {
    const ctx = makeCtx();
    ctx.browserSession = { id: 'session-1', mode: 'ephemeral' };
    sendBrowserBridgeRequest
      .mockResolvedValueOnce({ text: 'Page text' })
      .mockResolvedValueOnce({
        session: {
          sessionId: 'session-1',
          mode: 'ephemeral',
          tabCount: 1,
        },
        tabs: [{ tabId: '0', title: 'Example', url: 'https://example.com', active: true }],
      });

    const text = await executeBrowserExtractText({}, ctx);
    const tabs = await executeBrowserTabs({ action: 'list' }, ctx);
    expect(text.content).toContain('Page text');
    expect(tabs.content).toContain('Session: ephemeral');
    expect(tabs.content).toContain('[0]');
  });

  it('blocks mutating actions when mutation approval is required', async () => {
    const ctx = makeCtx();
    ctx.browserSession = { id: 'session-1', mode: 'ephemeral', snapshotVersion: 1 };
    ctx.browserPolicy = {
      ...ctx.browserPolicy,
      requireApprovalForBrowserMutations: true,
    };

    const res = await executeBrowserClick({ ref: '1' }, ctx);

    expect(res.ok).toBe(false);
    expect(res.content).toContain('requires approval');
    expect(sendBrowserBridgeRequest).not.toHaveBeenCalled();
  });

  it('closes the browser session and clears local state', async () => {
    sendBrowserBridgeRequest.mockResolvedValueOnce({ closed: true });
    const ctx = makeCtx();
    ctx.browserSession = { id: 'session-1', mode: 'ephemeral' };
    const res = await executeBrowserClose({}, ctx);
    expect(res.ok).toBe(true);
    expect(ctx.browserSession).toBeUndefined();
  });

  it('captures a browser screenshot', async () => {
    sendBrowserBridgeRequest
      .mockResolvedValueOnce({ sessionId: 'session-1' })
      .mockResolvedValueOnce({
        title: 'Example',
        url: 'https://example.com',
        path: 'C:/tmp/example.png',
        scope: 'viewport',
      });
    const ctx = makeCtx();
    const res = await executeBrowserScreenshot({}, ctx);
    expect(res.ok).toBe(true);
    expect(res.content).toContain('example.png');
  });
});
