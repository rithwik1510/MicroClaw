import { ToolExecutionResult, ToolHandler } from './types.js';
import { RuntimeToolPolicy } from '../runtime/types.js';
import { executeRememberThis } from './memory/remember.js';
import { executeMemorySearch } from './memory/search.js';
import {
  executeScheduleIntervalTask,
  executeScheduleOnceTask,
  executeScheduleRecurringTask,
  executeScheduleTask,
} from './tasks/schedule.js';
import { executeRegisterWatch } from './tasks/watch.js';
import {
  executeBrowserClick,
  executeBrowserClose,
  executeBrowserExtractText,
  executeBrowserOpenUrl,
  executeBrowserScreenshot,
  executeBrowserSelect,
  executeBrowserSnapshot,
  executeBrowserTabs,
  executeBrowserType,
} from './browser/actions.js';
import {
  executeWebClose,
  executeWebFetch,
  executeWebExtractText,
  executeWebGetLinks,
  executeWebOpenUrl,
  executeWebSearch,
} from './web/actions.js';

export function buildToolRegistry(): ToolHandler[] {
  return [
    {
      name: 'browser_open_url',
      family: 'browser',
      description: 'Open a URL in a host-managed browser session for multi-step interactive work.',
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      execute: executeBrowserOpenUrl,
    },
    {
      name: 'browser_snapshot',
      family: 'browser',
      description: 'Capture a compact page snapshot with stable refs for follow-up browser actions.',
      schema: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
        },
        additionalProperties: false,
      },
      execute: executeBrowserSnapshot,
    },
    {
      name: 'browser_click',
      family: 'browser',
      description: 'Click an element in the current browser page using a snapshot ref.',
      schema: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
        },
        required: ['ref'],
        additionalProperties: false,
      },
      execute: executeBrowserClick,
    },
    {
      name: 'browser_type',
      family: 'browser',
      description: 'Type text into an element in the current browser page using a snapshot ref.',
      schema: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['ref', 'text'],
        additionalProperties: false,
      },
      execute: executeBrowserType,
    },
    {
      name: 'browser_select',
      family: 'browser',
      description: 'Select a value in a browser page element using a snapshot ref.',
      schema: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['ref', 'value'],
        additionalProperties: false,
      },
      execute: executeBrowserSelect,
    },
    {
      name: 'browser_extract_text',
      family: 'browser',
      description: 'Extract readable text from the current browser page.',
      schema: {
        type: 'object',
        properties: {
          max_chars: { type: 'number' },
        },
        additionalProperties: false,
      },
      execute: executeBrowserExtractText,
    },
    {
      name: 'browser_screenshot',
      family: 'browser',
      description: 'Capture a screenshot of the current browser page for operator debugging.',
      schema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['viewport', 'full_page'] },
        },
        additionalProperties: false,
      },
      execute: executeBrowserScreenshot,
    },
    {
      name: 'browser_tabs',
      family: 'browser',
      description: 'List, focus, or close browser tabs in the current session.',
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'focus', 'close'] },
          tab_id: { type: 'string' },
        },
        additionalProperties: false,
      },
      execute: executeBrowserTabs,
    },
    {
      name: 'browser_close',
      family: 'browser',
      description: 'Close the active browser session and release host browser resources.',
      schema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      execute: executeBrowserClose,
    },
    {
      name: 'web_search',
      family: 'web',
      description:
        'Search the web for current or external information and return structured result context.',
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: executeWebSearch,
    },
    {
      name: 'web_fetch',
      family: 'web',
      description:
        'Fetch a specific URL and return readable page content without browsing interactively.',
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          max_chars: { type: 'number' },
          extract_mode: { type: 'string', enum: ['text'] },
        },
        required: ['url'],
        additionalProperties: false,
      },
      execute: executeWebFetch,
    },
    {
      name: 'web_open_url',
      family: 'web',
      description: 'Open a specific URL in the browser session.',
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      execute: executeWebOpenUrl,
    },
    {
      name: 'web_extract_text',
      family: 'web',
      description:
        'Extract readable text from the currently open web page.',
      schema: {
        type: 'object',
        properties: {
          max_chars: { type: 'number' },
        },
        additionalProperties: false,
      },
      execute: executeWebExtractText,
    },
    {
      name: 'web_get_links',
      family: 'web',
      description:
        'List links from the currently open page for source selection.',
      schema: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
        },
        additionalProperties: false,
      },
      execute: executeWebGetLinks,
    },
    {
      name: 'web_close',
      family: 'web',
      description: 'Close the active web session and release browser resources.',
      schema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      execute: executeWebClose,
    },
    {
      name: 'remember_this',
      family: 'memory',
      description: [
        'Save a durable fact to long-term memory. Only use for:',
        '- Explicit user requests: "remember that...", "always...", "never..."',
        '- Durable preferences: communication style, formatting, timezone',
        '- Stable personal facts: name, role, background',
        '- Long-term project context: project names, tech stack, constraints',
        '- Standing instructions the user wants repeated across conversations',
        'Do NOT use for: temporary task details, conversation-specific context,',
        'facts the user mentioned once casually, or things already in memory.',
      ].join('\n'),
      schema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The fact to remember (1-2 sentences, concise).',
          },
          kind: {
            type: 'string',
            enum: ['pref', 'fact', 'proj', 'loop', 'explicit'],
            description:
              'Category: pref=preference, fact=user fact, proj=project note, loop=open todo, explicit=general',
          },
          pin: {
            type: 'boolean',
            description:
              'Set true ONLY when the user says "always remember", "never forget", or "this is critical". Pinned entries are injected into every conversation regardless of topic. Use sparingly — max 5 pinned entries.',
          },
        },
        required: ['content'],
        additionalProperties: false,
      },
      execute: executeRememberThis,
    },
    {
      name: 'memory_search',
      family: 'memory',
      description:
        'Search long-term memory for a specific fact, preference, or project detail that may not be in current context. Use when you need to recall something specific mid-task.',
      schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keywords or short phrase to search for.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: executeMemorySearch,
    },
    {
      name: 'schedule_once_task',
      family: 'meta',
      description:
        'Schedule a one-time future task for this chat. Use this for requests like "at 12 PM today", "tomorrow at 9", or "in 2 hours".',
      schema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'The task NanoClaw should perform when the one-time schedule triggers.',
          },
          schedule_value: {
            type: 'string',
            description:
              'Legacy exact schedule value. Natural times like "today at 6 PM" or an ISO timestamp with timezone are both accepted.',
          },
          when: {
            type: 'string',
            description:
              'Preferred one-time target time. Copy the user intent naturally, for example "today at 6 PM", "tomorrow at 9 AM", or "in 2 hours".',
          },
          context_mode: {
            type: 'string',
            enum: ['group', 'isolated'],
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      execute: executeScheduleOnceTask,
    },
    {
      name: 'schedule_recurring_task',
      family: 'meta',
      description:
        'Schedule a recurring calendar-time task for this chat. Use this for requests like "every day at 9 AM" or "every weekday at noon".',
      schema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'The task NanoClaw should perform on each recurring run.',
          },
          schedule_value: {
            type: 'string',
            description:
              'Legacy recurring schedule value. Natural recurring phrases are also accepted.',
          },
          recurrence: {
            type: 'string',
            description:
              'Preferred recurring calendar phrase. Use "every day at 9 AM", "every weekday at noon", or "every Monday at 8:30 AM".',
          },
          context_mode: {
            type: 'string',
            enum: ['group', 'isolated'],
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      execute: executeScheduleRecurringTask,
    },
    {
      name: 'schedule_interval_task',
      family: 'meta',
      description:
        'Schedule a repeated elapsed-interval task for this chat. Use this only for requests like "every 5 minutes" or "every 2 hours".',
      schema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'The task NanoClaw should perform on each interval run.',
          },
          schedule_value: {
            type: 'string',
            description: 'Milliseconds between runs, for example 300000.',
          },
          every: {
            type: 'string',
            description:
              'Preferred interval phrase. Use "every 5 minutes" or "every 2 hours".',
          },
          context_mode: {
            type: 'string',
            enum: ['group', 'isolated'],
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      execute: executeScheduleIntervalTask,
    },
    {
      name: 'schedule_task',
      family: 'meta',
      description: [
        'Schedule an exact-time or recurring task for this chat.',
        'Prefer the more specific helpers schedule_once_task, schedule_recurring_task, or schedule_interval_task when you know which type the user asked for.',
        'Use schedule_type="once" for one-time future times like "today at 6 PM" or "in 2 hours".',
        'Use schedule_type="cron" for recurring schedules like "every weekday at 9 AM".',
        'Use schedule_type="interval" only for repeated elapsed intervals like "every 5 minutes".',
      ].join('\n'),
      schema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'The task NanoClaw should perform when the schedule triggers. Write the future task clearly.',
          },
          schedule_type: {
            type: 'string',
            enum: ['once', 'interval', 'cron'],
            description:
              'Use "once" for a one-time future time, "cron" for recurring calendar times, and "interval" only for repeated elapsed intervals.',
          },
          schedule_value: {
            type: 'string',
            description:
              'Legacy schedule value. Natural scheduling phrases are also accepted.',
          },
          when: {
            type: 'string',
            description:
              'For one-time schedules, prefer a natural phrase like "today at 6 PM" or "tomorrow at 9 AM".',
          },
          recurrence: {
            type: 'string',
            description:
              'For recurring calendar schedules, prefer a natural phrase like "every weekday at 9 AM".',
          },
          every: {
            type: 'string',
            description:
              'For interval schedules, prefer a natural phrase like "every 5 minutes" or "every 2 hours".',
          },
          context_mode: {
            type: 'string',
            enum: ['group', 'isolated'],
            description:
              'Use group to keep current chat context available; use isolated for a clean single-purpose run.',
          },
        },
        required: ['prompt', 'schedule_type'],
        additionalProperties: false,
      },
      execute: executeScheduleTask,
    },
    {
      name: 'register_watch',
      family: 'meta',
      description:
        'Register a recurring heartbeat watch for this chat. Use this for periodic monitoring or conditional reminders such as "keep an eye on this" or "if X happens, tell me", instead of doing a one-off check right now.',
      schema: {
        type: 'object',
        properties: {
          instruction: {
            type: 'string',
            description:
              'A plain-English heartbeat instruction describing what to watch, when to check, and when to notify.',
          },
        },
        required: ['instruction'],
        additionalProperties: false,
      },
      execute: executeRegisterWatch,
    },
    // Backward-compatibility shim for one cycle.
    {
      name: 'web_browse',
      family: 'web',
      description:
        'Deprecated alias. Use explicit tools: web_search, web_fetch, web_open_url, web_extract_text, web_get_links, web_close.',
      schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['search', 'open', 'text', 'links', 'close'],
          },
          query: { type: 'string' },
          url: { type: 'string' },
          max_chars: { type: 'number' },
          limit: { type: 'number' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async (args, ctx): Promise<ToolExecutionResult> => {
        const action =
          typeof args.action === 'string' ? args.action.toLowerCase() : '';
        if (action === 'search') return executeWebSearch(args, ctx);
        if (action === 'open') return executeWebOpenUrl(args, ctx);
        if (action === 'text') return executeWebExtractText(args, ctx);
        if (action === 'links') return executeWebGetLinks(args, ctx);
        if (action === 'close') return executeWebClose(args, ctx);
        return {
          ok: false,
          content:
            `Unsupported web_browse action "${action}". Use explicit web_* tools.`,
        };
      },
    },
  ];
}

export function filterToolRegistry(
  registry: ToolHandler[],
  toolPolicy: RuntimeToolPolicy | undefined,
): ToolHandler[] {
  return registry.filter((tool) => {
    if (tool.family === 'meta' || tool.family === 'memory') return true;
    const familyPolicy =
      tool.family === 'web'
        ? toolPolicy?.web
        : tool.family === 'browser'
          ? toolPolicy?.browser
          : toolPolicy?.docs;
    return familyPolicy?.enabled === true;
  });
}

export function toOpenAITools(registry: ToolHandler[]): Array<Record<string, unknown>> {
  return registry.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.schema,
    },
  }));
}

export function findTool(
  registry: ToolHandler[],
  name: string,
): ToolHandler | undefined {
  return registry.find((tool) => tool.name === name);
}
