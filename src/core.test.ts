import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AppCore } from './core.js';
import { _initTestDatabase } from './db.js';

// Mock modules that require external systems
vi.mock('./container-runtime.js', () => ({
  cleanupOrphans: vi.fn(),
}));
vi.mock('./process-lock.js', () => ({
  acquireProcessLock: vi.fn(),
  releaseProcessLock: vi.fn(),
}));
vi.mock('./tools/service-supervisor.js', () => ({
  ensureToolServicesReadyOnStartup: vi
    .fn()
    .mockResolvedValue({ ok: true, detail: 'mocked' }),
}));
vi.mock('./runtime/local-only-migration.js', () => ({
  migrateToLocalOnlyIfNeeded: vi.fn(),
}));
vi.mock('./auth/auth-manager.js', () => ({
  migrateEnvCredentialsToAuthProfilesIfNeeded: vi.fn(),
}));
vi.mock('@onecli-sh/sdk', () => {
  class MockOneCLI {
    ensureAgent = vi.fn().mockResolvedValue({ created: false });
  }
  return { OneCLI: MockOneCLI };
});

describe('AppCore', () => {
  let core: AppCore;

  beforeEach(() => {
    _initTestDatabase();
    core = new AppCore();
  });

  afterEach(async () => {
    await core.stop();
  });

  it('starts without channels', async () => {
    await core.start();
    expect(core.isRunning()).toBe(true);
  });

  it('stops cleanly', async () => {
    await core.start();
    await core.stop();
    expect(core.isRunning()).toBe(false);
  });

  it('getRegisteredGroups returns loaded state', async () => {
    await core.start();
    const groups = core.getRegisteredGroups();
    expect(typeof groups).toBe('object');
  });
});
