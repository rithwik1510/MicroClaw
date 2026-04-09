#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

import {
  getAuthProfileById,
  listAuthProfiles,
  loginWithSecret,
  migrateEnvCredentialsToAuthProfilesIfNeeded,
  removeAuthProfile,
  whoamiOpenAI,
} from '../auth/auth-manager.js';
import { probeOpenAICompatibleCapabilities } from '../auth/auth-health.js';
import { ASSISTANT_NAME, LOG_DIR } from '../config.js';
import { buildContextBundle } from '../context/builder.js';
import {
  compactMemory,
  doctorMemory,
  ensureContextFiles,
  reindexMemoryForGroup,
} from '../context/memory.js';
import { runAgentProcess } from '../execution/backend.js';
import {
  deleteGroupRuntimePolicy,
  deleteLocalEndpointProfile,
  deleteRuntimeProfile,
  getAllLocalEndpointProfiles,
  getAllRegisteredGroups,
  getAllRuntimeProfiles,
  getAllToolServiceProfiles,
  getGroupRuntimePolicy,
  getRuntimeProfile,
  initDatabase,
  logRuntimeEvent,
  setLocalEndpointProfile,
  setProviderCapability,
  setGroupRuntimePolicy,
  setRuntimeProfile,
} from '../db.js';
import { runOnboardWizard } from './wizard/onboard.js';
import { RuntimeProvider, RuntimeToolPolicy } from '../types.js';
import { assertLocalEndpointUrl } from '../runtime/local-endpoint-policy.js';
import { migrateToLocalOnlyIfNeeded } from '../runtime/local-only-migration.js';
import {
  resolveRuntimeExecutionAsync,
  resolveRuntimeSelection,
} from '../runtime/manager.js';
import {
  probeExecutionBackend,
  resolveExecutionBackendForProvider,
} from '../execution/backend.js';
import {
  collectDoctorReport,
  collectLaunchCheckReport,
  collectLaunchCheckReportDeep,
  collectStatusSnapshot,
  printDoctor,
  printLaunchCheck,
  printStatus,
} from './health.js';
import { collectDebugReport, printDebugReport } from './debug.js';
import { runDashboardTui } from './tui/dashboard.js';
import {
  ensureToolServicesReadyOnStartup,
  listToolServices,
  probeToolService,
  setToolServiceEnabled,
} from '../tools/service-supervisor.js';
import {
  discoverSkillManifests,
  validateSkillManifests,
} from '../skills/registry.js';

function usage(): void {
  console.log(`MicroClaw Command Center

Usage:
  microclaw onboard [--resume <session>] [--cancel <session>]
  microclaw init                                # alias of onboard
  microclaw auth <login|list|status|logout|refresh|whoami> [options]
  microclaw models <list|add|remove|enable|disable|tool-policy|policy|set-primary|set-fallback|clear-policy|test-health>
  microclaw local <add|list|probe|remove>
  microclaw status [--json]
  microclaw doctor [--json]
  microclaw launch-check [--json] [--deep]
  microclaw debug [--json] [--quick] [--jid <dc:...>]
  microclaw smoke [--jid <dc:...>] [--prompt <text>] [--json]
  microclaw context <init|show> [--group <folder> | --jid <dc:...>] [--prompt <text>]
  microclaw memory <compact|doctor|reindex> [--group <folder> | --jid <dc:...>] [--json]
  microclaw tools <list|status|probe|enable|disable> [--id <serviceId>] [--json]
  microclaw backend <status|probe> [--provider <openai_compatible|claude>] [--json]
  microclaw skills <list|validate> [--json]
  microclaw logs [--lines N]
  microclaw tui
`);
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = 'true';
      continue;
    }
    flags[key] = next;
    i++;
  }
  return flags;
}

function getFlag(
  flags: Record<string, string>,
  key: string,
  fallback = '',
): string {
  return flags[key] ?? fallback;
}

function requireFlag(flags: Record<string, string>, key: string): string {
  const value = flags[key];
  if (!value) {
    throw new Error(`Missing required flag --${key}`);
  }
  return value;
}

function parseCsvFlag(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized))
    return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseRuntimeToolPolicy(
  flags: Record<string, string>,
): RuntimeToolPolicy | undefined {
  const webEnabled = parseBooleanFlag(getFlag(flags, 'web'));
  const browserEnabled = parseBooleanFlag(getFlag(flags, 'browser'));
  if (webEnabled === undefined && browserEnabled === undefined)
    return undefined;
  return {
    web:
      webEnabled === undefined
        ? undefined
        : {
            enabled: webEnabled,
          },
    browser:
      browserEnabled === undefined
        ? undefined
        : {
            enabled: browserEnabled,
          },
  };
}

function resolveGroupFolderFlag(flags: Record<string, string>): string {
  const direct = getFlag(flags, 'group').trim();
  if (direct) return direct;

  const jid = getFlag(flags, 'jid').trim();
  if (!jid) {
    throw new Error('Missing required flag --group or --jid');
  }
  const groups = getAllRegisteredGroups();
  const group = groups[jid];
  if (!group) throw new Error(`Registered group not found for JID: ${jid}`);
  return group.folder;
}

async function runOnboard(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  await runOnboardWizard({
    resumeSessionId: getFlag(flags, 'resume') || undefined,
    cancelSessionId: getFlag(flags, 'cancel') || undefined,
  });
}

async function runAuth(args: string[]): Promise<void> {
  const sub = args[0] || 'list';
  const flags = parseFlags(args.slice(1));

  if (sub === 'list' || sub === 'status') {
    const profiles = listAuthProfiles();
    if (profiles.length === 0) {
      console.log('No auth profiles configured.');
      return;
    }
    for (const p of profiles) {
      console.log(
        `${p.id} provider=${p.provider} status=${p.status} type=${p.credentialType}${p.expiresAt ? ` expires=${p.expiresAt}` : ''}${p.riskLevel ? ` risk=${p.riskLevel}` : ''}`,
      );
    }
    return;
  }

  if (sub === 'logout') {
    const id = requireFlag(flags, 'id');
    removeAuthProfile(id);
    console.log(`Removed auth profile ${id}`);
    return;
  }

  if (sub === 'refresh') {
    const id = requireFlag(flags, 'id');
    const profile = getAuthProfileById(id);
    if (!profile) throw new Error(`Auth profile not found: ${id}`);
    console.log(
      `Refresh is not required for provider ${profile.provider} in local-only mode.`,
    );
    return;
  }

  if (sub === 'whoami') {
    const id = requireFlag(flags, 'id');
    const profile = getAuthProfileById(id);
    if (!profile) {
      throw new Error(`Auth profile not found: ${id}`);
    }

    if (profile.provider === 'openai_compatible') {
      const who = await whoamiOpenAI(id);
      console.log(
        who.ok
          ? `OpenAI-compatible: ${who.detail}`
          : `OpenAI-compatible check failed: ${who.detail}`,
      );
      return;
    }

    console.log(
      `Profile ${id}: provider=${profile.provider} status=${profile.status}${profile.expiresAt ? ` expires=${profile.expiresAt}` : ''}`,
    );
    return;
  }

  if (sub === 'login') {
    const provider = requireFlag(flags, 'provider');
    if (provider === 'claude') {
      const token = requireFlag(flags, 'token');
      const profile = loginWithSecret({
        provider: 'anthropic_setup_token',
        credentialType: 'setup_token',
        values: { CLAUDE_CODE_OAUTH_TOKEN: token },
      });
      console.log(`Created auth profile ${profile.id}`);
      return;
    }

    if (provider === 'openai_compatible') {
      const apiKey = getFlag(flags, 'api-key');
      const profile = loginWithSecret({
        provider: 'openai_compatible',
        credentialType: apiKey ? 'api_key' : 'none',
        values: apiKey ? { OPENAI_API_KEY: apiKey } : {},
      });
      console.log(`Created auth profile ${profile.id}`);
      return;
    }

    throw new Error(`Unsupported provider: ${provider}`);
  }

  throw new Error(`Unknown auth command: ${sub}`);
}

async function runModels(args: string[]): Promise<void> {
  const sub = args[0] || 'list';
  const flags = parseFlags(args.slice(1));
  if (sub === 'list') {
    const profiles = getAllRuntimeProfiles();
    for (const p of profiles) {
      console.log(
        `${p.id} provider=${p.provider} model=${p.model} enabled=${p.enabled ? '1' : '0'} priority=${p.priority} auth=${p.authProfileId || '-'} endpoint=${p.endpointKind || 'cloud'} web=${p.toolPolicy?.web?.enabled === false ? 'off' : 'on'} browser=${p.toolPolicy?.browser?.enabled === true ? 'on' : 'off'}`,
      );
    }
    if (profiles.length === 0) console.log('No runtime profiles configured.');
    return;
  }

  if (sub === 'add') {
    const provider = requireFlag(flags, 'provider') as RuntimeProvider;
    if (provider !== 'openai_compatible' && provider !== 'claude') {
      throw new Error(
        `Unsupported provider in local-only mode: ${provider}. Use openai_compatible or claude.`,
      );
    }
    const model = requireFlag(flags, 'model');
    const id = getFlag(flags, 'id', `runtime-${Date.now()}`);
    const authProfileId = getFlag(flags, 'auth-profile');
    if (authProfileId && !getAuthProfileById(authProfileId)) {
      throw new Error(`Auth profile not found: ${authProfileId}`);
    }
    const baseUrl = getFlag(flags, 'base-url') || undefined;
    const toolPolicy = parseRuntimeToolPolicy(flags);
    if (provider === 'openai_compatible') {
      if (!baseUrl) {
        throw new Error(
          'openai_compatible runtime requires --base-url (e.g. http://host.docker.internal:1234/v1)',
        );
      }
      assertLocalEndpointUrl(baseUrl);
    }
    setRuntimeProfile({
      id,
      provider,
      model,
      baseUrl,
      enabled: getFlag(flags, 'enabled', 'true') !== 'false',
      priority: Number(getFlag(flags, 'priority', '100')),
      toolPolicy,
      endpointKind:
        (getFlag(flags, 'endpoint-kind') as
          | 'cloud'
          | 'lmstudio'
          | 'ollama'
          | 'custom_openai') || 'cloud',
      authProfileId: authProfileId || undefined,
    });
    console.log(`Added runtime profile ${id}`);
    return;
  }

  if (sub === 'remove') {
    const id = requireFlag(flags, 'id');
    deleteRuntimeProfile(id);
    console.log(`Removed runtime profile ${id}`);
    return;
  }

  if (sub === 'disable' || sub === 'enable') {
    const id = requireFlag(flags, 'id');
    const existing = getAllRuntimeProfiles().find((p) => p.id === id);
    if (!existing) throw new Error(`Runtime profile not found: ${id}`);
    setRuntimeProfile({
      ...existing,
      enabled: sub === 'enable',
      updatedAt: new Date().toISOString(),
    });
    console.log(
      `${sub === 'enable' ? 'Enabled' : 'Disabled'} runtime profile ${id}`,
    );
    return;
  }

  if (sub === 'tool-policy') {
    const id = requireFlag(flags, 'id');
    const existing = getRuntimeProfile(id);
    if (!existing) throw new Error(`Runtime profile not found: ${id}`);

    const parsed = parseRuntimeToolPolicy(flags);
    if (!parsed) {
      console.log(
        `runtime=${existing.id} web=${existing.toolPolicy?.web?.enabled === false ? 'off' : 'on'} browser=${existing.toolPolicy?.browser?.enabled === true ? 'on' : 'off'}`,
      );
      return;
    }

    setRuntimeProfile({
      ...existing,
      toolPolicy: {
        ...existing.toolPolicy,
        ...parsed,
        web: {
          ...existing.toolPolicy?.web,
          ...parsed.web,
        },
      },
      updatedAt: new Date().toISOString(),
    });
    console.log(
      `Updated tool policy for ${id}: web=${parsed.web?.enabled === false ? 'off' : existing.toolPolicy?.web?.enabled === false ? 'off' : 'on'} browser=${parsed.browser?.enabled === true ? 'on' : parsed.browser?.enabled === false ? 'off' : existing.toolPolicy?.browser?.enabled === true ? 'on' : 'off'}`,
    );
    return;
  }

  if (sub === 'policy') {
    const groupFolder = resolveGroupFolderFlag(flags);
    const policy = getGroupRuntimePolicy(groupFolder);
    if (!policy) {
      console.log(`No runtime policy configured for group ${groupFolder}.`);
      return;
    }
    console.log(`group=${policy.groupFolder}`);
    console.log(`primary=${policy.primaryProfileId}`);
    console.log(
      `fallback=${policy.fallbackProfileIds.length > 0 ? policy.fallbackProfileIds.join(',') : '-'}`,
    );
    if (policy.retryPolicy) {
      console.log(
        `retry=maxAttempts:${policy.retryPolicy.maxAttempts},backoffMs:${policy.retryPolicy.backoffMs},timeoutMs:${policy.retryPolicy.timeoutMs}`,
      );
    } else {
      console.log('retry=default');
    }
    console.log(`updatedAt=${policy.updatedAt}`);
    return;
  }

  if (sub === 'set-primary') {
    const groupFolder = resolveGroupFolderFlag(flags);
    const primaryId = requireFlag(flags, 'id');
    const primary = getRuntimeProfile(primaryId);
    if (!primary) throw new Error(`Runtime profile not found: ${primaryId}`);

    const existing = getGroupRuntimePolicy(groupFolder);
    const fallback = (existing?.fallbackProfileIds || []).filter(
      (id) => id !== primaryId,
    );
    const validFallback: string[] = [];
    for (const id of fallback) {
      const profile = getRuntimeProfile(id);
      if (!profile) continue;
      if (profile.provider !== primary.provider) continue;
      validFallback.push(id);
    }

    setGroupRuntimePolicy({
      groupFolder,
      primaryProfileId: primaryId,
      fallbackProfileIds: validFallback,
      retryPolicy: existing?.retryPolicy,
    });
    console.log(
      `Set primary runtime for ${groupFolder} to ${primaryId}${validFallback.length > 0 ? ` (fallback=${validFallback.join(',')})` : ''}`,
    );
    return;
  }

  if (sub === 'set-fallback') {
    const groupFolder = resolveGroupFolderFlag(flags);
    const fallbackIds = parseCsvFlag(requireFlag(flags, 'ids'));
    const existing = getGroupRuntimePolicy(groupFolder);
    if (!existing) {
      throw new Error(
        `No runtime policy configured for group ${groupFolder}. Set primary first (models set-primary).`,
      );
    }
    const primary = getRuntimeProfile(existing.primaryProfileId);
    if (!primary) {
      throw new Error(
        `Primary runtime profile not found: ${existing.primaryProfileId}`,
      );
    }

    const uniqueFallback: string[] = [];
    const seen = new Set<string>();
    for (const id of fallbackIds) {
      if (id === existing.primaryProfileId || seen.has(id)) continue;
      const profile = getRuntimeProfile(id);
      if (!profile) throw new Error(`Runtime profile not found: ${id}`);
      if (profile.provider !== primary.provider) {
        throw new Error(
          `Fallback profile ${id} has provider ${profile.provider}, expected ${primary.provider} to match primary ${existing.primaryProfileId}.`,
        );
      }
      seen.add(id);
      uniqueFallback.push(id);
    }

    setGroupRuntimePolicy({
      groupFolder,
      primaryProfileId: existing.primaryProfileId,
      fallbackProfileIds: uniqueFallback,
      retryPolicy: existing.retryPolicy,
    });
    console.log(
      `Set fallback runtime chain for ${groupFolder}: ${uniqueFallback.length > 0 ? uniqueFallback.join(',') : '(none)'}`,
    );
    return;
  }

  if (sub === 'clear-policy') {
    const groupFolder = resolveGroupFolderFlag(flags);
    deleteGroupRuntimePolicy(groupFolder);
    console.log(`Cleared runtime policy for group ${groupFolder}`);
    return;
  }

  if (sub === 'test-health') {
    const id = requireFlag(flags, 'id');
    const jsonOutput = getFlag(flags, 'json', 'false') === 'true';
    const profile = getRuntimeProfile(id);
    if (!profile) throw new Error(`Runtime profile not found: ${id}`);

    const backend = resolveExecutionBackendForProvider(profile.provider);
    const backendProbe = probeExecutionBackend(backend);
    const resolved = await resolveRuntimeExecutionAsync(profile);

    let endpointProbe:
      | Awaited<ReturnType<typeof probeOpenAICompatibleCapabilities>>
      | undefined;
    if (profile.provider === 'openai_compatible') {
      if (!resolved.runtimeConfig.baseUrl) {
        throw new Error(
          `Runtime profile ${id} has no base URL; cannot probe openai_compatible endpoint.`,
        );
      }
      endpointProbe = await probeOpenAICompatibleCapabilities({
        baseUrl: resolved.runtimeConfig.baseUrl,
        apiKey: resolved.secrets.OPENAI_API_KEY || undefined,
        modelHint: profile.model,
      });
    }

    const payload = {
      id: profile.id,
      provider: profile.provider,
      model: profile.model,
      backend,
      backendOk: backendProbe.ok,
      backendDetail: backendProbe.detail,
      baseUrl: resolved.runtimeConfig.baseUrl || null,
      authRefreshMessage: resolved.authRefreshMessage || null,
      endpointProbe: endpointProbe
        ? {
            healthStatus: endpointProbe.healthStatus,
            supportsResponses: endpointProbe.capability.supportsResponses,
            supportsChatCompletions:
              endpointProbe.capability.supportsChatCompletions,
            supportsStreaming: endpointProbe.capability.supportsStreaming,
          }
        : null,
    };

    if (jsonOutput) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(
      `${backendProbe.ok ? 'PASS' : 'FAIL'} runtime=${profile.id} backend=${backend} detail=${backendProbe.detail}`,
    );
    if (endpointProbe) {
      console.log(
        `endpoint health=${endpointProbe.healthStatus} responses=${endpointProbe.capability.supportsResponses} chat=${endpointProbe.capability.supportsChatCompletions} streaming=${endpointProbe.capability.supportsStreaming}`,
      );
    }
    if (resolved.authRefreshMessage) {
      console.log(`auth: ${resolved.authRefreshMessage}`);
    }
    if (!backendProbe.ok || endpointProbe?.healthStatus === 'unreachable') {
      process.exitCode = 1;
    }
    return;
  }

  throw new Error(`Unknown models command: ${sub}`);
}

async function runLocal(args: string[]): Promise<void> {
  const sub = args[0] || 'list';
  const flags = parseFlags(args.slice(1));
  if (sub === 'list') {
    const rows = getAllLocalEndpointProfiles();
    for (const row of rows) {
      console.log(
        `${row.id} engine=${row.engine} base=${row.baseUrl} container=${row.containerReachableUrl} status=${row.healthStatus}`,
      );
    }
    if (rows.length === 0)
      console.log('No local endpoint profiles configured.');
    return;
  }

  if (sub === 'add' || sub === 'probe') {
    const engine = requireFlag(flags, 'engine') as
      | 'lmstudio'
      | 'ollama'
      | 'custom_openai';
    const baseUrl = requireFlag(flags, 'base-url');
    assertLocalEndpointUrl(baseUrl);
    const apiKey = getFlag(flags, 'api-key');
    const model = getFlag(flags, 'model', 'gpt-4.1-mini');
    const id = getFlag(flags, 'id', `local-${Date.now()}`);

    const probe = await probeOpenAICompatibleCapabilities({
      baseUrl,
      apiKey: apiKey || undefined,
      modelHint: model,
    });

    const containerReachableUrl = getFlag(
      flags,
      'container-url',
      baseUrl
        .replace('127.0.0.1', 'host.docker.internal')
        .replace('localhost', 'host.docker.internal'),
    );
    assertLocalEndpointUrl(containerReachableUrl);

    setLocalEndpointProfile({
      id,
      engine,
      baseUrl,
      apiKeyMode: apiKey ? 'optional' : 'none',
      containerReachableUrl,
      healthStatus: probe.healthStatus as
        | 'healthy'
        | 'degraded'
        | 'unreachable'
        | 'unknown',
      lastCheckedAt: new Date().toISOString(),
    });
    setProviderCapability(
      'openai_compatible',
      containerReachableUrl,
      probe.capability,
    );
    console.log(
      `Saved local endpoint ${id}. responses=${probe.capability.supportsResponses} chat=${probe.capability.supportsChatCompletions} health=${probe.healthStatus}`,
    );
    return;
  }

  if (sub === 'remove') {
    const id = requireFlag(flags, 'id');
    deleteLocalEndpointProfile(id);
    console.log(`Removed local endpoint ${id}`);
    return;
  }

  throw new Error(`Unknown local command: ${sub}`);
}

function readTail(filePath: string, lines: number): string {
  if (!fs.existsSync(filePath)) return '';
  const content = fs.readFileSync(filePath, 'utf8');
  return content.split('\n').slice(-lines).join('\n');
}

async function runStatus(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const jsonOutput = getFlag(flags, 'json', 'false') === 'true';
  const snapshot = collectStatusSnapshot(listAuthProfiles().length);
  if (jsonOutput) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  printStatus(snapshot);
}

async function runDoctor(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const jsonOutput = getFlag(flags, 'json', 'false') === 'true';
  const authProfiles = listAuthProfiles();
  const report = collectDoctorReport({
    hasClaudeAuthProfile: authProfiles.some(
      (p) => p.provider === 'anthropic_setup_token',
    ),
  });
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printDoctor(report);
}

async function runLaunchCheck(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const jsonOutput = getFlag(flags, 'json', 'false') === 'true';
  const deep = getFlag(flags, 'deep', 'false') === 'true';
  const report = deep
    ? await collectLaunchCheckReportDeep()
    : collectLaunchCheckReport();
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printLaunchCheck(report);
  }
  if (!report.pass) {
    process.exitCode = 1;
  }
}

async function runDebug(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const jsonOutput = getFlag(flags, 'json', 'false') === 'true';
  const quick = getFlag(flags, 'quick', 'false') === 'true';
  const jid = getFlag(flags, 'jid') || undefined;
  const report = await collectDebugReport({
    jid,
    skipHeavy: quick,
  });
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printDebugReport(report);
  }
  if (!report.pass) {
    process.exitCode = 1;
  }
}

async function runSmoke(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const jsonOutput = getFlag(flags, 'json', 'false') === 'true';
  const groups = getAllRegisteredGroups();
  const explicitJid = getFlag(flags, 'jid');
  const selectedJid = explicitJid || Object.keys(groups)[0];
  if (!selectedJid) {
    throw new Error('No registered groups found. Run onboard first.');
  }
  const group = groups[selectedJid];
  if (!group) {
    throw new Error(`Registered group not found for JID: ${selectedJid}`);
  }

  const selection = resolveRuntimeSelection(group.folder);
  const profile = selection.profiles[0];
  if (!profile) {
    throw new Error('No runtime profile selected for this group.');
  }

  const resolved = await resolveRuntimeExecutionAsync(profile);
  const prompt = getFlag(flags, 'prompt') || 'Reply with exactly: SMOKE_OK';

  logRuntimeEvent({
    id: `${Date.now()}-smoke-start`,
    groupFolder: group.folder,
    chatJid: selectedJid,
    profileId: profile.id,
    provider: profile.provider,
    eventType: 'attempt',
    message: 'CLI smoke test started',
    timestamp: new Date().toISOString(),
  });

  const output = await runAgentProcess(
    group,
    {
      prompt,
      groupFolder: group.folder,
      chatJid: selectedJid,
      isMain: group.isMain === true,
      singleTurn: true,
      assistantName: ASSISTANT_NAME,
      runtimeProfileId: profile.id,
      runtimeConfig: resolved.runtimeConfig,
      retryPolicy: selection.retryPolicy,
      secrets: resolved.secrets,
    },
    {
      onProcess: () => {
        // no-op; smoke test does not need queue process registration
      },
    },
  );

  if (output.status === 'success') {
    logRuntimeEvent({
      id: `${Date.now()}-smoke-success`,
      groupFolder: group.folder,
      chatJid: selectedJid,
      profileId: profile.id,
      provider: profile.provider,
      eventType: 'success',
      message: 'CLI smoke test succeeded',
      timestamp: new Date().toISOString(),
    });
  } else {
    logRuntimeEvent({
      id: `${Date.now()}-smoke-error`,
      groupFolder: group.folder,
      chatJid: selectedJid,
      profileId: profile.id,
      provider: profile.provider,
      eventType: 'error',
      message: output.error || 'CLI smoke test failed',
      timestamp: new Date().toISOString(),
    });
  }

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          jid: selectedJid,
          groupFolder: group.folder,
          runtimeProfile: profile.id,
          output,
        },
        null,
        2,
      ),
    );
  } else if (output.status === 'success') {
    console.log(`Smoke test success via ${profile.id}`);
    console.log(output.result || '(no result text)');
  } else {
    console.log(`Smoke test failed via ${profile.id}`);
    console.log(output.error || 'Unknown error');
  }

  if (output.status !== 'success') {
    process.exitCode = 1;
  }
}

async function runLogs(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const lines = Number(getFlag(flags, 'lines', '80'));
  const logFile = path.join(LOG_DIR, 'microclaw.log');
  const text = readTail(logFile, lines);
  if (!text) {
    console.log(`No logs at ${logFile}`);
    return;
  }
  console.log(text);
}

async function runContext(args: string[]): Promise<void> {
  const sub = args[0] || 'show';
  const flags = parseFlags(args.slice(1));
  const groupFolder = resolveGroupFolderFlag(flags);

  if (sub === 'init') {
    const created = ensureContextFiles(groupFolder);
    if (created.length === 0) {
      console.log(`Context files already present for ${groupFolder}.`);
      return;
    }
    console.log(`Created ${created.length} context file(s):`);
    for (const filePath of created) {
      console.log(filePath);
    }
    return;
  }

  if (sub === 'show') {
    const prompt =
      getFlag(flags, 'prompt') ||
      'Help me with the active project and stay aligned with my preferences.';
    const bundle = buildContextBundle({
      groupFolder,
      prompt,
    });
    console.log(`group=${groupFolder}`);
    console.log(`prompt=${bundle.diagnostics.promptPreview || '(empty)'}`);
    console.log(
      `keywords=${bundle.diagnostics.strongKeywords.join(', ') || '-'}`,
    );
    console.log(
      `final_chars=${bundle.diagnostics.finalChars} estimated_tokens=${bundle.diagnostics.estimatedFinalTokens} reserved_tool_chars=${bundle.diagnostics.reservedToolChars}`,
    );
    for (const layer of bundle.diagnostics.layers) {
      console.log(
        `${layer.included ? '[IN]' : '[--]'} ${layer.label} kind=${layer.kind} raw=${layer.rawChars} trimmed=${layer.trimmedChars} reason=${layer.inclusionReason} path=${layer.filePath}`,
      );
    }
    if (bundle.diagnostics.warnings.length > 0) {
      console.log('warnings=' + bundle.diagnostics.warnings.join(' | '));
    }
    console.log('\n--- SYSTEM PROMPT ---\n');
    console.log(bundle.systemPrompt || '(empty)');
    return;
  }

  throw new Error(`Unknown context command: ${sub}`);
}

async function runMemory(args: string[]): Promise<void> {
  const sub = args[0] || 'doctor';
  const flags = parseFlags(args.slice(1));
  const groupFolder = resolveGroupFolderFlag(flags);
  const jsonOutput = getFlag(flags, 'json', 'false') === 'true';

  if (sub === 'compact') {
    const result = compactMemory(groupFolder);
    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `Compacted memory for ${groupFolder}: promoted=${result.promotedCount} path=${result.memoryPath}`,
    );
    return;
  }

  if (sub === 'doctor') {
    const report = doctorMemory(groupFolder);
    if (jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (report.issues.length === 0) {
      console.log(`Memory doctor: no issues for ${groupFolder}`);
      return;
    }
    console.log(`Memory doctor for ${groupFolder}:`);
    for (const issue of report.issues) {
      console.log(`[${issue.severity}] ${issue.message}`);
    }
    return;
  }

  if (sub === 'reindex') {
    const count = reindexMemoryForGroup(groupFolder);
    if (jsonOutput) {
      console.log(JSON.stringify({ groupFolder, reindexed: count }, null, 2));
      return;
    }
    console.log(
      `Re-indexed memory for ${groupFolder}: ${count} entries indexed`,
    );
    return;
  }

  throw new Error(`Unknown memory command: ${sub}`);
}

async function runTools(args: string[]): Promise<void> {
  const sub = args[0] || 'status';
  const flags = parseFlags(args.slice(1));
  const jsonOutput = getFlag(flags, 'json', 'false') === 'true';

  if (sub === 'list') {
    const profiles = getAllToolServiceProfiles();
    if (jsonOutput) {
      console.log(JSON.stringify(profiles, null, 2));
      return;
    }
    if (profiles.length === 0) {
      console.log('No tool services configured.');
      return;
    }
    for (const p of profiles) {
      console.log(
        `${p.id} kind=${p.kind} enabled=${p.enabled ? '1' : '0'} startup=${p.startupMode} base=${p.baseUrl || '-'}`,
      );
    }
    return;
  }

  if (sub === 'status') {
    const services = listToolServices();
    if (jsonOutput) {
      console.log(JSON.stringify(services, null, 2));
      return;
    }
    if (services.length === 0) {
      console.log('No tool services configured.');
      return;
    }
    for (const s of services) {
      console.log(
        `${s.profile.id} ${s.profile.kind} enabled=${s.profile.enabled ? '1' : '0'} status=${s.state?.status || 'unknown'} detail=${s.state?.lastProbeDetail || '-'}`,
      );
    }
    return;
  }

  if (sub === 'probe') {
    const id = getFlag(flags, 'id');
    if (id) {
      const probe = await probeToolService(id);
      if (jsonOutput) {
        console.log(JSON.stringify({ id, ...probe }, null, 2));
      } else {
        console.log(
          probe.ok
            ? `Tool probe PASS (${id}): ${probe.detail}`
            : `Tool probe FAIL (${id}): ${probe.detail}`,
        );
      }
      if (!probe.ok) process.exitCode = 1;
      return;
    }
    const startup = await ensureToolServicesReadyOnStartup();
    if (jsonOutput) {
      console.log(JSON.stringify(startup, null, 2));
    } else {
      console.log(
        startup.ok
          ? `Tools healthy: ${startup.detail}`
          : `Tools degraded: ${startup.detail}`,
      );
      if (startup.failed.length > 0) {
        for (const fail of startup.failed) console.log(`- ${fail}`);
      }
    }
    if (!startup.ok) process.exitCode = 1;
    return;
  }

  if (sub === 'enable' || sub === 'disable') {
    const id = requireFlag(flags, 'id');
    setToolServiceEnabled(id, sub === 'enable');
    console.log(
      `${sub === 'enable' ? 'Enabled' : 'Disabled'} tool service ${id}`,
    );
    return;
  }

  throw new Error(`Unknown tools command: ${sub}`);
}

async function runBackend(args: string[]): Promise<void> {
  const sub = args[0] || 'status';
  const flags = parseFlags(args.slice(1));
  const jsonOutput = getFlag(flags, 'json', 'false') === 'true';
  const provider =
    (getFlag(flags, 'provider') as RuntimeProvider) || 'openai_compatible';

  if (provider !== 'openai_compatible' && provider !== 'claude') {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  const backend = resolveExecutionBackendForProvider(provider);
  if (sub === 'status' || sub === 'probe') {
    const probe = probeExecutionBackend(backend);
    const payload = {
      provider,
      backend,
      ok: probe.ok,
      detail: probe.detail,
    };
    if (jsonOutput) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(
      `${probe.ok ? 'PASS' : 'FAIL'} provider=${provider} backend=${backend} detail=${probe.detail}`,
    );
    if (!probe.ok) process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown backend command: ${sub}`);
}

async function runSkills(args: string[]): Promise<void> {
  const sub = args[0] || 'list';
  const flags = parseFlags(args.slice(1));
  const jsonOutput = getFlag(flags, 'json', 'false') === 'true';

  if (sub === 'list') {
    const items = discoverSkillManifests();
    if (jsonOutput) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }
    if (items.length === 0) {
      console.log('No skill manifests discovered.');
      return;
    }
    for (const item of items) {
      console.log(
        `${item.id} ok=${item.ok ? '1' : '0'} path=${item.path}${item.error ? ` error=${item.error}` : ''}`,
      );
    }
    return;
  }

  if (sub === 'validate') {
    const report = validateSkillManifests();
    if (jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(
        report.ok ? 'Skill manifests: valid' : 'Skill manifests: invalid',
      );
      for (const item of report.items) {
        console.log(
          `${item.ok ? '[OK]' : '[FAIL]'} ${item.id}${item.error ? ` - ${item.error}` : ''}`,
        );
      }
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown skills command: ${sub}`);
}

async function runTui(): Promise<void> {
  const launchReport = collectLaunchCheckReport();
  const blockingSetupIssues = launchReport.failedKeys.filter(
    (key) => key !== 'recent_discord_roundtrip',
  );
  if (blockingSetupIssues.length > 0) {
    console.log(
      'Setup is incomplete. Starting guided onboarding before TUI...\n',
    );
    await runOnboard([]);
  }
  await runDashboardTui();
}

async function main(): Promise<void> {
  initDatabase();
  migrateToLocalOnlyIfNeeded();
  migrateEnvCredentialsToAuthProfilesIfNeeded();
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    usage();
    return;
  }

  if (command === 'onboard') return runOnboard(rest);
  if (command === 'init') return runOnboard(rest);
  if (command === 'auth') return runAuth(rest);
  if (command === 'models') return runModels(rest);
  if (command === 'local') return runLocal(rest);
  if (command === 'status') return runStatus(rest);
  if (command === 'doctor') return runDoctor(rest);
  if (command === 'launch-check') return runLaunchCheck(rest);
  if (command === 'debug') return runDebug(rest);
  if (command === 'smoke') return runSmoke(rest);
  if (command === 'context') return runContext(rest);
  if (command === 'memory') return runMemory(rest);
  if (command === 'tools') return runTools(rest);
  if (command === 'backend') return runBackend(rest);
  if (command === 'skills') return runSkills(rest);
  if (command === 'logs') return runLogs(rest);
  if (command === 'tui') return runTui();

  usage();
  throw new Error(`Unknown command: ${command}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
