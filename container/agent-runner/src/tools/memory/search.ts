import fs from 'fs';
import path from 'path';

import { ToolExecutionContext, ToolExecutionResult } from '../types.js';

const MAX_QUERY_LENGTH = 120;
const DEFAULT_RESULT_LIMIT = 8;
const SEARCH_TIMEOUT_MS = 3000;
const SEARCH_POLL_INTERVAL_MS = 150;

// NANOCLAW_IPC_INPUT_DIR points to {ipcDir}/input — search dirs are siblings,
// mirroring how remember.ts resolves its 'memory' sibling dir.
function resolveSearchDir(subfolder: string): string {
  const inputDir =
    process.env.NANOCLAW_IPC_INPUT_DIR || '/workspace/ipc/input';
  return path.join(path.dirname(inputDir), subfolder);
}

function resolveGroupFolder(ctx: ToolExecutionContext): string {
  return (
    process.env.NANOCLAW_GROUP_FOLDER ||
    (ctx.secrets?.NANOCLAW_GROUP_FOLDER as string | undefined) ||
    ''
  );
}

function writeJsonAtomically(filePath: string, data: object): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filePath);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MemorySearchResultRow {
  content?: unknown;
  kind?: unknown;
}

export async function executeMemorySearch(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    return { ok: false, content: 'query is required.' };
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return {
      ok: false,
      content: `Query too long - keep memory searches under ${MAX_QUERY_LENGTH} chars.`,
    };
  }

  const groupFolder = resolveGroupFolder(ctx);
  if (!groupFolder) {
    return {
      ok: false,
      content: 'Memory search is unavailable because the current group is unknown.',
    };
  }

  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const requestPath = path.join(
    resolveSearchDir('memory-search-requests'),
    `${requestId}.json`,
  );
  const resultPath = path.join(
    resolveSearchDir('memory-search-results'),
    `${requestId}.json`,
  );

  try {
    writeJsonAtomically(requestPath, {
      type: 'memory_search',
      query,
      limit: DEFAULT_RESULT_LIMIT,
    });

    const deadline = Date.now() + SEARCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (fs.existsSync(resultPath)) {
        const raw = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as {
          results?: MemorySearchResultRow[];
        };
        fs.unlinkSync(resultPath);
        const results = Array.isArray(raw.results) ? raw.results : [];
        if (results.length === 0) {
          return { ok: true, content: 'No memory results found.' };
        }

        const lines = results
          .map((row) => {
            const kind = typeof row.kind === 'string' ? row.kind : 'memory';
            const content =
              typeof row.content === 'string' ? row.content.trim() : '';
            return content ? `- [${kind}] ${content}` : '';
          })
          .filter(Boolean);

        return {
          ok: true,
          content: lines.length > 0 ? lines.join('\n') : 'No memory results found.',
        };
      }
      await sleep(SEARCH_POLL_INTERVAL_MS);
    }

    return { ok: true, content: 'No memory results found (search timed out).' };
  } catch (err) {
    return {
      ok: false,
      content: `Memory search failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    try {
      if (fs.existsSync(requestPath)) fs.unlinkSync(requestPath);
    } catch {
      /* best effort cleanup */
    }
  }
}
