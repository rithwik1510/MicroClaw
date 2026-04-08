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

// NANOCLAW_IPC_INPUT_DIR = {tmpDir}/input → sibling dirs are directly under tmpDir,
// matching how resolveSearchDir() works: path.dirname(inputDir) = tmpDir.
function requestDir(tmpDir: string): string {
  return path.join(tmpDir, 'memory-search-requests');
}

function resultDir(tmpDir: string): string {
  return path.join(tmpDir, 'memory-search-results');
}

async function waitForSingleRequestFile(tmpDir: string): Promise<string> {
  const dir = requestDir(tmpDir);
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((file) => file.endsWith('.json'));
      if (files.length === 1) return files[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for memory search request file');
}

describe('executeMemorySearch', () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-search-test-'));
    process.env.NANOCLAW_IPC_INPUT_DIR = path.join(tmpDir, 'input');
    process.env.NANOCLAW_GROUP_FOLDER = 'test_group';
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes requests to the dedicated search subfolder', async () => {
    const { executeMemorySearch } = await import('./search.js');
    const pending = executeMemorySearch({ query: 'supabase project' }, makeCtx());

    const requestFile = await waitForSingleRequestFile(tmpDir);
    const data = JSON.parse(
      fs.readFileSync(path.join(requestDir(tmpDir), requestFile), 'utf-8'),
    ) as Record<string, unknown>;

    expect(data.type).toBe('memory_search');
    expect(data.query).toBe('supabase project');
    expect(data.limit).toBe(8);
    expect(data.groupFolder).toBeUndefined(); // groupFolder must not be in payload (security)
    // Confirm requests never leak into the remember_this memory dir
    expect(fs.existsSync(path.join(tmpDir, 'memory'))).toBe(false);

    const responsePath = path.join(resultDir(tmpDir), requestFile);
    fs.mkdirSync(path.dirname(responsePath), { recursive: true });
    fs.writeFileSync(responsePath, JSON.stringify({ results: [] }));

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.content).toContain('No memory results found');
  });

  it('formats response rows as bullet lines and removes the response file', async () => {
    const { executeMemorySearch } = await import('./search.js');
    const pending = executeMemorySearch({ query: 'api token' }, makeCtx());

    const requestFile = await waitForSingleRequestFile(tmpDir);
    const responsePath = path.join(resultDir(tmpDir), requestFile);
    fs.mkdirSync(path.dirname(responsePath), { recursive: true });
    fs.writeFileSync(
      responsePath,
      JSON.stringify({
        results: [
          { kind: 'fact', content: 'API token lives in the env file' },
          { kind: 'proj', content: 'Project uses Supabase locally' },
        ],
      }),
    );

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.content).toBe(
      '- [fact] API token lives in the env file\n- [proj] Project uses Supabase locally',
    );
    expect(fs.existsSync(responsePath)).toBe(false);
  });

  it('returns a graceful timeout message when no response arrives', async () => {
    const { executeMemorySearch } = await import('./search.js');
    const result = await executeMemorySearch({ query: 'stale keyword' }, makeCtx());
    expect(result.ok).toBe(true);
    expect(result.content).toContain('timed out');
  });

  it('validates query length', async () => {
    const { executeMemorySearch } = await import('./search.js');
    const result = await executeMemorySearch(
      { query: 'x'.repeat(121) },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('120');
  });

  it('derives search paths from NANOCLAW_IPC_INPUT_DIR, not a separate group env var', async () => {
    // Path isolation is guaranteed by NANOCLAW_IPC_INPUT_DIR being group-scoped
    // in production ({DATA_DIR}/ipc/{group}/input). NANOCLAW_GROUP_FOLDER is only
    // used for the "group unknown" guard, not for path construction.
    const { executeMemorySearch } = await import('./search.js');
    const pending = executeMemorySearch({ query: 'project id' }, makeCtx());

    const requestFile = await waitForSingleRequestFile(tmpDir);
    // Confirm the request landed in the dir derived from NANOCLAW_IPC_INPUT_DIR
    expect(fs.existsSync(path.join(requestDir(tmpDir), requestFile))).toBe(true);

    const responsePath = path.join(resultDir(tmpDir), requestFile);
    fs.mkdirSync(path.dirname(responsePath), { recursive: true });
    fs.writeFileSync(responsePath, JSON.stringify({ results: [] }));

    await expect(pending).resolves.toMatchObject({ ok: true });
  });
});
