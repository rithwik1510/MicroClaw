/**
 * TDD: Dashboard should connect to existing groups, not create empty ones.
 *
 * The user's real data (name, preferences, memories, daily notes) lives in
 * groups/discord_dm/. When the dashboard creates "Sam", it makes a new empty
 * groups/dashboard_sam/ folder. The agent sees nothing.
 *
 * Fix: the dashboard should show existing groups and let users chat through them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import {
  _initTestDatabase,
  setRegisteredGroup,
  getAllRegisteredGroups,
} from '../src/db.js';
import { chatsRouter } from './api/chats.js';

function createMockCore() {
  const groups: Record<string, any> = {};
  return {
    getChannels: () => [],
    getRegisteredGroups: () => groups,
    registerGroup: (jid: string, group: any) => {
      groups[jid] = group;
    },
    queue: { enqueueMessageCheck: vi.fn() },
  };
}

describe('dashboard group reuse', () => {
  let core: ReturnType<typeof createMockCore>;

  beforeEach(() => {
    _initTestDatabase();
    core = createMockCore();
  });

  it('GET /api/chats/groups returns existing registered groups', async () => {
    // Simulate existing Discord groups in the database
    core.registerGroup('discord:guild:channel', {
      name: 'Discord Main',
      folder: 'discord_main',
      trigger: '@Andy',
      added_at: '2026-03-01T00:00:00Z',
    });
    core.registerGroup('discord:dm:123', {
      name: 'Discord DM',
      folder: 'discord_dm',
      trigger: '',
      added_at: '2026-03-01T00:00:00Z',
      requiresTrigger: false,
    });

    const app = express();
    app.use(express.json());
    app.use('/api', chatsRouter(core as any));

    const res = await request(app).get('/api/chats/groups');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
    expect(res.body.some((g: any) => g.folder === 'discord_dm')).toBe(true);
  });

  it('POST /api/chats with existingFolder uses that folder instead of creating new one', async () => {
    // User wants to chat with their existing Discord DM context
    core.registerGroup('discord:dm:123', {
      name: 'Discord DM',
      folder: 'discord_dm',
      trigger: '',
      added_at: '2026-03-01T00:00:00Z',
      requiresTrigger: false,
    });

    const app = express();
    app.use(express.json());
    app.use('/api', chatsRouter(core as any));

    const res = await request(app)
      .post('/api/chats')
      .send({ name: 'Sam', existingFolder: 'discord_dm' });

    expect(res.status).toBe(201);
    expect(res.body.folder).toBe('discord_dm'); // Uses existing folder, not dashboard_sam
    expect(res.body.jid).toMatch(/^dashboard:/);
  });
});
