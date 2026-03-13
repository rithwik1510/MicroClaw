import { ProviderCapability } from '../types.js';

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

function normalizeOpenAIBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, '');
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

async function safeFetchJson(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: unknown; error?: string }> {
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = text;
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: {},
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function probeOpenAICompatibleCapabilities(input: {
  baseUrl: string;
  apiKey?: string;
  modelHint?: string;
}): Promise<{ capability: ProviderCapability; healthStatus: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (input.apiKey) {
    headers.Authorization = `Bearer ${input.apiKey}`;
  }

  const checkedAt = new Date().toISOString();
  const normalizedBase = normalizeOpenAIBaseUrl(input.baseUrl);

  const modelsRes = await safeFetchJson(joinUrl(normalizedBase, '/models'), {
    headers,
  });
  const modelsOk = modelsRes.ok;
  const model = input.modelHint || 'gpt-4.1-mini';

  const responsesRes = await safeFetchJson(
    joinUrl(normalizedBase, '/responses'),
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        input: 'say hello',
      }),
    },
  );

  const chatRes = await safeFetchJson(
    joinUrl(normalizedBase, '/chat/completions'),
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'say hello' }],
      }),
    },
  );

  const responsesBodyHasError =
    !!responsesRes.body &&
    typeof responsesRes.body === 'object' &&
    'error' in (responsesRes.body as Record<string, unknown>);
  const chatBodyHasError =
    !!chatRes.body &&
    typeof chatRes.body === 'object' &&
    'error' in (chatRes.body as Record<string, unknown>);

  const supportsResponses = responsesRes.ok && !responsesBodyHasError;
  const supportsChatCompletions = chatRes.ok && !chatBodyHasError;
  const toolsRes = await safeFetchJson(
    joinUrl(normalizedBase, '/chat/completions'),
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: 'Use the tool named ping and return result.',
          },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'ping',
              description: 'health probe tool',
              parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: 'auto',
      }),
    },
  );
  const supportsTools = toolsRes.ok;
  const requiresApiKey =
    (responsesRes.status === 401 ||
      chatRes.status === 401 ||
      toolsRes.status === 401) &&
    !input.apiKey;
  const healthy = modelsOk || supportsResponses || supportsChatCompletions;

  return {
    capability: {
      supportsResponses,
      supportsChatCompletions,
      supportsTools,
      supportsStreaming: supportsResponses || supportsChatCompletions,
      requiresApiKey,
      defaultModel: model,
      checkedAt,
    },
    healthStatus: healthy ? 'healthy' : 'unreachable',
  };
}
