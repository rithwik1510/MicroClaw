import { beforeEach, describe, expect, it, vi } from 'vitest';

const launchMock = vi.fn();
const launchPersistentContextMock = vi.fn();

vi.mock('playwright', () => ({
  chromium: {
    launch: (...args: unknown[]) => launchMock(...args),
    launchPersistentContext: (...args: unknown[]) =>
      launchPersistentContextMock(...args),
  },
}));

function makePage(
  overrides?: Partial<{
    goto: ReturnType<typeof vi.fn>;
    title: ReturnType<typeof vi.fn>;
    url: ReturnType<typeof vi.fn>;
    evaluate: ReturnType<typeof vi.fn>;
    locator: ReturnType<typeof vi.fn>;
    bringToFront: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>,
) {
  return {
    goto: vi.fn(),
    title: vi.fn(async () => 'Example'),
    url: vi.fn(() => 'https://example.com'),
    evaluate: vi.fn(async () => ({
      title: 'Example',
      url: 'https://example.com',
      elements: [{ ref: '1', tag: 'button', role: 'button', text: 'Submit' }],
      textPreview: 'Example text preview',
    })),
    locator: vi.fn(() => ({
      first: () => ({
        count: vi.fn(async () => 1),
        click: vi.fn(async () => undefined),
        fill: vi.fn(async () => undefined),
        selectOption: vi.fn(async () => undefined),
      }),
    })),
    bringToFront: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeContext(
  page = makePage(),
  extraPages: ReturnType<typeof makePage>[] = [],
) {
  const pages = [page, ...extraPages];
  for (const current of pages) {
    current.close = vi.fn(async () => {
      const index = pages.indexOf(current);
      if (index >= 0) pages.splice(index, 1);
    });
  }
  return {
    pages: vi.fn(() => pages),
    newPage: vi.fn(async () => {
      const next = makePage();
      next.close = vi.fn(async () => {
        const index = pages.indexOf(next);
        if (index >= 0) pages.splice(index, 1);
      });
      pages.push(next);
      return next;
    }),
    close: vi.fn(async () => undefined),
  };
}

describe('BrowserManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NANOCLAW_BROWSER_MAX_CONCURRENT_SESSIONS;
  });

  it('creates an ephemeral session and opens a page', async () => {
    const page = makePage();
    const context = makeContext(page);
    const browser = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => undefined),
    };
    launchMock.mockResolvedValue(browser);

    const { BrowserManager } = await import('./manager.js');
    const manager = new BrowserManager();
    const session = await manager.createSession({
      mode: 'ephemeral',
      owner: {
        groupFolder: 'main',
        chatJid: 'dc:test',
        role: 'browser-operator',
      },
    });

    expect(session.mode).toBe('ephemeral');
    const opened = await manager.openUrl(
      session.sessionId,
      'https://example.com',
    );
    expect(page.goto).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ timeout: 45_000 }),
    );
    expect(opened.url).toBe('https://example.com');
  });

  it('captures a snapshot with refs and page text', async () => {
    const page = makePage();
    const context = makeContext(page);
    const browser = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => undefined),
    };
    launchMock.mockResolvedValue(browser);

    const { BrowserManager } = await import('./manager.js');
    const manager = new BrowserManager();
    const session = await manager.createSession({
      mode: 'ephemeral',
      owner: {
        groupFolder: 'main',
        chatJid: 'dc:test',
        role: 'browser-operator',
      },
    });

    const snapshot = await manager.snapshot(session.sessionId, 5);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(snapshot.snapshotVersion).toBe(1);
    expect(snapshot.elements[0]?.ref).toBe('1');
    expect(snapshot.textPreview).toContain('Example');
  });

  it('creates a persistent session only when policy allows it', async () => {
    const context = makeContext();
    launchPersistentContextMock.mockResolvedValue(context);

    const { BrowserManager } = await import('./manager.js');
    const manager = new BrowserManager();
    await expect(
      manager.createSession({
        mode: 'persistent',
        owner: {
          groupFolder: 'main',
          chatJid: 'dc:test',
          role: 'browser-operator',
        },
        allowPersistentSessions: false,
      }),
    ).rejects.toThrow(/disabled by policy/);

    const session = await manager.createSession({
      mode: 'persistent',
      owner: {
        groupFolder: 'main',
        chatJid: 'dc:test',
        role: 'browser-operator',
      },
      allowPersistentSessions: true,
    });
    expect(session.mode).toBe('persistent');
  });

  it('enforces the global session cap', async () => {
    process.env.NANOCLAW_BROWSER_MAX_CONCURRENT_SESSIONS = '1';
    const context = makeContext();
    const browser = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => undefined),
    };
    launchMock.mockResolvedValue(browser);

    const { BrowserManager } = await import('./manager.js');
    const manager = new BrowserManager();
    await manager.createSession({
      mode: 'ephemeral',
      owner: {
        groupFolder: 'main',
        chatJid: 'dc:test',
        role: 'browser-operator',
      },
    });
    await expect(
      manager.createSession({
        mode: 'ephemeral',
        owner: {
          groupFolder: 'main',
          chatJid: 'dc:test',
          role: 'browser-operator',
        },
      }),
    ).rejects.toThrow(/cap reached/);
  });

  it('rejects browser access from a different owner', async () => {
    const page = makePage();
    const context = makeContext(page);
    const browser = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => undefined),
    };
    launchMock.mockResolvedValue(browser);

    const { BrowserManager } = await import('./manager.js');
    const manager = new BrowserManager();
    const session = await manager.createSession({
      mode: 'ephemeral',
      owner: {
        groupFolder: 'main',
        chatJid: 'dc:test',
        role: 'browser-operator',
      },
    });

    await expect(
      manager.openUrl(session.sessionId, 'https://example.com', {
        groupFolder: 'other',
        chatJid: 'dc:test',
        role: 'browser-operator',
      }),
    ).rejects.toThrow(/owned by another task\/chat/i);
  });

  it('reaps idle sessions before enforcing the session cap', async () => {
    vi.useFakeTimers();
    process.env.NANOCLAW_BROWSER_MAX_CONCURRENT_SESSIONS = '1';
    const context = makeContext();
    const browser = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => undefined),
    };
    launchMock.mockResolvedValue(browser);

    const { BrowserManager } = await import('./manager.js');
    const manager = new BrowserManager();
    await manager.createSession({
      mode: 'ephemeral',
      owner: {
        groupFolder: 'main',
        chatJid: 'dc:test',
        role: 'browser-operator',
      },
      idleTimeoutMs: 10,
    });

    vi.advanceTimersByTime(25);

    const session = await manager.createSession({
      mode: 'ephemeral',
      owner: {
        groupFolder: 'main',
        chatJid: 'dc:test',
        role: 'browser-operator',
      },
      idleTimeoutMs: 10,
    });

    expect(session.sessionId).toBeTruthy();
    expect(context.close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
