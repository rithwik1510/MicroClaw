import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { groupsDir } = vi.hoisted(() => {
  const tempRoot = `${process.cwd().replace(/\\/g, '/')}/.tmp-context-${Math.random().toString(36).slice(2)}`;
  return {
    groupsDir: `${tempRoot}/groups`,
  };
});

vi.mock('../config.js', () => ({
  GROUPS_DIR: groupsDir,
}));

describe('buildContextBundle', () => {
  beforeEach(() => {
    fs.rmSync(groupsDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(groupsDir, 'global'), { recursive: true });
    fs.mkdirSync(path.join(groupsDir, 'discord_dm', 'memory'), {
      recursive: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('assembles global, local, and daily context in priority order', async () => {
    fs.writeFileSync(
      path.join(groupsDir, 'global', 'SOUL.md'),
      '# Soul\nBe steady.\n',
    );
    fs.writeFileSync(
      path.join(groupsDir, 'global', 'IDENTITY.md'),
      '# Identity\nYou are MicroClaw.\n',
    );
    fs.writeFileSync(
      path.join(groupsDir, 'discord_dm', 'USER.md'),
      '# User\n\n## Profile\n- Preferred name: Ravi\n- Timezone: IST\n- Long autobiographical detail that should not all be injected every time.\n\n## Preferences\n- Prefer concise answers\n- Prefer practical solutions\n',
    );
    fs.writeFileSync(
      path.join(groupsDir, 'discord_dm', 'MEMORY.md'),
      '# Memory\n\n## Current Priorities\n- Ship the open claw app on local models\n\n## Projects\n- Project: open claw app\n- Another unrelated project note\n\n## Standing Instructions\n- Stay practical\n',
    );
    fs.writeFileSync(
      path.join(groupsDir, 'discord_dm', 'memory', '2026-03-07.md'),
      '09:10 proj: open claw app uses local models\n09:11 pref: user prefers concise answers\n09:12 fact: random unrelated note\n',
    );

    vi.setSystemTime(new Date('2026-03-07T10:30:00.000Z'));
    const { buildContextBundle } = await import('./builder.js');

    const bundle = buildContextBundle({
      groupFolder: 'discord_dm',
      prompt:
        '[Current message - respond to this]\nHow should the open claw app use local models?',
      today: new Date('2026-03-07T10:30:00.000Z'),
    });

    expect(bundle.systemPrompt).toContain('## SOUL');
    expect(bundle.systemPrompt).toContain('## IDENTITY');
    expect(bundle.systemPrompt).toContain('## MEMORY');
    expect(bundle.systemPrompt).toContain('## Local USER');
    // Daily notes injected when strong keywords match
    expect(bundle.systemPrompt).toContain('Daily notes (2026-03-07)');
    expect(bundle.diagnostics.strongKeywords).toContain('open');
    expect(
      bundle.diagnostics.layers.find((layer) => layer.kind === 'daily')
        ?.included,
    ).toBe(true);
    expect(
      bundle.diagnostics.layers.find(
        (layer) => layer.kind === 'user' && layer.scope === 'group',
      )?.inclusionReason,
    ).toBe('selective_context');
  });

  it('skips daily notes when no strong keywords are present', async () => {
    fs.writeFileSync(
      path.join(groupsDir, 'discord_dm', 'memory', '2026-03-07.md'),
      '09:10 proj: open claw app uses local models\n',
    );

    const { buildContextBundle } = await import('./builder.js');
    const bundle = buildContextBundle({
      groupFolder: 'discord_dm',
      prompt: '[Current message - respond to this]\nhello',
      today: new Date('2026-03-07T10:30:00.000Z'),
    });

    const dailyLayer = bundle.diagnostics.layers.find(
      (layer) => layer.kind === 'daily',
    );
    expect(dailyLayer?.included).toBe(false);
    expect(dailyLayer?.inclusionReason).toBe('no_strong_keywords');
  });

  it('trims low-priority layers before dropping soul context', async () => {
    fs.writeFileSync(
      path.join(groupsDir, 'global', 'SOUL.md'),
      '# Soul\n' + 'core rule\n'.repeat(120),
    );
    fs.writeFileSync(
      path.join(groupsDir, 'discord_dm', 'MEMORY.md'),
      '# Memory\n' + 'note\n'.repeat(3000),
    );

    const { buildContextBundle } = await import('./builder.js');
    const bundle = buildContextBundle({
      groupFolder: 'discord_dm',
      prompt:
        '[Current message - respond to this]\nTell me about note systems for this project',
      today: new Date('2026-03-07T10:30:00.000Z'),
    });

    const soulLayer = bundle.diagnostics.layers.find(
      (layer) => layer.kind === 'soul',
    );
    const memoryLayer = bundle.diagnostics.layers.find(
      (layer) => layer.kind === 'memory',
    );
    expect(soulLayer?.included).toBe(true);
    expect(memoryLayer?.trimmedChars).toBeLessThan(memoryLayer?.rawChars || 0);
  });

  it('skips placeholder modern files and suppresses legacy CLAUDE when modern context exists', async () => {
    fs.writeFileSync(
      path.join(groupsDir, 'global', 'SOUL.md'),
      '# Soul\n\n- Be concise.\n- Keep continuity strong.\n',
    );
    fs.writeFileSync(
      path.join(groupsDir, 'global', 'IDENTITY.md'),
      '# Identity\n\n- You are MicroClaw.\n',
    );
    fs.writeFileSync(
      path.join(groupsDir, 'global', 'USER.md'),
      '# User\n\n- Add durable user-wide preferences and stable facts here.\n- Keep this file concise and factual.\n',
    );
    fs.writeFileSync(
      path.join(groupsDir, 'global', 'CLAUDE.md'),
      '# Claude\n\nLegacy personality that should be suppressed.\n',
    );

    const { buildContextBundle } = await import('./builder.js');
    const bundle = buildContextBundle({
      groupFolder: 'discord_dm',
      prompt:
        '[Current message - respond to this]\nHelp me continue this project',
      today: new Date('2026-03-07T10:30:00.000Z'),
    });

    const globalUserLayer = bundle.diagnostics.layers.find(
      (layer) => layer.kind === 'user' && layer.scope === 'global',
    );
    const legacyLayer = bundle.diagnostics.layers.find(
      (layer) => layer.kind === 'legacy_claude' && layer.scope === 'legacy',
    );

    expect(globalUserLayer?.included).toBe(false);
    expect(globalUserLayer?.inclusionReason).toBe('placeholder');
    expect(legacyLayer?.included).toBe(false);
    expect(legacyLayer?.inclusionReason).toBe('modern_context_present');
  });

  it('keeps a user file when real content exists alongside an old placeholder line', async () => {
    fs.writeFileSync(
      path.join(groupsDir, 'global', 'SOUL.md'),
      '# Soul\n- Be steady.\n',
    );
    fs.writeFileSync(
      path.join(groupsDir, 'discord_dm', 'USER.md'),
      [
        '# User',
        '',
        '- Add durable user-wide preferences and stable facts here.',
        '- Preferred name: Ravi',
        '- Timezone: IST',
      ].join('\n'),
    );

    const { buildContextBundle } = await import('./builder.js');
    const bundle = buildContextBundle({
      groupFolder: 'discord_dm',
      prompt:
        '[Current message - respond to this]\nPlease keep using my preferred name.',
      today: new Date('2026-03-07T10:30:00.000Z'),
    });

    const localUserLayer = bundle.diagnostics.layers.find(
      (layer) => layer.kind === 'user' && layer.scope === 'group',
    );
    expect(localUserLayer?.included).toBe(true);
    expect(bundle.systemPrompt).toContain('Preferred name: Ravi');
  });

  it('enforces a hard cap on the final assembled context prompt', async () => {
    fs.writeFileSync(
      path.join(groupsDir, 'global', 'SOUL.md'),
      '# Soul\n' + '- core rule that should survive trimming\n'.repeat(500),
    );
    fs.writeFileSync(
      path.join(groupsDir, 'global', 'IDENTITY.md'),
      '# Identity\n' + '- identity guidance\n'.repeat(700),
    );
    fs.writeFileSync(
      path.join(groupsDir, 'global', 'TOOLS.md'),
      '# Tools\n' + '- tool guidance\n'.repeat(700),
    );
    fs.writeFileSync(
      path.join(groupsDir, 'discord_dm', 'USER.md'),
      '# User\n\n## Profile\n' + '- preferred name detail\n'.repeat(700),
    );
    fs.writeFileSync(
      path.join(groupsDir, 'discord_dm', 'MEMORY.md'),
      '# Memory\n\n## Projects\n' + '- project note\n'.repeat(1200),
    );

    const { buildContextBundle } = await import('./builder.js');
    const bundle = buildContextBundle({
      groupFolder: 'discord_dm',
      prompt:
        '[Current message - respond to this]\nHelp me continue the project safely.',
      today: new Date('2026-03-07T10:30:00.000Z'),
    });

    expect(bundle.systemPrompt.length).toBeLessThanOrEqual(
      bundle.diagnostics.hardCapChars,
    );
  });

  it('keeps user and memory context compact for local models', async () => {
    fs.writeFileSync(
      path.join(groupsDir, 'global', 'SOUL.md'),
      '# Soul\n- Be steady.\n',
    );
    fs.writeFileSync(
      path.join(groupsDir, 'global', 'IDENTITY.md'),
      '# Identity\n- You are MicroClaw.\n',
    );
    fs.writeFileSync(
      path.join(groupsDir, 'discord_dm', 'USER.md'),
      '# User\n\n## Profile\n- Preferred name: Ravi\n- Timezone: IST\n- Very long autobiographical background\n- Another long life detail\n\n## Preferences\n- Prefer concise answers\n- Prefer practical solutions\n- Prefer fewer greetings\n',
    );
    fs.writeFileSync(
      path.join(groupsDir, 'discord_dm', 'MEMORY.md'),
      '# Memory\n\n## Current Priorities\n- Build an open claw style assistant\n\n## Projects\n- Build an open claw style assistant for local models\n- Explore unrelated idea\n- Another unrelated idea\n\n## Standing Instructions\n- Keep replies practical\n- Avoid filler\n',
    );

    const { buildContextBundle } = await import('./builder.js');
    const bundle = buildContextBundle({
      groupFolder: 'discord_dm',
      prompt:
        '[Current message - respond to this]\nHow should we improve the local assistant personality?',
      today: new Date('2026-03-07T10:30:00.000Z'),
    });

    // Header is now shorter for local model context savings
    expect(bundle.systemPrompt).toContain(
      'You are a persistent personal assistant',
    );
    expect(bundle.systemPrompt).toContain('Preferred name: Ravi');
    expect(bundle.systemPrompt).not.toContain('Another long life detail');
    expect(bundle.systemPrompt).toContain('Build an open claw style assistant');
    expect(bundle.systemPrompt).not.toContain('Another unrelated idea');
  });
});
