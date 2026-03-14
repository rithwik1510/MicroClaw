type CapabilityRoute =
  | 'plain_response'
  | 'web_lookup'
  | 'browser_operation'
  | 'deny_or_escalate';

export interface ExternalRuntimeBudgetInput {
  capabilityRoute?: CapabilityRoute;
  configuredRequestTimeoutMs?: number;
  configuredToolLoopBudgetMs?: number;
  remainingRuntimeBudgetMs: number;
  webTotalBudgetMs?: number;
  browserTotalBudgetMs?: number;
}

export interface ExternalRuntimeBudgetOutput {
  effectiveRequestTimeoutMs: number;
  effectiveToolLoopBudgetMs: number;
}

const DEFAULT_TOOL_LOOP_BUDGET_MS = 600_000;
const DEFAULT_WEB_TOOL_LOOP_BUDGET_MS = 600_000;
const DEFAULT_BROWSER_TOOL_LOOP_BUDGET_MS = 600_000;

function positiveOrUndefined(value: number | undefined): number | undefined {
  return Number.isFinite(value) && (value || 0) > 0 ? value : undefined;
}

export function resolveExternalRuntimeBudgets(
  input: ExternalRuntimeBudgetInput,
): ExternalRuntimeBudgetOutput {
  const remainingRuntimeBudgetMs = Math.max(0, input.remainingRuntimeBudgetMs);
  const capabilityRoute = input.capabilityRoute || 'plain_response';
  const configuredRequestTimeoutMs = positiveOrUndefined(
    input.configuredRequestTimeoutMs,
  );
  const configuredToolLoopBudgetMs = positiveOrUndefined(
    input.configuredToolLoopBudgetMs,
  );
  const webTotalBudgetMs = positiveOrUndefined(input.webTotalBudgetMs);
  const browserTotalBudgetMs = positiveOrUndefined(input.browserTotalBudgetMs);

  let desiredToolLoopBudgetMs =
    configuredToolLoopBudgetMs || DEFAULT_TOOL_LOOP_BUDGET_MS;
  if (!configuredToolLoopBudgetMs) {
    if (capabilityRoute === 'browser_operation') {
      desiredToolLoopBudgetMs = Math.max(
        DEFAULT_BROWSER_TOOL_LOOP_BUDGET_MS,
        browserTotalBudgetMs || 0,
      );
    } else if (capabilityRoute === 'web_lookup') {
      desiredToolLoopBudgetMs = Math.max(
        DEFAULT_WEB_TOOL_LOOP_BUDGET_MS,
        webTotalBudgetMs || 0,
      );
    }
  }

  const effectiveToolLoopBudgetMs = Math.min(
    remainingRuntimeBudgetMs,
    desiredToolLoopBudgetMs,
  );
  const desiredRequestTimeoutMs =
    configuredRequestTimeoutMs || remainingRuntimeBudgetMs;
  const effectiveRequestTimeoutMs = Math.min(
    remainingRuntimeBudgetMs,
    desiredRequestTimeoutMs,
  );

  return {
    effectiveRequestTimeoutMs: Math.max(1000, effectiveRequestTimeoutMs),
    effectiveToolLoopBudgetMs: Math.max(3000, effectiveToolLoopBudgetMs),
  };
}
