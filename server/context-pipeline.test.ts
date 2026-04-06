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

    // USER.md content should be present
    expect(bundle.systemPrompt).toContain('direct');
  });

  it('includes IDENTITY for a dashboard group', () => {
    const bundle = buildContextBundle({
      groupFolder: 'dashboard_sam',
      prompt: 'what can you do?',
      turnMode: 'conversational',
      reservedToolChars: 2500,
      actualToolSchemaChars: 0,
    });

    // IDENTITY.md mentions NanoClaw
    expect(bundle.systemPrompt).toContain('NanoClaw');
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
