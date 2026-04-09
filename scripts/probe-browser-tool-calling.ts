import {
  getConversationSummary,
  getMessagesSince,
  initDatabase,
} from '../src/db.js';
import {
  buildContinuityPlan,
  buildContinuityPrompt,
} from '../src/continuity.js';
import { ASSISTANT_NAME } from '../src/config.js';

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
};

function summarizeContent(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 220);
}

async function probe(input: {
  baseUrl: string;
  model: string;
  userContent: string;
}): Promise<{
  toolCalls: string[];
  content: string;
}> {
  const payload = {
    model: input.model,
    messages: [
      {
        role: 'system',
        content: [
          'Browser operator policy:',
          '- Use tools instead of giving manual instructions.',
          '- If the user names a site or product but does not give a URL, use web_search first to find the official site or login page.',
          '- Then use browser_open_url to start the managed browser flow.',
          '- Do not say you cannot browse or that you will try a different approach before using the tools.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: input.userContent,
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'web_search',
          description:
            'Search the web for current or external information and return structured result context.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
            required: ['query'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'browser_open_url',
          description:
            'Open a URL in a host-managed browser session for multi-step interactive work.',
          parameters: {
            type: 'object',
            properties: {
              url: { type: 'string' },
            },
            required: ['url'],
            additionalProperties: false,
          },
        },
      },
    ],
    tool_choice: 'auto',
    max_tokens: 400,
  };

  const response = await fetch(`${input.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${input.baseUrl}/chat/completions`);
  }

  const json = (await response.json()) as ChatCompletionResponse;
  const message = json.choices?.[0]?.message;
  const toolCalls = (message?.tool_calls || [])
    .map((call) => call.function?.name || '')
    .filter(Boolean);

  return {
    toolCalls,
    content: message?.content || '',
  };
}

async function main(): Promise<void> {
  const baseUrl = process.env.PROBE_BASE_URL || 'http://127.0.0.1:1234/v1';
  const model = process.env.PROBE_MODEL || 'qwen/qwen3-8b';
  const prompt = resolveProbePrompt();

  const direct = await probe({
    baseUrl,
    model,
    userContent: prompt,
  });
  const noThink = await probe({
    baseUrl,
    model,
    userContent: `/no_think\n${prompt}`,
  });

  console.log(`Probe model: ${model}`);
  console.log(`Probe base URL: ${baseUrl}`);
  console.log('');
  console.log(`direct prompt tool calls: ${direct.toolCalls.join(', ') || '(none)'}`);
  console.log(`direct prompt content: ${summarizeContent(direct.content) || '(empty)'}`);
  console.log('');
  console.log(`no_think prompt tool calls: ${noThink.toolCalls.join(', ') || '(none)'}`);
  console.log(`no_think prompt content: ${summarizeContent(noThink.content) || '(empty)'}`);

  if (direct.toolCalls.length === 0) {
    process.exitCode = 1;
    console.error('');
    console.error('Probe failed: the raw browser-operation prompt did not produce a tool call.');
  }
}

function resolveProbePrompt(): string {
  const explicitPrompt = process.env.PROBE_PROMPT;
  if (explicitPrompt?.trim()) return explicitPrompt.trim();

  const probeChatJid = process.env.PROBE_CHAT_JID;
  const probeGroupFolder = process.env.PROBE_GROUP_FOLDER;
  if (!probeChatJid || !probeGroupFolder) {
    return 'log in and see for yourself on VibeLevel.ai';
  }

  initDatabase();
  const allMessages = getMessagesSince(
    [probeChatJid],
    '1970-01-01T00:00:00.000Z',
  );
  const targetMessage = [...allMessages]
    .reverse()
    .find((message) => !message.is_bot_message);
  if (!targetMessage) {
    throw new Error(`No user message found for ${probeChatJid}`);
  }

  const conversationMessages = allMessages.filter(
    (message) => message.timestamp <= targetMessage.timestamp,
  );
  const currentMessages = conversationMessages.filter(
    (message) => message.timestamp === targetMessage.timestamp,
  );
  const storedSummary = getConversationSummary(probeGroupFolder);
  const continuityPlan = buildContinuityPlan({
    assistantName: ASSISTANT_NAME,
    conversationMessages,
    currentMessages,
    storedSummary: storedSummary?.summary,
    recentTurnLimit: 6,
    summaryMinMessages: 8,
    summaryMinChars: 3000,
  });
  return buildContinuityPrompt({
    assistantName: ASSISTANT_NAME,
    summary: continuityPlan.summaryToUse,
    recentContextMessages: continuityPlan.recentContextMessages,
    currentMessages: continuityPlan.currentMessages,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
