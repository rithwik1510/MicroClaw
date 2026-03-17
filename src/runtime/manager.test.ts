import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  setAuthProfile,
  setGroupRuntimePolicy,
  setRuntimeProfile,
} from '../db.js';
import {
  DEFAULT_RETRY_POLICY,
  defaultToolPolicyForProvider,
  resolveRuntimeExecution,
  resolveRuntimeSelection,
} from './manager.js';
import { saveCredentials } from '../auth/vault.js';

describe('runtime manager', () => {
  beforeEach(() => {
    _initTestDatabase();
    delete process.env.OPENAI_API_KEY;
    delete process.env.NANOCLAW_DEFAULT_MODEL;
    delete process.env.NANOCLAW_DEFAULT_BASE_URL;
    delete process.env.OPENAI_COMPAT_BASE_URL;
    delete process.env.NANOCLAW_PREFER_ENV_RUNTIME;
  });

  it('returns builtin default profile when no DB profiles exist', () => {
    const selection = resolveRuntimeSelection('whatsapp_main');
    expect(selection.profiles.length).toBe(1);
    expect(selection.profiles[0].provider).toBe('openai_compatible');
    expect(selection.retryPolicy).toEqual(DEFAULT_RETRY_POLICY);
  });

  it('uses group runtime policy ordering when configured', () => {
    setRuntimeProfile({
      id: 'claude-main',
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      enabled: true,
      priority: 10,
    });
    setRuntimeProfile({
      id: 'local-primary',
      provider: 'openai_compatible',
      model: 'gpt-4.1-mini',
      enabled: true,
      priority: 20,
    });

    setGroupRuntimePolicy({
      groupFolder: 'whatsapp_main',
      primaryProfileId: 'local-primary',
      fallbackProfileIds: ['claude-main'],
    });

    const selection = resolveRuntimeSelection('whatsapp_main');
    expect(selection.profiles.map((p) => p.id)).toEqual(['local-primary']);
  });

  it('falls back to enabled profiles ordered by priority', () => {
    setRuntimeProfile({
      id: 'p2',
      provider: 'openai_compatible',
      model: 'gpt-4.1-mini',
      enabled: true,
      priority: 50,
    });
    setRuntimeProfile({
      id: 'p1',
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      enabled: true,
      priority: 10,
    });

    const selection = resolveRuntimeSelection('work_group');
    expect(selection.profiles.map((p) => p.id)).toEqual(['p1']);
  });

  it('resolves runtime secrets from auth profile when bound', () => {
    setAuthProfile({
      id: 'auth-openai',
      provider: 'openai_compatible',
      credentialType: 'api_key',
      status: 'active',
    });
    saveCredentials('auth-openai', { OPENAI_API_KEY: 'db-auth-key' });

    setRuntimeProfile({
      id: 'openai-primary',
      provider: 'openai_compatible',
      model: 'gpt-4.1-mini',
      enabled: true,
      priority: 1,
      authProfileId: 'auth-openai',
    });

    const selection = resolveRuntimeSelection('main');
    const resolved = resolveRuntimeExecution(selection.profiles[0]);
    expect(resolved.secrets.OPENAI_API_KEY).toBe('db-auth-key');
  });

  it('applies default web tool policy for openai-compatible runtimes', () => {
    setRuntimeProfile({
      id: 'openai-tools',
      provider: 'openai_compatible',
      model: 'gpt-4.1-mini',
      enabled: true,
      priority: 1,
    });

    const selection = resolveRuntimeSelection('main');
    const resolved = resolveRuntimeExecution(selection.profiles[0]);
    expect(resolved.runtimeConfig.toolPolicy).toEqual(
      defaultToolPolicyForProvider('openai_compatible'),
    );
  });

  it('includes browser policy defaults but keeps browser disabled by default', () => {
    const policy = defaultToolPolicyForProvider('openai_compatible');
    expect(policy.browser).toEqual(
      expect.objectContaining({
        enabled: false,
        maxSteps: 6,
        totalBudgetMs: 90_000,
        maxConcurrentSessionsGlobal: 2,
        maxTabsPerSession: 3,
        idleTimeoutMs: 300_000,
        allowPersistentSessions: true,
        allowAttachedSessions: false,
        allowDesktopControl: false,
      }),
    );
  });

  it('does not prefer the env-configured cloud runtime unless explicitly enabled', () => {
    process.env.OPENAI_API_KEY = 'test-api-key';
    process.env.NANOCLAW_DEFAULT_MODEL =
      'qwen/qwen3-235b-a22b-instruct-2507';
    process.env.NANOCLAW_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

    setRuntimeProfile({
      id: 'runtime-lmstudio-main',
      provider: 'openai_compatible',
      model: 'qwen/qwen3-8b',
      enabled: true,
      priority: 0,
      endpointKind: 'lmstudio',
      baseUrl: 'http://host.docker.internal:1234/v1',
    });

    const selection = resolveRuntimeSelection('discord_dm');
    expect(selection.profiles[0].id).toBe('runtime-lmstudio-main');
  });

  it('prefers the env-configured cloud runtime when explicitly enabled', () => {
    process.env.OPENAI_API_KEY = 'test-api-key';
    process.env.NANOCLAW_DEFAULT_MODEL =
      'qwen/qwen3-235b-a22b-instruct-2507';
    process.env.NANOCLAW_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
    process.env.NANOCLAW_PREFER_ENV_RUNTIME = 'true';

    setRuntimeProfile({
      id: 'runtime-lmstudio-main',
      provider: 'openai_compatible',
      model: 'qwen/qwen3-8b',
      enabled: true,
      priority: 0,
      endpointKind: 'lmstudio',
      baseUrl: 'http://host.docker.internal:1234/v1',
    });

    const selection = resolveRuntimeSelection('discord_dm');
    expect(selection.profiles[0].id).toBe('builtin-default');
    expect(selection.profiles[0].model).toBe(
      'qwen/qwen3-235b-a22b-instruct-2507',
    );
    expect(selection.profiles[0].baseUrl).toBe('https://openrouter.ai/api/v1');
  });
});
