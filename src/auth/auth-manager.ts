import {
  deleteAuthProfile,
  getAllAuthProfiles,
  getAuthProfile,
  setAuthProfile,
} from '../db.js';
import { readEnvFile } from '../env.js';
import {
  AuthCredentialHandle,
  AuthProfile,
  AuthProvider,
  AuthRefreshResult,
  RuntimeProfile,
} from '../types.js';
import { materializeCredentialEnv } from './providers.js';
import { deleteCredentials, getCredentials, saveCredentials } from './vault.js';

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function listAuthProfiles(): AuthProfile[] {
  return getAllAuthProfiles();
}

export function migrateEnvCredentialsToAuthProfilesIfNeeded(): number {
  if (getAllAuthProfiles().length > 0) return 0;
  const env = readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
  ]);

  let created = 0;
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    loginWithSecret({
      provider: 'anthropic_setup_token',
      credentialType: 'setup_token',
      accountLabel: 'migrated-env-claude',
      values: { CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN },
    });
    created++;
  } else if (env.ANTHROPIC_API_KEY) {
    loginWithSecret({
      provider: 'anthropic_setup_token',
      credentialType: 'api_key',
      accountLabel: 'migrated-env-anthropic-api',
      values: { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY },
    });
    created++;
  }

  if (env.OPENAI_API_KEY) {
    loginWithSecret({
      provider: 'openai_compatible',
      credentialType: 'api_key',
      accountLabel: 'migrated-env-openai-compatible',
      values: { OPENAI_API_KEY: env.OPENAI_API_KEY },
    });
    created++;
  }

  return created;
}

export function getAuthProfileById(id: string): AuthProfile | undefined {
  return getAuthProfile(id);
}

export function upsertAuthProfile(
  profile: Omit<AuthProfile, 'createdAt' | 'updatedAt'> & {
    createdAt?: string;
    updatedAt?: string;
  },
): AuthProfile {
  const saved: AuthProfile = {
    ...profile,
    createdAt: profile.createdAt || nowIso(),
    updatedAt: profile.updatedAt || nowIso(),
  };
  setAuthProfile(saved);
  return saved;
}

export function removeAuthProfile(id: string): void {
  deleteAuthProfile(id);
  deleteCredentials(id);
}

export function saveAuthCredentials(
  profileId: string,
  values: Record<string, string>,
): void {
  saveCredentials(profileId, values);
}

export function resolveAuthCredentialHandle(
  authProfileId: string,
  runtimeProfile?: RuntimeProfile,
): AuthCredentialHandle | undefined {
  const profile = getAuthProfile(authProfileId);
  if (!profile) return undefined;
  const credentials = getCredentials(authProfileId);
  if (!credentials) return undefined;
  const env = materializeCredentialEnv(profile, credentials, runtimeProfile);

  const headers: Record<string, string> = {};
  if (env.OPENAI_API_KEY) {
    headers.Authorization = `Bearer ${env.OPENAI_API_KEY}`;
  }
  return {
    profileId: authProfileId,
    materializedHeaders: headers,
    materializedEnv: env,
  };
}

export function loginWithSecret(params: {
  provider: AuthProvider;
  credentialType: AuthProfile['credentialType'];
  accountLabel?: string;
  scopes?: string[];
  expiresAt?: string;
  tokenType?: string;
  refreshEligible?: boolean;
  providerAccountId?: string;
  riskLevel?: AuthProfile['riskLevel'];
  values: Record<string, string>;
}): AuthProfile {
  const id = makeId('auth');
  const profile = upsertAuthProfile({
    id,
    provider: params.provider,
    credentialType: params.credentialType,
    accountLabel: params.accountLabel,
    scopes: params.scopes,
    expiresAt: params.expiresAt,
    tokenType: params.tokenType,
    refreshEligible: params.refreshEligible,
    providerAccountId: params.providerAccountId,
    riskLevel: params.riskLevel,
    status: 'active',
  });
  saveAuthCredentials(id, params.values);
  return profile;
}

export async function ensureAuthProfileReady(
  authProfileId: string,
): Promise<AuthRefreshResult | undefined> {
  const profile = getAuthProfile(authProfileId);
  if (!profile) return undefined;
  return {
    refreshed: false,
    profileId: authProfileId,
    expiresAt: profile.expiresAt,
    accountId: profile.providerAccountId,
    message: 'Auth profile ready',
  };
}

export async function whoamiOpenAI(profileId: string): Promise<{
  ok: boolean;
  detail: string;
}> {
  const creds = getCredentials(profileId);
  const token = creds?.OPENAI_API_KEY || '';
  const baseUrl =
    process.env.OPENAI_COMPAT_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    'http://127.0.0.1:1234/v1';
  try {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers,
    });
    if (!res.ok) {
      return { ok: false, detail: `HTTP ${res.status}` };
    }
    return {
      ok: true,
      detail: 'Local OpenAI-compatible endpoint reachable',
    };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
