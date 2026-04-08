import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

function readIpcFile(tmpDir: string): Record<string, unknown> {
  const memoryDir = path.join(tmpDir, 'memory');
  const files = fs.readdirSync(memoryDir).filter((f) => f.endsWith('.json'));
  expect(files).toHaveLength(1);
  return JSON.parse(fs.readFileSync(path.join(memoryDir, files[0]), 'utf-8'));
}

describe('executeRememberThis', () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remember-test-'));
    // NANOCLAW_IPC_INPUT_DIR = {tmpDir}/input; memory dir = {tmpDir}/memory
    process.env.NANOCLAW_IPC_INPUT_DIR = path.join(tmpDir, 'input');
    process.env.NANOCLAW_GROUP_FOLDER = 'test_group';
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes IPC file with correct fields', async () => {
    const { executeRememberThis } = await import('./remember.js');
    const result = await executeRememberThis(
      { content: 'user prefers dark mode', kind: 'pref' },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain('pref');
    expect(result.content).toContain('user prefers dark mode');

    const data = readIpcFile(tmpDir);
    expect(data.type).toBe('remember_this');
    expect(data.content).toBe('user prefers dark mode');
    expect(data.kind).toBe('pref');
    expect(data.pinned).toBe(false);
    expect(data.scope).toBe('group');
    expect(typeof data.timestamp).toBe('string');
  });

  it('writes pinned: true and includes note in return message', async () => {
    const { executeRememberThis } = await import('./remember.js');
    const result = await executeRememberThis(
      { content: 'always use metric units', kind: 'pref', pin: true },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain('pinned');

    const data = readIpcFile(tmpDir);
    expect(data.pinned).toBe(true);
  });

  it('defaults kind to explicit when omitted', async () => {
    const { executeRememberThis } = await import('./remember.js');
    await executeRememberThis({ content: 'some fact' }, makeCtx());
    const data = readIpcFile(tmpDir);
    expect(data.kind).toBe('explicit');
  });

  it('defaults to explicit kind for unknown kind value', async () => {
    const { executeRememberThis } = await import('./remember.js');
    await executeRememberThis({ content: 'some fact', kind: 'bogus' }, makeCtx());
    const data = readIpcFile(tmpDir);
    expect(data.kind).toBe('explicit');
  });

  it('rejects empty content', async () => {
    const { executeRememberThis } = await import('./remember.js');
    const result = await executeRememberThis({ content: '' }, makeCtx());
    expect(result.ok).toBe(false);
    expect(result.content).toContain('required');
  });

  it('rejects content over 500 chars', async () => {
    const { executeRememberThis } = await import('./remember.js');
    const result = await executeRememberThis(
      { content: 'x'.repeat(501) },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('500');
  });

  it('uses atomic write (no .tmp files left behind)', async () => {
    const { executeRememberThis } = await import('./remember.js');
    await executeRememberThis({ content: 'some durable fact', kind: 'fact' }, makeCtx());
    const memoryDir = path.join(tmpDir, 'memory');
    const allFiles = fs.readdirSync(memoryDir);
    const tmpFiles = allFiles.filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
    expect(allFiles.filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });
});
