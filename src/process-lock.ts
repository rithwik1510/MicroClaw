import { execFileSync } from 'child_process';
import fs from 'fs';

export interface ProcessLockPayload {
  pid?: number;
  startedAt?: string;
}

export interface ProcessMetadata {
  pid: number;
  startedAtMs?: number;
  commandLine?: string;
  name?: string;
}

interface ProcessLockOptions {
  lockPath: string;
  dataDir: string;
  pid?: number;
  startedAt?: string;
  processSignatures?: string[];
  inspectProcess?: (pid: number) => ProcessMetadata | undefined;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readProcessLockPayload(
  lockPath: string,
): ProcessLockPayload | undefined {
  if (!fs.existsSync(lockPath)) return undefined;
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    return JSON.parse(raw) as ProcessLockPayload;
  } catch {
    return undefined;
  }
}

function normalizeSignature(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function getProcessMetadata(pid: number): ProcessMetadata | undefined {
  if (!isPidAlive(pid)) return undefined;
  if (process.platform !== 'win32') {
    return { pid };
  }

  try {
    const script = `
$proc = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue
if ($null -eq $proc) { return }
[pscustomobject]@{
  pid = ${pid}
  name = $proc.Name
  commandLine = $proc.CommandLine
  creationDate = $proc.CreationDate
} | ConvertTo-Json -Compress
`;
    const raw = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    if (!raw) return { pid };
    const parsed = JSON.parse(raw) as {
      pid?: number;
      name?: string;
      commandLine?: string;
      creationDate?: string;
    };
    const startedAtMs = parsed.creationDate
      ? Date.parse(parsed.creationDate)
      : undefined;
    return {
      pid,
      name: parsed.name,
      commandLine: parsed.commandLine,
      startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : undefined,
    };
  } catch {
    return { pid };
  }
}

function isExpectedProcessIdentity(
  payload: ProcessLockPayload | undefined,
  metadata: ProcessMetadata | undefined,
  processSignatures: string[],
): boolean {
  if (!metadata) return false;

  const lockStartedAtMs = payload?.startedAt
    ? Date.parse(payload.startedAt)
    : NaN;
  if (
    Number.isFinite(lockStartedAtMs) &&
    Number.isFinite(metadata.startedAtMs) &&
    (metadata.startedAtMs as number) - (lockStartedAtMs as number) > 5_000
  ) {
    return false;
  }

  const haystack = normalizeSignature(
    `${metadata.name || ''} ${metadata.commandLine || ''}`,
  );
  if (!haystack) {
    return true;
  }
  return processSignatures.some((signature) =>
    haystack.includes(normalizeSignature(signature)),
  );
}

export function acquireProcessLock(options: ProcessLockOptions): void {
  const pid = options.pid ?? process.pid;
  const startedAt = options.startedAt ?? new Date().toISOString();
  const inspectProcess = options.inspectProcess || getProcessMetadata;
  const processSignatures = (
    options.processSignatures?.length
      ? options.processSignatures
      : [process.cwd(), 'src/index.ts', 'dist/index.js', 'microclaw']
  ).filter(Boolean);

  fs.mkdirSync(options.dataDir, { recursive: true });
  const payload =
    JSON.stringify(
      {
        pid,
        startedAt,
      },
      null,
      2,
    ) + '\n';

  try {
    fs.writeFileSync(options.lockPath, payload, { flag: 'wx' });
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'EEXIST') throw err;
  }

  const existing = readProcessLockPayload(options.lockPath);
  const existingPid = existing?.pid;
  if (existingPid && existingPid !== pid && isPidAlive(existingPid)) {
    const metadata = inspectProcess(existingPid);
    if (isExpectedProcessIdentity(existing, metadata, processSignatures)) {
      throw new Error(
        `Another MicroClaw instance is already running (PID ${existingPid}). Stop it before starting a new one.`,
      );
    }
  }

  try {
    fs.unlinkSync(options.lockPath);
  } catch {
    // ignore stale lock cleanup errors
  }

  fs.writeFileSync(options.lockPath, payload, { flag: 'wx' });
}

export function releaseProcessLock(lockPath: string, pid = process.pid): void {
  const existing = readProcessLockPayload(lockPath);
  if (existing?.pid && existing.pid !== pid) {
    return;
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // ignore
  }
}
