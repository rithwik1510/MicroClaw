import fs from 'fs';
import path from 'path';

import {
  deleteAuthProfile,
  deleteGroupRuntimePolicy,
  deleteLocalEndpointProfile,
  deleteProviderCapabilitiesByProviders,
  deleteProviderCapability,
  deleteRuntimeProfile,
  getAllAuthProfiles,
  getAllGroupRuntimePolicies,
  getAllLocalEndpointProfiles,
  getAllProviderCapabilities,
  getAllRuntimeProfiles,
  getRouterState,
  setGroupRuntimePolicy,
  setRouterState,
  setRuntimeProfile,
} from '../db.js';
import { STORE_DIR } from '../config.js';
import { deleteCredentials } from '../auth/vault.js';
import { validateLocalEndpointUrl } from './local-endpoint-policy.js';

const MIGRATION_KEY = 'local_only_migration_v1_done';

const LEGACY_AUTH_PROVIDERS = new Set([
  'openai_codex_oauth',
  'openai_api_key',
  'gemini_api_key',
  'gemini_oauth',
  'gemini_oauth_desktop',
  'gemini_cli_oauth_import',
]);

function isLegacyRuntimeProvider(provider: string): boolean {
  return provider === 'openai' || provider === 'gemini';
}

function ensureBackupDir(): string {
  const dir = path.join(STORE_DIR, 'migrations');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function migrateToLocalOnlyIfNeeded(): void {
  if (getRouterState(MIGRATION_KEY) === '1') return;

  const runtimeProfiles = getAllRuntimeProfiles();
  const authProfiles = getAllAuthProfiles();
  const localProfiles = getAllLocalEndpointProfiles();
  const policies = getAllGroupRuntimePolicies();
  const capabilities = getAllProviderCapabilities();

  const backup = {
    createdAt: new Date().toISOString(),
    runtimeProfiles,
    authProfiles,
    localProfiles,
    policies,
    capabilities,
  };

  const backupPath = path.join(
    ensureBackupDir(),
    `local-only-backup-${Date.now()}.json`,
  );
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), 'utf8');

  const runtimeIdsToDelete = runtimeProfiles
    .filter((p) => {
      if (isLegacyRuntimeProvider(p.provider)) return true;
      if (p.provider === 'openai_compatible' && p.baseUrl) {
        return !validateLocalEndpointUrl(p.baseUrl).ok;
      }
      return false;
    })
    .map((p) => p.id);
  for (const id of runtimeIdsToDelete) deleteRuntimeProfile(id);

  const authIdsToDelete = authProfiles
    .filter((p) => LEGACY_AUTH_PROVIDERS.has(p.provider))
    .map((p) => p.id);
  for (const id of authIdsToDelete) {
    deleteAuthProfile(id);
    deleteCredentials(id);
  }

  for (const lp of localProfiles) {
    const base = validateLocalEndpointUrl(lp.baseUrl);
    const container = validateLocalEndpointUrl(lp.containerReachableUrl);
    if (!base.ok || !container.ok) {
      deleteLocalEndpointProfile(lp.id);
    }
  }

  deleteProviderCapabilitiesByProviders(['openai', 'gemini']);
  for (const cap of capabilities) {
    if (cap.provider !== 'openai_compatible') continue;
    if (!cap.baseUrl) {
      deleteProviderCapability(cap.provider, cap.baseUrl);
      continue;
    }
    if (!validateLocalEndpointUrl(cap.baseUrl).ok) {
      deleteProviderCapability(cap.provider, cap.baseUrl);
    }
  }

  const existingRuntime = new Map(
    getAllRuntimeProfiles().map((p) => [p.id, p] as const),
  );
  for (const policy of getAllGroupRuntimePolicies()) {
    const primary = existingRuntime.get(policy.primaryProfileId);
    const fallbacks = policy.fallbackProfileIds.filter((id) =>
      existingRuntime.has(id),
    );

    if (!primary) {
      if (fallbacks.length === 0) {
        deleteGroupRuntimePolicy(policy.groupFolder);
        continue;
      }
      const newPrimary = existingRuntime.get(fallbacks[0]);
      if (!newPrimary) {
        deleteGroupRuntimePolicy(policy.groupFolder);
        continue;
      }
      const sameProviderFallbacks = fallbacks
        .slice(1)
        .filter(
          (id) => existingRuntime.get(id)?.provider === newPrimary.provider,
        );
      setGroupRuntimePolicy({
        groupFolder: policy.groupFolder,
        primaryProfileId: newPrimary.id,
        fallbackProfileIds: sameProviderFallbacks,
        retryPolicy: policy.retryPolicy,
      });
      continue;
    }

    const constrainedFallbacks = fallbacks.filter(
      (id) => existingRuntime.get(id)?.provider === primary.provider,
    );
    if (constrainedFallbacks.length !== policy.fallbackProfileIds.length) {
      // Rewrite policy to prevent cross-provider fallback.
      setGroupRuntimePolicy({
        groupFolder: policy.groupFolder,
        primaryProfileId: primary.id,
        fallbackProfileIds: constrainedFallbacks,
        retryPolicy: policy.retryPolicy,
      });
    }
  }

  const remainingRuntime = getAllRuntimeProfiles();
  if (remainingRuntime.length === 0) {
    const remainingLocal = getAllLocalEndpointProfiles()[0];
    if (remainingLocal) {
      setRuntimeProfile({
        id: `runtime-local-${Date.now()}`,
        provider: 'openai_compatible',
        model: 'gpt-4.1-mini',
        baseUrl: remainingLocal.containerReachableUrl,
        endpointKind: remainingLocal.engine,
        enabled: true,
        priority: 0,
      });
    }
  }

  setRouterState(MIGRATION_KEY, '1');
  setRouterState(`${MIGRATION_KEY}_backup`, backupPath);
}
