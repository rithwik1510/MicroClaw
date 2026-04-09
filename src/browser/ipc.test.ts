import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _initTestDatabase } from '../db.js';

const manager = {
  createSession: vi.fn(async () => ({
    sessionId: 'session-1',
    mode: 'ephemeral',
    permissionTier: 'isolated',
    owner: {
      groupFolder: 'main',
      chatJid: 'dc:test',
      role: 'browser-operator',
    },
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    tabCount: 1,
  })),
  openUrl: vi.fn(async () => ({
    title: 'Example',
    url: 'https://example.com',
  })),
  snapshot: vi.fn(async () => ({
    title: 'Example',
    url: 'https://example.com',
    elements: [],
    textPreview: 'Example text',
  })),
  click: vi.fn(),
  type: vi.fn(),
  select: vi.fn(),
  extractText: vi.fn(),
  listTabs: vi.fn(),
  listTabsWithState: vi.fn(async () => ({
    session: {
      sessionId: 'session-1',
      mode: 'ephemeral',
      permissionTier: 'isolated',
      owner: {
        groupFolder: 'main',
        chatJid: 'dc:test',
        role: 'browser-operator',
      },
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      tabCount: 1,
      status: 'active',
    },
    tabs: [],
  })),
  getSessionState: vi.fn(() => ({
    sessionId: 'session-1',
    mode: 'ephemeral',
    permissionTier: 'isolated',
    owner: {
      groupFolder: 'main',
      chatJid: 'dc:test',
      role: 'browser-operator',
    },
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    tabCount: 1,
    status: 'active',
  })),
  focusTab: vi.fn(),
  closeTab: vi.fn(),
  closeSession: vi.fn(),
};

vi.mock('./manager.js', () => ({
  getBrowserManager: () => manager,
}));

describe('processBrowserIpcGroup', () => {
  const baseDir = path.join(os.tmpdir(), `microclaw-browser-ipc-${Date.now()}`);

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('processes a browser request and writes a response file', async () => {
    _initTestDatabase();
    const requestsDir = path.join(baseDir, 'browser', 'requests');
    fs.mkdirSync(requestsDir, { recursive: true });
    fs.writeFileSync(
      path.join(requestsDir, 'req-1.json'),
      JSON.stringify({
        id: 'req-1',
        type: 'browser_request',
        action: 'create_session',
        mode: 'ephemeral',
        owner: {
          groupFolder: 'main',
          chatJid: 'dc:test',
          role: 'browser-operator',
        },
      }),
    );

    const { processBrowserIpcGroup } = await import('./ipc.js');
    await processBrowserIpcGroup(baseDir);

    const responsePath = path.join(
      baseDir,
      'browser',
      'responses',
      'req-1.json',
    );
    expect(fs.existsSync(responsePath)).toBe(true);
    const response = JSON.parse(fs.readFileSync(responsePath, 'utf8')) as {
      ok: boolean;
      data: { sessionId: string };
    };
    expect(response.ok).toBe(true);
    expect(response.data.sessionId).toBe('session-1');
    expect(manager.createSession).toHaveBeenCalledTimes(1);
  });
});
