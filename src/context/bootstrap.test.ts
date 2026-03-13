import fs from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { groupsDir, state } = vi.hoisted(() => ({
  groupsDir: `${process.cwd().replace(/\\/g, '/')}/.tmp-bootstrap-${Math.random().toString(36).slice(2)}/groups`,
  state: new Map<string, string>(),
}));

vi.mock('../config.js', () => ({
  GROUPS_DIR: groupsDir,
}));

vi.mock('../db.js', () => ({
  getRouterState: (key: string) => state.get(key),
  setRouterState: (key: string, value: string) => state.set(key, value),
}));

describe('assistant bootstrap', () => {
  beforeEach(() => {
    fs.rmSync(path.dirname(groupsDir), { recursive: true, force: true });
    fs.mkdirSync(path.join(groupsDir, 'global'), { recursive: true });
    fs.mkdirSync(path.join(groupsDir, 'discord_dm'), { recursive: true });
    state.clear();

    fs.writeFileSync(
      path.join(groupsDir, 'global', 'SOUL.md'),
      '# Soul\n\n- Be calm, direct, and grounded.\n- Act like a persistent local-first personal assistant, not a generic chatbot.\n- Favor clarity, practical help, and continuity over filler.\n- Protect the user from risky or destructive actions by surfacing tradeoffs plainly.\n- Keep the tone warm and collaborative without becoming overly formal.\n',
    );
    fs.writeFileSync(
      path.join(groupsDir, 'global', 'USER.md'),
      '# User\n\n- Add durable user-wide preferences and stable facts here.\n- Keep this file concise and factual.\n',
    );
    fs.writeFileSync(
      path.join(groupsDir, 'global', 'TOOLS.md'),
      '# Tools\n\n- Local models have limited context windows, so keep retrieved context compact.\n- Prefer durable memory over repeating large prompt instructions.\n- Treat tool output as evidence, not personality.\n',
    );
    fs.writeFileSync(
      path.join(groupsDir, 'discord_dm', 'USER.md'),
      '# User\n\n- Personal DM preferences and stable facts for this chat go here.\n',
    );
    fs.writeFileSync(
      path.join(groupsDir, 'discord_dm', 'MEMORY.md'),
      '# Memory\n',
    );
  });

  it('does not auto-send setup before the user explicitly starts it', async () => {
    const { maybeHandleAssistantBootstrap } = await import('./bootstrap.js');
    const result = maybeHandleAssistantBootstrap({
      groupFolder: 'discord_dm',
      latestMessageText: 'hello',
      isDm: true,
    });

    expect(result.handled).toBe(false);
    expect(result.messageToSend).toBeUndefined();
  });

  it('starts the intro flow when the user explicitly starts setup', async () => {
    const { maybeHandleAssistantBootstrap } = await import('./bootstrap.js');

    const result = maybeHandleAssistantBootstrap({
      groupFolder: 'discord_dm',
      latestMessageText: 'setup assistant',
      isDm: true,
    });

    expect(result.handled).toBe(true);
    expect(result.messageToSend).toContain('Welcome to MicroClaw setup');
  });

  it('starts the single hybrid setup flow on continue', async () => {
    const { maybeHandleAssistantBootstrap } = await import('./bootstrap.js');
    maybeHandleAssistantBootstrap({
      groupFolder: 'discord_dm',
      latestMessageText: 'setup assistant',
      isDm: true,
    });

    const result = maybeHandleAssistantBootstrap({
      groupFolder: 'discord_dm',
      latestMessageText: 'continue',
      isDm: true,
    });

    expect(result.handled).toBe(true);
    expect(result.messageToSend).toContain('Question 1/6');
  });

  it('writes structured personalized files after hybrid confirm', async () => {
    const { maybeHandleAssistantBootstrap } = await import('./bootstrap.js');
    const turns = [
      'setup assistant',
      'continue',
      'Call me Ravi. I am a student in India building AI products and I want practical help finding work while building a local-first assistant.',
      'Call me Ravi and use IST timezone',
      'Be my coding partner and personal assistant',
      'Be concise, direct, and warm',
      'Confirm before risky shell or browser actions',
      'Keep things practical, concise, and budget-aware when we work.',
      'confirm',
    ];

    let lastMessage = '';
    for (const turn of turns) {
      const result = maybeHandleAssistantBootstrap({
        groupFolder: 'discord_dm',
        latestMessageText: turn,
        isDm: true,
      });
      lastMessage = result.messageToSend || '';
    }

    const userContent = fs.readFileSync(
      path.join(groupsDir, 'discord_dm', 'USER.md'),
      'utf8',
    );
    const identityContent = fs.readFileSync(
      path.join(groupsDir, 'global', 'IDENTITY.md'),
      'utf8',
    );
    const soulContent = fs.readFileSync(
      path.join(groupsDir, 'global', 'SOUL.md'),
      'utf8',
    );
    const toolsContent = fs.readFileSync(
      path.join(groupsDir, 'global', 'TOOLS.md'),
      'utf8',
    );
    const memoryContent = fs.readFileSync(
      path.join(groupsDir, 'discord_dm', 'MEMORY.md'),
      'utf8',
    );

    expect(lastMessage).toContain('Setup saved');
    expect(userContent).toContain('Preferred name: Ravi');
    expect(userContent.toLowerCase()).toContain('student in india');
    expect(identityContent).toContain('coding partner and personal assistant');
    expect(soulContent).toContain('Keep replies concise');
    expect(toolsContent).toContain(
      'Confirm before potentially risky shell commands',
    );
    expect(memoryContent).toContain('building AI products');
    expect(memoryContent).toContain('local-first assistant');
  });

  it('restarts setup from scratch and clears prior answers', async () => {
    const { maybeHandleAssistantBootstrap } = await import('./bootstrap.js');

    maybeHandleAssistantBootstrap({
      groupFolder: 'discord_dm',
      latestMessageText: 'setup assistant',
      isDm: true,
    });
    maybeHandleAssistantBootstrap({
      groupFolder: 'discord_dm',
      latestMessageText: 'continue',
      isDm: true,
    });
    maybeHandleAssistantBootstrap({
      groupFolder: 'discord_dm',
      latestMessageText: 'Call me Ravi. I want focused help building products.',
      isDm: true,
    });

    const restarted = maybeHandleAssistantBootstrap({
      groupFolder: 'discord_dm',
      latestMessageText: 'restart',
      isDm: true,
    });

    expect(restarted.messageToSend).toContain('Setup restarted from scratch');
    expect(restarted.messageToSend).toContain('Welcome to MicroClaw setup');

    maybeHandleAssistantBootstrap({
      groupFolder: 'discord_dm',
      latestMessageText: 'continue',
      isDm: true,
    });
    maybeHandleAssistantBootstrap({
      groupFolder: 'discord_dm',
      latestMessageText:
        'Call me Mira. I am building a local personal assistant.',
      isDm: true,
    });
    maybeHandleAssistantBootstrap({
      groupFolder: 'discord_dm',
      latestMessageText: 'Call me Mira and use IST timezone',
      isDm: true,
    });
    maybeHandleAssistantBootstrap({
      groupFolder: 'discord_dm',
      latestMessageText: 'Be my personal operator',
      isDm: true,
    });
    maybeHandleAssistantBootstrap({
      groupFolder: 'discord_dm',
      latestMessageText: 'Be concise and warm',
      isDm: true,
    });
    maybeHandleAssistantBootstrap({
      groupFolder: 'discord_dm',
      latestMessageText: 'Confirm before risky shell actions',
      isDm: true,
    });
    maybeHandleAssistantBootstrap({
      groupFolder: 'discord_dm',
      latestMessageText: 'Keep answers practical and concise',
      isDm: true,
    });
    maybeHandleAssistantBootstrap({
      groupFolder: 'discord_dm',
      latestMessageText: 'confirm',
      isDm: true,
    });

    const userContent = fs.readFileSync(
      path.join(groupsDir, 'discord_dm', 'USER.md'),
      'utf8',
    );
    expect(userContent).toContain('Preferred name: Mira');
    expect(userContent).not.toContain('Preferred name: Ravi');
  });

  it('accepts legacy setup replies like profile and still enters the single flow', async () => {
    const { maybeHandleAssistantBootstrap } = await import('./bootstrap.js');

    maybeHandleAssistantBootstrap({
      groupFolder: 'discord_dm',
      latestMessageText: 'setup assistant',
      isDm: true,
    });
    const firstQuestion = maybeHandleAssistantBootstrap({
      groupFolder: 'discord_dm',
      latestMessageText: 'profile',
      isDm: true,
    });

    expect(firstQuestion.messageToSend).toContain('Question 1/6');
  });

  it('accepts legacy setup replies like quick and still enters the single flow', async () => {
    const { maybeHandleAssistantBootstrap } = await import('./bootstrap.js');

    maybeHandleAssistantBootstrap({
      groupFolder: 'discord_dm',
      latestMessageText: 'setup assistant',
      isDm: true,
    });
    const q1 = maybeHandleAssistantBootstrap({
      groupFolder: 'discord_dm',
      latestMessageText: 'quick',
      isDm: true,
    });

    expect(q1.messageToSend).toContain('Question 1/6');
  });
});
