import { RuntimeUsageLog, RuntimeUsageMetrics } from './types.js';

type Pricing = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  source: 'env' | 'builtin' | 'default';
};

const BUILTIN_MODEL_PRICING: Record<string, Pricing> = {
  'qwen/qwen3-235b-a22b-instruct-2507': {
    inputPerMillionUsd: 0.071,
    outputPerMillionUsd: 0.1,
    source: 'builtin',
  },
};

function roundUsd(value: number): number {
  return Number(value.toFixed(8));
}

function normalizeModel(model: string): string {
  return model.trim().toLowerCase();
}

function parsePositiveNumber(raw: string | undefined): number | null {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function resolveRuntimePricing(model: string): Pricing {
  const envInput = parsePositiveNumber(
    process.env.NANOCLAW_INPUT_COST_PER_MTOKENS,
  );
  const envOutput = parsePositiveNumber(
    process.env.NANOCLAW_OUTPUT_COST_PER_MTOKENS,
  );
  if (envInput !== null && envOutput !== null) {
    return {
      inputPerMillionUsd: envInput,
      outputPerMillionUsd: envOutput,
      source: 'env',
    };
  }

  return (
    BUILTIN_MODEL_PRICING[normalizeModel(model)] || {
      inputPerMillionUsd: 0,
      outputPerMillionUsd: 0,
      source: 'default',
    }
  );
}

export function estimateRuntimeCost(input: {
  model: string;
  usage: RuntimeUsageMetrics;
}): Pick<
  RuntimeUsageLog,
  'inputCostUsd' | 'outputCostUsd' | 'totalCostUsd' | 'notes'
> {
  const pricing = resolveRuntimePricing(input.model);
  const inputCostUsd =
    (input.usage.inputTokens / 1_000_000) * pricing.inputPerMillionUsd;
  const outputCostUsd =
    (input.usage.outputTokens / 1_000_000) * pricing.outputPerMillionUsd;
  const notes =
    pricing.source === 'default'
      ? 'No pricing configured for this model; cost defaults to 0.'
      : input.usage.source === 'estimated'
        ? `Token usage estimated; pricing source=${pricing.source}.`
        : `Pricing source=${pricing.source}.`;

  return {
    inputCostUsd: roundUsd(inputCostUsd),
    outputCostUsd: roundUsd(outputCostUsd),
    totalCostUsd: roundUsd(inputCostUsd + outputCostUsd),
    notes,
  };
}

export function buildRuntimeUsageLog(input: {
  groupFolder: string;
  chatJid: string;
  profileId?: string;
  provider: RuntimeUsageLog['provider'];
  model: string;
  triggerKind: RuntimeUsageLog['triggerKind'];
  startedAt: string;
  durationMs: number;
  usage: RuntimeUsageMetrics;
}): RuntimeUsageLog {
  const cost = estimateRuntimeCost({
    model: input.model,
    usage: input.usage,
  });
  return {
    groupFolder: input.groupFolder,
    chatJid: input.chatJid,
    profileId: input.profileId,
    provider: input.provider,
    model: input.model,
    triggerKind: input.triggerKind,
    startedAt: input.startedAt,
    durationMs: input.durationMs,
    usage: input.usage,
    ...cost,
  };
}
