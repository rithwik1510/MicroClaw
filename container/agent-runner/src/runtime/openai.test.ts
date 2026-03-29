import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { RuntimeRequest } from './types.js';
import { OpenAIRuntimeAdapter } from './openai.js';

const mockPostJson = vi.fn();
const mockPostJsonStream = vi.fn();
const mockExecuteWebSearch = vi.fn();
const mockCloseWebSession = vi.fn(async () => undefined);
const mockCloseBrowserSession = vi.fn(async () => undefined);

vi.mock('./http.js', () => ({
  postJson: (...args: unknown[]) => mockPostJson(...args),
  postJsonStream: (...args: unknown[]) => mockPostJsonStream(...args),
  makeSessionId: () => 'session-test',
}));

vi.mock('../tools/browser/actions.js', () => ({
  executeBrowserOpenUrl: vi.fn(async () => ({ ok: true, content: 'Opened browser session' })),
  executeBrowserSnapshot: vi.fn(async () => ({ ok: true, content: 'Snapshot' })),
  executeBrowserClick: vi.fn(async () => ({ ok: true, content: 'Clicked' })),
  executeBrowserType: vi.fn(async () => ({ ok: true, content: 'Typed' })),
  executeBrowserSelect: vi.fn(async () => ({ ok: true, content: 'Selected' })),
  executeBrowserExtractText: vi.fn(async () => ({ ok: true, content: 'Text' })),
  executeBrowserScreenshot: vi.fn(async () => ({ ok: true, content: 'Shot' })),
  executeBrowserTabs: vi.fn(async () => ({ ok: true, content: 'Tabs' })),
  executeBrowserClose: vi.fn(async () => ({ ok: true, content: 'Closed browser session' })),
  closeBrowserSessionFromContext: (...args: unknown[]) =>
    mockCloseBrowserSession(...args),
}));

vi.mock('../tools/web/actions.js', () => ({
  executeWebSearch: (...args: unknown[]) => mockExecuteWebSearch(...args),
  executeWebFetch: vi.fn(async () => ({ ok: true, content: 'fetched' })),
  executeWebOpenUrl: vi.fn(async () => ({ ok: true, content: 'opened' })),
  executeWebExtractText: vi.fn(async () => ({ ok: true, content: 'text' })),
  executeWebGetLinks: vi.fn(async () => ({ ok: true, content: 'links' })),
  executeWebClose: vi.fn(async () => ({ ok: true, content: 'closed' })),
  closeWebSessionFromContext: (...args: unknown[]) =>
    mockCloseWebSession(...args),
}));

function baseRequest(overrides?: Partial<RuntimeRequest>): RuntimeRequest {
  return {
    prompt: 'latest AI news',
    config: {
      provider: 'openai_compatible',
      model: 'test-model',
      baseUrl: 'http://localhost:1234/v1',
      toolPolicy: {
        web: {
          enabled: true,
        },
      },
      capabilities: {
        supportsResponses: false,
        supportsChatCompletions: true,
        supportsTools: true,
        supportsStreaming: false,
        requiresApiKey: false,
        checkedAt: new Date().toISOString(),
      },
    },
    secrets: {
      WEB_SEARCH_PROVIDER: 'auto',
    },
    ...overrides,
  };
}

function toolNamesFromPayload(payload: { tools?: Array<{ function?: { name?: string } }> }): string[] {
  return (payload.tools || [])
    .map((tool) => tool.function?.name || '')
    .filter(Boolean);
}

function withCapabilityRoute(
  config: RuntimeRequest['config'],
  capabilityRoute: NonNullable<RuntimeRequest['config']['capabilityRoute']>,
): RuntimeRequest['config'] {
  return {
    ...config,
    capabilityRoute,
  };
}

describe('OpenAIRuntimeAdapter', () => {
  const testIpcBase = path.join(
    os.tmpdir(),
    'nanoclaw-openai-test',
    String(Date.now()),
  );

  beforeEach(() => {
    mockPostJson.mockReset();
    mockPostJsonStream.mockReset();
    mockExecuteWebSearch.mockReset();
    mockCloseWebSession.mockClear();
    mockCloseBrowserSession.mockClear();
    fs.rmSync(testIpcBase, { recursive: true, force: true });
    fs.mkdirSync(path.join(testIpcBase, 'input'), { recursive: true });
    process.env.NANOCLAW_IPC_INPUT_DIR = path.join(testIpcBase, 'input');
    delete process.env.NANOCLAW_HOST_DIRECTORIES;
  });

  it('does not force web prefetch when the model declines tool use on its own', async () => {
    mockPostJson.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content:
              "It seems like we've reached the web search limit for today. Let's try another approach with Fibonacci code.",
            tool_calls: [],
          },
        },
      ],
    });
    mockExecuteWebSearch.mockResolvedValueOnce({
      ok: false,
      content: 'search call budget exhausted',
    });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(baseRequest());

    expect(mockExecuteWebSearch).not.toHaveBeenCalled();
    expect(res.result).toContain('web search limit');
  });

  it('returns provider usage when chat completions exposes token counts', async () => {
    mockPostJson.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'Latest AI news is moving quickly.',
            tool_calls: [],
          },
        },
      ],
      usage: {
        prompt_tokens: 123,
        completion_tokens: 45,
        total_tokens: 168,
      },
    });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(baseRequest());

    expect(res.usage).toEqual({
      inputTokens: 123,
      outputTokens: 45,
      totalTokens: 168,
      source: 'provider',
      requests: 1,
    });
  });

  it('streams plain conversational text when streaming is supported', async () => {
    mockPostJsonStream.mockImplementationOnce(
      async (
        _url: string,
        _body: unknown,
        _headers: Record<string, string>,
        onEvent: (payload: unknown) => Promise<void>,
      ) => {
        await onEvent({
          choices: [{ delta: { content: 'Hello' } }],
        });
        await onEvent({
          choices: [{ delta: { content: ' there' } }],
        });
        await onEvent({
          choices: [{ delta: {} }],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 5,
            total_tokens: 25,
          },
        });
      },
    );

    const partials: string[] = [];
    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt: 'hello there',
        config: {
          ...baseRequest().config,
          baseUrl: 'https://api.deepinfra.com/v1/openai',
          capabilities: {
            ...baseRequest().config.capabilities!,
            supportsTools: false,
            supportsStreaming: true,
          },
        },
        onPartialText: async (text) => {
          partials.push(text);
        },
      }),
    );

    expect(mockPostJsonStream).toHaveBeenCalledTimes(1);
    expect(mockPostJson).not.toHaveBeenCalled();
    expect(partials.join('')).toBe('Hello there');
    expect(res.result).toBe('Hello there');
    expect(res.usage).toEqual({
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
      source: 'provider',
      requests: 1,
    });
  });

  it('retries web turns instead of accepting a no-tool fallback answer', async () => {
    mockPostJson
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content:
                'I need to inspect live sources before I answer.',
              tool_calls: [],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'tool-web-1',
                  type: 'function',
                  function: {
                    name: 'web_search',
                    arguments: JSON.stringify({ query: 'weather in hyderabad india' }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'It is currently warm in Hyderabad with seasonal heat.',
              tool_calls: [],
            },
          },
        ],
      });
    mockExecuteWebSearch.mockResolvedValueOnce({
      ok: true,
      restricted: false,
      content: 'Search results:\n1. Weather | https://example.com/weather | Warm in Hyderabad.',
    });
    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt: 'search for weather in hyderabad, india',
        config: withCapabilityRoute(baseRequest().config, 'web_lookup'),
      }),
    );

    expect(mockExecuteWebSearch).toHaveBeenCalledTimes(1);
    const retryPayload = mockPostJson.mock.calls[1]?.[1] as {
      messages: Array<{ role: string; content?: string }>;
      tool_choice?: unknown;
    };
    expect(retryPayload.tool_choice).toBe('required');
    expect(
      retryPayload.messages.some(
        (message) =>
          message.role === 'user' &&
          (message.content || '').includes('This is still a web-lookup turn.'),
      ),
    ).toBe(true);
    expect(res.result).toContain('Hyderabad');
  });

  it('does not expose planner tools for simple web lookup turns', async () => {
    mockPostJson
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'tool-web-simple',
                  type: 'function',
                  function: {
                    name: 'web_search',
                    arguments: JSON.stringify({ query: 'latest AI news' }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'The latest AI news is changing quickly.',
              tool_calls: [],
            },
          },
        ],
      });
    mockExecuteWebSearch.mockResolvedValueOnce({
      ok: true,
      restricted: false,
      content: 'Search results:\n1. AI News | https://example.com/news | Latest AI news.',
    });

    const adapter = new OpenAIRuntimeAdapter();
    await adapter.run(
      baseRequest({
        config: withCapabilityRoute(baseRequest().config, 'web_lookup'),
      }),
    );

    const payload = mockPostJson.mock.calls[0]?.[1] as {
      tools?: Array<{ function?: { name?: string } }>;
    };
    const names = toolNamesFromPayload(payload);
    expect(names).toContain('web_search');
    expect(names).not.toContain('create_plan');
    expect(names).not.toContain('critique_response');
  });

  it('removes scheduling tools from ordinary plain-response turns', async () => {
    mockPostJson.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'Hello there.',
            tool_calls: [],
          },
        },
      ],
    });

    const adapter = new OpenAIRuntimeAdapter();
    await adapter.run(
      baseRequest({
        prompt: 'hi',
        config: withCapabilityRoute(baseRequest().config, 'plain_response'),
      }),
    );

    const payload = mockPostJson.mock.calls[0]?.[1] as {
      tools?: Array<{ function?: { name?: string } }>;
    };
    const names = toolNamesFromPayload(payload);
    expect(names).toContain('remember_this');
    expect(names).toContain('memory_search');
    expect(names).not.toContain('schedule_task');
    expect(names).not.toContain('register_watch');
  });

  it('forces future live-work prompts through scheduling tools before allowing a final answer', async () => {
    mockPostJson
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'Here are the latest AI release updates right now.',
              tool_calls: [],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call-schedule',
                  type: 'function',
                  function: {
                    name: 'schedule_once_task',
                    arguments: JSON.stringify({
                      prompt:
                        'Read the latest AI release news and send only the important updates.',
                      schedule_value: '2099-03-14T12:15:00+05:30',
                      context_mode: 'group',
                    }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: "I've scheduled that for you.",
              tool_calls: [],
            },
          },
        ],
      });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt: 'At 12:15 PM today, read the latest AI release news and send me the important updates.',
        secrets: {
          WEB_SEARCH_PROVIDER: 'auto',
          NANOCLAW_CHAT_JID: 'dc:test-chat',
        },
        config: withCapabilityRoute(baseRequest().config, 'web_lookup'),
      }),
    );

    const firstPayload = mockPostJson.mock.calls[0]?.[1] as {
      messages: Array<{ role: string; content?: string }>;
      tools?: Array<{ function?: { name?: string } }>;
      tool_choice?: unknown;
    };
    const firstNames = toolNamesFromPayload(firstPayload);
    expect(firstNames).toEqual(['schedule_once_task']);
    expect(firstPayload.tool_choice).toBe('required');

    const secondPayload = mockPostJson.mock.calls[1]?.[1] as {
      messages: Array<{ role: string; content?: string }>;
      tools?: Array<{ function?: { name?: string } }>;
      tool_choice?: unknown;
    };
    const secondNames = toolNamesFromPayload(secondPayload);
    expect(secondNames).toEqual(['schedule_once_task']);
    expect(secondPayload.tool_choice).toBe('required');
    expect(res.result).toContain('Scheduled task for this chat');
  });

  it('succeeds when the model chooses the correct once tool but passes only the task prompt', async () => {
    mockPostJson.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call-schedule-natural',
                type: 'function',
                function: {
                  name: 'schedule_once_task',
                  arguments: JSON.stringify({
                    prompt:
                      'Read the latest AI release news and send only the important updates.',
                  }),
                },
              },
            ],
          },
        },
      ],
    });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt: 'At 11:59 PM, read the latest AI release news and send me only the important updates.',
        secrets: {
          WEB_SEARCH_PROVIDER: 'auto',
          NANOCLAW_CHAT_JID: 'dc:test-chat',
          NANOCLAW_CURRENT_TIME_ISO: '2099-03-14T12:00:00.000+05:30',
        },
        config: withCapabilityRoute(baseRequest().config, 'plain_response'),
      }),
    );

    expect(res.result).toContain('Scheduled task for this chat');
  });

  it('rejects the wrong schedule_type for exact-time requests and retries scheduling', async () => {
    mockPostJson
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call-schedule-wrong',
                  type: 'function',
                  function: {
                    name: 'schedule_interval_task',
                    arguments: JSON.stringify({
                      prompt: 'Read the latest AI release news and send only the important updates.',
                      schedule_value: '300000',
                      context_mode: 'group',
                    }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call-schedule-right',
                  type: 'function',
                  function: {
                    name: 'schedule_once_task',
                    arguments: JSON.stringify({
                      prompt: 'Read the latest AI release news and send only the important updates.',
                      schedule_value: '2099-03-14T12:15:00+05:30',
                      context_mode: 'group',
                    }),
                  },
                },
              ],
            },
          },
        ],
      });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt: 'At 12:15 PM today, read the latest AI release news and send me the important updates.',
        secrets: {
          WEB_SEARCH_PROVIDER: 'auto',
          NANOCLAW_CHAT_JID: 'dc:test-chat',
        },
        config: withCapabilityRoute(baseRequest().config, 'plain_response'),
      }),
    );

    expect(mockPostJson).toHaveBeenCalledTimes(2);
    const retryPayload = mockPostJson.mock.calls[1]?.[1] as {
      messages: Array<{ role: string; content?: string }>;
      tools?: Array<{ function?: { name?: string } }>;
      tool_choice?: unknown;
    };
    expect(toolNamesFromPayload(retryPayload)).toEqual(['schedule_once_task']);
    expect(retryPayload.tool_choice).toBe('required');
    expect(res.result).toContain('Scheduled task for this chat');
  });

  it('returns a clear host-file failure when the model keeps avoiding host-file tools', async () => {
    mockPostJson
      .mockResolvedValue({
        choices: [
          {
            message: {
              content:
                "I don't have direct visibility into the files on your computer unless you share them with me.",
              tool_calls: [],
            },
          },
        ],
      });
    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt: 'can you see my desktop folders?',
        config: withCapabilityRoute(baseRequest().config, 'host_file_operation'),
      }),
    );

    expect(mockPostJson).toHaveBeenCalledTimes(3);
    const firstPayload = mockPostJson.mock.calls[0]?.[1] as {
      tools?: Array<{ function?: { name?: string } }>;
      tool_choice?: unknown;
    };
    expect(firstPayload.tool_choice).toBe('required');
    expect(res.result).toContain("couldn't complete a valid file-access step");
  });

  it('retries host-file turns when the model prints a fake move_host_path tool payload as text', async () => {
    const desktopDir = path.join(testIpcBase, 'Desktop');
    const projectsDir = path.join(desktopDir, 'Projects');
    const sourceDir = path.join(desktopDir, 'Fridge recipe');
    const destinationDir = path.join(projectsDir, 'Fridge recipe');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(projectsDir, { recursive: true });
    process.env.NANOCLAW_HOST_DIRECTORIES = JSON.stringify({
      directories: [
        {
          path: desktopDir,
          label: 'Desktop',
          readonly: false,
        },
      ],
    });

    mockPostJson
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify(
                {
                  tool: 'move_host_path',
                  parameters: {
                    source_path: sourceDir,
                    destination_path: destinationDir,
                  },
                },
                null,
                2,
              ),
              tool_calls: [],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'tool-host-move-1',
                  type: 'function',
                  function: {
                    name: 'move_host_path',
                    arguments: JSON.stringify({
                      source_path: sourceDir,
                      destination_path: destinationDir,
                    }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'Moved the folder successfully.',
              tool_calls: [],
            },
          },
        ],
      });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt:
          'Move the Fridge recipe folder into the Projects folder on my desktop.',
        config: withCapabilityRoute(
          baseRequest().config,
          'host_file_operation',
        ),
      }),
    );

    expect(mockPostJson).toHaveBeenCalledTimes(3);
    const retryPayload = mockPostJson.mock.calls[1]?.[1] as {
      messages: Array<{ role: string; content?: string }>;
      tool_choice?: unknown;
    };
    const retryMessage = retryPayload.messages[retryPayload.messages.length - 1];
    expect(retryPayload.tool_choice).toBe('required');
    expect(retryMessage?.content).toContain(
      'This is still a host-file turn. Use a host-file action tool now',
    );
    expect(mockPostJson).toHaveBeenCalledTimes(3);
    expect(typeof res.result).toBe('string');
  });

  it('uses best-effort answer when web context refusal text is returned', async () => {
    mockPostJson
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: "I can't provide a specific answer based on the given web context.",
              tool_calls: [],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content:
                "Based on recent releases, GPT-5.x and Claude 4.5 are generally top coding models, with tradeoffs in speed and cost.",
            },
          },
        ],
      });

    mockExecuteWebSearch.mockResolvedValueOnce({
      ok: true,
      restricted: false,
      content:
        'Query: best coding model\n\nSearch page summary: there was an error with duckduckgo result rendering.',
    });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt: 'which is best coding model as of recent releases',
        config: withCapabilityRoute(baseRequest().config, 'web_lookup'),
      }),
    );

    expect(res.result).toContain('GPT-5');
    expect(res.result).not.toContain('based on the given web context');
  });

  it('rescues explicit latest-update prompts when the model falls back to stale knowledge-cutoff text', async () => {
    mockPostJson
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content:
                'As of my knowledge cutoff in 2024, there has not been a major overhaul. Check official sources for the latest updates.',
              tool_calls: [],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content:
                'Claude Code added recurring /loop support and workflow improvements in late 2025.',
            },
          },
        ],
      });

    mockExecuteWebSearch.mockResolvedValueOnce({
      ok: true,
      restricted: false,
      content:
        'Query: latest updates to the Claude CLI\n\nSources:\n1. Claude Code releases | https://github.com/anthropics/claude-code/releases | Added /loop support.\n2. CLI reference | https://code.claude.com/docs/en/cli-reference | Current command docs.',
    });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt: 'can u give latest news on claude cli',
        config: withCapabilityRoute(baseRequest().config, 'web_lookup'),
      }),
    );

    expect(mockExecuteWebSearch).toHaveBeenCalledTimes(1);
    expect(res.result).toContain('/loop support');
    expect(res.result).not.toContain('knowledge cutoff');
  });

  it('returns direct no-tool answer for non-web prompt without fallback detour', async () => {
    mockPostJson.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'Use tests and small iterations to write better code.',
            tool_calls: [],
          },
        },
      ],
    });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt:
          'how do u think the best way to write code in this day and age?',
      }),
    );

    expect(res.result).toContain('small iterations');
    expect(mockExecuteWebSearch).not.toHaveBeenCalled();
  });

  it('does not expose web behavior when runtime profile disables web tools', async () => {
    mockPostJson.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'I can still help think through the project direction.',
          },
        },
      ],
    });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt: 'look up the latest AI news',
        config: {
          provider: 'openai_compatible',
          model: 'test-model',
          baseUrl: 'http://localhost:1234/v1',
          toolPolicy: {
            web: {
              enabled: false,
            },
          },
          capabilities: {
            supportsResponses: false,
            supportsChatCompletions: true,
            supportsTools: true,
            supportsStreaming: false,
            requiresApiKey: false,
            checkedAt: new Date().toISOString(),
          },
        },
      }),
    );

    expect(res.result).toContain('project direction');
    expect(mockExecuteWebSearch).not.toHaveBeenCalled();
    expect(mockPostJson).toHaveBeenCalledWith(
      'http://localhost:1234/v1/chat/completions',
      expect.objectContaining({
        messages: expect.arrayContaining([
          {
            role: 'user',
            content: 'look up the latest AI news',
          },
        ]),
      }),
      expect.any(Object),
      expect.any(Number),
    );
  });

  it('keeps non-web prompts conversational when WEB_TOOL_ENABLE_MODE is auto', async () => {
    mockPostJson.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'You are learning by building, and that work is valid.',
          },
        },
      ],
    });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt:
          'i am worried whether building apps with ai tools is helping me learn',
        secrets: {
          WEB_TOOL_ENABLE_MODE: 'auto',
        },
      }),
    );

    expect(res.result).toContain('learning by building');
    expect(mockExecuteWebSearch).not.toHaveBeenCalled();
    expect(mockPostJson).toHaveBeenCalledTimes(1);
    expect(mockPostJson).toHaveBeenCalledWith(
      'http://localhost:1234/v1/chat/completions',
      expect.objectContaining({
        messages: expect.arrayContaining([
          {
            role: 'user',
            content:
              'i am worried whether building apps with ai tools is helping me learn',
          },
        ]),
      }),
      expect.any(Object),
      expect.any(Number),
    );
  });

  it('keeps plain-response turns limited to safe memory tools', async () => {
    mockPostJson.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'That implementation plan looks solid overall.',
          },
        },
      ],
    });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt:
          'what do you think of this implementation plan for our memory system?',
        config: {
          provider: 'openai_compatible',
          model: 'test-model',
          baseUrl: 'http://localhost:1234/v1',
          toolPolicy: {
            web: { enabled: true },
            browser: { enabled: true },
          },
          capabilities: {
            supportsResponses: false,
            supportsChatCompletions: true,
            supportsTools: true,
            supportsStreaming: false,
            requiresApiKey: false,
            checkedAt: new Date().toISOString(),
          },
        },
      }),
    );

    expect(res.result).toContain('looks solid overall');
    expect(mockPostJson).toHaveBeenCalledTimes(1);
    const payload = mockPostJson.mock.calls[0]?.[1] as {
      tools?: Array<{ function?: { name?: string } }>;
      messages: Array<{ role: string; content?: string }>;
    };
    const names = toolNamesFromPayload(payload);
    expect(payload.messages[0]?.role).toBe('system');
    expect(names).toContain('remember_this');
    expect(names).toContain('memory_search');
    expect(names).not.toContain('schedule_task');
    expect(names).not.toContain('register_watch');
    expect(names).not.toContain('web_search');
  });

  it('treats pasted tracking-tag explanations as conversational instead of browser work', async () => {
    mockPostJson.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content:
              'This is a LinkedIn Insight Tag. Your task is to place that tracking snippet on the site so LinkedIn can measure visits and conversions.',
          },
        },
      ],
    });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt: [
          'My manager gave me this message:',
          '<script type="text/javascript"> _linkedin_partner_id = "8816634"; window._linkedin_data_partner_ids = window._linkedin_data_partner_ids || []; window._linkedin_data_partner_ids.push(_linkedin_partner_id); </script>',
          '<script type="text/javascript">(function(l) { var s = document.getElementsByTagName("script")[0]; var b = document.createElement("script"); b.src = "https://snap.licdn.com/li.lms-analytics/insight.min.js"; s.parentNode.insertBefore(b, s);})(window.lintrk); </script>',
          '<noscript><img src="https://px.ads.linkedin.com/collect/?pid=8816634&fmt=gif" /></noscript>',
          'I do not know what this work is exactly. Please explain it.',
        ].join('\n'),
        config: {
          provider: 'openai_compatible',
          model: 'test-model',
          baseUrl: 'http://localhost:1234/v1',
          toolPolicy: {
            web: { enabled: true },
            browser: { enabled: true },
          },
          capabilities: {
            supportsResponses: false,
            supportsChatCompletions: true,
            supportsTools: true,
            supportsStreaming: false,
            requiresApiKey: false,
            checkedAt: new Date().toISOString(),
          },
        },
      }),
    );

    expect(res.result).toContain('LinkedIn Insight Tag');
    expect(mockPostJson).toHaveBeenCalledTimes(1);
    expect(mockPostJson).toHaveBeenCalledWith(
      'http://localhost:1234/v1/chat/completions',
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('Please explain it.'),
          }),
        ]),
      }),
      expect.any(Object),
      expect.any(Number),
    );
    const payload = mockPostJson.mock.calls[0]?.[1] as {
      tools?: Array<{ function?: { name?: string } }>;
    };
    const names = toolNamesFromPayload(payload);
    expect(names).toContain('remember_this');
    expect(names).toContain('memory_search');
    expect(names).not.toContain('schedule_task');
    expect(names).not.toContain('register_watch');
    expect(names).not.toContain('browser_open_url');
    expect(names).not.toContain('web_search');
  });

  it('prefixes qwen3 prompts with /no_think for direct chat completions', async () => {
    mockPostJson.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '<think>\n\n</think>\n\nOK',
            tool_calls: [],
          },
        },
      ],
    });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt: 'Reply with exactly: OK',
        config: {
          provider: 'openai_compatible',
          model: 'qwen/qwen3-8b',
          baseUrl: 'http://127.0.0.1:1234/v1',
          capabilities: {
            supportsResponses: false,
            supportsChatCompletions: true,
            supportsTools: true,
            supportsStreaming: false,
            requiresApiKey: false,
            checkedAt: new Date().toISOString(),
          },
        },
      }),
    );

    expect(res.result).toBe('OK');
    expect(mockPostJson).toHaveBeenCalledWith(
      'http://127.0.0.1:1234/v1/chat/completions',
      expect.objectContaining({
        messages: expect.arrayContaining([
          {
            role: 'user',
            content: '/no_think\nReply with exactly: OK',
          },
        ]),
      }),
      expect.any(Object),
      expect.any(Number),
    );
  });

  it('does not trigger web tools for a simple current message when older context mentions latest/news', async () => {
    mockPostJson.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'Hello there.',
            tool_calls: [],
          },
        },
      ],
    });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt: [
          'You are Andy, continuing an ongoing conversation.',
          '',
          '[Previous conversation summary]',
          '- User previously asked for the latest AI news and benchmark updates.',
          '',
          '[Current message - respond to this]',
          'posan: hello',
        ].join('\n'),
      }),
    );

    expect(res.result).toBe('Hello there.');
    expect(mockExecuteWebSearch).not.toHaveBeenCalled();
  });

  it('trims oversized local tool prompts while preserving the current message', async () => {
    mockPostJson.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'Still here.',
            tool_calls: [],
          },
        },
      ],
    });

    const hugeHistory = 'Earlier context. '.repeat(700);
    const hugeSystem = 'System rule. '.repeat(320);
    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        systemPrompt: hugeSystem,
        prompt: [
          hugeHistory,
          '',
          '[Current message - respond to this]',
          '<messages>',
          '<message sender="rishi" time="2026-03-07T13:00:00.000Z">hello there from the current turn</message>',
          '</messages>',
        ].join('\n'),
      }),
    );

    expect(res.result).toBe('Still here.');
    const payload = mockPostJson.mock.calls[0][1] as {
      messages: Array<{ role: string; content?: string }>;
    };
    const joined = payload.messages
      .map((message) => message.content || '')
      .join('\n');
    expect(joined.length).toBeLessThanOrEqual(7200);
    expect(joined).toContain('[Current message - respond to this]');
    expect(joined).toContain('hello there from the current turn');
  });

  it('caps cloud plain-response turns even when no tool calls are made', async () => {
    mockPostJson.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'Detailed answer.',
            tool_calls: [],
          },
        },
      ],
    });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt: 'hello there',
        secrets: {
          ...baseRequest().secrets,
          OPENAI_MAX_OUTPUT_TOKENS: '2048',
        },
        config: withCapabilityRoute(
          {
            ...baseRequest().config,
            baseUrl: 'https://api.deepinfra.com/v1/openai',
          },
          'plain_response',
        ),
      }),
    );

    expect(res.result).toBe('Detailed answer.');
    expect(mockPostJson).toHaveBeenNthCalledWith(
      1,
      'https://api.deepinfra.com/v1/openai/chat/completions',
      expect.objectContaining({
        max_tokens: 2048,
      }),
      expect.any(Object),
      expect.any(Number),
    );
  });

  it('uses looser cloud-safe sanitization while redacting sensitive runtime details', async () => {
    mockPostJson.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'Cloud ready.',
            tool_calls: [],
          },
        },
      ],
    });

    const adapter = new OpenAIRuntimeAdapter();
    await adapter.run(
      baseRequest({
        prompt: 'hello there',
        systemPrompt: [
          '## Your workspace',
          'Work from C:\\Users\\posan\\OneDrive\\Desktop\\RIA BOT\\nanoclaw and keep the current task context.',
          '',
          '## Admin context',
          'OPENAI_API_KEY=super-secret-key',
          '',
          '## Identity',
          'You are a warm, collaborative assistant.',
        ].join('\n'),
        config: withCapabilityRoute(
          {
            ...baseRequest().config,
            baseUrl: 'https://api.deepinfra.com/v1/openai',
          },
          'plain_response',
        ),
      }),
    );

    const payload = mockPostJson.mock.calls[0][1] as {
      messages: Array<{ role: string; content?: string }>;
    };
    const joined = payload.messages
      .map((message) => message.content || '')
      .join('\n');
    expect(joined).toContain('You are a warm, collaborative assistant.');
    expect(joined).toContain('[redacted-path]');
    expect(joined).not.toContain('super-secret-key');
    expect(joined).not.toContain('OPENAI_API_KEY');
    expect(joined).not.toContain(
      'C:\\Users\\posan\\OneDrive\\Desktop\\RIA BOT\\nanoclaw',
    );
  });

  it('strips think blocks from direct model replies', async () => {
    mockPostJson.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content:
              '<think>I should reason privately here.</think>\n\nFinal answer for the user.',
            tool_calls: [],
          },
        },
      ],
    });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt: 'say hello',
      }),
    );

    expect(res.result).toBe('Final answer for the user.');
  });

  it('drops dangling think blocks from direct model replies', async () => {
    mockPostJson.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '<think>I should reason privately here without emitting a final answer.',
            tool_calls: [],
          },
        },
      ],
    });

    const adapter = new OpenAIRuntimeAdapter();
    await expect(
      adapter.run(
        baseRequest({
          prompt: 'say hello',
        }),
      ),
    ).rejects.toThrow(/no text output/i);
  });

  it('propagates a timeout when the local runtime times out on hello', async () => {
    mockPostJson.mockRejectedValueOnce(
      new Error(
        'Request timeout after 20000ms for http://127.0.0.1:1234/v1/chat/completions',
      ),
    );

    const adapter = new OpenAIRuntimeAdapter();
    await expect(
      adapter.run(
        baseRequest({
          prompt: 'hello',
        }),
      ),
    ).rejects.toThrow(/Request timeout after 20000ms/);
    expect(mockExecuteWebSearch).not.toHaveBeenCalled();
  });

  it('propagates a timeout when the continuity prompt wraps hello in message XML', async () => {
    mockPostJson.mockRejectedValueOnce(
      new Error(
        'Request timeout after 20000ms for http://127.0.0.1:1234/v1/chat/completions',
      ),
    );

    const adapter = new OpenAIRuntimeAdapter();
    await expect(
      adapter.run(
        baseRequest({
          prompt: [
            'You are Andy, continuing an ongoing conversation.',
            '',
            '[Previous conversation summary]',
            '- User previously asked for the latest AI news.',
            '',
            '[Current message - respond to this]',
            '<messages>',
            '<message sender="rishi" time="2026-03-07T13:00:00.000Z">hello</message>',
            '</messages>',
          ].join('\n'),
        }),
      ),
    ).rejects.toThrow(/Request timeout after 20000ms/);
    expect(mockExecuteWebSearch).not.toHaveBeenCalled();
  });

  it('propagates a timeout when the local runtime times out on a casual message', async () => {
    mockPostJson.mockRejectedValueOnce(
      new Error(
        'Request timeout after 30000ms for http://127.0.0.1:1234/v1/chat/completions',
      ),
    );

    const adapter = new OpenAIRuntimeAdapter();
    await expect(
      adapter.run(
        baseRequest({
          prompt: 'you there?',
        }),
      ),
    ).rejects.toThrow(/Request timeout after 30000ms/);
    expect(mockExecuteWebSearch).not.toHaveBeenCalled();
  });

  it('propagates a timeout when the tool-capable turn never reaches any tool call', async () => {
    mockPostJson.mockRejectedValueOnce(
      new Error(
        'Request timeout after 4096ms for http://127.0.0.1:1234/v1/chat/completions',
      ),
    );

    const adapter = new OpenAIRuntimeAdapter();
    await expect(
      adapter.run(
        baseRequest({
          prompt: 'current weather in hyderabad',
        }),
      ),
    ).rejects.toThrow(/Request timeout after 4096ms/);
    expect(mockExecuteWebSearch).not.toHaveBeenCalled();
  });

  it('forces web prefetch when tool calls started but no final assistant text arrived', async () => {
    mockPostJson
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'tool-1',
                  type: 'function',
                  function: {
                    name: 'web_search',
                    arguments: JSON.stringify({ query: 'latest ai news' }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockRejectedValueOnce(
        new Error(
          'Request timeout after 4096ms for http://127.0.0.1:1234/v1/chat/completions',
        ),
      );

    mockExecuteWebSearch
      .mockResolvedValueOnce({
        ok: false,
        content: 'Web search failed: ECONNREFUSED',
      })
      .mockResolvedValueOnce({
        ok: false,
        content: 'Web search failed: ECONNREFUSED',
      });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        config: withCapabilityRoute(baseRequest().config, 'web_lookup'),
      }),
    );

    expect(mockExecuteWebSearch).toHaveBeenCalledTimes(1);
    expect(res.result).toContain('Web search failed: ECONNREFUSED');
    expect(res.result).not.toContain(
      "I couldn't complete a live web lookup right now",
    );
  });

  it('saves and expands sources after an actual tool-assisted web turn', async () => {
    mockPostJson
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'tool-1',
                  type: 'function',
                  function: {
                    name: 'web_search',
                    arguments: JSON.stringify({ query: 'latest ai news' }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'OpenAI announced improvements in benchmark reliability.',
              tool_calls: [],
            },
          },
        ],
      });

    mockExecuteWebSearch.mockResolvedValueOnce({
      ok: true,
      restricted: false,
      content:
        'Query: latest ai news\n\nSources:\n1. OpenAI news | https://openai.com/news | Updates.\n2. ZDNET report | https://www.zdnet.com/article/test | Benchmarks.',
    });

    const adapter = new OpenAIRuntimeAdapter();
    const first = await adapter.run(
      baseRequest({
        config: withCapabilityRoute(baseRequest().config, 'web_lookup'),
      }),
    );
    expect(first.result).toContain('benchmark reliability');

    const second = await adapter.run(
      baseRequest({
        prompt: 'show sources',
      }),
    );
    expect(second.result).toContain('Sources for: latest ai news');
    expect(second.result).toContain('<https://openai.com/news>');
  });

  it('does not save sources when the model never actually uses a web tool', async () => {
    mockPostJson
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content:
                "I couldn't complete a live web lookup right now. Please retry in a moment.",
              tool_calls: [],
            },
          },
        ],
      });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(baseRequest());

    expect(mockExecuteWebSearch).not.toHaveBeenCalled();
    expect(res.result).toContain("I couldn't complete a live web lookup right now");
  });

  it('returns compact source footer and expands on show sources', async () => {
    mockPostJson
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: "I can't access real-time updates without web.",
              tool_calls: [],
            },
          },
        ],
      });

    const adapter = new OpenAIRuntimeAdapter();
    const first = await adapter.run(baseRequest());
    expect(first.result).toContain("can't access real-time updates");

    const second = await adapter.run(
      baseRequest({
        prompt: 'show sources',
      }),
    );
    expect(second.result).toContain('No recent web sources found');
  });

  it('enters the tool loop for browser-intent prompts when browser policy is enabled', async () => {
    mockExecuteWebSearch.mockResolvedValueOnce({
      ok: true,
      restricted: false,
      content:
        'Query: open the website and log in to the dashboard\n\nSources:\n1. Example Login | https://example.com/login | Official login page.',
    });
    mockPostJson.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'tool-1',
                type: 'function',
                function: {
                  name: 'browser_open_url',
                  arguments: JSON.stringify({ url: 'https://example.com/login' }),
                },
              },
            ],
          },
        },
      ],
    }).mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'I opened the login page in the managed browser session.',
            tool_calls: [],
          },
        },
      ],
    });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt: 'open the website and log in to the dashboard',
        systemPrompt: [
          '# Andy',
          '',
          'You are Andy, a personal assistant.',
          '## What You Can Do',
          '- Browse the web with agent-browser',
          '- Run bash commands in your sandbox',
          '## Communication',
          'Keep responses clear.',
        ].join('\n'),
        config: {
          provider: 'openai_compatible',
          model: 'test-model',
          baseUrl: 'http://localhost:1234/v1',
          capabilityRoute: 'browser_operation',
          toolPolicy: {
            web: { enabled: true },
            browser: { enabled: true },
          },
          capabilities: {
            supportsResponses: false,
            supportsChatCompletions: true,
            supportsTools: true,
            supportsStreaming: false,
            requiresApiKey: false,
            checkedAt: new Date().toISOString(),
          },
        },
      }),
    );

    expect(res.result).toContain('managed browser session');
    expect(mockCloseBrowserSession).toHaveBeenCalledTimes(1);
    expect(mockPostJson).toHaveBeenNthCalledWith(
      1,
      'http://localhost:1234/v1/chat/completions',
      expect.objectContaining({
        tool_choice: 'required',
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining(
              'If the user names a site or product but does not give a URL, use web_search first',
            ),
          }),
          expect.objectContaining({
            role: 'user',
            content: 'open the website and log in to the dashboard',
          }),
        ]),
      }),
      expect.any(Object),
      expect.any(Number),
    );
    const firstPayload = mockPostJson.mock.calls[0]?.[1] as {
      tools?: Array<{ function?: { name?: string } }>;
      tool_choice?: unknown;
    };
    const toolNames =
      firstPayload.tools?.map((tool) => tool.function?.name).filter(Boolean) || [];
    expect(toolNames).toContain('browser_open_url');
    expect(toolNames).toContain('create_plan');
    expect(firstPayload.tool_choice).toBe('required');
    expect(firstPayload.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          content: expect.stringContaining('https://example.com/login'),
        }),
        expect.objectContaining({
          role: 'system',
          content: expect.not.stringContaining('agent-browser'),
        }),
      ]),
    );
  });

  it('bootstraps browser turns with an obvious domain before asking the model to continue', async () => {
    mockPostJson
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'I opened the site and reviewed the initial page state.',
              tool_calls: [],
            },
          },
        ],
      });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt: 'open the website vibelevel.ai and tell me what the site is about',
        config: {
          provider: 'openai_compatible',
          model: 'test-model',
          baseUrl: 'http://localhost:1234/v1',
          capabilityRoute: 'browser_operation',
          toolPolicy: {
            web: { enabled: true },
            browser: { enabled: true },
          },
          capabilities: {
            supportsResponses: false,
            supportsChatCompletions: true,
            supportsTools: true,
            supportsStreaming: false,
            requiresApiKey: false,
            checkedAt: new Date().toISOString(),
          },
        },
      }),
    );

    expect(res.result).toContain('opened the site');
    expect(mockPostJson).toHaveBeenCalledTimes(1);
    expect(mockPostJson).toHaveBeenNthCalledWith(
      1,
      'http://localhost:1234/v1/chat/completions',
      expect.objectContaining({
        tool_choice: 'auto',
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            tool_calls: expect.arrayContaining([
              expect.objectContaining({
                function: expect.objectContaining({
                  name: 'browser_open_url',
                  arguments: JSON.stringify({ url: 'https://vibelevel.ai' }),
                }),
              }),
            ]),
          }),
          expect.objectContaining({
            role: 'tool',
            content: expect.stringContaining('Opened browser session'),
          }),
          expect.objectContaining({
            role: 'tool',
            content: expect.stringContaining('Snapshot'),
          }),
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining(
              'Resolved target URL for this turn: https://vibelevel.ai',
            ),
          }),
        ]),
      }),
      expect.any(Object),
      expect.any(Number),
    );
  });

  it('nudges browser turns back into tool use when the first reply deflects conversationally', async () => {
    mockPostJson
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content:
                'It looks like there was an issue accessing the website. Let me try a different approach.',
              tool_calls: [],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'tool-1',
                  type: 'function',
                  function: {
                    name: 'create_plan',
                    arguments: JSON.stringify({
                      taskAnalysis:
                        'Need to inspect the live site after a failed first attempt and then summarize findings.',
                      steps: [
                        {
                          id: 1,
                          action: 'Inspect the current site state',
                          toolsNeeded: ['browser_extract_text'],
                        },
                      ],
                    }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'I found the official site and can continue in the browser.',
              tool_calls: [],
            },
          },
        ],
      });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt: 'log in and see for yourself on VibeLevel.ai',
        config: {
          provider: 'openai_compatible',
          model: 'test-model',
          baseUrl: 'http://localhost:1234/v1',
          capabilityRoute: 'browser_operation',
          toolPolicy: {
            web: { enabled: true },
            browser: { enabled: true },
          },
          capabilities: {
            supportsResponses: false,
            supportsChatCompletions: true,
            supportsTools: true,
            supportsStreaming: false,
            requiresApiKey: false,
            checkedAt: new Date().toISOString(),
          },
        },
      }),
    );

    expect(res.result).toContain('official site');
    expect(mockExecuteWebSearch).not.toHaveBeenCalled();
    expect(mockPostJson).toHaveBeenNthCalledWith(
      2,
      'http://localhost:1234/v1/chat/completions',
      expect.objectContaining({
        tool_choice: 'required',
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining(
              'This is still a browser-operation turn.',
            ),
          }),
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining(
              'browser is already open at https://VibeLevel.ai',
            ),
          }),
        ]),
      }),
      expect.any(Object),
      expect.any(Number),
    );
  });

  it('synthesizes a final answer when browser tools ran but the visible reply is empty', async () => {
    mockPostJson
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'tool-1',
                  type: 'function',
                  function: {
                    name: 'browser_click',
                    arguments: JSON.stringify({ ref: '8' }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '<think>Checking the page state.</think>',
              tool_calls: [],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content:
                'I reached the dashboard entry page, and VibeLevel appears to be an AI product focused on creative workflow support.',
            },
          },
        ],
      });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt: 'log into the dashboard of vibelevel.ai and check what their product is about',
        config: {
          provider: 'openai_compatible',
          model: 'test-model',
          baseUrl: 'http://localhost:1234/v1',
          capabilityRoute: 'browser_operation',
          toolPolicy: {
            web: { enabled: true },
            browser: { enabled: true },
          },
          capabilities: {
            supportsResponses: false,
            supportsChatCompletions: true,
            supportsTools: true,
            supportsStreaming: false,
            requiresApiKey: false,
            checkedAt: new Date().toISOString(),
          },
        },
      }),
    );

    expect(res.result).toContain('VibeLevel');
    expect(mockPostJson).toHaveBeenCalledTimes(3);
    expect(mockPostJson).toHaveBeenNthCalledWith(
      3,
      'http://localhost:1234/v1/chat/completions',
      expect.objectContaining({
        max_tokens: 1400,
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining(
              'Synthesize the completed tool results into a clear, comprehensive response',
            ),
          }),
        ]),
      }),
      expect.any(Object),
      expect.any(Number),
    );
    const thirdPayload = mockPostJson.mock.calls[2]?.[1] as {
      tools?: unknown;
    };
    expect(thirdPayload.tools).toBeUndefined();
  });

  it('adds a resolved target URL hint and keeps first tool-turn completions compact', async () => {
    mockPostJson
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'tool-1',
                  type: 'function',
                  function: {
                    name: 'browser_open_url',
                    arguments: JSON.stringify({ url: 'https://vibelevel.ai' }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'I opened the target site.',
              tool_calls: [],
            },
          },
        ],
      });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt: 'log into the dashboard of vibelevel.ai and check what their product is about',
        config: {
          provider: 'openai_compatible',
          model: 'test-model',
          baseUrl: 'http://localhost:1234/v1',
          capabilityRoute: 'browser_operation',
          toolPolicy: {
            web: { enabled: true },
            browser: { enabled: true },
          },
          capabilities: {
            supportsResponses: false,
            supportsChatCompletions: true,
            supportsTools: true,
            supportsStreaming: false,
            requiresApiKey: false,
            checkedAt: new Date().toISOString(),
          },
        },
      }),
    );

    expect(res.result).toContain('opened the target site');
    expect(mockPostJson).toHaveBeenNthCalledWith(
      1,
      'http://localhost:1234/v1/chat/completions',
      expect.objectContaining({
        max_tokens: 280,
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining(
              'Resolved target URL for this turn: https://vibelevel.ai',
            ),
          }),
        ]),
      }),
      expect.any(Object),
      expect.any(Number),
    );
  });

  it('keeps the first cloud tool-loop completion bounded before any tool calls', async () => {
    mockPostJson
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'tool-1',
                  type: 'function',
                  function: {
                    name: 'browser_open_url',
                    arguments: JSON.stringify({ url: 'https://vibelevel.ai' }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'I opened the target site.',
              tool_calls: [],
            },
          },
        ],
      });

    const adapter = new OpenAIRuntimeAdapter();
    const res = await adapter.run(
      baseRequest({
        prompt: 'log into the dashboard of vibelevel.ai and check what their product is about',
        config: {
          provider: 'openai_compatible',
          model: 'test-model',
          baseUrl: 'https://api.deepinfra.com/v1/openai',
          capabilityRoute: 'browser_operation',
          toolPolicy: {
            web: { enabled: true },
            browser: { enabled: true },
          },
          capabilities: {
            supportsResponses: false,
            supportsChatCompletions: true,
            supportsTools: true,
            supportsStreaming: false,
            requiresApiKey: false,
            checkedAt: new Date().toISOString(),
          },
        },
      }),
    );

    expect(res.result).toContain('opened the target site');
    expect(mockPostJson).toHaveBeenNthCalledWith(
      1,
      'https://api.deepinfra.com/v1/openai/chat/completions',
      expect.objectContaining({
        max_tokens: 900,
      }),
      expect.any(Object),
      expect.any(Number),
    );
  });

  it('exposes create_plan for structurally multi-step browser work', async () => {
    mockPostJson
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'I opened the target site.',
              tool_calls: [],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'I reached the target site and reviewed the initial page.',
              tool_calls: [],
            },
          },
        ],
      });

    const adapter = new OpenAIRuntimeAdapter();
    await adapter.run(
      baseRequest({
        prompt:
          'log into the dashboard of vibelevel.ai, inspect the product flow, then summarize what it does and verify any blockers',
        config: {
          provider: 'openai_compatible',
          model: 'test-model',
          baseUrl: 'http://localhost:1234/v1',
          capabilityRoute: 'browser_operation',
          toolPolicy: {
            web: { enabled: true },
            browser: { enabled: true },
          },
          capabilities: {
            supportsResponses: false,
            supportsChatCompletions: true,
            supportsTools: true,
            supportsStreaming: false,
            requiresApiKey: false,
            checkedAt: new Date().toISOString(),
          },
        },
      }),
    );

    const payload = mockPostJson.mock.calls[0]?.[1] as {
      tools?: Array<{ function?: { name?: string } }>;
      tool_choice?: unknown;
    };
    const names = toolNamesFromPayload(payload);
    expect(names).toContain('browser_open_url');
    expect(names).toContain('create_plan');
    expect(payload.tool_choice).toBe('required');
  });

  it('switches from create_plan to critique_response after a plan exists', async () => {
    mockPostJson
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'plan-1',
                  type: 'function',
                  function: {
                    name: 'create_plan',
                    arguments: JSON.stringify({
                      taskAnalysis: 'Need to inspect the dashboard, extract findings, and verify blockers.',
                      steps: [
                        { id: 1, action: 'Open the dashboard', toolsNeeded: ['browser_open_url'] },
                        { id: 2, action: 'Inspect the product flow', toolsNeeded: ['browser_snapshot', 'browser_extract_text'] },
                      ],
                    }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'The site was inspected and the key blockers were noted.',
              tool_calls: [],
            },
          },
        ],
      });

    const adapter = new OpenAIRuntimeAdapter();
    await adapter.run(
      baseRequest({
        prompt:
          'review this dashboard carefully: log into vibelevel.ai, inspect the flow, and verify blockers before answering',
        config: {
          provider: 'openai_compatible',
          model: 'test-model',
          baseUrl: 'http://localhost:1234/v1',
          capabilityRoute: 'browser_operation',
          toolPolicy: {
            web: { enabled: true },
            browser: { enabled: true },
          },
          capabilities: {
            supportsResponses: false,
            supportsChatCompletions: true,
            supportsTools: true,
            supportsStreaming: false,
            requiresApiKey: false,
            checkedAt: new Date().toISOString(),
          },
        },
      }),
    );

    const firstPayload = mockPostJson.mock.calls[0]?.[1] as {
      tools?: Array<{ function?: { name?: string } }>;
      tool_choice?: unknown;
    };
    const secondPayload = mockPostJson.mock.calls[1]?.[1] as {
      tools?: Array<{ function?: { name?: string } }>;
      tool_choice?: unknown;
    };
    const firstNames = toolNamesFromPayload(firstPayload);
    const secondNames = toolNamesFromPayload(secondPayload);
    expect(firstNames).toContain('browser_open_url');
    expect(firstNames).toContain('create_plan');
    expect(secondNames).not.toContain('create_plan');
    expect(secondNames).toContain('critique_response');
    expect(secondNames).toContain('browser_open_url');
    expect(firstPayload.tool_choice).toBe('required');
    expect(secondPayload.tool_choice).toBe('auto');
  });
});

describe('host_file_operation contract', () => {
  it('list_host_directories is not in the textual contract matcher regex', () => {
    const contractRegex = /^(read_host_file|write_host_file|edit_host_file|glob_host_files|grep_host_files|make_host_directory|move_host_path|copy_host_path)$/;
    expect(contractRegex.test('list_host_directories')).toBe(false);
    expect(contractRegex.test('list_host_entries')).toBe(false);
    expect(contractRegex.test('read_host_file')).toBe(true);
    expect(contractRegex.test('write_host_file')).toBe(true);
  });

  it('tool_choice stays required after list_host_directories until an action tool satisfies the contract', async () => {
    // Iteration 1: model calls list_host_directories (does NOT satisfy contract)
    // Iteration 2: model calls list_host_entries (DOES satisfy contract)
    // Iteration 3: model generates final text
    mockPostJson
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: '',
            tool_calls: [{
              id: 'hf-1',
              type: 'function',
              function: {
                name: 'list_host_directories',
                arguments: '{}',
              },
            }],
          },
        }],
      })
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: '',
            tool_calls: [{
              id: 'hf-2',
              type: 'function',
              function: {
                name: 'list_host_entries',
                arguments: JSON.stringify({ path: '/tmp/test' }),
              },
            }],
          },
        }],
      })
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: 'Here are your files: file1.txt, file2.txt',
            tool_calls: [],
          },
        }],
      });

    const adapter = new OpenAIRuntimeAdapter();
    const result = await adapter.run(
      baseRequest({
        prompt: '[Current message - respond to this]\nShow me what files are in my Desktop folder',
        config: {
          provider: 'openai_compatible',
          model: 'test-model',
          baseUrl: 'http://localhost:1234/v1',
          capabilityRoute: 'host_file_operation',
          toolPolicy: {},
          capabilities: {
            supportsResponses: false,
            supportsChatCompletions: true,
            supportsTools: true,
            supportsStreaming: false,
            requiresApiKey: false,
            checkedAt: new Date().toISOString(),
          },
        },
        secrets: {},
      }),
    );

    // Should have made at least 2 API calls
    expect(mockPostJson.mock.calls.length).toBeGreaterThanOrEqual(2);

    const firstPayload = mockPostJson.mock.calls[0]?.[1] as { tool_choice?: unknown };
    const secondPayload = mockPostJson.mock.calls[1]?.[1] as { tool_choice?: unknown };

    // Iteration 1: tool_choice MUST be 'required' (force first tool call)
    expect(firstPayload.tool_choice).toBe('required');
    // Iteration 2: tool_choice MUST STILL be 'required' (list_host_directories didn't satisfy contract)
    // This is the key fix — previously this was 'auto', letting local models skip the action tool
    expect(secondPayload.tool_choice).toBe('required');
  });

  it('list_host_entries does not satisfy the contract — model must use an action tool', async () => {
    // Scenario: user asks to "organize" a folder
    // Iter 1: model calls list_host_directories → not satisfied
    // Iter 2: model calls list_host_entries → should NOT satisfy contract
    // Iter 3: model should still be forced (tool_choice=required) to call move_host_path
    // Planner is disabled to isolate the contract behavior from planner forcing.
    mockPostJson
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: '',
            tool_calls: [{
              id: 'hf-1',
              type: 'function',
              function: { name: 'list_host_directories', arguments: '{}' },
            }],
          },
        }],
      })
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: '',
            tool_calls: [{
              id: 'hf-2',
              type: 'function',
              function: { name: 'list_host_entries', arguments: JSON.stringify({ path: '/tmp/test' }) },
            }],
          },
        }],
      })
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: '',
            tool_calls: [{
              id: 'hf-3',
              type: 'function',
              function: {
                name: 'move_host_path',
                arguments: JSON.stringify({ source_path: '/tmp/test/a.txt', destination_path: '/tmp/test/archive/a.txt' }),
              },
            }],
          },
        }],
      })
      .mockResolvedValueOnce({
        choices: [{
          message: { content: 'Done! Moved a.txt into archive.', tool_calls: [] },
        }],
      });

    const adapter = new OpenAIRuntimeAdapter();
    await adapter.run(
      baseRequest({
        prompt: '[Current message - respond to this]\nOrganize my Desktop folder by moving old files into archive',
        config: {
          provider: 'openai_compatible',
          model: 'test-model',
          baseUrl: 'http://localhost:1234/v1',
          capabilityRoute: 'host_file_operation',
          plannerCritic: { enabled: false, maxRevisionCycles: 0 },
          toolPolicy: {},
          capabilities: {
            supportsResponses: false,
            supportsChatCompletions: true,
            supportsTools: true,
            supportsStreaming: false,
            requiresApiKey: false,
            checkedAt: new Date().toISOString(),
          },
        },
        secrets: { PLANNER_CRITIC_ENABLED: 'false' },
      }),
    );

    expect(mockPostJson.mock.calls.length).toBeGreaterThanOrEqual(3);

    const thirdPayload = mockPostJson.mock.calls[2]?.[1] as { tool_choice?: unknown };
    // After list_host_directories + list_host_entries, tool_choice must STILL be 'required'
    // because neither discovery tool satisfies the contract
    expect(thirdPayload.tool_choice).toBe('required');
  });
});
