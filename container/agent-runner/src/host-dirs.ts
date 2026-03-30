/**
 * Host directory discovery and scanning for NanoClaw agents.
 *
 * Works in two modes:
 *   Native mode — reads real host paths from NANOCLAW_HOST_DIRECTORIES env var
 *                 (a JSON string set by backend.ts from ~/.config/microclaw/host-directories.json)
 *   Docker mode — falls back to scanning /workspace/extra/* subdirectories
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export interface HostDirectory {
  /** Absolute path on host (native) or /workspace/extra/X (Docker). */
  path: string;
  /** Display label, e.g. "Documents". */
  label: string;
  /** Whether the directory is configured as read-only. */
  readonly: boolean;
}

export interface HostDirectoryInfo extends HostDirectory {
  exists: boolean;
  writable: boolean;
  itemCount: number;
  topItems: string[];
}

export interface HostDirectoriesConfig {
  directories: HostDirectory[];
}

const CONFIG_PATH = path.join(
  os.homedir(),
  '.config',
  'microclaw',
  'host-directories.json',
);

/**
 * Load host directories config.
 * Priority: NANOCLAW_HOST_DIRECTORIES env var → config file → null
 */
export function loadHostDirectoriesConfig(): HostDirectoriesConfig | null {
  const envVar = process.env.NANOCLAW_HOST_DIRECTORIES;
  if (envVar) {
    try {
      const parsed = JSON.parse(envVar) as HostDirectoriesConfig;
      if (Array.isArray(parsed.directories)) {
        return parsed;
      }
    } catch {
      // fall through to file
    }
  }

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw) as HostDirectoriesConfig;
      if (Array.isArray(parsed.directories)) {
        return parsed;
      }
    }
  } catch {
    // fall through
  }

  return null;
}

/**
 * Expand ~ to home directory in a path string.
 */
function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Resolve the list of host directories to use.
 * Returns HostDirectory[] from config, or falls back to /workspace/extra/* for Docker.
 */
export function resolveHostDirectories(): HostDirectory[] {
  const config = loadHostDirectoriesConfig();
  if (config && config.directories.length > 0) {
    return config.directories.map((d) => ({
      ...d,
      path: expandHome(d.path),
    }));
  }

  // Docker fallback: scan /workspace/extra/
  const extraBase = '/workspace/extra';
  try {
    if (fs.existsSync(extraBase)) {
      return fs
        .readdirSync(extraBase, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => ({
          path: path.join(extraBase, e.name),
          label: e.name,
          readonly: false,
        }));
    }
  } catch {
    // ignore
  }

  return [];
}

/**
 * Scan a single directory and return detailed info.
 */
export function scanDirectory(dir: HostDirectory): HostDirectoryInfo {
  const resolvedPath = expandHome(dir.path);
  const exists = fs.existsSync(resolvedPath);
  if (!exists) {
    return { ...dir, path: resolvedPath, exists: false, writable: false, itemCount: 0, topItems: [] };
  }

  let writable = false;
  if (!dir.readonly) {
    try {
      fs.accessSync(resolvedPath, fs.constants.W_OK);
      writable = true;
    } catch {
      // read-only mount or permissions
    }
  }

  let itemCount = 0;
  const topItems: string[] = [];
  try {
    const items = fs.readdirSync(resolvedPath);
    itemCount = items.length;
    for (const item of items.slice(0, 15)) {
      try {
        const stat = fs.statSync(path.join(resolvedPath, item));
        const suffix = stat.isDirectory() ? '/' : ` (${formatSize(stat.size)})`;
        topItems.push(`  ${item}${suffix}`);
      } catch {
        topItems.push(`  ${item}`);
      }
    }
    if (items.length > 15) {
      topItems.push(`  ... and ${items.length - 15} more items`);
    }
  } catch {
    topItems.push('  (unable to list contents)');
  }

  return { ...dir, path: resolvedPath, exists, writable, itemCount, topItems };
}

/**
 * Scan all configured host directories.
 */
export function scanAllDirectories(): HostDirectoryInfo[] {
  return resolveHostDirectories().map(scanDirectory);
}

/**
 * Format directory scan results for the MCP tool response.
 */
export function formatDirectoryReport(dirs: HostDirectoryInfo[]): string {
  const lines: string[] = [];
  for (const dir of dirs) {
    if (!dir.exists) {
      lines.push(`${dir.label} — NOT FOUND\n  Configured path: ${dir.path}`);
      continue;
    }
    lines.push(
      `${dir.label}/\n` +
        `  Path: ${dir.path}\n` +
        `  Access: ${dir.writable ? 'read-write' : 'read-only'}\n` +
        `  Items: ${dir.itemCount}\n` +
        `  Contents:\n${dir.topItems.join('\n') || '  (empty)'}`,
    );
  }
  return `Host directories accessible:\n\n${lines.join('\n\n')}`;
}

/**
 * Format bytes into a human-readable size string.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
