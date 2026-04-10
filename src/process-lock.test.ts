import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';

import { acquireProcessLock, releaseProcessLock } from './process-lock.js';

describe('process lock', () => {
  it('replaces a stale lock when the pid belongs to an unrelated process', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'microclaw-lock-'));
    const lockPath = path.join(dir, 'microclaw.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 16424,
        startedAt: '2026-03-13T10:54:00.000Z',
      }),
    );

    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(() => true as never);

    expect(() =>
      acquireProcessLock({
        lockPath,
        dataDir: dir,
        pid: 777,
        startedAt: '2026-03-13T11:00:00.000Z',
        inspectProcess: () => ({
          pid: 16424,
          name: 'msedgewebview2.exe',
          commandLine: 'C:\\Windows\\SystemApps\\SearchHost.exe',
          startedAtMs: Date.parse('2026-03-13T10:54:14.000Z'),
        }),
      }),
    ).not.toThrow();

    const stored = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
      pid: number;
    };
    expect(stored.pid).toBe(777);

    killSpy.mockRestore();
  });

  it('keeps blocking when the live pid is still the MicroClaw host', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'microclaw-lock-'));
    const lockPath = path.join(dir, 'microclaw.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 888,
        startedAt: '2026-03-13T11:00:00.000Z',
      }),
    );

    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(() => true as never);

    expect(() =>
      acquireProcessLock({
        lockPath,
        dataDir: dir,
        pid: 999,
        startedAt: '2026-03-13T11:01:00.000Z',
        processSignatures: ['microclaw', 'src/index.ts'],
        inspectProcess: () => ({
          pid: 888,
          name: 'node.exe',
          commandLine:
            'C:/Users/posan/OneDrive/Desktop/RIA BOT/microclaw/node_modules/tsx/dist/cli.mjs src/index.ts',
          startedAtMs: Date.parse('2026-03-13T11:00:01.000Z'),
        }),
      }),
    ).toThrow(/already running/);

    killSpy.mockRestore();
  });

  it('releases only when the current pid owns the lock', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'microclaw-lock-'));
    const lockPath = path.join(dir, 'microclaw.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 1001,
        startedAt: '2026-03-13T11:00:00.000Z',
      }),
    );

    releaseProcessLock(lockPath, 2002);
    expect(fs.existsSync(lockPath)).toBe(true);

    releaseProcessLock(lockPath, 1001);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
