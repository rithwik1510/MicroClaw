import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

import { loginWithSecret } from '../../auth/auth-manager.js';
import { probeOpenAICompatibleCapabilities } from '../../auth/auth-health.js';
import {
  getAllAuthProfiles,
  getAllRegisteredGroups,
  getAllRuntimeProfiles,
  getLatestActiveWizardSession,
  setRegisteredGroup,
  setProviderCapability,
  getWizardSession,
  setLocalEndpointProfile,
  setRuntimeProfile,
  setWizardSession,
} from '../../db.js';
import { readEnvFile } from '../../env.js';
import {
  ProviderCapability,
  RuntimeProvider,
  WizardStepId,
} from '../../types.js';
import { ASSISTANT_NAME } from '../../config.js';
import { assertLocalEndpointUrl } from '../../runtime/local-endpoint-policy.js';
import { collectLaunchCheckReportDeep } from '../health.js';

interface OnboardState {
  configDecision?: 'keep' | 'modify' | 'reset';
  provider?: RuntimeProvider;
  authMethod?: string;
  authProfileId?: string;
  model?: string;
  channel?: 'whatsapp' | 'telegram' | 'discord' | 'slack' | 'none';
  channelAuthComplete?: boolean;
  runtimeProfileId?: string;
  localBaseUrl?: string;
  localContainerUrl?: string;
  localHealthStatus?: 'healthy' | 'degraded' | 'unreachable' | 'unknown';
  localCapability?: ProviderCapability;
  discordTokenConfigured?: boolean;
  discordChannelId?: string;
  discordChannelName?: string;
  webToolEnabled?: boolean;
}

interface OnboardOptions {
  resumeSessionId?: string;
  cancelSessionId?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeSessionId(): string {
  return `wiz-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultModel(provider: RuntimeProvider): string {
  switch (provider) {
    case 'claude':
      return 'claude-sonnet-4-5';
    case 'openai_compatible':
      return 'gpt-4.1-mini';
    default:
      return 'gpt-4.1-mini';
  }
}

interface OpenAIChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
}

function normalizeOpenAIBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, '');
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (
          part &&
          typeof part === 'object' &&
          'text' in part &&
          typeof (part as { text?: unknown }).text === 'string'
        ) {
          return (part as { text: string }).text;
        }
        return '';
      })
      .filter(Boolean);
    return parts.join('\n').trim();
  }
  return '';
}

async function verifyModelKnowledge(input: {
  baseUrl: string;
  model: string;
  apiKey?: string;
}): Promise<{ ok: boolean; detail: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (input.apiKey) {
    headers.Authorization = `Bearer ${input.apiKey}`;
  }
  try {
    const res = await fetch(
      `${normalizeOpenAIBaseUrl(input.baseUrl)}/chat/completions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: input.model,
          messages: [
            {
              role: 'user',
              content: 'One-word answer only: What is the capital of France?',
            },
          ],
          temperature: 0,
        }),
      },
    );
    const bodyText = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        detail: `HTTP ${res.status}: ${bodyText.slice(0, 180)}`,
      };
    }
    const parsed = JSON.parse(bodyText) as OpenAIChatCompletionResponse;
    const content = extractContentText(parsed.choices?.[0]?.message?.content);
    const ok = /paris/i.test(content);
    return {
      ok,
      detail: ok
        ? `knowledge_check=${content}`
        : `knowledge_check_failed=${content || '(empty)'}`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function parseBool(value: string, fallback = false): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return fallback;
  return v === 'y' || v === 'yes' || v === 'true' || v === '1';
}

function isChannelConfigured(channel: NonNullable<OnboardState['channel']>): {
  ok: boolean;
  detail: string;
} {
  if (channel === 'none') return { ok: true, detail: 'No channel selected' };

  const env = readEnvFile([
    'DISCORD_BOT_TOKEN',
    'TELEGRAM_BOT_TOKEN',
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
  ]);

  if (channel === 'discord') {
    const ok = !!(process.env.DISCORD_BOT_TOKEN || env.DISCORD_BOT_TOKEN);
    return {
      ok,
      detail: ok ? 'DISCORD_BOT_TOKEN detected' : 'Missing DISCORD_BOT_TOKEN',
    };
  }
  if (channel === 'telegram') {
    const ok = !!(process.env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN);
    return {
      ok,
      detail: ok ? 'TELEGRAM_BOT_TOKEN detected' : 'Missing TELEGRAM_BOT_TOKEN',
    };
  }
  if (channel === 'slack') {
    const bot = process.env.SLACK_BOT_TOKEN || env.SLACK_BOT_TOKEN;
    const app = process.env.SLACK_APP_TOKEN || env.SLACK_APP_TOKEN;
    const ok = !!(bot && app);
    return {
      ok,
      detail: ok
        ? 'SLACK_BOT_TOKEN and SLACK_APP_TOKEN detected'
        : 'Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN',
    };
  }
  if (channel === 'whatsapp') {
    const authFile = path.join(process.cwd(), 'store', 'auth', 'creds.json');
    const ok = fs.existsSync(authFile);
    return {
      ok,
      detail: ok
        ? 'WhatsApp auth creds file detected'
        : `Missing WhatsApp auth creds file at ${authFile}`,
    };
  }

  return { ok: false, detail: `Unknown channel type: ${channel}` };
}

function getRegisteredGroupCountForChannel(
  channel: NonNullable<OnboardState['channel']>,
): number {
  const groups = Object.entries(getAllRegisteredGroups());
  if (channel === 'none') return 0;
  const prefix =
    channel === 'discord'
      ? 'dc:'
      : channel === 'telegram'
        ? 'tg:'
        : channel === 'slack'
          ? 'sl:'
          : channel === 'whatsapp'
            ? 'wa:'
            : '';
  if (!prefix) return 0;
  return groups.filter(([jid]) => jid.startsWith(prefix)).length;
}

function upsertEnvVar(key: string, value: string): void {
  const envPath = path.join(process.cwd(), '.env');
  const safeValue = value.replace(/\r?\n/g, '').trim();
  if (!safeValue) return;

  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, `${key}=${safeValue}\n`, 'utf8');
    return;
  }

  const content = fs.readFileSync(envPath, 'utf8');
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  const next = pattern.test(content)
    ? content.replace(pattern, `${key}=${safeValue}`)
    : `${content.trimEnd()}\n${key}=${safeValue}\n`;
  fs.writeFileSync(envPath, next, 'utf8');
}

function ensurePlaywrightChromiumInstalled(): { ok: boolean; detail: string } {
  const res = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    [
      '--prefix',
      'container/agent-runner',
      'exec',
      'playwright',
      'install',
      'chromium',
    ],
    {
      cwd: process.cwd(),
      stdio: 'pipe',
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  if (res.status === 0) {
    return { ok: true, detail: 'Playwright Chromium is installed.' };
  }
  const stderr = (res.stderr || '').trim();
  const stdout = (res.stdout || '').trim();
  const detail = (stderr || stdout || `exit code ${res.status || 1}`).slice(
    0,
    260,
  );
  return {
    ok: false,
    detail:
      `Failed to install Playwright Chromium (${detail}). ` +
      'Run: npm --prefix container/agent-runner exec playwright install chromium',
  };
}

async function askChoice(
  rl: readline.Interface,
  prompt: string,
  options: string[],
  currentValue?: string,
): Promise<string> {
  while (true) {
    console.log(prompt);
    for (let i = 0; i < options.length; i++) {
      const isCurrent = currentValue && currentValue === options[i];
      console.log(`  ${i + 1}. ${options[i]}${isCurrent ? ' (current)' : ''}`);
    }
    const answer = (
      await rl.question('Select by number or value (required): ')
    ).trim();

    if (!answer) {
      if (currentValue && options.includes(currentValue)) {
        return currentValue;
      }
      console.log('Selection required. Please choose one option.');
      continue;
    }

    const maybeIndex = Number(answer);
    if (
      Number.isInteger(maybeIndex) &&
      maybeIndex >= 1 &&
      maybeIndex <= options.length
    ) {
      return options[maybeIndex - 1];
    }

    if (options.includes(answer)) {
      return answer;
    }

    console.log(
      `Invalid choice: ${answer}. Expected one of ${options.join(', ')}`,
    );
  }
}

async function askYesNo(
  rl: readline.Interface,
  prompt: string,
  currentValue?: boolean,
): Promise<boolean> {
  while (true) {
    const suffix =
      currentValue === undefined
        ? ''
        : ` (current: ${currentValue ? 'yes' : 'no'})`;
    const answer = (await rl.question(`${prompt}${suffix} [yes/no]: `))
      .trim()
      .toLowerCase();

    if (!answer) {
      if (currentValue !== undefined) return currentValue;
      console.log('Selection required. Type yes or no.');
      continue;
    }
    if (['y', 'yes', 'true', '1'].includes(answer)) return true;
    if (['n', 'no', 'false', '0'].includes(answer)) return false;
    console.log('Please answer yes or no.');
  }
}

function saveSession(
  sessionId: string,
  step: WizardStepId,
  state: OnboardState,
  status: 'active' | 'completed' | 'cancelled' | 'failed' = 'active',
): void {
  setWizardSession({
    sessionId,
    currentStep: step,
    stateJson: state as Record<string, unknown>,
    status,
  });
}

function printReview(sessionId: string, state: OnboardState): void {
  const redacted = {
    ...state,
    authProfileId: state.authProfileId || '(none)',
  };
  console.log('\nReview');
  console.log(`Session: ${sessionId}`);
  console.log(JSON.stringify(redacted, null, 2));
}

async function runAuthFlow(
  rl: readline.Interface,
  state: OnboardState,
): Promise<OnboardState> {
  if (!state.provider) {
    throw new Error('Provider must be selected before auth flow');
  }

  if (state.provider === 'claude') {
    const token = (await rl.question('Paste Claude setup token: ')).trim();
    const profile = loginWithSecret({
      provider: 'anthropic_setup_token',
      credentialType: 'setup_token',
      accountLabel: 'onboard-claude',
      values: { CLAUDE_CODE_OAUTH_TOKEN: token },
    });
    return { ...state, authProfileId: profile.id };
  }

  const baseUrl = (
    await rl.question(
      'Local OpenAI-compatible base URL (e.g. http://127.0.0.1:1234/v1): ',
    )
  ).trim();
  assertLocalEndpointUrl(baseUrl);
  const apiKey = (
    await rl.question(
      'Optional local endpoint API key (press Enter for none): ',
    )
  ).trim();

  const profile = loginWithSecret({
    provider: 'openai_compatible',
    credentialType: apiKey ? 'api_key' : 'none',
    accountLabel: 'onboard-local-openai-compatible',
    values: apiKey ? { OPENAI_API_KEY: apiKey } : {},
  });

  const containerUrl = baseUrl
    .replace(/127\.0\.0\.1/g, 'host.docker.internal')
    .replace(/localhost/g, 'host.docker.internal');
  assertLocalEndpointUrl(containerUrl);

  const modelHint = state.model || defaultModel('openai_compatible');
  const hostProbe = await probeOpenAICompatibleCapabilities({
    baseUrl,
    apiKey: apiKey || undefined,
    modelHint,
  });
  if (hostProbe.healthStatus !== 'healthy') {
    throw new Error(
      `Local endpoint probe failed on host URL (${baseUrl}). Health: ${hostProbe.healthStatus}`,
    );
  }

  const containerProbe = await probeOpenAICompatibleCapabilities({
    baseUrl: containerUrl,
    apiKey: apiKey || undefined,
    modelHint,
  });
  if (containerProbe.healthStatus !== 'healthy') {
    throw new Error(
      `Local endpoint probe failed on container URL (${containerUrl}). Health: ${containerProbe.healthStatus}`,
    );
  }

  const knowledge = await verifyModelKnowledge({
    baseUrl,
    model: modelHint,
    apiKey: apiKey || undefined,
  });
  if (!knowledge.ok) {
    throw new Error(
      `Model knowledge check failed on host URL (${baseUrl}): ${knowledge.detail}`,
    );
  }

  return {
    ...state,
    authProfileId: profile.id,
    localBaseUrl: baseUrl,
    localContainerUrl: containerUrl,
    localHealthStatus: containerProbe.healthStatus as
      | 'healthy'
      | 'degraded'
      | 'unreachable'
      | 'unknown',
    localCapability: containerProbe.capability,
  };
}

export async function runOnboardWizard(
  options: OnboardOptions = {},
): Promise<void> {
  const steps: WizardStepId[] = [
    'welcome',
    'config_detect',
    'model_provider',
    'auth_method',
    'auth_flow',
    'model_choice',
    'channel_choice',
    'channel_auth',
    'web_tool_setup',
    'review',
    'apply',
    'health',
  ];

  if (options.cancelSessionId) {
    const existing = getWizardSession(options.cancelSessionId);
    if (!existing) {
      throw new Error(`Wizard session not found: ${options.cancelSessionId}`);
    }
    saveSession(
      existing.sessionId,
      existing.currentStep,
      existing.stateJson as OnboardState,
      'cancelled',
    );
    console.log(`Cancelled wizard session ${existing.sessionId}`);
    return;
  }

  let sessionId = options.resumeSessionId;
  let state: OnboardState = {};
  let step: WizardStepId = 'welcome';

  if (sessionId) {
    const session = getWizardSession(sessionId);
    if (!session) {
      throw new Error(`Wizard session not found: ${sessionId}`);
    }
    sessionId = session.sessionId;
    step = session.currentStep;
    state = session.stateJson as OnboardState;
  } else {
    const latest = getLatestActiveWizardSession();
    if (latest) {
      sessionId = latest.sessionId;
      step = latest.currentStep;
      state = latest.stateJson as OnboardState;
      console.log(
        `Resuming active wizard session ${sessionId} at step ${step}`,
      );
    } else {
      sessionId = makeSessionId();
      saveSession(sessionId, 'welcome', {}, 'active');
    }
  }

  const rl = readline.createInterface({ input, output });

  try {
    let index = Math.max(0, steps.indexOf(step));

    while (index < steps.length) {
      step = steps[index];
      saveSession(sessionId!, step, state, 'active');

      switch (step) {
        case 'welcome': {
          console.log('MicroClaw onboard wizard');
          console.log(
            'Flow: Home -> Model/Auth -> Channels -> Review -> Apply',
          );
          index++;
          break;
        }

        case 'config_detect': {
          const runtimeCount = getAllRuntimeProfiles().length;
          const authCount = getAllAuthProfiles().length;
          console.log(`Detected runtime profiles: ${runtimeCount}`);
          console.log(`Detected auth profiles: ${authCount}`);

          const decision = (await askChoice(
            rl,
            'Config action',
            ['keep', 'modify', 'reset'],
            state.configDecision,
          )) as OnboardState['configDecision'];

          state = { ...state, configDecision: decision };
          index++;
          break;
        }

        case 'model_provider': {
          if (
            state.configDecision === 'keep' &&
            getAllRuntimeProfiles().length > 0
          ) {
            index = steps.indexOf('channel_choice');
            break;
          }

          const provider = (await askChoice(
            rl,
            'Model provider',
            ['openai_compatible', 'claude'],
            state.provider,
          )) as RuntimeProvider;
          state = { ...state, provider };
          index++;
          break;
        }

        case 'auth_method': {
          const provider = state.provider || 'openai_compatible';
          let choices = ['setup_token'];
          let fallback = 'setup_token';

          if (provider === 'openai_compatible') {
            choices = ['local'];
            fallback = 'local';
          }

          const authMethod = await askChoice(
            rl,
            'Auth method',
            choices,
            state.authMethod || fallback,
          );

          state = { ...state, authMethod };
          index++;
          break;
        }

        case 'auth_flow': {
          if (
            state.configDecision === 'keep' &&
            getAllAuthProfiles().length > 0
          ) {
            index++;
            break;
          }
          state = await runAuthFlow(rl, state);
          console.log(`Auth profile created: ${state.authProfileId}`);
          index++;
          break;
        }

        case 'model_choice': {
          const provider = state.provider || 'openai_compatible';
          const model = (
            await rl.question(
              `Default model for ${provider} [${state.model || defaultModel(provider)}]: `,
            )
          ).trim();
          state = {
            ...state,
            model: model || state.model || defaultModel(provider),
          };
          index++;
          break;
        }

        case 'channel_choice': {
          const channel = (await askChoice(
            rl,
            'Primary channel',
            ['whatsapp', 'telegram', 'discord', 'slack', 'none'],
            state.channel,
          )) as OnboardState['channel'];
          state = { ...state, channel };
          index++;
          break;
        }

        case 'channel_auth': {
          if (state.channel === 'none') {
            state = { ...state, channelAuthComplete: true };
            index++;
            break;
          }
          if (!state.channel) {
            throw new Error(
              'Channel selection missing before channel auth step.',
            );
          }

          console.log(
            `Channel selected: ${state.channel}. Complete channel setup in existing setup flow if not already configured.`,
          );
          const channelCheck = isChannelConfigured(state.channel);
          const registeredCount = getRegisteredGroupCountForChannel(
            state.channel,
          );
          console.log(`Channel check: ${channelCheck.detail}`);
          console.log(
            `Registered ${state.channel} groups/channels: ${registeredCount}`,
          );

          if (state.channel === 'discord' && !channelCheck.ok) {
            const token = (
              await rl.question(
                'Paste DISCORD_BOT_TOKEN now (or leave empty to configure later): ',
              )
            ).trim();
            if (token) {
              upsertEnvVar('DISCORD_BOT_TOKEN', token);
              state = { ...state, discordTokenConfigured: true };
              console.log('Saved DISCORD_BOT_TOKEN to .env');
            }
          }

          if (state.channel === 'discord') {
            const channelId = (
              await rl.question(
                'Discord channel ID to register now (optional, digits only): ',
              )
            ).trim();
            if (channelId) {
              const isDigits = /^\d+$/.test(channelId);
              if (!isDigits) {
                throw new Error(
                  'Discord channel ID must contain digits only (no dc: prefix).',
                );
              }
              const channelName = (
                await rl.question(
                  'Friendly channel name (optional, e.g. My Server #general): ',
                )
              ).trim();
              state = {
                ...state,
                discordChannelId: channelId,
                discordChannelName: channelName || `Discord ${channelId}`,
              };
            }
          }

          const done = await askYesNo(
            rl,
            'Is channel auth already completed?',
            state.channelAuthComplete ?? channelCheck.ok,
          );
          state = { ...state, channelAuthComplete: done };
          index++;
          break;
        }

        case 'web_tool_setup': {
          upsertEnvVar('WEB_TOOL_PRIMARY', 'playwright');
          upsertEnvVar('WEB_TOOL_FALLBACK', 'none');
          upsertEnvVar('WEB_TOOL_MAX_STEPS', '4');
          upsertEnvVar('WEB_TOOL_MAX_SEARCH_CALLS', '1');
          upsertEnvVar('WEB_TOOL_SEARCH_TIMEOUT_MS', '4000');
          upsertEnvVar('WEB_TOOL_PAGE_FETCH_TIMEOUT_MS', '5000');
          upsertEnvVar('WEB_TOOL_TOTAL_BUDGET_MS', '15000');
          upsertEnvVar(
            'WEB_RESTRICTED_DOMAINS',
            'linkedin.com,www.linkedin.com,m.linkedin.com',
          );

          const install = ensurePlaywrightChromiumInstalled();
          if (!install.ok) {
            throw new Error(install.detail);
          }
          console.log(install.detail);
          state = { ...state, webToolEnabled: true };
          index++;
          break;
        }

        case 'review': {
          printReview(sessionId!, state);
          const apply = await askYesNo(rl, 'Apply this configuration now?');
          if (!apply) {
            saveSession(sessionId!, 'review', state, 'cancelled');
            console.log(`Wizard session ${sessionId} cancelled at review.`);
            return;
          }
          index++;
          break;
        }

        case 'apply': {
          if (
            !(
              state.configDecision === 'keep' &&
              getAllRuntimeProfiles().length > 0
            )
          ) {
            const provider = state.provider || 'openai_compatible';
            const runtimeId = `runtime-${Date.now()}`;
            state = { ...state, runtimeProfileId: runtimeId };

            if (
              provider === 'openai_compatible' &&
              state.localBaseUrl &&
              state.localContainerUrl
            ) {
              const localId = `local-${Date.now()}`;
              setLocalEndpointProfile({
                id: localId,
                engine: 'custom_openai',
                baseUrl: state.localBaseUrl,
                apiKeyMode: state.authMethod === 'local' ? 'optional' : 'none',
                containerReachableUrl: state.localContainerUrl,
                healthStatus: state.localHealthStatus || 'unknown',
              });
              if (state.localCapability) {
                setProviderCapability(
                  'openai_compatible',
                  state.localContainerUrl,
                  state.localCapability,
                );
              }
            }

            setRuntimeProfile({
              id: runtimeId,
              provider,
              model: state.model || defaultModel(provider),
              enabled: true,
              priority: 0,
              authProfileId: state.authProfileId,
              endpointKind:
                provider === 'openai_compatible' ? 'custom_openai' : 'cloud',
              baseUrl:
                provider === 'openai_compatible'
                  ? state.localContainerUrl
                  : undefined,
            });
            console.log(`Applied runtime profile ${runtimeId}`);
          } else {
            console.log('Keeping existing runtime configuration as requested.');
          }

          if (state.channel === 'discord' && state.discordChannelId) {
            const jid = `dc:${state.discordChannelId}`;
            setRegisteredGroup(jid, {
              name:
                state.discordChannelName || `Discord ${state.discordChannelId}`,
              folder: 'discord_main',
              trigger: `@${ASSISTANT_NAME}`,
              added_at: new Date().toISOString(),
              requiresTrigger: false,
              isMain: true,
            });
            console.log(`Registered Discord main channel: ${jid}`);
          }

          index++;
          break;
        }

        case 'health': {
          const runtimeCount = getAllRuntimeProfiles().length;
          const authCount = getAllAuthProfiles().length;
          const hasClaudeRuntime = getAllRuntimeProfiles().some(
            (p) => p.provider === 'claude',
          );
          const healthy =
            runtimeCount > 0 && (!hasClaudeRuntime || authCount > 0);

          console.log('\nHealth Check');
          console.log(`Runtime profiles: ${runtimeCount}`);
          console.log(`Auth profiles: ${authCount}`);
          let channelOk = true;
          let channelRegisteredOk = true;
          if (state.channel && state.channel !== 'none') {
            const selectedChannel = state.channel;
            const channelCheck = isChannelConfigured(selectedChannel);
            channelOk = channelCheck.ok;
            const registeredCount =
              getRegisteredGroupCountForChannel(selectedChannel);
            channelRegisteredOk = registeredCount > 0;
            console.log(
              `Channel ${selectedChannel}: ${channelCheck.ok ? 'configured' : 'not configured'} (${channelCheck.detail})`,
            );
            console.log(
              `Channel ${selectedChannel}: ${registeredCount > 0 ? `${registeredCount} registration(s) found` : 'no registered channel/group found'}`,
            );
          }

          const deep = await collectLaunchCheckReportDeep();
          console.log('\nDeep Launch Check');
          for (const item of deep.items) {
            console.log(
              `[${item.ok ? 'PASS' : 'FAIL'}] ${item.key}: ${item.detail}`,
            );
          }

          const ignoredDeepKeys = new Set<string>([
            'recent_discord_roundtrip',
            'discord_recent_human_message',
          ]);
          if (state.channel !== 'discord') {
            for (const item of deep.items) {
              if (item.key.startsWith('discord_')) {
                ignoredDeepKeys.add(item.key);
              }
            }
          }
          const blockingDeepFailures = deep.items.filter(
            (item) => !item.ok && !ignoredDeepKeys.has(item.key),
          );

          if (
            !healthy ||
            !channelOk ||
            !channelRegisteredOk ||
            blockingDeepFailures.length > 0
          ) {
            if (blockingDeepFailures.length > 0) {
              const keys = blockingDeepFailures.map((f) => f.key).join(', ');
              console.log(`Blocking deep-check failures: ${keys}`);
            }
            throw new Error(
              'Health check failed: runtime/auth/channel setup is incomplete after apply (missing token/config or channel registration).',
            );
          }

          saveSession(sessionId!, 'health', state, 'completed');
          console.log(`Onboarding completed. Session: ${sessionId}`);
          return;
        }

        default:
          throw new Error(`Unhandled step: ${step}`);
      }
    }
  } catch (err) {
    saveSession(sessionId!, step, state, 'failed');
    throw err;
  } finally {
    rl.close();
  }
}
