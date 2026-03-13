export const CONTEXT_CHARS_PER_TOKEN_SAFETY_RATIO = 4;
export const CONTEXT_SOFT_CAP_CHARS = 14_000;
export const CONTEXT_HARD_CAP_CHARS = 18_000;
export const CONTEXT_RESERVED_TOOL_CHARS = 4_000;
export const CONTEXT_ESTIMATED_TOOL_SCHEMA_CHARS = 1_800;

// Memory and identity layers — generous caps so nothing important is dropped
export const CONTEXT_MAX_SOUL_CHARS = 2_000;
export const CONTEXT_MAX_IDENTITY_CHARS = 2_000;
export const CONTEXT_MAX_USER_CHARS = 3_000;
export const CONTEXT_MAX_TOOLS_CHARS = 3_000;
export const CONTEXT_MAX_MEMORY_CHARS = 3_000;

// Daily notes — keyword-gated so they only appear when relevant to the current message
export const CONTEXT_MAX_DAILY_EXCERPTS = 8;
export const CONTEXT_MAX_DAILY_EXCERPT_CHARS = 2_000;

// FTS5 retrieval — additive layer on top of the always-on memory anchor
export const CONTEXT_MAX_RETRIEVED_MEMORY_CHARS = 1_500;
export const CONTEXT_MAX_RETRIEVED_MEMORY_ITEMS = 12;
