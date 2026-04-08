import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ToolExecutionContext } from '../types.js';

function makeCtx(): ToolExecutionContext {
  return {
    maxSearchCallsPerTurn: 1,
    maxToolSteps: 3,
    searchTimeoutMs: 1000,
    pageFetchTimeoutMs: 1000,
    totalWebBudgetMs: 5000,
    startedAtMs: Date.now(),
    stepCount: 0,
    searchCount: 0,
  };
}

describe('executeRegisterWatch', () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;
  let groupDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-tool-test-'));
    groupDir = path.join(tmpDir, 'group');
    process.env.NANOCLAW_GROUP_WORKSPACE_DIR = groupDir;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates HEARTBEAT.md with the requested watch item', async () => {
    const { executeRegisterWatch } = await import('./watch.js');
    const result = await executeRegisterWatch(
      {
        instruction:
          'Every day at 12:00 PM, check AI release news and notify me if there is anything important.',
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    const heartbeatPath = path.join(groupDir, 'HEARTBEAT.md');
    const content = fs.readFileSync(heartbeatPath, 'utf8');
    expect(content).toContain('## Watch / reminder items');
    expect(content).toContain(
      '- Every day at 12:00 PM, check AI release news and notify me if there is anything important.',
    );
  });

  it('appends to an existing watch section without duplicating an instruction', async () => {
    const { executeRegisterWatch } = await import('./watch.js');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'HEARTBEAT.md'),
      [
        '# Heartbeat Checklist',
        '',
        '## Watch / reminder items',
        '- If my nightly backup fails, tell me once.',
        '',
        '## Notes',
        '- Stay quiet otherwise.',
        '',
      ].join('\n'),
    );

    await executeRegisterWatch(
      { instruction: 'If my nightly backup fails, tell me once.' },
      makeCtx(),
    );
    await executeRegisterWatch(
      {
        instruction:
          '- Every weekday at 9 AM, check deployment health and notify me if it is down.',
      },
      makeCtx(),
    );

    const content = fs.readFileSync(
      path.join(groupDir, 'HEARTBEAT.md'),
      'utf8',
    );
    expect(content.match(/If my nightly backup fails, tell me once\./g)).toHaveLength(1);
    expect(content).toContain(
      '- Every weekday at 9 AM, check deployment health and notify me if it is down.',
    );
  });

  it('falls back to the current workspace plus group folder when the explicit workspace env is absent', async () => {
    const { executeRegisterWatch } = await import('./watch.js');
    process.env = { ...originalEnv };
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-tool-repo-'));
    const previousCwd = process.cwd();
    const nestedGroupDir = path.join(repoRoot, 'groups', 'discord_dm');
    fs.mkdirSync(nestedGroupDir, { recursive: true });
    process.chdir(repoRoot);
    process.env.NANOCLAW_GROUP_FOLDER = 'discord_dm';

    try {
      const result = await executeRegisterWatch(
        {
          instruction: 'Keep an eye on AI release news and notify me only when something important changes.',
        },
        makeCtx(),
      );

      expect(result.ok).toBe(true);
      const content = fs.readFileSync(
        path.join(nestedGroupDir, 'HEARTBEAT.md'),
        'utf8',
      );
      expect(content).toContain('Keep an eye on AI release news');
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
