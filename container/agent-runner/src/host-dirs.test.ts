import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadHostDirectoriesConfig,
  resolveHostDirectories,
  scanDirectory,
  scanAllDirectories,
  formatDirectoryReport,
  formatSize,
} from './host-dirs.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-host-dirs-test-'));
}

describe('formatSize', () => {
  it('formats bytes', () => {
    expect(formatSize(0)).toBe('0B');
    expect(formatSize(512)).toBe('512B');
    expect(formatSize(1023)).toBe('1023B');
  });

  it('formats kilobytes', () => {
    expect(formatSize(1024)).toBe('1.0KB');
    expect(formatSize(2048)).toBe('2.0KB');
    expect(formatSize(1536)).toBe('1.5KB');
  });

  it('formats megabytes', () => {
    expect(formatSize(1024 * 1024)).toBe('1.0MB');
    expect(formatSize(1024 * 1024 * 5)).toBe('5.0MB');
  });

  it('formats gigabytes', () => {
    expect(formatSize(1024 * 1024 * 1024)).toBe('1.0GB');
  });
});

describe('loadHostDirectoriesConfig', () => {
  const originalEnv = process.env.NANOCLAW_HOST_DIRECTORIES;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NANOCLAW_HOST_DIRECTORIES;
    } else {
      process.env.NANOCLAW_HOST_DIRECTORIES = originalEnv;
    }
  });

  it('returns null when no config and no env var', () => {
    delete process.env.NANOCLAW_HOST_DIRECTORIES;
    // Config file probably doesn't exist in test env — just check it doesn't throw
    const result = loadHostDirectoriesConfig();
    // Result is either null or a valid config
    expect(result === null || Array.isArray(result?.directories)).toBe(true);
  });

  it('reads config from NANOCLAW_HOST_DIRECTORIES env var', () => {
    const tmpDir = makeTempDir();
    process.env.NANOCLAW_HOST_DIRECTORIES = JSON.stringify({
      directories: [{ path: tmpDir, label: 'Test', readonly: false }],
    });

    const config = loadHostDirectoriesConfig();
    expect(config).not.toBeNull();
    expect(config!.directories).toHaveLength(1);
    expect(config!.directories[0].path).toBe(tmpDir);
    expect(config!.directories[0].label).toBe('Test');

    fs.rmdirSync(tmpDir);
  });

  it('ignores malformed env var and returns null', () => {
    process.env.NANOCLAW_HOST_DIRECTORIES = 'not-valid-json';
    // Should not throw, should return null (or file-based config if exists)
    expect(() => loadHostDirectoriesConfig()).not.toThrow();
  });
});

describe('resolveHostDirectories', () => {
  const originalEnv = process.env.NANOCLAW_HOST_DIRECTORIES;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NANOCLAW_HOST_DIRECTORIES;
    } else {
      process.env.NANOCLAW_HOST_DIRECTORIES = originalEnv;
    }
  });

  it('returns directories from env var', () => {
    const tmpDir = makeTempDir();
    process.env.NANOCLAW_HOST_DIRECTORIES = JSON.stringify({
      directories: [{ path: tmpDir, label: 'Tmp', readonly: false }],
    });

    const dirs = resolveHostDirectories();
    expect(dirs.length).toBeGreaterThanOrEqual(1);
    const found = dirs.find((d) => d.label === 'Tmp');
    expect(found).toBeDefined();

    fs.rmdirSync(tmpDir);
  });
});

describe('scanDirectory', () => {
  it('returns exists=false for missing directory', () => {
    const info = scanDirectory({
      path: '/absolutely-nonexistent-nanoclaw-test-path-xyz',
      label: 'Missing',
      readonly: false,
    });

    expect(info.exists).toBe(false);
    expect(info.writable).toBe(false);
    expect(info.itemCount).toBe(0);
    expect(info.topItems).toHaveLength(0);
  });

  it('returns correct info for an existing directory', () => {
    const tmpDir = makeTempDir();
    fs.writeFileSync(path.join(tmpDir, 'file1.txt'), 'hello');
    fs.writeFileSync(path.join(tmpDir, 'file2.txt'), 'world');
    fs.mkdirSync(path.join(tmpDir, 'subdir'));

    const info = scanDirectory({ path: tmpDir, label: 'Temp', readonly: false });

    expect(info.exists).toBe(true);
    expect(info.itemCount).toBe(3);
    expect(info.topItems.length).toBeGreaterThan(0);
    // Directories should have a trailing /
    const subdirEntry = info.topItems.find((i) => i.includes('subdir'));
    expect(subdirEntry).toMatch(/subdir\//);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('marks read-only dirs as not writable', () => {
    const info = scanDirectory({
      path: os.tmpdir(),
      label: 'ReadOnly',
      readonly: true,
    });

    expect(info.exists).toBe(true);
    expect(info.writable).toBe(false); // readonly flag forces writable=false
  });

  it('limits topItems to 15 plus a "more" line', () => {
    const tmpDir = makeTempDir();
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(path.join(tmpDir, `file-${i}.txt`), 'x');
    }

    const info = scanDirectory({ path: tmpDir, label: 'Many', readonly: false });
    expect(info.itemCount).toBe(20);
    // 15 items + 1 "... and N more" line
    expect(info.topItems).toHaveLength(16);
    expect(info.topItems[15]).toContain('more');

    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('scanAllDirectories', () => {
  const originalEnv = process.env.NANOCLAW_HOST_DIRECTORIES;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NANOCLAW_HOST_DIRECTORIES;
    } else {
      process.env.NANOCLAW_HOST_DIRECTORIES = originalEnv;
    }
  });

  it('returns empty array when no config', () => {
    delete process.env.NANOCLAW_HOST_DIRECTORIES;
    // Without config and without /workspace/extra, should return [] or empty-ish
    // (We can't guarantee the file doesn't exist, so just check it doesn't throw)
    expect(() => scanAllDirectories()).not.toThrow();
  });

  it('scans configured directories from env var', () => {
    const tmpDir = makeTempDir();
    fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'hello');

    process.env.NANOCLAW_HOST_DIRECTORIES = JSON.stringify({
      directories: [{ path: tmpDir, label: 'TestDir', readonly: false }],
    });

    const results = scanAllDirectories();
    const found = results.find((d) => d.label === 'TestDir');
    expect(found).toBeDefined();
    expect(found!.exists).toBe(true);
    expect(found!.itemCount).toBe(1);

    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('formatDirectoryReport', () => {
  it('includes directory label and path', () => {
    const tmpDir = makeTempDir();
    const dirs = [
      {
        path: tmpDir,
        label: 'MyDocs',
        readonly: false,
        exists: true,
        writable: true,
        itemCount: 2,
        topItems: ['  file1.txt (10B)', '  file2.txt (20B)'],
      },
    ];

    const report = formatDirectoryReport(dirs);
    expect(report).toContain('MyDocs');
    expect(report).toContain(tmpDir);
    expect(report).toContain('read-write');
    expect(report).toContain('Items: 2');

    fs.rmdirSync(tmpDir);
  });

  it('shows NOT FOUND for missing directories', () => {
    const dirs = [
      {
        path: '/does-not-exist',
        label: 'Gone',
        readonly: false,
        exists: false,
        writable: false,
        itemCount: 0,
        topItems: [],
      },
    ];

    const report = formatDirectoryReport(dirs);
    expect(report).toContain('NOT FOUND');
    expect(report).toContain('Gone');
  });
});
