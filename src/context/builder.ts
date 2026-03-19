import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import {
  getPinnedMemoryEntries,
  queryMemoryExact,
  queryMemoryFts,
} from '../db.js';
import {
  CONTEXT_CHARS_PER_TOKEN_SAFETY_RATIO,
  CONTEXT_ESTIMATED_TOOL_SCHEMA_CHARS,
  CONTEXT_HARD_CAP_CHARS,
  CONTEXT_MAX_DAILY_EXCERPTS,
  CONTEXT_MAX_DAILY_EXCERPT_CHARS,
  CONTEXT_MAX_IDENTITY_CHARS,
  CONTEXT_MAX_MEMORY_CHARS,
  CONTEXT_MAX_RETRIEVED_MEMORY_CHARS,
  CONTEXT_MAX_RETRIEVED_MEMORY_ITEMS,
  CONTEXT_MAX_SOUL_CHARS,
  CONTEXT_MAX_TOOLS_CHARS,
  CONTEXT_MAX_USER_CHARS,
  CONTEXT_RESERVED_TOOL_CHARS,
  CONTEXT_SOFT_CAP_CHARS,
} from './config.js';
import { ensureMemoryIndexed } from './memory.js';
import { ContextBundle, ContextLayer, ContextSourceKind } from './types.js';

interface BuildContextBundleInput {
  groupFolder: string;
  prompt: string;
  today?: Date;
  turnMode?:
    | 'conversational'
    | 'memory_assisted'
    | 'web_browser'
    | 'scheduling_planning';
  reservedToolChars?: number;
  actualToolSchemaChars?: number;
}

type MarkdownSection = {
  title: string;
  bullets: string[];
  paragraphs: string[];
};

type CandidateFile = {
  kind: ContextSourceKind;
  scope: 'global' | 'group' | 'legacy';
  label: string;
  filePath: string;
  maxChars: number;
  trimMode: 'tail' | 'head';
};

type FileSnapshot = {
  raw: string;
  mtimeMs: number;
};

const fileSnapshotCache = new Map<string, FileSnapshot>();
const staticLayerCache = new Map<string, ContextLayer>();

const PLACEHOLDER_MATCHERS: Partial<Record<ContextSourceKind, string[]>> = {
  soul: [
    [
      '# Soul',
      '',
      '- Be calm, direct, and grounded.',
      '- Act like a persistent local-first personal assistant, not a generic chatbot.',
      '- Favor clarity, practical help, and continuity over filler.',
      '- Protect the user from risky or destructive actions by surfacing tradeoffs plainly.',
      '- Keep the tone warm and collaborative without becoming overly formal.',
    ].join('\n'),
  ],
  user: [
    [
      '# User',
      '',
      '- Add durable user-wide preferences and stable facts here.',
      '- Keep this file concise and factual.',
    ].join('\n'),
    [
      '# User',
      '',
      '- Personal DM preferences and stable facts for this chat go here.',
    ].join('\n'),
    [
      '# User',
      '',
      '- Shared project or server-specific preferences for this scope go here.',
    ].join('\n'),
    ['# User', '', '- Add durable user-wide preferences here.'].join('\n'),
    [
      '# User',
      '',
      '- Add scope-specific preferences for this DM or group.',
    ].join('\n'),
  ],
  tools: [
    [
      '# Tools',
      '',
      '- Local models have limited context windows, so keep retrieved context compact.',
      '- Prefer durable memory over repeating large prompt instructions.',
      '- Treat tool output as evidence, not personality.',
    ].join('\n'),
    ['# Tools', '', '- Add environment-specific tool guidance here.'].join(
      '\n',
    ),
  ],
  memory: ['# Memory'],
};

const GENERIC_KEYWORDS = new Set([
  'about',
  'agent',
  'build',
  'building',
  'change',
  'chat',
  'check',
  'current',
  'everything',
  'feed',
  'find',
  'hello',
  'help',
  'issue',
  'latest',
  'look',
  'message',
  'news',
  'project',
  'recent',
  'reply',
  'search',
  'source',
  'sources',
  'tell',
  'today',
  'tool',
  'web',
  'what',
  'must',
  'need',
  'now',
]);

function normalizeMarkdown(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/<!--\s*assistant-bootstrap:(?:start|end)\s*-->/gi, '')
    .trim();
}

function trimTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 16)).trimEnd()}\n\n[truncated]`;
}

function trimHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const trimmed = text
    .slice(text.length - Math.max(0, maxChars - 16))
    .trimStart();
  return `[truncated]\n\n${trimmed}`;
}

function applyTrimMode(
  text: string,
  maxChars: number,
  mode: 'tail' | 'head' | 'drop',
): string {
  if (mode === 'drop') return '';
  return mode === 'head' ? trimHead(text, maxChars) : trimTail(text, maxChars);
}

function currentPromptMessage(prompt: string): string {
  const marker = '[Current message - respond to this]';
  const index = prompt.lastIndexOf(marker);
  if (index === -1) return prompt.trim();
  return prompt.slice(index + marker.length).trim();
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function extractPromptText(prompt: string): string {
  const current = currentPromptMessage(prompt).trim();
  if (!current) return '';
  const messageMatches = Array.from(
    current.matchAll(/<message\b[^>]*>([\s\S]*?)<\/message>/gi),
  );
  if (messageMatches.length > 0) {
    return messageMatches
      .map((match) => decodeXmlEntities(match[1] || '').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return decodeXmlEntities(current.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractStrongKeywords(promptText: string): string[] {
  const quoted = Array.from(promptText.matchAll(/"([^"]{4,80})"/g))
    .map((match) => match[1].trim().toLowerCase())
    .filter((value) => value.split(/\s+/).length <= 5);
  const urls = Array.from(promptText.matchAll(/https?:\/\/[^\s<>"']+/gi)).map(
    (match) => match[0].toLowerCase(),
  );
  const domains = Array.from(
    promptText.matchAll(
      /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/gi,
    ),
  ).map((match) => match[0].toLowerCase());
  const identifiers =
    promptText.match(
      /\b[A-Z][A-Za-z0-9_-]{2,}\b|\b[a-z]+[A-Z][A-Za-z0-9_-]*\b/g,
    ) || [];

  const tokens =
    promptText.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{3,}/g) || [];
  const filtered = tokens.filter((token) => {
    if (GENERIC_KEYWORDS.has(token)) return false;
    if (/^\d+$/.test(token)) return false;
    if (token.length < 4) return false;
    return true;
  });

  const merged = [
    ...quoted,
    ...urls,
    ...domains,
    ...identifiers.map((v) => v.toLowerCase()),
    ...filtered,
  ];
  return Array.from(new Set(merged)).slice(0, 12);
}

function isUsefulRetrievedMemory(kind: string, content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized || normalized.length < 12) return false;
  if (normalized.includes('?')) return false;
  if (/https?:\/\//i.test(normalized)) return false;
  if (
    /\b(dont do a search|do not search|no search|explain me what i need to do|nothing about specific project today|best books to read|for suppose i am using)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }
  if (
    /^hey[, ]|keep this in your memory|if u remeber|if you remember/i.test(
      normalized,
    )
  ) {
    return false;
  }
  if (kind === 'loop') {
    return /\b(follow up|revisit|remember|next|pending|open)\b/i.test(
      normalized,
    );
  }
  return true;
}

function readFileSnapshotIfPresent(filePath: string): FileSnapshot | null {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  const cached = fileSnapshotCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached;
  }
  const snapshot = {
    raw: normalizeMarkdown(fs.readFileSync(filePath, 'utf8')),
    mtimeMs: stat.mtimeMs,
  };
  fileSnapshotCache.set(filePath, snapshot);
  return snapshot;
}

function readFileIfPresent(filePath: string): string {
  return readFileSnapshotIfPresent(filePath)?.raw || '';
}

function isStaticLayerKind(kind: ContextSourceKind): boolean {
  return (
    kind === 'soul' ||
    kind === 'identity' ||
    kind === 'user' ||
    kind === 'tools'
  );
}

function looksLikePlaceholder(kind: ContextSourceKind, raw: string): boolean {
  const normalized = normalizeMarkdown(raw);
  if (!normalized) return true;
  const placeholders = PLACEHOLDER_MATCHERS[kind] || [];
  return placeholders.some(
    (placeholder) => normalizeMarkdown(placeholder) === normalized,
  );
}

function buildCandidateFiles(groupFolder: string): CandidateFile[] {
  const globalDir = path.join(GROUPS_DIR, 'global');
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  return [
    {
      kind: 'soul',
      scope: 'global',
      label: 'SOUL',
      filePath: path.join(globalDir, 'SOUL.md'),
      maxChars: CONTEXT_MAX_SOUL_CHARS,
      trimMode: 'tail',
    },
    {
      kind: 'identity',
      scope: 'global',
      label: 'IDENTITY',
      filePath: path.join(globalDir, 'IDENTITY.md'),
      maxChars: CONTEXT_MAX_IDENTITY_CHARS,
      trimMode: 'tail',
    },
    {
      kind: 'user',
      scope: 'global',
      label: 'Global USER',
      filePath: path.join(globalDir, 'USER.md'),
      maxChars: CONTEXT_MAX_USER_CHARS,
      trimMode: 'tail',
    },
    {
      kind: 'tools',
      scope: 'global',
      label: 'TOOLS',
      filePath: path.join(globalDir, 'TOOLS.md'),
      maxChars: CONTEXT_MAX_TOOLS_CHARS,
      trimMode: 'tail',
    },
    {
      kind: 'user',
      scope: 'group',
      label: 'Local USER',
      filePath: path.join(groupDir, 'USER.md'),
      maxChars: CONTEXT_MAX_USER_CHARS,
      trimMode: 'tail',
    },
    {
      kind: 'memory',
      scope: 'group',
      label: 'MEMORY',
      filePath: path.join(groupDir, 'MEMORY.md'),
      maxChars: CONTEXT_MAX_MEMORY_CHARS,
      trimMode: 'tail',
    },
    {
      kind: 'legacy_claude',
      scope: 'legacy',
      label: 'Legacy global CLAUDE',
      filePath: path.join(globalDir, 'CLAUDE.md'),
      maxChars: 1_500,
      trimMode: 'tail',
    },
    {
      kind: 'legacy_claude',
      scope: 'legacy',
      label: 'Legacy local CLAUDE',
      filePath: path.join(groupDir, 'CLAUDE.md'),
      maxChars: 1_500,
      trimMode: 'tail',
    },
  ];
}

function kindHeading(kind: ContextSourceKind, label: string): string {
  switch (kind) {
    case 'soul':
      return `## ${label}\nThese are the assistant's non-negotiable voice and behavior rules.`;
    case 'identity':
      return `## ${label}\nThis defines who the assistant is and how it should position itself.`;
    case 'user':
      return `## ${label}\nThese are durable user preferences and profile notes.`;
    case 'tools':
      return `## ${label}\nThese are environment and tool-use notes.`;
    case 'memory':
      return `## ${label}\nThese are curated long-term notes for this scope.`;
    case 'daily':
      return `## ${label}\nThese are recent daily notes relevant to the current turn.`;
    case 'retrieved_memory':
      return `## ${label}\nMemory snippets retrieved for this conversation.`;
    case 'legacy_claude':
      return `## ${label}\nLegacy compatibility notes kept at lowest priority.`;
  }
}

function buildRetrievedMemoryLayer(
  pinned: Array<{ content: string; kind: string }>,
  retrieved: Array<{ content: string; kind: string; rank: number }>,
): ContextLayer {
  if (pinned.length === 0 && retrieved.length === 0) {
    return {
      kind: 'retrieved_memory',
      scope: 'group',
      label: 'Retrieved Memory',
      filePath: '',
      included: false,
      inclusionReason: 'no_matches',
      trimMode: 'tail',
      rawChars: 0,
      trimmedChars: 0,
      content: '',
    };
  }

  const lines: string[] = [];
  // Pinned entries always come first, marked clearly
  for (const e of pinned) lines.push(`- [pinned:${e.kind}] ${e.content}`);
  // Retrieved entries follow
  for (const e of retrieved) lines.push(`- [${e.kind}] ${e.content}`);

  const body = lines.join('\n');
  const trimmed = trimTail(body, CONTEXT_MAX_RETRIEVED_MEMORY_CHARS);
  const content =
    `${kindHeading('retrieved_memory', 'Retrieved Memory')}\n${trimmed}`.trim();

  return {
    kind: 'retrieved_memory',
    scope: 'group',
    label: 'Retrieved Memory',
    filePath: '',
    included: true,
    inclusionReason: pinned.length > 0 ? 'pinned_and_fts5' : 'fts5_retrieval',
    trimMode: 'tail',
    rawChars: body.length,
    trimmedChars: content.length,
    content,
  };
}

function parseMarkdownSections(raw: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let current: MarkdownSection | null = null;

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      current = {
        title: headingMatch[1].trim(),
        bullets: [],
        paragraphs: [],
      };
      sections.push(current);
      continue;
    }
    if (/^#\s+/.test(line)) continue;
    if (!current) {
      current = { title: 'General', bullets: [], paragraphs: [] };
      sections.push(current);
    }
    if (/^-\s+/.test(line)) {
      current.bullets.push(line.replace(/^-\s+/, '').trim());
    } else {
      current.paragraphs.push(line);
    }
  }

  return sections;
}

function scoreLine(line: string, keywords: string[]): number {
  const lower = line.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    if (lower.includes(keyword)) score += keyword.includes(' ') ? 3 : 2;
  }
  if (
    /\b(preferred name|timezone|standing instruction|current priorities|open loops?)\b/i.test(
      line,
    )
  ) {
    score += 1;
  }
  return score;
}

function dedupe(items: string[], maxItems: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const normalized = item.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(item.trim());
    if (result.length >= maxItems) break;
  }
  return result;
}

function withoutOverlaps(items: string[], excluded: string[]): string[] {
  const excludedSet = new Set(
    excluded.map((item) => item.trim().toLowerCase()).filter(Boolean),
  );
  return items.filter((item) => !excludedSet.has(item.trim().toLowerCase()));
}

function isPlaceholderBullet(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  return [
    'add durable user-wide preferences and stable facts here.',
    'personal dm preferences and stable facts for this chat go here.',
    'shared project or server-specific preferences for this scope go here.',
    'add durable user-wide preferences here.',
    'add scope-specific preferences for this dm or group.',
    'add environment-specific tool guidance here.',
  ].includes(normalized);
}

function selectScored(
  lines: string[],
  keywords: string[],
  maxItems: number,
): string[] {
  return dedupe(
    lines
      .map((line, index) => ({ line, index, score: scoreLine(line, keywords) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((item) => item.line),
    maxItems,
  );
}

function buildCompactUserContent(raw: string, keywords: string[]): string {
  const sections = parseMarkdownSections(raw);
  const filteredSections = sections.map((section) => ({
    ...section,
    bullets: section.bullets.filter((bullet) => !isPlaceholderBullet(bullet)),
  }));
  const profile = filteredSections.find((section) =>
    /profile/i.test(section.title),
  );
  const preferences = filteredSections.find((section) =>
    /preference/i.test(section.title),
  );
  const general = filteredSections.find((section) =>
    /general/i.test(section.title),
  );

  const identityBullets = dedupe(
    [
      ...(profile?.bullets.filter((line) =>
        /preferred name|timezone|context/i.test(line),
      ) || []),
      ...selectScored(profile?.bullets || [], keywords, 2),
      ...(general?.bullets || []).slice(0, 1),
    ],
    3,
  );

  const preferenceBullets = dedupe(
    [
      ...selectScored(preferences?.bullets || [], keywords, 2),
      ...(preferences?.bullets || []).slice(0, 2),
    ],
    3,
  );

  const lines = ['# User'];
  if (identityBullets.length > 0) {
    lines.push('', '## Core Profile');
    for (const bullet of identityBullets) lines.push(`- ${bullet}`);
  }
  if (preferenceBullets.length > 0) {
    lines.push('', '## Active Preferences');
    for (const bullet of preferenceBullets) lines.push(`- ${bullet}`);
  }
  return lines.join('\n');
}

function buildCompactMemoryContent(raw: string, keywords: string[]): string {
  const sections = parseMarkdownSections(raw);
  const priorities = sections.find((section) =>
    /current priorities/i.test(section.title),
  );
  const projects = sections.find((section) => /projects?/i.test(section.title));
  const standing = sections.find((section) =>
    /standing instructions/i.test(section.title),
  );
  const loops = sections.find((section) => /open loops?/i.test(section.title));

  const anchorBullets = dedupe(
    [
      ...(priorities?.bullets || []).slice(0, 1),
      ...(standing?.bullets || []).slice(0, 1),
    ],
    2,
  );
  const relevantBullets = dedupe(
    [
      ...selectScored(priorities?.bullets || [], keywords, 2),
      ...selectScored(projects?.bullets || [], keywords, 3),
      ...selectScored(loops?.bullets || [], keywords, 2),
      ...selectScored(standing?.bullets || [], keywords, 2),
    ],
    4,
  );
  const filteredAnchorBullets = withoutOverlaps(
    anchorBullets,
    standing?.bullets || [],
  );
  const filteredRelevantBullets = withoutOverlaps(
    relevantBullets,
    filteredAnchorBullets,
  );

  const lines = ['# Memory'];
  if (filteredAnchorBullets.length > 0) {
    lines.push('', '## Current Focus');
    for (const bullet of filteredAnchorBullets) lines.push(`- ${bullet}`);
  }
  if (filteredRelevantBullets.length > 0) {
    lines.push('', '## Relevant Notes');
    for (const bullet of filteredRelevantBullets) lines.push(`- ${bullet}`);
  }
  return lines.join('\n');
}

function trimLayerToChars(layer: ContextLayer, maxChars: number): void {
  if (!layer.included || !layer.content) return;
  layer.content = applyTrimMode(layer.content, maxChars, layer.trimMode);
  layer.trimmedChars = layer.content.length;
}

function compactLayerContent(
  kind: ContextSourceKind,
  raw: string,
  keywords: string[],
): string {
  if (kind === 'user') {
    return buildCompactUserContent(raw, keywords);
  }
  if (kind === 'memory') {
    return buildCompactMemoryContent(raw, keywords);
  }
  return raw;
}

function buildFileLayer(
  candidate: CandidateFile,
  keywords: string[],
): ContextLayer {
  const snapshot = readFileSnapshotIfPresent(candidate.filePath);
  const raw = snapshot?.raw || '';
  if (!raw) {
    return {
      kind: candidate.kind,
      scope: candidate.scope,
      label: candidate.label,
      filePath: candidate.filePath,
      included: false,
      inclusionReason: 'missing',
      trimMode: candidate.trimMode,
      rawChars: 0,
      trimmedChars: 0,
      content: '',
    };
  }
  const staticCacheKey =
    snapshot && isStaticLayerKind(candidate.kind)
      ? [
          candidate.filePath,
          snapshot.mtimeMs,
          candidate.maxChars,
          candidate.trimMode,
          candidate.kind,
          keywords.join('\u0001'),
        ].join('::')
      : null;
  if (staticCacheKey) {
    const cached = staticLayerCache.get(staticCacheKey);
    if (cached) {
      return cached;
    }
  }
  if (looksLikePlaceholder(candidate.kind, raw)) {
    return {
      kind: candidate.kind,
      scope: candidate.scope,
      label: candidate.label,
      filePath: candidate.filePath,
      included: false,
      inclusionReason: 'placeholder',
      trimMode: candidate.trimMode,
      rawChars: raw.length,
      trimmedChars: 0,
      content: '',
    };
  }

  const compacted = compactLayerContent(candidate.kind, raw, keywords);
  if (!compacted.trim()) {
    return {
      kind: candidate.kind,
      scope: candidate.scope,
      label: candidate.label,
      filePath: candidate.filePath,
      included: false,
      inclusionReason: 'compacted_empty',
      trimMode: candidate.trimMode,
      rawChars: raw.length,
      trimmedChars: 0,
      content: '',
    };
  }
  const trimmed = applyTrimMode(
    compacted,
    candidate.maxChars,
    candidate.trimMode,
  );
  const content =
    `${kindHeading(candidate.kind, candidate.label)}\n${trimmed}`.trim();
  const layer = {
    kind: candidate.kind,
    scope: candidate.scope,
    label: candidate.label,
    filePath: candidate.filePath,
    included: true,
    inclusionReason: compacted === raw ? 'file_loaded' : 'selective_context',
    trimMode: candidate.trimMode,
    rawChars: raw.length,
    trimmedChars: content.length,
    content,
  };
  if (staticCacheKey) {
    staticLayerCache.set(staticCacheKey, layer);
  }
  return layer;
}

function suppressLegacyLayersIfModernContextPresent(
  layers: ContextLayer[],
): void {
  const modernLayers = layers.filter(
    (layer) =>
      layer.included &&
      ['soul', 'identity', 'user', 'tools', 'memory'].includes(layer.kind),
  );
  const hasStrongModernContext =
    modernLayers.some(
      (layer) => layer.kind === 'soul' || layer.kind === 'identity',
    ) && modernLayers.length >= 2;

  if (!hasStrongModernContext) return;

  for (const layer of layers) {
    if (layer.kind !== 'legacy_claude' || !layer.included) continue;
    layer.included = false;
    layer.content = '';
    layer.trimmedChars = 0;
    layer.inclusionReason = 'modern_context_present';
  }
}

function scoreDailyLine(line: string, keywords: string[]): number {
  const lower = line.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    if (lower.includes(keyword)) score += keyword.includes(' ') ? 3 : 2;
  }
  if (/\b(pref|proj|fact|loop)\s*:/i.test(line)) score += 2;
  return score;
}

function buildDailyLayer(
  groupFolder: string,
  today: Date,
  keywords: string[],
): ContextLayer {
  const day = today.toISOString().slice(0, 10);
  const filePath = path.join(GROUPS_DIR, groupFolder, 'memory', `${day}.md`);
  const raw = readFileIfPresent(filePath);
  if (!raw) {
    return {
      kind: 'daily',
      scope: 'group',
      label: `Daily notes (${day})`,
      filePath,
      included: false,
      inclusionReason: 'missing',
      trimMode: 'head',
      rawChars: 0,
      trimmedChars: 0,
      content: '',
    };
  }
  if (keywords.length === 0) {
    return {
      kind: 'daily',
      scope: 'group',
      label: `Daily notes (${day})`,
      filePath,
      included: false,
      inclusionReason: 'no_strong_keywords',
      trimMode: 'head',
      rawChars: raw.length,
      trimmedChars: 0,
      content: '',
    };
  }

  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const matches = lines
    .map((line, index) => ({
      line,
      index,
      score: scoreDailyLine(line, keywords),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, CONTEXT_MAX_DAILY_EXCERPTS)
    .sort((a, b) => a.index - b.index)
    .map((item) => `- ${item.line.replace(/^-+\s*/, '')}`);

  if (matches.length === 0) {
    return {
      kind: 'daily',
      scope: 'group',
      label: `Daily notes (${day})`,
      filePath,
      included: false,
      inclusionReason: 'no_relevant_matches',
      trimMode: 'head',
      rawChars: raw.length,
      trimmedChars: 0,
      content: '',
    };
  }

  const joined =
    kindHeading('daily', `Daily notes (${day})`) +
    '\n' +
    trimTail(matches.join('\n'), CONTEXT_MAX_DAILY_EXCERPT_CHARS);

  return {
    kind: 'daily',
    scope: 'group',
    label: `Daily notes (${day})`,
    filePath,
    included: true,
    inclusionReason: 'keyword_match',
    trimMode: 'head',
    rawChars: raw.length,
    trimmedChars: joined.length,
    content: joined,
  };
}

function joinLayers(layers: ContextLayer[]): string {
  const included = layers
    .filter((layer) => layer.included && layer.content.trim())
    .map((layer) => layer.content.trim());
  if (included.length === 0) return '';
  const header =
    'You are a persistent personal assistant. Use project context below as guidance. Prioritize the current request. Do not fabricate facts.';
  return [header, ...included].join('\n\n');
}

function shrinkLayersToBudget(
  layers: ContextLayer[],
  maxChars: number,
): string[] {
  const working = layers.map((layer) => ({ ...layer }));
  const warnings: string[] = [];
  const totalChars = () =>
    working
      .filter((layer) => layer.included)
      .reduce((sum, layer) => sum + layer.content.length, 0);

  const shrinkKinds: ContextSourceKind[] = [
    'legacy_claude',
    'daily',
    'retrieved_memory',
    'memory',
    'tools',
    'user',
    'identity',
  ];

  while (totalChars() > maxChars) {
    const target = working.find(
      (layer) =>
        layer.included &&
        shrinkKinds.includes(layer.kind) &&
        layer.content.length > 240,
    );
    if (!target) break;
    const nextMax = Math.max(160, Math.floor(target.content.length * 0.82));
    target.content = applyTrimMode(target.content, nextMax, target.trimMode);
    target.trimmedChars = target.content.length;
    target.inclusionReason = 'trimmed_for_budget';
  }

  if (totalChars() > maxChars) {
    for (const layer of working) {
      if (totalChars() <= maxChars) break;
      if (!layer.included || layer.kind === 'soul') continue;
      layer.included = false;
      layer.content = '';
      layer.trimmedChars = 0;
      layer.inclusionReason = 'dropped_for_budget';
    }
  }

  if (totalChars() > maxChars) {
    warnings.push('Context exceeded budget even after aggressive trimming.');
  }

  layers.splice(0, layers.length, ...working);
  return warnings;
}

function enforceFinalPromptHardCap(
  layers: ContextLayer[],
  maxChars: number,
): string[] {
  const warnings: string[] = [];
  let systemPrompt = joinLayers(layers);
  if (systemPrompt.length <= maxChars) return warnings;

  warnings.push(
    `Final context prompt exceeded hard cap (${maxChars} chars); trimming.`,
  );

  const trimKinds: ContextSourceKind[] = [
    'legacy_claude',
    'daily',
    'retrieved_memory',
    'memory',
    'tools',
    'user',
    'identity',
    'soul',
  ];

  while (systemPrompt.length > maxChars) {
    const target = layers.find(
      (layer) =>
        layer.included &&
        trimKinds.includes(layer.kind) &&
        layer.content.length > 240,
    );
    if (!target) break;
    const nextMax = Math.max(160, Math.floor(target.content.length * 0.82));
    target.content = applyTrimMode(target.content, nextMax, target.trimMode);
    target.trimmedChars = target.content.length;
    target.inclusionReason = 'trimmed_for_hard_cap';
    systemPrompt = joinLayers(layers);
  }

  if (systemPrompt.length > maxChars) {
    for (const layer of layers) {
      if (systemPrompt.length <= maxChars) break;
      if (!layer.included || layer.kind === 'soul') continue;
      layer.included = false;
      layer.content = '';
      layer.trimmedChars = 0;
      layer.inclusionReason = 'dropped_for_hard_cap';
      systemPrompt = joinLayers(layers);
    }
  }

  if (systemPrompt.length > maxChars) {
    const soulLayer = layers.find(
      (layer) => layer.kind === 'soul' && layer.included,
    );
    if (soulLayer) {
      soulLayer.content = applyTrimMode(
        soulLayer.content,
        Math.max(160, maxChars - 160),
        soulLayer.trimMode,
      );
      soulLayer.trimmedChars = soulLayer.content.length;
      soulLayer.inclusionReason = 'trimmed_for_hard_cap';
      systemPrompt = joinLayers(layers);
    }
  }

  if (systemPrompt.length > maxChars) {
    warnings.push(
      'Final context prompt still exceeds hard cap after aggressive trimming.',
    );
  }

  return warnings;
}

export function buildContextBundle(
  input: BuildContextBundleInput,
): ContextBundle {
  const promptText = extractPromptText(input.prompt);
  const strongKeywords = extractStrongKeywords(promptText);
  const turnMode = input.turnMode || 'conversational';
  const layers = buildCandidateFiles(input.groupFolder).map((candidate) =>
    buildFileLayer(candidate, strongKeywords),
  );
  if (turnMode !== 'conversational' || strongKeywords.length >= 2) {
    layers.push(
      buildDailyLayer(
        input.groupFolder,
        input.today || new Date(),
        strongKeywords,
      ),
    );
  } else {
    layers.push({
      kind: 'daily',
      scope: 'group',
      label: `Daily notes (${(input.today || new Date()).toISOString().slice(0, 10)})`,
      filePath: path.join(
        GROUPS_DIR,
        input.groupFolder,
        'memory',
        `${(input.today || new Date()).toISOString().slice(0, 10)}.md`,
      ),
      included: false,
      inclusionReason:
        strongKeywords.length === 0
          ? 'no_strong_keywords'
          : 'turn_mode_suppressed',
      trimMode: 'head',
      rawChars: 0,
      trimmedChars: 0,
      content: '',
    });
  }

  // FTS5 retrieval: ensure index is populated, then fetch relevant snippets
  try {
    ensureMemoryIndexed(input.groupFolder);
  } catch {
    /* non-fatal if DB not yet initialized */
  }
  const pinnedEntries = (() => {
    try {
      return getPinnedMemoryEntries(input.groupFolder).filter((entry) =>
        isUsefulRetrievedMemory(entry.kind, entry.content),
      );
    } catch {
      return [];
    }
  })();
  const exactEntries =
    strongKeywords.length > 0
      ? (() => {
          try {
            return queryMemoryExact({
              groupFolder: input.groupFolder,
              phrases: strongKeywords,
              limit: Math.max(
                4,
                Math.floor(CONTEXT_MAX_RETRIEVED_MEMORY_ITEMS / 2),
              ),
            });
          } catch {
            return [];
          }
        })()
      : [];
  const ftsEntries =
    strongKeywords.length > 0
      ? (() => {
          try {
            return queryMemoryFts({
              groupFolder: input.groupFolder,
              keywords: strongKeywords,
              limit: CONTEXT_MAX_RETRIEVED_MEMORY_ITEMS,
            });
          } catch {
            return [];
          }
        })()
      : [];
  const retrievedEntries = dedupe(
    [...exactEntries, ...ftsEntries].map(
      (entry) => `[${entry.kind}] ${entry.content}`,
    ),
    CONTEXT_MAX_RETRIEVED_MEMORY_ITEMS,
  )
    .map((line, index) => ({
      content: line.replace(/^\[[^\]]+\]\s+/, ''),
      kind: line.match(/^\[([^\]]+)\]/)?.[1] || 'memory',
      rank: index,
    }))
    .filter((entry) => isUsefulRetrievedMemory(entry.kind, entry.content));
  layers.push(buildRetrievedMemoryLayer(pinnedEntries, retrievedEntries));

  for (const layer of layers) {
    if (
      layer.kind === 'memory' &&
      turnMode === 'conversational' &&
      strongKeywords.length < 2
    ) {
      trimLayerToChars(layer, 900);
      layer.inclusionReason = 'always_on_anchor';
    }
    if (
      layer.kind === 'retrieved_memory' &&
      turnMode === 'conversational' &&
      strongKeywords.length < 2 &&
      layer.included
    ) {
      trimLayerToChars(layer, 700);
      layer.inclusionReason =
        layer.inclusionReason === 'pinned_and_fts5'
          ? 'pinned_anchor'
          : 'retrieved_anchor';
    }
  }

  suppressLegacyLayersIfModernContextPresent(layers);

  const reservedToolChars =
    input.reservedToolChars || CONTEXT_RESERVED_TOOL_CHARS;
  const actualToolSchemaChars =
    input.actualToolSchemaChars || CONTEXT_ESTIMATED_TOOL_SCHEMA_CHARS;
  const warnings = shrinkLayersToBudget(
    layers,
    CONTEXT_SOFT_CAP_CHARS - reservedToolChars,
  );
  warnings.push(...enforceFinalPromptHardCap(layers, CONTEXT_HARD_CAP_CHARS));
  const systemPrompt = joinLayers(layers);
  const finalChars = systemPrompt.length;

  return {
    systemPrompt,
    diagnostics: {
      groupFolder: input.groupFolder,
      promptPreview: promptText.slice(0, 240),
      strongKeywords,
      turnMode,
      charsPerTokenSafetyRatio: CONTEXT_CHARS_PER_TOKEN_SAFETY_RATIO,
      softCapChars: CONTEXT_SOFT_CAP_CHARS,
      hardCapChars: CONTEXT_HARD_CAP_CHARS,
      reservedToolChars,
      estimatedToolSchemaChars: CONTEXT_ESTIMATED_TOOL_SCHEMA_CHARS,
      actualToolSchemaChars,
      totalLayerChars: layers.reduce((sum, layer) => sum + layer.rawChars, 0),
      finalChars,
      estimatedFinalTokens: Math.ceil(
        finalChars / CONTEXT_CHARS_PER_TOKEN_SAFETY_RATIO,
      ),
      layerCount: layers.filter((layer) => layer.included).length,
      layers,
      warnings,
    },
  };
}
