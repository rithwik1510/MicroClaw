import { readEnvFile } from '../env.js';
import { ensureAuthProfileReady } from '../auth/auth-manager.js';
import {
  getAllRuntimeProfiles,
  getGroupRuntimePolicy,
  getProviderCapability,
} from '../db.js';
import { resolveAuthCredentialHandle } from '../auth/auth-manager.js';
import {
  GroupRuntimePolicy,
  RetryPolicy,
  RuntimeExecutionConfig,
  RuntimeProfile,
  RuntimeProvider,
  RuntimeToolPolicy,
} from '../types.js';

export interface RuntimeSelection {
  profiles: RuntimeProfile[];
  retryPolicy: RetryPolicy;
}

export interface RuntimeExecutionResolved {
  runtimeConfig: RuntimeExecutionConfig;
  secrets: Record<string, string>;
}

export interface RuntimeExecutionResolvedWithAuth extends RuntimeExecutionResolved {
  authRefreshMessage?: string;
}

export function defaultToolPolicyForProvider(
  provider: RuntimeProvider,
): RuntimeToolPolicy {
  return {
    web: {
      enabled: provider === 'openai_compatible',
    },
    browser: {
      enabled: false,
      maxSteps: 6,
      totalBudgetMs: 90_000,
      maxConcurrentSessionsGlobal: 2,
      maxTabsPerSession: 3,
      idleTimeoutMs: 300_000,
      allowPersistentSessions: true,
      allowAttachedSessions: false,
      allowDesktopControl: false,
      requireApprovalForBrowserMutations: false,
      allowFormSubmission: true,
      allowFileUpload: false,
    },
  };
}

export function resolveToolPolicy(profile: RuntimeProfile): RuntimeToolPolicy {
  const defaults = defaultToolPolicyForProvider(profile.provider);
  return {
    ...defaults,
    ...profile.toolPolicy,
    web: {
      ...defaults.web,
      ...profile.toolPolicy?.web,
    },
    browser: {
      ...defaults.browser,
      ...profile.toolPolicy?.browser,
    },
    memory: profile.toolPolicy?.memory
      ? { ...profile.toolPolicy.memory }
      : undefined,
    docs: profile.toolPolicy?.docs ? { ...profile.toolPolicy.docs } : undefined,
  };
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 2,
  backoffMs: 1500,
  retryableErrors: ['timeout', 'rate_limited', 'provider_unavailable'],
  timeoutMs: 600_000,
};

function providerDefaultModel(provider: RuntimeProvider): string {
  switch (provider) {
    case 'openai_compatible':
      return 'gpt-4.1-mini';
    case 'claude':
    default:
      return 'claude-sonnet-4-5';
  }
}

function envConfiguredOpenAICompatibleRuntime(): boolean {
  const env = readEnvFile([
    'OPENAI_API_KEY',
    'NANOCLAW_DEFAULT_MODEL',
    'NANOCLAW_DEFAULT_BASE_URL',
    'OPENAI_COMPAT_BASE_URL',
  ]);

  const apiKey = process.env.OPENAI_API_KEY || env.OPENAI_API_KEY;
  const defaultModel =
    process.env.NANOCLAW_DEFAULT_MODEL || env.NANOCLAW_DEFAULT_MODEL;
  const defaultBaseUrl =
    process.env.NANOCLAW_DEFAULT_BASE_URL ||
    env.NANOCLAW_DEFAULT_BASE_URL ||
    process.env.OPENAI_COMPAT_BASE_URL ||
    env.OPENAI_COMPAT_BASE_URL;

  return !!(apiKey && (defaultModel || defaultBaseUrl));
}

function preferEnvRuntimeOverride(): boolean {
  const env = readEnvFile(['NANOCLAW_PREFER_ENV_RUNTIME']);
  const raw =
    process.env.NANOCLAW_PREFER_ENV_RUNTIME ||
    env.NANOCLAW_PREFER_ENV_RUNTIME ||
    '';
  return raw.trim().toLowerCase() === 'true';
}

export function getBuiltinDefaultProfile(): RuntimeProfile {
  const env = readEnvFile([
    'NANOCLAW_DEFAULT_PROVIDER',
    'NANOCLAW_DEFAULT_MODEL',
    'NANOCLAW_DEFAULT_BASE_URL',
    'ANTHROPIC_BASE_URL',
    'OPENAI_COMPAT_BASE_URL',
  ]);

  const rawProvider =
    process.env.NANOCLAW_DEFAULT_PROVIDER || env.NANOCLAW_DEFAULT_PROVIDER;
  const provider: RuntimeProvider =
    rawProvider === 'openai_compatible' || rawProvider === 'claude'
      ? rawProvider
      : 'openai_compatible';

  const model =
    process.env.NANOCLAW_DEFAULT_MODEL ||
    env.NANOCLAW_DEFAULT_MODEL ||
    providerDefaultModel(provider);

  const baseUrl =
    provider === 'claude'
      ? process.env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL
      : process.env.NANOCLAW_DEFAULT_BASE_URL ||
        env.NANOCLAW_DEFAULT_BASE_URL ||
        process.env.OPENAI_COMPAT_BASE_URL ||
        env.OPENAI_COMPAT_BASE_URL ||
        'http://host.docker.internal:1234/v1';

  const authEnvVar =
    provider === 'claude' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'OPENAI_API_KEY';

  const now = new Date().toISOString();
  return {
    id: 'builtin-default',
    provider,
    model,
    baseUrl: baseUrl || undefined,
    endpointKind: provider === 'openai_compatible' ? 'custom_openai' : 'cloud',
    enabled: true,
    priority: 0,
    authEnvVar,
    toolPolicy: defaultToolPolicyForProvider(provider),
    createdAt: now,
    updatedAt: now,
  };
}

function dedupeProfiles(profiles: RuntimeProfile[]): RuntimeProfile[] {
  const seen = new Set<string>();
  const result: RuntimeProfile[] = [];
  for (const profile of profiles) {
    if (seen.has(profile.id)) continue;
    seen.add(profile.id);
    result.push(profile);
  }
  return result;
}

function constrainFallbackProviderFamily(
  profiles: RuntimeProfile[],
): RuntimeProfile[] {
  if (profiles.length === 0) return profiles;
  const primary = profiles[0].provider;
  return profiles.filter((p) => p.provider === primary);
}

function resolveFromPolicy(
  policy: GroupRuntimePolicy | undefined,
  profiles: RuntimeProfile[],
): RuntimeProfile[] {
  if (!policy) return [];

  const map = new Map(profiles.map((p) => [p.id, p]));
  const resolved: RuntimeProfile[] = [];

  const primary = map.get(policy.primaryProfileId);
  if (primary) resolved.push(primary);

  for (const id of policy.fallbackProfileIds || []) {
    const fallback = map.get(id);
    if (fallback) resolved.push(fallback);
  }

  return dedupeProfiles(resolved);
}

export function resolveRuntimeSelection(groupFolder: string): RuntimeSelection {
  const dbProfiles = getAllRuntimeProfiles().filter((p) => p.enabled);
  const builtin = getBuiltinDefaultProfile();
  const preferEnvRuntime =
    builtin.provider === 'openai_compatible' &&
    envConfiguredOpenAICompatibleRuntime() &&
    preferEnvRuntimeOverride();

  // No stored profiles yet: use built-in default.
  if (dbProfiles.length === 0) {
    return {
      profiles: [builtin],
      retryPolicy: DEFAULT_RETRY_POLICY,
    };
  }

  const policy = getGroupRuntimePolicy(groupFolder);
  const fromPolicy = resolveFromPolicy(policy, dbProfiles);
  const ordered =
    fromPolicy.length > 0
      ? fromPolicy
      : [...dbProfiles].sort((a, b) => a.priority - b.priority);
  const constrained = constrainFallbackProviderFamily(
    preferEnvRuntime ? [builtin, ...ordered] : ordered,
  );

  return {
    profiles: dedupeProfiles(constrained),
    retryPolicy: policy?.retryPolicy || DEFAULT_RETRY_POLICY,
  };
}

export function toRuntimeExecutionConfig(
  profile: RuntimeProfile,
): RuntimeExecutionConfig {
  const baseUrl =
    profile.endpointKind && profile.endpointKind !== 'cloud' && profile.baseUrl
      ? profile.baseUrl
          .replace(/127\.0\.0\.1/g, 'host.docker.internal')
          .replace(/localhost/g, 'host.docker.internal')
      : profile.baseUrl;
  const capability = getProviderCapability(profile.provider, baseUrl);
  return {
    provider: profile.provider,
    model: profile.model,
    baseUrl,
    authEnvVar: profile.authEnvVar,
    toolPolicy: resolveToolPolicy(profile),
    capabilities: capability,
  };
}

function envFallbackSecrets(profile: RuntimeProfile): Record<string, string> {
  const env = readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_COMPAT_BASE_URL',
  ]);

  const baseUrl = profile.baseUrl;

  if (profile.provider === 'claude') {
    return {
      CLAUDE_CODE_OAUTH_TOKEN:
        process.env.CLAUDE_CODE_OAUTH_TOKEN ||
        env.CLAUDE_CODE_OAUTH_TOKEN ||
        '',
      ANTHROPIC_API_KEY:
        process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY || '',
      ANTHROPIC_BASE_URL:
        process.env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL || '',
    };
  }

  return {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || env.OPENAI_API_KEY || '',
    OPENAI_BASE_URL:
      baseUrl ||
      process.env.OPENAI_COMPAT_BASE_URL ||
      env.OPENAI_COMPAT_BASE_URL ||
      '',
  };
}

export function resolveRuntimeExecution(
  profile: RuntimeProfile,
): RuntimeExecutionResolved {
  const runtimeConfig = toRuntimeExecutionConfig(profile);

  if (profile.authProfileId) {
    const handle = resolveAuthCredentialHandle(profile.authProfileId, profile);
    if (handle) {
      const secrets = {
        ...envFallbackSecrets(profile),
        ...handle.materializedEnv,
      };
      if (
        profile.provider === 'openai_compatible' &&
        runtimeConfig.baseUrl &&
        !secrets.OPENAI_BASE_URL
      ) {
        secrets.OPENAI_BASE_URL = runtimeConfig.baseUrl;
      }
      return { runtimeConfig, secrets };
    }
  }

  return { runtimeConfig, secrets: envFallbackSecrets(profile) };
}

export async function resolveRuntimeExecutionAsync(
  profile: RuntimeProfile,
): Promise<RuntimeExecutionResolvedWithAuth> {
  let authRefreshMessage: string | undefined;
  if (profile.authProfileId) {
    const refresh = await ensureAuthProfileReady(profile.authProfileId).catch(
      () => undefined,
    );
    authRefreshMessage = refresh?.message;
  }
  const resolved = resolveRuntimeExecution(profile);
  return {
    ...resolved,
    authRefreshMessage,
  };
}
