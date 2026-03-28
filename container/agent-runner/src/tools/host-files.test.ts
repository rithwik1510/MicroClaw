import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  __testOnly,
  executeEditHostFile,
  executeListHostEntries,
  executeMakeHostDirectory,
  executeMoveHostPath,
  executeReadHostFile,
  executeWriteHostFile,
} from './host-files.js';

const baseCtx = {
  maxSearchCallsPerTurn: 0,
  maxToolSteps: 20,
  searchTimeoutMs: 1000,
  pageFetchTimeoutMs: 1000,
  totalWebBudgetMs: 1000,
  startedAtMs: Date.now(),
  stepCount: 0,
  searchCount: 0,
  secrets: {},
};

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-host-files-'));
}

function setHostDirs(paths: Array<{ path: string; label: string; readonly: boolean }>): void {
  process.env.NANOCLAW_HOST_DIRECTORIES = JSON.stringify({ directories: paths });
}

afterEach(() => {
  delete process.env.NANOCLAW_HOST_DIRECTORIES;
});

describe('host file authorization', () => {
  it('allows paths inside configured roots', () => {
    const dir = makeTempDir();
    setHostDirs([{ path: dir, label: 'Temp', readonly: false }]);
    const auth = __testOnly().authorizePath(path.join(dir, 'notes.txt'), 'write');
    expect('path' in auth && auth.path).toContain('notes.txt');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects paths outside configured roots', () => {
    const dir = makeTempDir();
    setHostDirs([{ path: dir, label: 'Temp', readonly: false }]);
    const auth = __testOnly().authorizePath(path.join(os.tmpdir(), 'outside.txt'), 'write');
    expect('ok' in auth && auth.restricted).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects writes to readonly roots', () => {
    const dir = makeTempDir();
    setHostDirs([{ path: dir, label: 'Temp', readonly: true }]);
    const auth = __testOnly().authorizePath(path.join(dir, 'notes.txt'), 'write');
    expect('ok' in auth && auth.restricted).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('host file tools', () => {
  it('reads and writes text files inside allowed roots', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'draft.txt');
    setHostDirs([{ path: dir, label: 'Temp', readonly: false }]);

    const write = await executeWriteHostFile(
      { path: filePath, content: 'hello world', mode: 'create' },
      baseCtx,
    );
    expect(write.ok).toBe(true);

    const read = await executeReadHostFile({ path: filePath }, baseCtx);
    expect(read.ok).toBe(true);
    expect(read.content).toContain('hello world');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('requires confirmation before overwriting an existing file', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'draft.txt');
    fs.writeFileSync(filePath, 'old', 'utf8');
    setHostDirs([{ path: dir, label: 'Temp', readonly: false }]);

    const blocked = await executeWriteHostFile(
      { path: filePath, content: 'new', mode: 'overwrite' },
      baseCtx,
    );
    expect(blocked.ok).toBe(false);

    const allowed = await executeWriteHostFile(
      { path: filePath, content: 'new', mode: 'overwrite' },
      {
        ...baseCtx,
        secrets: { NANOCLAW_ORIGINAL_PROMPT: 'Yes, go ahead and overwrite it.' },
      },
    );
    expect(allowed.ok).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('new');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('edits files and lists entries', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'draft.txt');
    fs.writeFileSync(filePath, 'hello world', 'utf8');
    setHostDirs([{ path: dir, label: 'Temp', readonly: false }]);

    const edit = await executeEditHostFile(
      { path: filePath, search: 'world', replace: 'there' },
      baseCtx,
    );
    expect(edit.ok).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toContain('hello there');

    const list = await executeListHostEntries({ path: dir }, baseCtx);
    expect(list.ok).toBe(true);
    expect(list.content).toContain('draft.txt');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates directories and moves files within allowed roots', async () => {
    const dir = makeTempDir();
    const sourceDir = path.join(dir, 'src');
    const targetDir = path.join(dir, 'dest');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'draft.txt'), 'hello', 'utf8');
    setHostDirs([{ path: dir, label: 'Temp', readonly: false }]);

    const mkdir = await executeMakeHostDirectory({ path: targetDir }, baseCtx);
    expect(mkdir.ok).toBe(true);

    const move = await executeMoveHostPath(
      { from: path.join(sourceDir, 'draft.txt'), to: path.join(targetDir, 'draft.txt') },
      baseCtx,
    );
    expect(move.ok).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'draft.txt'))).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('allows overwrite when confirm arg is true without prompt keywords', async () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'existing.txt');
    fs.writeFileSync(file, 'old content');
    setHostDirs([{ path: dir, label: 'Test', readonly: false }]);

    const result = await executeWriteHostFile(
      { path: file, content: 'new content', mode: 'overwrite', confirm: true },
      baseCtx,
    );

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('new content');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts source_path and destination_path aliases for move operations', async () => {
    const dir = makeTempDir();
    const sourceDir = path.join(dir, 'Desktop');
    const targetDir = path.join(sourceDir, 'Projects');
    const sourcePath = path.join(sourceDir, 'Fridge recipe');
    const destinationPath = path.join(targetDir, 'Fridge recipe');
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });
    setHostDirs([{ path: sourceDir, label: 'Desktop', readonly: false }]);

    const move = await executeMoveHostPath(
      { source_path: sourcePath, destination_path: destinationPath },
      baseCtx,
    );
    expect(move.ok).toBe(true);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(destinationPath)).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
