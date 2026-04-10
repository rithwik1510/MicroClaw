import { describe, expect, it } from 'vitest';

import {
  buildContinuityPlan,
  buildContinuityPrompt,
  buildRollingSummary,
  isSyntheticAssistantReply,
} from './continuity.js';
import type { NewMessage } from './types.js';

function msg(
  overrides: Partial<NewMessage> & Pick<NewMessage, 'id' | 'content'>,
): NewMessage {
  return {
    id: overrides.id,
    chat_jid: overrides.chat_jid || 'dc:1',
    sender: overrides.sender || 'user-1',
    sender_name: overrides.sender_name || 'Rishi',
    content: overrides.content,
    timestamp: overrides.timestamp || '2026-03-06T10:00:00.000Z',
    is_from_me: overrides.is_from_me,
    is_bot_message: overrides.is_bot_message,
  };
}

describe('buildRollingSummary', () => {
  it('summarizes older user and assistant turns into compact bullets', () => {
    const summary = buildRollingSummary(
      [
        msg({
          id: '1',
          content:
            'We are turning MicroClaw into a cheaper local-first assistant.',
        }),
        msg({
          id: '2',
          sender: 'Andy',
          sender_name: 'Andy',
          content: 'We should improve the runtime and web tooling first.',
          is_bot_message: true,
        }),
        msg({
          id: '3',
          content: 'Also I want better continuity and personality in Discord.',
        }),
      ],
      'Andy',
    );

    expect(summary).toContain('[Active goals and projects]');
    expect(summary).toContain('MicroClaw');
    expect(summary).toContain('[Recent commitments and decisions]');
  });

  it('skips synthetic fallback assistant replies when summarizing', () => {
    const summary = buildRollingSummary(
      [
        msg({ id: '1', content: 'hello' }),
        msg({
          id: '2',
          sender: 'Andy',
          sender_name: 'Andy',
          content:
            'I ran into a runtime issue while processing that request. Please retry in a moment.',
          is_bot_message: true,
        }),
        msg({ id: '3', content: 'help me with my project build' }),
      ],
      'Andy',
    );

    expect(summary).not.toContain('runtime issue');
    expect(summary).toContain('help me with my project build');
  });
});

describe('buildContinuityPlan', () => {
  it('keeps a bounded recent window and rolls older context into summary', () => {
    const conversationMessages = Array.from({ length: 12 }, (_, index) =>
      msg({
        id: `m${index + 1}`,
        content: `We are implementing compaction for MicroClaw turn ${index + 1}.`,
        timestamp: `2026-03-07T10:${String(index).padStart(2, '0')}:00.000Z`,
      }),
    );

    const plan = buildContinuityPlan({
      assistantName: 'Andy',
      conversationMessages,
      currentMessages: [conversationMessages[conversationMessages.length - 1]],
      recentTurnLimit: 4,
      summaryMinMessages: 3,
    });

    expect(plan.recentContextMessages).toHaveLength(4);
    expect(plan.sourceMessageCount).toBe(7);
    expect(plan.summaryToUse).toContain('[Active goals and projects]');
    expect(plan.shouldPersistSummary).toBe(true);
  });

  it('uses stored summary when the current window does not need a refresh', () => {
    const plan = buildContinuityPlan({
      assistantName: 'Andy',
      conversationMessages: [
        msg({ id: '1', content: 'hello there' }),
        msg({ id: '2', content: 'can you help with this refactor?' }),
      ],
      currentMessages: [
        msg({ id: '3', content: 'now review the latest patch' }),
      ],
      storedSummary:
        '[Active goals and projects]\n- User: Keep continuity strong.',
      recentTurnLimit: 4,
      summaryMinMessages: 8,
    });

    expect(plan.shouldPersistSummary).toBe(false);
    expect(plan.summaryToUse).toContain('Keep continuity strong');
    expect(plan.diagnostics.usedStoredSummary).toBe(true);
  });
});

describe('buildContinuityPrompt', () => {
  it('wraps summary, recent context, and current message with explicit sections', () => {
    const prompt = buildContinuityPrompt({
      assistantName: 'Andy',
      summary: '- The user is upgrading MicroClaw for local-first usage.',
      recentContextMessages: [
        msg({ id: 'r1', content: 'Can you improve the web search?' }),
        msg({
          id: 'r2',
          sender: 'Andy',
          sender_name: 'Andy',
          content: 'Yes, I can clean up the fallback path.',
          is_bot_message: true,
        }),
      ],
      currentMessages: [
        msg({ id: 'c1', content: 'Now make continuity feel much better.' }),
      ],
    });

    expect(prompt).toContain('[Previous conversation summary]');
    expect(prompt).toContain(
      '[Recent conversation since the summarized portion - for context]',
    );
    expect(prompt).toContain('[Current message - respond to this]');
    expect(prompt).toContain('role="assistant"');
    expect(prompt).toContain('Now make continuity feel much better.');
  });

  it('omits polluted fallback summaries and recent synthetic replies', () => {
    const prompt = buildContinuityPrompt({
      assistantName: 'Andy',
      summary:
        '- Rishi said "hello" Andy replied "I ran into a runtime issue while processing that request. Please retry in a moment."',
      recentContextMessages: [
        msg({ id: 'r1', content: 'hello again' }),
        msg({
          id: 'r2',
          sender: 'Andy',
          sender_name: 'Andy',
          content:
            'I ran into a runtime issue while processing that request. Please retry in a moment.',
          is_bot_message: true,
        }),
      ],
      currentMessages: [msg({ id: 'c1', content: 'help me with the app now' })],
    });

    expect(prompt).not.toContain('[Previous conversation summary]');
    expect(prompt).not.toContain('runtime issue while processing');
    expect(prompt).toContain('help me with the app now');
  });

  it('collapses repeated identical recent messages so continuity does not balloon', () => {
    const repeated = msg({
      id: 'r1',
      content:
        'I am worried that building apps with AI tools is not helping me learn.',
      timestamp: '2026-03-07T16:45:00.000Z',
    });
    const prompt = buildContinuityPrompt({
      assistantName: 'Andy',
      recentContextMessages: [
        repeated,
        {
          ...repeated,
          id: 'r2',
          timestamp: '2026-03-07T16:50:00.000Z',
        },
        {
          ...repeated,
          id: 'r3',
          timestamp: '2026-03-07T16:55:00.000Z',
        },
      ],
      currentMessages: [
        {
          ...repeated,
          id: 'c1',
          timestamp: '2026-03-07T17:00:00.000Z',
        },
      ],
    });

    expect(
      prompt.match(
        /I am worried that building apps with AI tools is not helping me learn\./g,
      )?.length,
    ).toBe(2);
  });

  it('bounds oversized current messages so the continuity prompt stays compact', () => {
    const hugeCurrent = 'A'.repeat(20_000);
    const prompt = buildContinuityPrompt({
      assistantName: 'Andy',
      recentContextMessages: [
        msg({ id: 'r1', content: 'We should keep continuity strong.' }),
      ],
      currentMessages: [msg({ id: 'c1', content: hugeCurrent })],
    });

    expect(prompt.length).toBeLessThan(12_500);
    expect(prompt).toContain('[truncated]');
    expect(prompt).toContain('AAAAAAAAAA');
  });
});

describe('isSyntheticAssistantReply', () => {
  it('recognizes stored fallback replies', () => {
    expect(
      isSyntheticAssistantReply(
        'I ran into a runtime issue while processing that request. Please retry in a moment.',
      ),
    ).toBe(true);
    expect(
      isSyntheticAssistantReply('A likely cause is mismatched config.'),
    ).toBe(false);
  });

  it('treats repeated browser/web deflection replies as synthetic continuity noise', () => {
    expect(
      isSyntheticAssistantReply(
        "I can help you with that. Let me guide you through how to log in and explore VibeLevel.ai's dashboard.",
      ),
    ).toBe(true);
    expect(
      isSyntheticAssistantReply(
        'It looks like there was an issue accessing the website. Let me try a different approach to find out more about VibeLevel.ai and its product.',
      ),
    ).toBe(true);
    expect(
      isSyntheticAssistantReply(
        'It seems there was an issue with the web search. Let me try a different approach to gather information about VibeLevel.ai and its product.',
      ),
    ).toBe(true);
  });
});
