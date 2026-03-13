import {
  closeWebSessionFromContext,
  executeWebSearch,
} from '../container/agent-runner/src/tools/web/actions.js';
import type { ToolExecutionContext } from '../container/agent-runner/src/tools/types.js';

function toPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  const query = process.argv.slice(2).join(' ').trim() || 'latest AI news';
  let exitCode = 0;
  const ctx: ToolExecutionContext = {
    secrets: {
      WEB_RESTRICTED_DOMAINS:
        process.env.WEB_RESTRICTED_DOMAINS ||
        'linkedin.com,www.linkedin.com,m.linkedin.com',
    },
    maxSearchCallsPerTurn: toPositiveInt(
      process.env.WEB_TOOL_MAX_SEARCH_CALLS,
      2,
    ),
    maxToolSteps: toPositiveInt(process.env.WEB_TOOL_MAX_STEPS, 6),
    searchTimeoutMs: toPositiveInt(process.env.WEB_TOOL_SEARCH_TIMEOUT_MS, 8000),
    pageFetchTimeoutMs: toPositiveInt(
      process.env.WEB_TOOL_PAGE_FETCH_TIMEOUT_MS,
      5000,
    ),
    totalWebBudgetMs: toPositiveInt(process.env.WEB_TOOL_TOTAL_BUDGET_MS, 20000),
    startedAtMs: Date.now(),
    stepCount: 0,
    searchCount: 0,
  };

  try {
    const result = await executeWebSearch({ query }, ctx);
    if (!result.ok) {
      console.error(
        JSON.stringify(
          {
            ok: false,
            query,
            restricted: result.restricted || false,
            error: result.content,
          },
          null,
          2,
        ),
      );
      exitCode = 1;
      return;
    }

    const preview = result.content.slice(0, 300);
    console.log(
      JSON.stringify(
        {
          ok: true,
          query,
          preview,
        },
        null,
        2,
      ),
    );
  } finally {
    await closeWebSessionFromContext(ctx).catch(() => undefined);
    process.exit(exitCode);
  }
}

void main();
