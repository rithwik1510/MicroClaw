import { describe, expect, it } from 'vitest';

import { resolveExternalRuntimeBudgets } from './budgets.js';

describe('resolveExternalRuntimeBudgets', () => {
  it('gives browser-operation turns a larger default tool loop budget', () => {
    const budgets = resolveExternalRuntimeBudgets({
      capabilityRoute: 'browser_operation',
      configuredRequestTimeoutMs: 30_000,
      remainingRuntimeBudgetMs: 180_000,
      browserTotalBudgetMs: 15_000,
    });

    expect(budgets.effectiveRequestTimeoutMs).toBe(30_000);
    expect(budgets.effectiveToolLoopBudgetMs).toBe(180_000);
  });

  it('keeps an explicitly configured tool loop budget', () => {
    const budgets = resolveExternalRuntimeBudgets({
      capabilityRoute: 'browser_operation',
      configuredToolLoopBudgetMs: 45_000,
      remainingRuntimeBudgetMs: 180_000,
      browserTotalBudgetMs: 15_000,
    });

    expect(budgets.effectiveToolLoopBudgetMs).toBe(45_000);
  });

  it('caps both budgets by the remaining runtime budget', () => {
    const budgets = resolveExternalRuntimeBudgets({
      capabilityRoute: 'web_lookup',
      configuredRequestTimeoutMs: 20_000,
      remainingRuntimeBudgetMs: 8_000,
      webTotalBudgetMs: 30_000,
    });

    expect(budgets.effectiveRequestTimeoutMs).toBe(8_000);
    expect(budgets.effectiveToolLoopBudgetMs).toBe(8_000);
  });
});
