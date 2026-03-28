import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  formatDirectoryReport,
  resolveHostDirectories,
  scanAllDirectories,
} from '../host-dirs.js';
import { ToolExecutionContext, ToolExecutionResult } from './types.js';

type HostFileAccessMode = 'read' | 'write';

type AuthorizedPath = {
  path: string;
  rootLabel: string;
  rootPath: string;
  readonly: boolean;
};

type MoveCopyPaths = {
  sourcePath: unknown;
  destinationPath: unknown;
};

const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_MAX_FILE_CHARS = 12000;

function expandHome(inputPath: string): string {
  if (inputPath === '~' || inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(os.homedir(), inputPath.slice(1));
  }
  return inputPath;
}

function normalizeForComparison(inputPath: string): string {
  const normalized = path.normalize(inputPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithinPath(rootPath: string, childPath: string): boolean {
  const relative = path.relative(rootPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function nearestExistingAncestor(targetPath: string): string | null {
  let current = path.resolve(targetPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function safeRealpath(targetPath: string): string {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function getConfiguredRoots() {
  return resolveHostDirectories()
    .map((dir) => {
      const resolvedPath = path.resolve(expandHome(dir.path));
      const existingAnchor = nearestExistingAncestor(resolvedPath) || resolvedPath;
      return {
        ...dir,
        resolvedPath,
        anchorPath: safeRealpath(existingAnchor),
      };
    })
    .filter((dir, index, all) => {
      const key = normalizeForComparison(dir.resolvedPath);
      return all.findIndex((candidate) => normalizeForComparison(candidate.resolvedPath) === key) === index;
    });
}

function authorizationError(message: string): ToolExecutionResult {
  return { ok: false, restricted: true, content: message };
}

function authorizePath(
  rawPath: unknown,
  mode: HostFileAccessMode,
): AuthorizedPath | ToolExecutionResult {
  const inputPath = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!inputPath) {
    return { ok: false, content: 'path is required.' };
  }

  const roots = getConfiguredRoots();
  if (roots.length === 0) {
    return authorizationError(
      'No host directories are configured. Run the host-files setup first and try again.',
    );
  }

  const resolvedPath = path.resolve(expandHome(inputPath));
  const anchor = nearestExistingAncestor(resolvedPath);
  const authorized = roots.find((root) => {
    const rootPath = normalizeForComparison(root.anchorPath);
    if (fs.existsSync(resolvedPath)) {
      return isWithinPath(rootPath, normalizeForComparison(safeRealpath(resolvedPath)));
    }
    if (!anchor) return false;
    return isWithinPath(rootPath, normalizeForComparison(safeRealpath(anchor)));
  });

  if (!authorized) {
    const labels = roots.map((root) => `${root.label} (${root.resolvedPath})`).join(', ');
    return authorizationError(
      `Path is outside the configured host-directory allowlist: ${resolvedPath}. Allowed roots: ${labels}`,
    );
  }

  if (mode === 'write' && authorized.readonly) {
    return authorizationError(
      `Path is in a read-only host directory: ${resolvedPath} (${authorized.label}).`,
    );
  }

  return {
    path: resolvedPath,
    rootLabel: authorized.label,
    rootPath: authorized.resolvedPath,
    readonly: authorized.readonly,
  };
}

function hasExplicitConfirmation(ctx: ToolExecutionContext, args?: Record<string, unknown>): boolean {
  if (args?.confirm === true) return true;
  const prompt = (
    ctx.secrets?.NANOCLAW_ORIGINAL_PROMPT ||
    ctx.secrets?.NANOCLAW_CURRENT_PROMPT ||
    ''
  ).trim();
  if (!prompt) return false;
  return /\b(confirm|confirmed|yes|go ahead|proceed|overwrite|replace it|do it|move it|rename it)\b/i.test(
    prompt,
  );
}

function ensureTextFile(filePath: string): ToolExecutionResult | null {
  try {
    const buffer = fs.readFileSync(filePath);
    if (buffer.includes(0)) {
      return { ok: false, content: `File appears to be binary and cannot be read as text: ${filePath}` };
    }
  } catch (err) {
    return {
      ok: false,
      content: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return null;
}

function clampLimit(raw: unknown, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function resolveMoveCopyPaths(args: Record<string, unknown>): MoveCopyPaths {
  return {
    sourcePath: args.source_path ?? args.from,
    destinationPath: args.destination_path ?? args.to,
  };
}

function describeEntry(entryPath: string, stats: fs.Stats): string {
  const basename = path.basename(entryPath);
  if (stats.isDirectory()) return `${basename}/`;
  return `${basename} (${stats.size} bytes)`;
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  let regex = '^';
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === '*' && next === '*') {
      regex += '.*';
      index++;
      continue;
    }
    if (char === '*') {
      regex += '[^/]*';
      continue;
    }
    if (char === '?') {
      regex += '.';
      continue;
    }
    regex += /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char;
  }
  regex += '$';
  return new RegExp(regex, process.platform === 'win32' ? 'i' : '');
}

function walkDirectory(
  basePath: string,
  options: {
    recursive: boolean;
    limit: number;
    onEntry: (entryPath: string, stats: fs.Stats) => void;
  },
): void {
  const queue = [basePath];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      let stats: fs.Stats;
      try {
        stats = fs.statSync(fullPath);
      } catch {
        continue;
      }
      options.onEntry(fullPath, stats);
      if (options.limit <= 0) return;
      if (options.recursive && entry.isDirectory()) {
        queue.push(fullPath);
      }
    }
  }
}

export async function executeListHostDirectories(
  _args: Record<string, unknown>,
  _ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const dirs = scanAllDirectories();
  if (dirs.length === 0) {
    return {
      ok: true,
      content:
        'No host directories are configured for this agent yet. Use the host-files setup flow first.',
    };
  }
  return { ok: true, content: formatDirectoryReport(dirs) };
}

export async function executeListHostEntries(
  args: Record<string, unknown>,
  _ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const authorized = authorizePath(args.path, 'read');
  if ('ok' in authorized) return authorized;
  if (!fs.existsSync(authorized.path)) {
    return { ok: false, content: `Directory does not exist: ${authorized.path}` };
  }
  const stats = fs.statSync(authorized.path);
  if (!stats.isDirectory()) {
    return { ok: false, content: `Path is not a directory: ${authorized.path}` };
  }

  const recursive = args.recursive === true;
  const limit = clampLimit(args.limit, 50, DEFAULT_MAX_RESULTS);
  const lines: string[] = [];
  walkDirectory(authorized.path, {
    recursive,
    limit,
    onEntry: (entryPath, entryStats) => {
      if (lines.length >= limit) return;
      const relative = path.relative(authorized.path, entryPath) || path.basename(entryPath);
      lines.push(`${relative.replace(/\\/g, '/')} ${entryStats.isDirectory() ? '[dir]' : `[${entryStats.size} bytes]`}`);
    },
  });

  const header = `Entries in ${authorized.path} (${recursive ? 'recursive' : 'top-level'}):`;
  const body = lines.length > 0 ? lines.join('\n') : '(empty)';
  return { ok: true, content: `${header}\n${body}` };
}

export async function executeReadHostFile(
  args: Record<string, unknown>,
  _ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const authorized = authorizePath(args.path, 'read');
  if ('ok' in authorized) return authorized;
  if (!fs.existsSync(authorized.path)) {
    return { ok: false, content: `File does not exist: ${authorized.path}` };
  }
  const stats = fs.statSync(authorized.path);
  if (!stats.isFile()) {
    return { ok: false, content: `Path is not a file: ${authorized.path}` };
  }

  const binaryCheck = ensureTextFile(authorized.path);
  if (binaryCheck) return binaryCheck;

  const content = fs.readFileSync(authorized.path, 'utf8');
  const startLine = Math.max(1, clampLimit(args.start_line, 1, 1_000_000));
  const maxLines = clampLimit(args.max_lines, 200, 2000);
  const maxChars = clampLimit(args.max_chars, DEFAULT_MAX_FILE_CHARS, 100_000);
  const lines = content.split(/\r?\n/).slice(startLine - 1, startLine - 1 + maxLines);
  const text = lines.join('\n').slice(0, maxChars);
  return {
    ok: true,
    content: `File: ${authorized.path}\n${text || '(empty file or selection)'}`,
  };
}

export async function executeWriteHostFile(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const authorized = authorizePath(args.path, 'write');
  if ('ok' in authorized) return authorized;
  const content = typeof args.content === 'string' ? args.content : '';
  const mode = args.mode === 'overwrite' ? 'overwrite' : 'create';
  const exists = fs.existsSync(authorized.path);

  if (mode === 'create' && exists) {
    return {
      ok: false,
      content: `File already exists: ${authorized.path}. Use mode="overwrite" with explicit confirmation if you want to replace it.`,
    };
  }
  if (mode === 'overwrite' && exists && !hasExplicitConfirmation(ctx, args)) {
    return {
      ok: false,
      content:
        'Overwriting an existing file needs explicit user confirmation in the current turn.',
    };
  }

  fs.mkdirSync(path.dirname(authorized.path), { recursive: true });
  fs.writeFileSync(authorized.path, content, 'utf8');
  return {
    ok: true,
    content: `${exists ? 'Updated' : 'Created'} file in ${authorized.rootLabel}: ${authorized.path}`,
  };
}

export async function executeEditHostFile(
  args: Record<string, unknown>,
  _ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const authorized = authorizePath(args.path, 'write');
  if ('ok' in authorized) return authorized;
  if (!fs.existsSync(authorized.path)) {
    return { ok: false, content: `File does not exist: ${authorized.path}` };
  }
  const search = typeof args.search === 'string' ? args.search : '';
  const replace = typeof args.replace === 'string' ? args.replace : '';
  if (!search) return { ok: false, content: 'search is required.' };

  const binaryCheck = ensureTextFile(authorized.path);
  if (binaryCheck) return binaryCheck;
  const original = fs.readFileSync(authorized.path, 'utf8');
  if (!original.includes(search)) {
    return { ok: false, content: `Search text was not found in ${authorized.path}` };
  }
  const replaceAll = args.replace_all === true;
  const updated = replaceAll
    ? original.split(search).join(replace)
    : original.replace(search, replace);
  fs.writeFileSync(authorized.path, updated, 'utf8');
  return {
    ok: true,
    content: `Edited file in ${authorized.rootLabel}: ${authorized.path}`,
  };
}

export async function executeGlobHostFiles(
  args: Record<string, unknown>,
  _ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const authorized = authorizePath(args.base_path, 'read');
  if ('ok' in authorized) return authorized;
  const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
  if (!pattern) return { ok: false, content: 'pattern is required.' };
  const limit = clampLimit(args.limit, 50, DEFAULT_MAX_RESULTS);
  const regex = globToRegExp(pattern);
  const matches: string[] = [];

  walkDirectory(authorized.path, {
    recursive: true,
    limit,
    onEntry: (entryPath) => {
      if (matches.length >= limit) return;
      const relative = path.relative(authorized.path, entryPath).replace(/\\/g, '/');
      if (regex.test(relative)) {
        matches.push(relative);
      }
    },
  });

  return {
    ok: true,
    content:
      matches.length > 0
        ? `Glob matches under ${authorized.path}:\n${matches.join('\n')}`
        : `No matches for "${pattern}" under ${authorized.path}.`,
  };
}

export async function executeGrepHostFiles(
  args: Record<string, unknown>,
  _ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const authorized = authorizePath(args.base_path, 'read');
  if ('ok' in authorized) return authorized;
  const query = typeof args.query === 'string' ? args.query : '';
  if (!query) return { ok: false, content: 'query is required.' };
  const limit = clampLimit(args.limit, 50, DEFAULT_MAX_RESULTS);
  const matches: string[] = [];

  walkDirectory(authorized.path, {
    recursive: true,
    limit,
    onEntry: (entryPath, stats) => {
      if (matches.length >= limit || !stats.isFile()) return;
      const binaryCheck = ensureTextFile(entryPath);
      if (binaryCheck) return;
      const content = fs.readFileSync(entryPath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        if (lines[index].includes(query)) {
          matches.push(`${path.relative(authorized.path, entryPath).replace(/\\/g, '/')}:${index + 1}: ${lines[index]}`);
          break;
        }
      }
    },
  });

  return {
    ok: true,
    content:
      matches.length > 0
        ? `Grep matches under ${authorized.path}:\n${matches.join('\n')}`
        : `No grep matches for "${query}" under ${authorized.path}.`,
  };
}

export async function executeMakeHostDirectory(
  args: Record<string, unknown>,
  _ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const authorized = authorizePath(args.path, 'write');
  if ('ok' in authorized) return authorized;
  fs.mkdirSync(authorized.path, { recursive: true });
  return {
    ok: true,
    content: `Created directory in ${authorized.rootLabel}: ${authorized.path}`,
  };
}

export async function executeMoveHostPath(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const { sourcePath, destinationPath } = resolveMoveCopyPaths(args);
  const source = authorizePath(sourcePath, 'write');
  if ('ok' in source) return source;
  const destination = authorizePath(destinationPath, 'write');
  if ('ok' in destination) return destination;
  if (!fs.existsSync(source.path)) {
    return { ok: false, content: `Source path does not exist: ${source.path}` };
  }
  if (fs.existsSync(destination.path) && !hasExplicitConfirmation(ctx, args)) {
    return {
      ok: false,
      content:
        'Replacing an existing destination requires explicit user confirmation in the current turn.',
    };
  }
  fs.mkdirSync(path.dirname(destination.path), { recursive: true });
  fs.renameSync(source.path, destination.path);
  return {
    ok: true,
    content: `Moved ${source.path} to ${destination.path}`,
  };
}

export async function executeCopyHostPath(
  args: Record<string, unknown>,
  _ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const { sourcePath, destinationPath } = resolveMoveCopyPaths(args);
  const source = authorizePath(sourcePath, 'read');
  if ('ok' in source) return source;
  const destination = authorizePath(destinationPath, 'write');
  if ('ok' in destination) return destination;
  if (!fs.existsSync(source.path)) {
    return { ok: false, content: `Source path does not exist: ${source.path}` };
  }
  fs.mkdirSync(path.dirname(destination.path), { recursive: true });
  fs.cpSync(source.path, destination.path, { recursive: true, force: false, errorOnExist: true });
  return {
    ok: true,
    content: `Copied ${source.path} to ${destination.path}`,
  };
}

export function __testOnly() {
  return {
    authorizePath,
    hasExplicitConfirmation,
    globToRegExp,
    getConfiguredRoots,
    describeEntry,
  };
}
