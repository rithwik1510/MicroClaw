import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { _initTestDatabase } from '../src/db.js';
import { createApp } from './index.js';

// Mock external dependencies that AppCore would use
vi.mock('../src/container-runtime.js', () => ({
  cleanupOrphans: vi.fn(),
}));
vi.mock('../src/process-lock.js', () => ({
  acquireProcessLock: vi.fn(),
  releaseProcessLock: vi.fn(),
}));
vi.mock('../src/tools/service-supervisor.js', () => ({
  ensureToolServicesReadyOnStartup: vi
    .fn()
    .mockResolvedValue({ ok: true, detail: 'mocked' }),
}));
vi.mock('../src/runtime/local-only-migration.js', () => ({
  migrateToLocalOnlyIfNeeded: vi.fn(),
}));
vi.mock('../src/auth/auth-manager.js', () => ({
  migrateEnvCredentialsToAuthProfilesIfNeeded: vi.fn(),
}));
vi.mock('@onecli-sh/sdk', () => {
  class MockOneCLI {
    ensureAgent = vi.fn().mockResolvedValue({ created: false });
  }
  return { OneCLI: MockOneCLI };
});

// Minimal AppCore mock with the real interface
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

describe('server integration', () => {
  let core: ReturnType<typeof createMockCore>;

  beforeEach(() => {
    _initTestDatabase();
    core = createMockCore();
  });

  it('GET /api/health returns ok', async () => {
    const { app } = createApp(core as any);
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /api/setup returns completed status', async () => {
    const { app } = createApp(core as any);
    const res = await request(app).get('/api/setup');
    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(false);
  });

  it('POST /api/setup saves config', async () => {
    const { app } = createApp(core as any);
    const res = await request(app)
      .post('/api/setup')
      .send({ provider: 'openai_compatible', model: 'qwen2.5:14b' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /api/agents returns list', async () => {
    const { app } = createApp(core as any);
    const res = await request(app).get('/api/agents');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/chats creates dashboard chat', async () => {
    const { app } = createApp(core as any);
    const res = await request(app)
      .post('/api/chats')
      .send({ name: 'General' });
    expect(res.status).toBe(201);
    expect(res.body.jid).toMatch(/^dashboard:/);
  });

  it('creates a dashboard channel on app creation', () => {
    const { dashboardChannel } = createApp(core as any);
    expect(dashboardChannel).toBeDefined();
    expect(dashboardChannel.name).toBe('dashboard');
    expect(dashboardChannel.isConnected()).toBe(true);
  });

  it('pushes dashboard channel onto core channels', () => {
    createApp(core as any);
    expect(core.getChannels().length).toBe(1);
    expect(core.getChannels()[0].name).toBe('dashboard');
  });
});
