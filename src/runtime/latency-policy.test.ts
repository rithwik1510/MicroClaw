import { describe, expect, it } from 'vitest';

import { resolveLatencyTurnPolicy } from './latency-policy.js';

describe('latency policy', () => {
  it('uses the strictest limits for tiny conversation turns', () => {
    expect(resolveLatencyTurnPolicy('tiny_conversation')).toEqual({
      skipContextBundle: true,
      disableTools: true,
      runtimeSecretOverrides: {
        OPENAI_REQUEST_TIMEOUT_MS: '25000',
        OPENAI_MAX_OUTPUT_TOKENS: '120',
        OPENAI_INPUT_BUDGET_CHARS: '1600',
      },
    });
  });

  it('keeps compact context for simple conversation turns but disables tools', () => {
    expect(resolveLatencyTurnPolicy('simple_conversation')).toEqual({
      skipContextBundle: false,
      disableTools: true,
      runtimeSecretOverrides: {
        OPENAI_REQUEST_TIMEOUT_MS: '40000',
        OPENAI_MAX_OUTPUT_TOKENS: '220',
        OPENAI_INPUT_BUDGET_CHARS: '3200',
      },
    });
  });
});
