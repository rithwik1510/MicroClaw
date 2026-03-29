import { readEnvFile } from '../env.js';

const env = readEnvFile([
  'NANOCLAW_CONTEXT_CHARS_PER_TOKEN',
  'NANOCLAW_CONTEXT_SOFT_CAP_CHARS',
  'NANOCLAW_CONTEXT_HARD_CAP_CHARS',
  'NANOCLAW_CONTEXT_RESERVED_TOOL_CHARS',
  'NANOCLAW_CONTEXT_ESTIMATED_TOOL_SCHEMA_CHARS',
]);

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const CONTEXT_CHARS_PER_TOKEN_SAFETY_RATIO = parsePositiveInt(
  process.env.NANOCLAW_CONTEXT_CHARS_PER_TOKEN ||
    env.NANOCLAW_CONTEXT_CHARS_PER_TOKEN,
  4,
);
export const CONTEXT_SOFT_CAP_CHARS = parsePositiveInt(
  process.env.NANOCLAW_CONTEXT_SOFT_CAP_CHARS ||
    env.NANOCLAW_CONTEXT_SOFT_CAP_CHARS,
  32_000,
);
export const CONTEXT_HARD_CAP_CHARS = parsePositiveInt(
  process.env.NANOCLAW_CONTEXT_HARD_CAP_CHARS ||
    env.NANOCLAW_CONTEXT_HARD_CAP_CHARS,
  42_000,
);
export const CONTEXT_RESERVED_TOOL_CHARS = parsePositiveInt(
  process.env.NANOCLAW_CONTEXT_RESERVED_TOOL_CHARS ||
    env.NANOCLAW_CONTEXT_RESERVED_TOOL_CHARS,
  14_000,
);
export const CONTEXT_ESTIMATED_TOOL_SCHEMA_CHARS = parsePositiveInt(
  process.env.NANOCLAW_CONTEXT_ESTIMATED_TOOL_SCHEMA_CHARS ||
    env.NANOCLAW_CONTEXT_ESTIMATED_TOOL_SCHEMA_CHARS,
  12_000,
);

// Memory and identity layers — generous caps so nothing important is dropped
export const CONTEXT_MAX_SOUL_CHARS = 4_000;
export const CONTEXT_MAX_MOPUS_CHARS = 3_000;
export const CONTEXT_MAX_IDENTITY_CHARS = 4_000;
export const CONTEXT_MAX_STYLE_CHARS = 2_500;
export const CONTEXT_MAX_USER_CHARS = 6_000;
export const CONTEXT_MAX_TOOLS_CHARS = 6_000;
export const CONTEXT_MAX_MEMORY_CHARS = 6_000;

// Daily notes — keyword-gated so they only appear when relevant to the current message
export const CONTEXT_MAX_DAILY_EXCERPTS = 12;
export const CONTEXT_MAX_DAILY_EXCERPT_CHARS = 4_000;

// FTS5 retrieval — additive layer on top of the always-on memory anchor
export const CONTEXT_MAX_RETRIEVED_MEMORY_CHARS = 4_000;
export const CONTEXT_MAX_RETRIEVED_MEMORY_ITEMS = 20;
