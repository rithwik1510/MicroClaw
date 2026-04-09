import { execSync } from 'child_process';
import { Client, GatewayIntentBits, TextChannel } from 'discord.js';
import {
  getAllLocalEndpointProfiles,
  getAllRegisteredGroups,
  getAllRuntimeProfiles,
  getProviderCapability,
  getRuntimeEvents,
} from '../db.js';
import { readEnvFile } from '../env.js';
import { RuntimeEvent, RuntimeProfile } from '../types.js';
import {
  probeExecutionBackend,
  resolveExecutionBackendForProvider,
} from '../execution/backend.js';
import {
  listToolServices,
  probeToolService,
} from '../tools/service-supervisor.js';

export interface StatusSnapshot {
  timestamp: string;
  runtimeProfilesCount: number;
  authProfilesCount: number;
  localEndpointsCount: number;
  registeredGroupsCount: number;
  runtimeProfiles: Array<{
    id: string;
    provider: string;
    model: string;
    enabled: boolean;
    authProfileId?: string;
    baseUrl?: string;
    supportsResponses?: boolean;
    supportsChatCompletions?: boolean;
  }>;
  recentRuntimeEvents: RuntimeEvent[];
}

export interface DoctorReport {
  healthy: boolean;
  issues: string[];
}

export interface LaunchCheckItem {
  key: string;
  ok: boolean;
  detail: string;
}

export interface LaunchCheckReport {
  pass: boolean;
  strict: boolean;
  checkedAt: string;
  items: LaunchCheckItem[];
  failedKeys: string[];
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

function prepareProbeContent(model: string, content: string): string {
  if (/\bqwen3\b/i.test(model) && !/^\s*\/no_think\b/i.test(content)) {
    return `/no_think\n${content}`;
  }
  return content;
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
  if (
    content &&
    typeof content === 'object' &&
    'text' in content &&
    typeof (content as { text?: unknown }).text === 'string'
  ) {
    return (content as { text: string }).text.trim();
  }
  return '';
}

function isContainerRuntimeAvailable(): boolean {
  try {
    execSync('docker info', {
      stdio: 'pipe',
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

function isDockerRequired(runtimeProfiles: RuntimeProfile[]): boolean {
  const forced = (process.env.NANOCLAW_EXECUTION_BACKEND || '')
    .trim()
    .toLowerCase();
  if (forced === 'docker') return true;
  return runtimeProfiles.some((p) => p.enabled && p.provider === 'claude');
}

function choosePrimaryLocalRuntime(
  runtimeProfiles: RuntimeProfile[],
): RuntimeProfile | undefined {
  return runtimeProfiles.find(
    (p) => p.enabled && p.provider === 'openai_compatible',
  );
}

async function postOpenAIChatCompletion(input: {
  baseUrl: string;
  model: string;
  content: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; content?: string; detail: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    input.timeoutMs || 15000,
  );
  try {
    const normalizedBase = normalizeOpenAIBaseUrl(input.baseUrl);
    const endpoint = `${normalizedBase}/chat/completions`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: input.model,
        messages: [
          {
            role: 'user',
            content: prepareProbeContent(input.model, input.content),
          },
        ],
        temperature: 0,
      }),
      signal: controller.signal,
    });
    const bodyText = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        detail: `HTTP ${res.status} from ${endpoint}: ${bodyText.slice(0, 180)}`,
      };
    }
    let parsed: OpenAIChatCompletionResponse | undefined;
    try {
      parsed = JSON.parse(bodyText) as OpenAIChatCompletionResponse;
    } catch {
      return {
        ok: false,
        detail: `Invalid JSON response from ${endpoint}`,
      };
    }
    const content = extractContentText(parsed.choices?.[0]?.message?.content);
    if (!content) {
      return {
        ok: false,
        detail: 'Model returned empty content',
      };
    }
    return {
      ok: true,
      content,
      detail: `response="${content.slice(0, 120)}"`,
    };
  } catch (err) {
    return {
      ok: false,
      detail:
        err instanceof Error
          ? err.name === 'AbortError'
            ? `Timeout after ${input.timeoutMs || 15000}ms while calling ${input.baseUrl}`
            : `Request failed for ${input.baseUrl}: ${err.message}`
          : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function readOpenAITimeoutMs(): number {
  const env = readEnvFile(['OPENAI_REQUEST_TIMEOUT_MS']);
  const parsed = Number.parseInt(
    process.env.OPENAI_REQUEST_TIMEOUT_MS ||
      env.OPENAI_REQUEST_TIMEOUT_MS ||
      '',
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}

async function runDeepModelChecks(
  primaryRuntime: RuntimeProfile | undefined,
): Promise<LaunchCheckItem[]> {
  if (!primaryRuntime || primaryRuntime.provider !== 'openai_compatible') {
    return [
      {
        key: 'model_live_response',
        ok: false,
        detail: 'Skipped: no openai_compatible primary runtime',
      },
      {
        key: 'model_knowledge_smoke',
        ok: false,
        detail: 'Skipped: no openai_compatible primary runtime',
      },
    ];
  }
  if (!primaryRuntime.baseUrl) {
    return [
      {
        key: 'model_live_response',
        ok: false,
        detail: 'Primary runtime has no baseUrl',
      },
      {
        key: 'model_knowledge_smoke',
        ok: false,
        detail: 'Primary runtime has no baseUrl',
      },
    ];
  }

  const probeTimeoutMs = Math.max(
    20_000,
    Math.min(readOpenAITimeoutMs(), 120_000),
  );

  const candidateBaseUrls = new Set<string>();
  candidateBaseUrls.add(primaryRuntime.baseUrl);
  if (primaryRuntime.baseUrl.includes('host.docker.internal')) {
    candidateBaseUrls.add(
      primaryRuntime.baseUrl.replace('host.docker.internal', '127.0.0.1'),
    );
    candidateBaseUrls.add(
      primaryRuntime.baseUrl.replace('host.docker.internal', 'localhost'),
    );
  }
  const localMatch = getAllLocalEndpointProfiles().find(
    (p) => p.containerReachableUrl === primaryRuntime.baseUrl,
  );
  if (localMatch?.baseUrl) {
    candidateBaseUrls.add(localMatch.baseUrl);
  }

  let selectedBaseUrl: string | undefined;
  let selectedProbeDetail = '';
  for (const baseUrl of candidateBaseUrls) {
    const smokeProbe = await postOpenAIChatCompletion({
      baseUrl,
      model: primaryRuntime.model,
      content: 'Reply with exactly: OK',
      timeoutMs: Math.min(probeTimeoutMs, 90_000),
    });
    if (smokeProbe.ok) {
      selectedBaseUrl = baseUrl;
      selectedProbeDetail = smokeProbe.detail;
      break;
    }
    selectedProbeDetail = smokeProbe.detail;
  }

  if (!selectedBaseUrl) {
    return [
      {
        key: 'model_live_response',
        ok: false,
        detail: `No host-reachable base URL passed probe (${selectedProbeDetail})`,
      },
      {
        key: 'model_knowledge_smoke',
        ok: false,
        detail: 'Skipped: model live response probe failed',
      },
    ];
  }

  const live = await postOpenAIChatCompletion({
    baseUrl: selectedBaseUrl,
    model: primaryRuntime.model,
    content: 'Reply with exactly: OK',
    timeoutMs: probeTimeoutMs,
  });
  const knowledge = await postOpenAIChatCompletion({
    baseUrl: selectedBaseUrl,
    model: primaryRuntime.model,
    content: 'One-word answer only: What is the capital of France?',
    timeoutMs: probeTimeoutMs,
  });

  const knowledgeOk = Boolean(
    knowledge.ok && knowledge.content && /paris/i.test(knowledge.content),
  );

  return [
    {
      key: 'model_live_response',
      ok: live.ok,
      detail: `${live.detail} (base=${selectedBaseUrl})`,
    },
    {
      key: 'model_knowledge_smoke',
      ok: knowledgeOk,
      detail: knowledge.ok
        ? `expected "Paris", got "${knowledge.content?.slice(0, 80)}"`
        : knowledge.detail,
    },
  ];
}

async function runDeepDiscordChecks(token: string): Promise<LaunchCheckItem[]> {
  if (!token) {
    return [
      {
        key: 'discord_gateway_intents',
        ok: false,
        detail: 'Skipped: missing DISCORD_BOT_TOKEN',
      },
      {
        key: 'discord_channel_access',
        ok: false,
        detail: 'Skipped: missing DISCORD_BOT_TOKEN',
      },
      {
        key: 'discord_recent_human_message',
        ok: false,
        detail: 'Skipped: missing DISCORD_BOT_TOKEN',
      },
    ];
  }

  const intentsItem: LaunchCheckItem = {
    key: 'discord_gateway_intents',
    ok: false,
    detail: 'Unable to read Discord application flags',
  };
  try {
    const appRes = await fetch('https://discord.com/api/v10/applications/@me', {
      headers: {
        Authorization: `Bot ${token}`,
      },
    });
    if (appRes.ok) {
      const app = (await appRes.json()) as { flags?: number };
      const flags = app.flags || 0;
      const hasMessageContent = (flags & 262144) !== 0;
      const hasLimitedMessageContent = (flags & 524288) !== 0;
      intentsItem.ok = hasMessageContent || hasLimitedMessageContent;
      intentsItem.detail = hasMessageContent
        ? 'Full Message Content intent enabled'
        : hasLimitedMessageContent
          ? 'Message Content intent is LIMITED (works best with explicit @mention)'
          : 'Message Content intent appears disabled';
    } else {
      intentsItem.detail = `Discord API /applications/@me returned ${appRes.status}`;
    }
  } catch (err) {
    intentsItem.detail = err instanceof Error ? err.message : String(err);
  }

  const groups = getAllRegisteredGroups();
  const discordJid = Object.keys(groups).find((jid) => jid.startsWith('dc:'));
  if (!discordJid) {
    return [
      intentsItem,
      {
        key: 'discord_channel_access',
        ok: false,
        detail: 'No registered Discord channel found',
      },
      {
        key: 'discord_recent_human_message',
        ok: false,
        detail: 'No registered Discord channel found',
      },
    ];
  }

  const channelId = discordJid.replace(/^dc:/, '');
  const accessItem: LaunchCheckItem = {
    key: 'discord_channel_access',
    ok: false,
    detail: 'Unable to validate channel access',
  };
  const humanMessageItem: LaunchCheckItem = {
    key: 'discord_recent_human_message',
    ok: false,
    detail: 'Unable to read recent channel messages',
  };

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  try {
    await client.login(token);
    const channel = await client.channels.fetch(channelId);
    if (!channel || !('permissionsFor' in channel)) {
      accessItem.detail =
        'Channel not found or permission metadata unavailable';
      humanMessageItem.detail = 'Channel not text-capable';
    } else {
      const perms = channel.permissionsFor(client.user!.id);
      const canView = perms?.has('ViewChannel') || false;
      const canSend = perms?.has('SendMessages') || false;
      const canReadHistory = perms?.has('ReadMessageHistory') || false;
      accessItem.ok = canView && canSend && canReadHistory;
      accessItem.detail = `view=${canView} send=${canSend} history=${canReadHistory}`;

      if (channel instanceof TextChannel) {
        const recent = await channel.messages.fetch({ limit: 20 });
        const humanMessages = recent.filter((m) => !m.author.bot);
        humanMessageItem.ok = humanMessages.size > 0;
        humanMessageItem.detail =
          humanMessages.size > 0
            ? `Found ${humanMessages.size} human messages in last 20`
            : 'No human messages in last 20 (send one fresh @mention test message)';
      } else {
        humanMessageItem.detail = `Channel type ${String(channel.type)} not supported for message fetch`;
      }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    accessItem.detail = detail;
    humanMessageItem.detail = detail;
  } finally {
    client.destroy();
  }

  return [intentsItem, accessItem, humanMessageItem];
}

async function runDeepWebChecks(): Promise<LaunchCheckItem[]> {
  const env = readEnvFile([
    'WEB_SEARCH_PROVIDER',
    'WEB_FETCH_PROVIDER',
    'SEARXNG_BASE_URL',
    'WEB_BROWSER_FALLBACK',
    'WEB_TOOL_PRIMARY',
  ]);
  const searchProvider = (
    process.env.WEB_SEARCH_PROVIDER ||
    env.WEB_SEARCH_PROVIDER ||
    process.env.WEB_TOOL_PRIMARY ||
    env.WEB_TOOL_PRIMARY ||
    'auto'
  )
    .trim()
    .toLowerCase();
  const fetchProvider = (
    process.env.WEB_FETCH_PROVIDER ||
    env.WEB_FETCH_PROVIDER ||
    'auto'
  )
    .trim()
    .toLowerCase();
  const searxngBaseUrl = (
    process.env.SEARXNG_BASE_URL ||
    env.SEARXNG_BASE_URL ||
    'http://127.0.0.1:8888'
  ).replace(/\/$/, '');
  const browserFallback = (
    process.env.WEB_BROWSER_FALLBACK ||
    env.WEB_BROWSER_FALLBACK ||
    'playwright'
  )
    .trim()
    .toLowerCase();
  const enabledServices = listToolServices().filter(
    (s) => s.profile.enabled && s.profile.kind === 'custom_http',
  );
  const supportedSearchProvider = [
    'auto',
    'off',
    'searxng',
    'duckduckgo',
    'playwright',
  ].includes(searchProvider);
  const supportedFetchProvider = ['auto', 'http', 'playwright'].includes(
    fetchProvider,
  );

  const configItem: LaunchCheckItem = {
    key: 'web_tool_config',
    ok: supportedSearchProvider && supportedFetchProvider,
    detail: !supportedSearchProvider
      ? `Unsupported WEB_SEARCH_PROVIDER=${searchProvider}`
      : !supportedFetchProvider
        ? `Unsupported WEB_FETCH_PROVIDER=${fetchProvider}`
        : `search=${searchProvider} fetch=${fetchProvider} browser_fallback=${browserFallback}`,
  };

  if (searchProvider === 'off') {
    return [
      configItem,
      {
        key: 'web_tool_search_provider_ready',
        ok: true,
        detail: 'Skipped: web tools disabled',
      },
      {
        key: 'web_tool_browser_fallback_ready',
        ok: true,
        detail: 'Skipped: web tools disabled',
      },
    ];
  }

  let searchProviderReady = true;
  let searchProviderDetail = '';
  if (searchProvider === 'searxng' || searchProvider === 'auto') {
    try {
      const res = await fetch(
        `${searxngBaseUrl}/search?q=nanoclaw&format=json`,
        { signal: AbortSignal.timeout(4000) },
      );
      searchProviderReady = res.ok;
      searchProviderDetail = res.ok
        ? `SearXNG reachable at ${searxngBaseUrl}`
        : `SearXNG probe returned HTTP ${res.status}`;
    } catch (err) {
      searchProviderReady = searchProvider === 'auto';
      searchProviderDetail =
        searchProvider === 'auto'
          ? `SearXNG unavailable at ${searxngBaseUrl}; DuckDuckGo fallback should handle search`
          : err instanceof Error
            ? err.message.slice(0, 200)
            : String(err).slice(0, 200);
    }
  } else {
    searchProviderDetail = `Configured search provider ${searchProvider}`;
  }

  let playwrightReady = true;
  let playwrightDetail = 'Playwright fallback disabled';
  if (
    browserFallback === 'playwright' ||
    searchProvider === 'playwright' ||
    fetchProvider === 'playwright'
  ) {
    try {
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      execSync(
        `${npmCmd} --prefix container/agent-runner exec playwright -- --version`,
        {
          stdio: 'pipe',
          timeout: 15000,
        },
      );
      playwrightReady = true;
      playwrightDetail =
        'Playwright CLI and browser dependencies are available';
    } catch (err) {
      playwrightReady = false;
      playwrightDetail =
        err instanceof Error
          ? err.message.slice(0, 200)
          : String(err).slice(0, 200);
    }
  }

  const probeResults = await Promise.all(
    enabledServices.map(async (svc) => ({
      id: svc.profile.id,
      result: await probeToolService(svc.profile.id),
    })),
  );
  const failed = probeResults.filter((x) => !x.result.ok);
  const probeDetail = probeResults
    .map((x) => `${x.id}:${x.result.ok ? 'ok' : 'fail'}`)
    .join(', ');

  return [
    configItem,
    {
      key: 'web_tool_search_provider_ready',
      ok: searchProviderReady,
      detail: searchProviderDetail,
    },
    {
      key: 'web_tool_browser_fallback_ready',
      ok: playwrightReady,
      detail: playwrightDetail,
    },
    {
      key: 'web_tool_service_probe',
      ok: failed.length === 0,
      detail: probeDetail || 'No probes executed',
    },
    {
      key: 'web_tool_action_smoke',
      ok: failed.length === 0,
      detail:
        failed.length === 0
          ? 'Enabled web/tool services passed probes'
          : `${failed.length} service probe(s) failed`,
    },
  ];
}

export function collectStatusSnapshot(
  authProfilesCount: number,
): StatusSnapshot {
  const runtimeProfiles = getAllRuntimeProfiles();
  const localProfiles = getAllLocalEndpointProfiles();
  const groupCount = Object.keys(getAllRegisteredGroups()).length;
  const runtimeEvents = getRuntimeEvents(undefined, 8);

  return {
    timestamp: new Date().toISOString(),
    runtimeProfilesCount: runtimeProfiles.length,
    authProfilesCount,
    localEndpointsCount: localProfiles.length,
    registeredGroupsCount: groupCount,
    runtimeProfiles: runtimeProfiles.slice(0, 20).map((rp) => {
      const cap = getProviderCapability(rp.provider, rp.baseUrl);
      return {
        id: rp.id,
        provider: rp.provider,
        model: rp.model,
        enabled: rp.enabled,
        authProfileId: rp.authProfileId,
        baseUrl: rp.baseUrl,
        supportsResponses: cap?.supportsResponses,
        supportsChatCompletions: cap?.supportsChatCompletions,
      };
    }),
    recentRuntimeEvents: runtimeEvents,
  };
}

export function collectDoctorReport(input: {
  hasClaudeAuthProfile: boolean;
}): DoctorReport {
  const issues: string[] = [];
  const runtimeProfiles = getAllRuntimeProfiles();
  const dockerRequired = isDockerRequired(runtimeProfiles);
  if (dockerRequired && !isContainerRuntimeAvailable()) {
    issues.push('Container runtime unavailable. Start Docker and retry.');
  }

  if (runtimeProfiles.length === 0) {
    issues.push(
      'No runtime profiles configured. Run `microclaw models add` or `microclaw onboard`.',
    );
  }

  if (
    !input.hasClaudeAuthProfile &&
    runtimeProfiles.some((p) => p.provider === 'claude')
  ) {
    issues.push(
      'No auth profiles configured for Claude runtime. Run `microclaw auth login --provider claude --token ...` or `microclaw onboard`.',
    );
  }

  const groups = getAllRegisteredGroups();
  const entries = Object.entries(groups);
  if (entries.length === 0) {
    issues.push(
      'No registered groups/channels found. Register one with setup register step or onboard Discord channel ID.',
    );
  } else {
    const hasPlaceholder = entries.some(([jid]) =>
      jid.includes('YOUR_DISCORD_CHANNEL_ID'),
    );
    if (hasPlaceholder) {
      issues.push(
        'Found placeholder Discord JID (dc:YOUR_DISCORD_CHANNEL_ID). Replace it with your real channel ID.',
      );
    }
  }

  return { healthy: issues.length === 0, issues };
}

function hasDiscordTokenConfigured(): boolean {
  const envFile = readEnvFile(['DISCORD_BOT_TOKEN']);
  return Boolean(process.env.DISCORD_BOT_TOKEN || envFile.DISCORD_BOT_TOKEN);
}

function getDiscordTokenValue(): string {
  const envFile = readEnvFile(['DISCORD_BOT_TOKEN']);
  return (
    process.env.DISCORD_BOT_TOKEN ||
    envFile.DISCORD_BOT_TOKEN ||
    ''
  ).trim();
}

function hasRecentSuccessForDiscord(): boolean {
  const events = getRuntimeEvents(undefined, 120);
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  return events.some((evt) => {
    if (evt.eventType !== 'success') return false;
    if (!evt.chatJid.startsWith('dc:')) return false;
    const ts = Date.parse(evt.timestamp);
    return Number.isFinite(ts) && ts >= oneDayAgo;
  });
}

export function collectLaunchCheckReport(): LaunchCheckReport {
  const checkedAt = new Date().toISOString();
  const items: LaunchCheckItem[] = [];
  const runtimeProfiles = getAllRuntimeProfiles();
  const localProfiles = getAllLocalEndpointProfiles();
  const groups = getAllRegisteredGroups();

  const dockerRequired = isDockerRequired(runtimeProfiles);
  const containerOk = isContainerRuntimeAvailable();
  items.push({
    key: 'container_runtime',
    ok: dockerRequired ? containerOk : true,
    detail: dockerRequired
      ? containerOk
        ? 'Docker/container runtime reachable'
        : 'Docker/container runtime is unavailable (required by active Claude/docker profile)'
      : containerOk
        ? 'Docker/container runtime reachable (optional in native mode)'
        : 'Docker/container runtime unavailable (optional in native mode)',
  });

  const primaryLocalRuntime = choosePrimaryLocalRuntime(runtimeProfiles);
  items.push({
    key: 'primary_local_runtime',
    ok: Boolean(primaryLocalRuntime),
    detail: primaryLocalRuntime
      ? `${primaryLocalRuntime.id} (${primaryLocalRuntime.model})`
      : 'No enabled openai_compatible runtime profile found',
  });

  const hasHealthyEndpoint = localProfiles.some(
    (p) => p.healthStatus === 'healthy',
  );
  items.push({
    key: 'local_endpoint_health',
    ok: hasHealthyEndpoint,
    detail: hasHealthyEndpoint
      ? 'At least one local endpoint is healthy'
      : 'No healthy local endpoint profile found',
  });

  const token = getDiscordTokenValue();
  const tokenConfigured = hasDiscordTokenConfigured();
  const tokenLooksPrefixed = token.toLowerCase().startsWith('bot ');
  const tokenOk = tokenConfigured && !tokenLooksPrefixed;
  items.push({
    key: 'discord_token',
    ok: tokenOk,
    detail: tokenOk
      ? 'DISCORD_BOT_TOKEN is configured'
      : tokenLooksPrefixed
        ? 'DISCORD_BOT_TOKEN appears to include a "Bot " prefix. Use raw token only.'
        : 'DISCORD_BOT_TOKEN missing in process env and .env',
  });

  const discordGroups = Object.keys(groups).filter((jid) =>
    jid.startsWith('dc:'),
  );
  const hasPlaceholder = discordGroups.some((jid) =>
    jid.includes('YOUR_DISCORD_CHANNEL_ID'),
  );
  const groupOk = discordGroups.length > 0 && !hasPlaceholder;
  items.push({
    key: 'discord_registration',
    ok: groupOk,
    detail: groupOk
      ? `${discordGroups.length} Discord channel(s) registered`
      : hasPlaceholder
        ? 'Placeholder Discord channel ID still configured'
        : 'No Discord channel registration found',
  });

  const cap = primaryLocalRuntime
    ? getProviderCapability(
        primaryLocalRuntime.provider,
        primaryLocalRuntime.baseUrl,
      )
    : undefined;
  const capabilityOk = Boolean(
    cap && (cap.supportsResponses || cap.supportsChatCompletions),
  );
  items.push({
    key: 'runtime_capability',
    ok: capabilityOk,
    detail: capabilityOk
      ? `responses=${Boolean(cap?.supportsResponses)} chat=${Boolean(cap?.supportsChatCompletions)}`
      : 'No cached provider capability proving responses/chat support',
  });

  if (primaryLocalRuntime) {
    const backend = resolveExecutionBackendForProvider(
      primaryLocalRuntime.provider,
    );
    const backendProbe = probeExecutionBackend(backend);
    items.push({
      key: 'runtime_backend_probe',
      ok: backendProbe.ok,
      detail: `${backend}: ${backendProbe.detail}`,
    });
  } else {
    items.push({
      key: 'runtime_backend_probe',
      ok: false,
      detail: 'Skipped: no enabled primary runtime',
    });
  }

  const toolServices = listToolServices().filter(
    (x) => x.profile.enabled && x.profile.kind === 'custom_http',
  );
  const unhealthy = toolServices.filter(
    (x) => x.state && x.state.status !== 'healthy',
  );
  items.push({
    key: 'tool_services_status',
    ok: unhealthy.length === 0,
    detail:
      toolServices.length === 0
        ? 'No enabled tool services configured'
        : unhealthy.length === 0
          ? `${toolServices.length} enabled tool service(s) healthy`
          : `${unhealthy.length}/${toolServices.length} enabled tool service(s) unhealthy`,
  });

  const recentRoundTripOk = hasRecentSuccessForDiscord();
  items.push({
    key: 'recent_discord_roundtrip',
    ok: recentRoundTripOk,
    detail: recentRoundTripOk
      ? 'Observed a Discord runtime success event in the last 24h'
      : 'No Discord runtime success event observed in the last 24h',
  });

  const failedKeys = items.filter((item) => !item.ok).map((item) => item.key);
  return {
    pass: failedKeys.length === 0,
    strict: true,
    checkedAt,
    items,
    failedKeys,
  };
}

export async function collectLaunchCheckReportDeep(): Promise<LaunchCheckReport> {
  const base = collectLaunchCheckReport();
  const runtimeProfiles = getAllRuntimeProfiles();
  const primaryLocalRuntime = choosePrimaryLocalRuntime(runtimeProfiles);
  const token = getDiscordTokenValue();

  const deepItems: LaunchCheckItem[] = [];
  deepItems.push(...(await runDeepModelChecks(primaryLocalRuntime)));
  deepItems.push(...(await runDeepDiscordChecks(token)));
  deepItems.push(...(await runDeepWebChecks()));

  const items = [...base.items, ...deepItems];
  const failedKeys = items.filter((item) => !item.ok).map((item) => item.key);
  return {
    ...base,
    items,
    failedKeys,
    pass: failedKeys.length === 0,
  };
}

export function printStatus(snapshot: StatusSnapshot): void {
  console.log('MicroClaw status');
  console.log(`Runtime profiles: ${snapshot.runtimeProfilesCount}`);
  console.log(`Auth profiles: ${snapshot.authProfilesCount}`);
  console.log(`Local endpoints: ${snapshot.localEndpointsCount}`);
  console.log(`Registered groups: ${snapshot.registeredGroupsCount}`);
  for (const rp of snapshot.runtimeProfiles) {
    const state = rp.enabled ? 'active' : 'disabled';
    console.log(
      `- ${rp.id}: ${rp.provider}/${rp.model} state=${state} auth=${rp.authProfileId || '-'} cap.responses=${rp.supportsResponses ?? 'n/a'}`,
    );
  }
  if (snapshot.recentRuntimeEvents.length > 0) {
    console.log('\nRecent runtime events:');
    for (const evt of snapshot.recentRuntimeEvents) {
      console.log(
        `- ${evt.timestamp} ${evt.eventType} profile=${evt.profileId} ${evt.message}`,
      );
    }
  }
}

export function printDoctor(report: DoctorReport): void {
  if (report.healthy) {
    console.log('Doctor: healthy');
    return;
  }
  console.log('Doctor found issues:');
  for (const issue of report.issues) console.log(`- ${issue}`);
}

export function printLaunchCheck(report: LaunchCheckReport): void {
  console.log('Launch Check (strict)');
  console.log(`Checked at: ${report.checkedAt}`);
  for (const item of report.items) {
    console.log(`[${item.ok ? 'PASS' : 'FAIL'}] ${item.key}: ${item.detail}`);
  }
  console.log(report.pass ? '\nResult: PASS' : '\nResult: FAIL');
}
