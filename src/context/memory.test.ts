import fs from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { groupsDir } = vi.hoisted(() => {
  const tempRoot = `${process.cwd().replace(/\\/g, '/')}/.tmp-memory-${Math.random().toString(36).slice(2)}`;
  return {
    groupsDir: `${tempRoot}/groups`,
  };
});

vi.mock('../config.js', () => ({
  GROUPS_DIR: groupsDir,
}));

describe('memory helpers', () => {
  beforeEach(() => {
    fs.rmSync(groupsDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(groupsDir, 'discord_dm', 'memory'), {
      recursive: true,
    });
  });

  it('extracts only durable user memory candidates', async () => {
    const { extractMemoryCandidates } = await import('./memory.js');
    const candidates = extractMemoryCandidates(
      [
        {
          id: '1',
          chat_jid: 'dc:test',
          sender: 'user',
          sender_name: 'User',
          content: 'I prefer concise replies when we talk about the project',
          timestamp: '2026-03-07T10:00:00.000Z',
        },
        {
          id: '2',
          chat_jid: 'dc:test',
          sender: 'bot',
          sender_name: 'Andy',
          content: 'I prefer concise replies too',
          timestamp: '2026-03-07T10:01:00.000Z',
          is_bot_message: true,
        },
      ],
      'Andy',
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.kind).toBe('pref');
  });

  it('filters low-signal question and instruction style memory candidates', async () => {
    const { extractMemoryCandidates } = await import('./memory.js');
    const candidates = extractMemoryCandidates(
      [
        {
          id: '1',
          chat_jid: 'dc:test',
          sender: 'user',
          sender_name: 'User',
          content: 'dont do a search, just explain me what i need to do there',
          timestamp: '2026-03-07T10:00:00.000Z',
        },
        {
          id: '2',
          chat_jid: 'dc:test',
          sender: 'user',
          sender_name: 'User',
          content:
            'I prefer practical replies that get straight to the point',
          timestamp: '2026-03-07T10:01:00.000Z',
        },
      ],
      'Andy',
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.text).toContain('I prefer practical replies');
  });

  it('appends tagged daily notes and compacts them into MEMORY.md', async () => {
    const { appendDailyMemoryNotes, compactMemory } =
      await import('./memory.js');
    appendDailyMemoryNotes(
      'discord_dm',
      [
        {
          kind: 'proj',
          text: 'we are building an open claw style app on local models',
          source: 'user',
          timestamp: '2026-03-07T10:00:00.000Z',
          origin: 'auto_capture',
          durability: 'durable',
          confidence: 0.82,
        },
        {
          kind: 'pref',
          text: 'user prefers concise answers',
          source: 'user',
          timestamp: '2026-03-07T10:01:00.000Z',
          origin: 'auto_capture',
          durability: 'durable',
          confidence: 0.9,
        },
      ],
      new Date('2026-03-07T10:30:00.000Z'),
    );

    const result = compactMemory('discord_dm');
    const content = fs.readFileSync(result.memoryPath, 'utf8');

    expect(result.promotedCount).toBe(2);
    expect(content).toContain('## Preferences');
    expect(content).toContain('## Projects');
  });

  it('reports missing or weak memory files', async () => {
    const { doctorMemory } = await import('./memory.js');
    const report = doctorMemory('discord_dm');
    expect(report.issues.length).toBeGreaterThan(0);
  });
});
