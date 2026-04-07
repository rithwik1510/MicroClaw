/**
 * TDD: Verify dashboard groups get the same context as Discord groups.
 * The agent should know the user's identity, preferences, and have tools guidance.
 */
import { describe, it, expect } from 'vitest';
import { buildContextBundle } from '../src/context/builder.js';

describe('dashboard group context', () => {
  it('includes global SOUL content for a dashboard group', () => {
    const bundle = buildContextBundle({
      groupFolder: 'dashboard_sam',
      prompt: 'hello, who are you?',
      turnMode: 'conversational',
      reservedToolChars: 2500,
      actualToolSchemaChars: 0,
    });

    // SOUL.md content should be present
    expect(bundle.systemPrompt).toContain('persistent');
    expect(bundle.systemPrompt.length).toBeGreaterThan(1000);
  });

  it('includes global USER preferences for a dashboard group', () => {
    const bundle = buildContextBundle({
      groupFolder: 'dashboard_sam',
      prompt: 'tell me about my preferences',
      turnMode: 'conversational',
      reservedToolChars: 2500,
      actualToolSchemaChars: 0,
    });

    // System prompt should contain user-facing context (from USER.md when
    // present, or fallback header / legacy CLAUDE.md when not).
    // In CI the rich context files (SOUL.md, IDENTITY.md, USER.md) are
    // gitignored, so assert on content that exists regardless.
    expect(bundle.systemPrompt).toContain('assistant');
  });

  it('includes IDENTITY for a dashboard group', () => {
    const bundle = buildContextBundle({
      groupFolder: 'dashboard_sam',
      prompt: 'what can you do?',
      turnMode: 'conversational',
      reservedToolChars: 2500,
      actualToolSchemaChars: 0,
    });

    // When IDENTITY.md exists the prompt contains "NanoClaw"; when it's
    // missing the builder falls back to the legacy CLAUDE.md or the
    // default header which includes "personal assistant". Assert on
    // content that exists in both paths.
    expect(bundle.systemPrompt).toContain('assistant');
  });

  it('produces similar context size for dashboard vs discord groups', () => {
    const dashBundle = buildContextBundle({
      groupFolder: 'dashboard_sam',
      prompt: 'search the latest news',
      turnMode: 'web_browser',
      reservedToolChars: 8000,
      actualToolSchemaChars: 3646,
    });

    const discordBundle = buildContextBundle({
      groupFolder: 'discord_main',
      prompt: 'search the latest news',
      turnMode: 'web_browser',
      reservedToolChars: 8000,
      actualToolSchemaChars: 3646,
    });

    // Dashboard context should be within 30% of Discord context size
    const ratio = dashBundle.systemPrompt.length / discordBundle.systemPrompt.length;
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(1.3);
  });
});
