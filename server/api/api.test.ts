import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { _initTestDatabase } from '../../src/db.js';
import {
  createAgent,
  getSetupValue,
  getAllAgents,
  storeMessageDirect,
  storeChatMetadata,
} from '../../src/db.js';
import { healthRouter } from './health.js';
import { setupRouter } from './setup.js';
import { agentsRouter } from './agents.js';
import { chatsRouter } from './chats.js';

// Minimal AppCore mock — only the methods the routes actually call
function createMockCore() {
  const groups: Record<string, any> = {};
  const channels: any[] = [];
  return {
    getChannels: () => channels,
    getRegisteredGroups: () => groups,
    registerGroup: (jid: string, group: any) => {
      groups[jid] = group;
    },
    queue: { enqueueMessageCheck: vi.fn() },
  };
}

function createTestApp(core: ReturnType<typeof createMockCore>) {
  const app = express();
  app.use(express.json());
  app.use('/api', healthRouter(core as any));
  app.use('/api', setupRouter());
  app.use('/api', agentsRouter());
  app.use('/api', chatsRouter(core as any));
  return app;
}

describe('API routes', () => {
  let app: express.Express;
  let core: ReturnType<typeof createMockCore>;

  beforeEach(() => {
    _initTestDatabase();
    core = createMockCore();
    app = createTestApp(core);
  });

  // ── Health ──────────────────────────────────────
  describe('GET /api/health', () => {
    it('returns status ok with uptime', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(typeof res.body.uptime).toBe('number');
    });

    it('returns empty channels when none connected', async () => {
      const res = await request(app).get('/api/health');
      expect(res.body.channels).toEqual([]);
      expect(res.body.groups).toBe(0);
    });
  });

  // ── Setup ───────────────────────────────────────
  describe('GET /api/setup', () => {
    it('returns completed false when not configured', async () => {
      const res = await request(app).get('/api/setup');
      expect(res.status).toBe(200);
      expect(res.body.completed).toBe(false);
    });

    it('returns completed true after setup', async () => {
      await request(app)
        .post('/api/setup')
        .send({ provider: 'openai_compatible', model: 'qwen2.5:14b' });

      const res = await request(app).get('/api/setup');
      expect(res.body.completed).toBe(true);
    });
  });

  describe('POST /api/setup', () => {
    it('saves provider and model', async () => {
      const res = await request(app)
        .post('/api/setup')
        .send({ provider: 'openai_compatible', model: 'qwen2.5:14b' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(getSetupValue('provider')).toBe('openai_compatible');
      expect(getSetupValue('model')).toBe('qwen2.5:14b');
      expect(getSetupValue('onboarding_completed')).toBe('true');
    });

    it('rejects missing provider', async () => {
      const res = await request(app)
        .post('/api/setup')
        .send({ model: 'qwen2.5:14b' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('rejects missing model', async () => {
      const res = await request(app)
        .post('/api/setup')
        .send({ provider: 'openai_compatible' });

      expect(res.status).toBe(400);
    });
  });

  // ── Agents ──────────────────────────────────────
  describe('GET /api/agents', () => {
    it('returns empty list initially', async () => {
      const res = await request(app).get('/api/agents');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('POST /api/agents', () => {
    it('creates an agent', async () => {
      const res = await request(app)
        .post('/api/agents')
        .send({ name: 'TestBot', model: 'qwen2.5:14b' });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('TestBot');
      expect(res.body.model).toBe('qwen2.5:14b');
      expect(res.body.id).toMatch(/^agent-/);
    });

    it('rejects missing name', async () => {
      const res = await request(app)
        .post('/api/agents')
        .send({ model: 'qwen2.5:14b' });

      expect(res.status).toBe(400);
    });

    it('rejects missing model', async () => {
      const res = await request(app)
        .post('/api/agents')
        .send({ name: 'TestBot' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/agents/:id', () => {
    it('returns 404 for nonexistent agent', async () => {
      const res = await request(app).get('/api/agents/nonexistent');
      expect(res.status).toBe(404);
    });

    it('returns agent by id', async () => {
      const createRes = await request(app)
        .post('/api/agents')
        .send({ name: 'TestBot', model: 'qwen2.5:14b' });

      const res = await request(app).get(`/api/agents/${createRes.body.id}`);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('TestBot');
    });
  });

  describe('PUT /api/agents/:id', () => {
    it('updates agent fields', async () => {
      const createRes = await request(app)
        .post('/api/agents')
        .send({ name: 'TestBot', model: 'qwen2.5:14b' });

      const res = await request(app)
        .put(`/api/agents/${createRes.body.id}`)
        .send({ name: 'UpdatedBot' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('UpdatedBot');
      expect(res.body.model).toBe('qwen2.5:14b'); // unchanged
    });

    it('returns 404 for nonexistent agent', async () => {
      const res = await request(app)
        .put('/api/agents/nonexistent')
        .send({ name: 'X' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/agents/:id', () => {
    it('deletes an agent', async () => {
      const createRes = await request(app)
        .post('/api/agents')
        .send({ name: 'TestBot', model: 'qwen2.5:14b' });

      const res = await request(app).delete(
        `/api/agents/${createRes.body.id}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      // verify gone
      const getRes = await request(app).get(
        `/api/agents/${createRes.body.id}`,
      );
      expect(getRes.status).toBe(404);
    });

    it('returns 404 for nonexistent agent', async () => {
      const res = await request(app).delete('/api/agents/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  // ── Chats ───────────────────────────────────────
  describe('POST /api/chats', () => {
    it('creates a dashboard chat', async () => {
      const res = await request(app)
        .post('/api/chats')
        .send({ name: 'General' });

      expect(res.status).toBe(201);
      expect(res.body.jid).toMatch(/^dashboard:general-/);
      expect(res.body.name).toBe('General');
      expect(res.body.folder).toMatch(/^dashboard_general$/);
    });

    it('rejects missing name', async () => {
      const res = await request(app).post('/api/chats').send({});
      expect(res.status).toBe(400);
    });

    it('registers group with core', async () => {
      await request(app).post('/api/chats').send({ name: 'Test' });
      const groups = core.getRegisteredGroups();
      const jids = Object.keys(groups);
      expect(jids.length).toBe(1);
      expect(jids[0]).toMatch(/^dashboard:test-/);
    });
  });

  describe('GET /api/chats/:jid/messages', () => {
    it('returns empty for new chat', async () => {
      const res = await request(app).get(
        '/api/chats/dashboard:test/messages',
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });
});
