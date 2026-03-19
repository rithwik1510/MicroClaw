import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import {
  clearNonExplicitMemoryEntries,
  getMemoryEntryCount,
  getRouterState,
  insertMemoryEntry,
  setRouterState,
} from '../db.js';
import { NewMessage } from '../types.js';
import { MemoryCandidate, MemoryDoctorReport } from './types.js';

const MEMORY_SECTION_ORDER: Array<MemoryCandidate['kind']> = [
  'fact',
  'pref',
  'proj',
  'loop',
];
const MAX_PINNED_CORE_ENTRIES = 5;

function looksTransientInstruction(text: string): boolean {
  return /\b(today|right now|just now|this task|this chat|dont do a search|do not search|no search|what should i do there|explain me what i need to do)\b/i.test(
    text,
  );
}

function looksQuestionLikeMemory(text: string): boolean {
  return (
    text.includes('?') ||
    /^(what|why|how|should i|can you|is it|where|when|which)\b/i.test(text)
  );
}

function isUsefulMemoryText(
  kind: MemoryCandidate['kind'],
  text: string,
): boolean {
  const normalized = normalizeLine(text);
  if (normalized.length < 12) return false;
  if (/^https?:\/\//i.test(normalized)) return false;
  if (looksTransientInstruction(normalized)) return false;
  if (looksQuestionLikeMemory(normalized)) return false;
  if (
    /\b(hello|hi|thanks|thank you|okay|ok|cool|nice|great)\b/i.test(
      normalized,
    ) &&
    normalized.length < 40
  ) {
    return false;
  }
  if (
    /\b(for suppose|suppose i am using|nothing about specific project today|best books to read)\b/i.test(
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

function normalizeLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function isQuestionLike(content: string): boolean {
  const lower = content.toLowerCase();
  return (
    content.includes('?') ||
    /^(what|why|how|can you|should i|do i need|is it okay|which|where|when)\b/.test(
      lower,
    )
  );
}

function isExplicitMemoryRequest(content: string): boolean {
  return /\b(remember this|remember that|keep this in (your )?memory|never forget|always remember|from now on)\b/i.test(
    content,
  );
}

function classifyUserMessage(content: string): {
  kind: MemoryCandidate['kind'];
  origin: MemoryCandidate['origin'];
  durability: MemoryCandidate['durability'];
  confidence: number;
} | null {
  const lower = content.toLowerCase();
  if (isQuestionLike(content) && !isExplicitMemoryRequest(content)) {
    return null;
  }
  if (isExplicitMemoryRequest(content)) {
    const pinned =
      /\b(always remember|never forget|critical|important to remember)\b/i.test(
        content,
      );
    const kind =
      /\b(prefer|please be|keep replies|tone|format|call me|my name is)\b/i.test(
        content,
      )
        ? 'pref'
        : /\b(project|repo|app|constraint|deadline|roadmap|building)\b/i.test(
              content,
            )
          ? 'proj'
          : /\b(todo|follow up|later|next|remind)\b/i.test(content)
            ? 'loop'
            : 'fact';
    return {
      kind,
      origin: 'explicit_request',
      durability: pinned ? 'pinned' : 'durable',
      confidence: pinned ? 0.98 : 0.95,
    };
  }
  if (
    /\b(i prefer|prefer |please be |please keep |keep replies|be concise|be brief|call me|my name is)\b/.test(
      lower,
    )
  ) {
    return {
      kind: 'pref',
      origin: 'auto_capture',
      durability: 'durable',
      confidence: 0.88,
    };
  }
  if (
    /\b(project|repo|app|constraint|deadline|roadmap|we are building|tech stack|working on nanoclaw|working on microclaw)\b/.test(
      lower,
    ) &&
    !/\b(today|right now|just for now|for this task|for this chat)\b/.test(
      lower,
    )
  ) {
    return {
      kind: 'proj',
      origin: 'auto_capture',
      durability: 'durable',
      confidence: 0.84,
    };
  }
  if (
    /\b(todo|follow up|later|remind me|next step|need to revisit)\b/.test(lower)
  ) {
    return {
      kind: 'loop',
      origin: 'auto_capture',
      durability: 'session',
      confidence: 0.72,
    };
  }
  if (
    /\b(i am|i'm|i use|i work|i live|i started|i will start|my timezone|my role|working from)\b/.test(
      lower,
    ) &&
    !/\b(i want|i need|i hope|i wish|i feel)\b/.test(lower)
  ) {
    return {
      kind: 'fact',
      origin: 'auto_capture',
      durability: 'durable',
      confidence: 0.82,
    };
  }
  return null;
}

function sanitizeCandidateText(text: string): string {
  return normalizeLine(text)
    .replace(/^remember (that\s+)?/i, '')
    .replace(/^note (that\s+)?/i, '');
}

export function extractMemoryCandidates(
  messages: NewMessage[],
  assistantName: string,
): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];
  for (const message of messages) {
    const isAssistant =
      message.is_bot_message === true || message.sender_name === assistantName;
    if (isAssistant) continue;
    const normalized = normalizeLine(message.content);
    if (!normalized || normalized.length < 18 || normalized.length > 280) {
      continue;
    }
    if (/^https?:\/\//i.test(normalized)) continue;
    if (
      /runtime issue|please retry in a moment|couldn't produce a reply/i.test(
        normalized,
      )
    ) {
      continue;
    }
    const classification = classifyUserMessage(normalized);
    if (!classification) continue;
    if (!isUsefulMemoryText(classification.kind, normalized)) continue;
    candidates.push({
      kind: classification.kind,
      text: sanitizeCandidateText(normalized),
      source: 'user',
      timestamp: message.timestamp,
      origin: classification.origin,
      durability: classification.durability,
      confidence: classification.confidence,
    });
  }
  return candidates;
}

export function appendDailyMemoryNotes(
  groupFolder: string,
  candidates: MemoryCandidate[],
  today = new Date(),
): number {
  if (candidates.length === 0) return 0;
  const day = today.toISOString().slice(0, 10);
  const filePath = path.join(GROUPS_DIR, groupFolder, 'memory', `${day}.md`);
  ensureDir(filePath);

  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map(normalizeLine)
    : [];
  const seen = new Set(existing.filter(Boolean));
  const additions: string[] = [];

  for (const candidate of candidates) {
    const stamped = `${candidate.timestamp.slice(11, 16)} ${candidate.kind}: ${candidate.text}`;
    if (seen.has(stamped)) continue;
    seen.add(stamped);
    additions.push(stamped);
  }

  if (additions.length === 0) return 0;
  const prefix =
    fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8').trim()
      ? '\n'
      : '';
  fs.appendFileSync(filePath, `${prefix}${additions.join('\n')}\n`);
  return additions.length;
}

function extractTaggedMemoryLine(line: string): MemoryCandidate | null {
  const match = line.match(
    /^(?:\d{2}:\d{2}\s+)?(pref|fact|proj|loop)\s*:\s*(.+)$/i,
  );
  if (!match) return null;
  return {
    kind: match[1].toLowerCase() as MemoryCandidate['kind'],
    text: normalizeLine(match[2]),
    source: 'user',
    timestamp: '',
    origin: 'auto_capture',
    durability: match[1].toLowerCase() === 'loop' ? 'session' : 'durable',
    confidence: match[1].toLowerCase() === 'loop' ? 0.7 : 0.8,
  };
}

function shouldPromoteMemoryLine(
  kind: MemoryCandidate['kind'],
  text: string,
): boolean {
  const normalized = normalizeLine(text).toLowerCase();
  if (!normalized || normalized.length < 8) return false;
  return isUsefulMemoryText(kind, normalized);
}

type MarkdownSection = {
  title: string;
  bullets: string[];
};

function parseMarkdownSections(raw: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let current: MarkdownSection | null = null;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      current = { title: heading[1].trim(), bullets: [] };
      sections.push(current);
      continue;
    }
    if (/^#\s+/.test(line)) continue;
    if (!current) {
      current = { title: 'General', bullets: [] };
      sections.push(current);
    }
    const bullet = line.match(/^-+\s*(.+)$/);
    if (bullet) current.bullets.push(normalizeLine(bullet[1]));
  }

  return sections;
}

function readBulletSections(filePath: string): MarkdownSection[] {
  if (!fs.existsSync(filePath)) return [];
  return parseMarkdownSections(fs.readFileSync(filePath, 'utf8'));
}

function syncPinnedCoreMemory(groupFolder: string): number {
  const userPath = path.join(GROUPS_DIR, groupFolder, 'USER.md');
  const memoryPath = path.join(GROUPS_DIR, groupFolder, 'MEMORY.md');
  const now = new Date().toISOString();
  const pinnedCandidates: Array<{
    kind: MemoryCandidate['kind'];
    text: string;
  }> = [];

  const userSections = readBulletSections(userPath);
  const profileSection = userSections.find((section) =>
    /profile/i.test(section.title),
  );
  const preferenceSection = userSections.find((section) =>
    /preference/i.test(section.title),
  );
  for (const bullet of profileSection?.bullets || []) {
    if (!isUsefulMemoryText('fact', bullet)) continue;
    pinnedCandidates.push({ kind: 'fact', text: bullet });
    if (pinnedCandidates.length >= 2) break;
  }
  for (const bullet of preferenceSection?.bullets || []) {
    if (!isUsefulMemoryText('pref', bullet)) continue;
    pinnedCandidates.push({ kind: 'pref', text: bullet });
    if (pinnedCandidates.length >= 4) break;
  }

  const memorySections = readBulletSections(memoryPath);
  const prioritiesSection = memorySections.find((section) =>
    /current priorities|current focus|priorities/i.test(section.title),
  );
  for (const bullet of prioritiesSection?.bullets || []) {
    if (!isUsefulMemoryText('proj', bullet)) continue;
    pinnedCandidates.push({ kind: 'proj', text: bullet });
    if (pinnedCandidates.length >= MAX_PINNED_CORE_ENTRIES) break;
  }

  let inserted = 0;
  const seen = new Set<string>();
  for (const candidate of pinnedCandidates) {
    const key = `${candidate.kind}:${normalizeLine(candidate.text).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    insertMemoryEntry({
      group_folder: groupFolder,
      scope: 'group',
      kind: candidate.kind,
      content: candidate.text,
      source: 'explicit',
      origin: 'explicit_request',
      durability: 'pinned',
      confidence: 0.98,
      created_at: now,
      last_confirmed_at: now,
      source_file:
        candidate.kind === 'proj' ? memoryPath : userPath,
      pinned: true,
    });
    inserted++;
    if (inserted >= MAX_PINNED_CORE_ENTRIES) break;
  }
  return inserted;
}

export function compactMemory(groupFolder: string): {
  memoryPath: string;
  promotedCount: number;
} {
  const memoryDir = path.join(GROUPS_DIR, groupFolder, 'memory');
  const memoryPath = path.join(GROUPS_DIR, groupFolder, 'MEMORY.md');

  // Step 1: Collect fresh items from the last 14 daily files — newest first
  // so that if we hit the per-section cap, we keep the most recent entries.
  const freshGrouped = new Map<MemoryCandidate['kind'], string[]>();
  for (const kind of MEMORY_SECTION_ORDER) freshGrouped.set(kind, []);

  if (fs.existsSync(memoryDir)) {
    const files = fs
      .readdirSync(memoryDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .sort()
      .reverse() // newest first — freshest items fill the list first
      .slice(0, 14);

    for (const file of files) {
      const lines = fs
        .readFileSync(path.join(memoryDir, file), 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      for (const line of lines) {
        const parsed = extractTaggedMemoryLine(line);
        if (!parsed) continue;
        if (!shouldPromoteMemoryLine(parsed.kind, parsed.text)) continue;
        const items = freshGrouped.get(parsed.kind)!;
        if (!items.includes(parsed.text)) {
          items.push(parsed.text);
        }
      }
    }
  }

  // Step 2: Carry forward entries from the existing MEMORY.md that are NOT
  // already in the fresh daily notes. This prevents durable facts (preferences
  // stated once months ago) from being silently dropped each compaction cycle.
  if (fs.existsSync(memoryPath)) {
    const lines = fs
      .readFileSync(memoryPath, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    let currentSectionKind: MemoryCandidate['kind'] | null = null;
    for (const line of lines) {
      const sectionMatch = line.match(/^##\s+(.+)$/);
      if (sectionMatch) {
        currentSectionKind = kindFromSectionHeading(sectionMatch[1]);
        continue;
      }
      if (currentSectionKind) {
        const bulletMatch = line.match(/^-+\s*(.+)$/);
        if (bulletMatch) {
          const text = normalizeLine(bulletMatch[1]);
          if (
            text.length > 3 &&
            shouldPromoteMemoryLine(currentSectionKind, text)
          ) {
            const items = freshGrouped.get(currentSectionKind)!;
            // Append at the end — lower priority than fresh items.
            // When the 20-per-section cap is hit, these older entries are the
            // first to be trimmed, not the fresh ones.
            if (!items.includes(text)) items.push(text);
          }
        }
      }
      // Also handle tagged format in MEMORY.md (edge case)
      const tagged = extractTaggedMemoryLine(line);
      if (tagged && !currentSectionKind) {
        const items = freshGrouped.get(tagged.kind)!;
        if (
          shouldPromoteMemoryLine(tagged.kind, tagged.text) &&
          !items.includes(tagged.text)
        ) {
          items.push(tagged.text);
        }
      }
    }
  }

  const sections: string[] = ['# Memory'];
  const labels: Record<MemoryCandidate['kind'], string> = {
    fact: 'Profile',
    pref: 'Preferences',
    proj: 'Projects',
    loop: 'Open Loops',
  };
  let promotedCount = 0;
  for (const kind of MEMORY_SECTION_ORDER) {
    const items = freshGrouped.get(kind)!;
    if (items.length === 0) continue;
    sections.push('', `## ${labels[kind]}`);
    for (const item of items.slice(0, 20)) {
      sections.push(`- ${item}`);
      promotedCount++;
    }
  }

  ensureDir(memoryPath);
  fs.writeFileSync(memoryPath, `${sections.join('\n')}\n`);

  // Sync FTS5 index after compaction
  try {
    reindexMemoryForGroup(groupFolder);
  } catch {
    // Non-fatal — index will be rebuilt on next ensureMemoryIndexed call
  }

  return { memoryPath, promotedCount };
}

export function cleanupMemoryForGroup(groupFolder: string): {
  cleanedDailyFiles: number;
  removedDailyEntries: number;
  promotedCount: number;
  memoryPath: string;
} {
  const memoryDir = path.join(GROUPS_DIR, groupFolder, 'memory');
  let cleanedDailyFiles = 0;
  let removedDailyEntries = 0;

  if (fs.existsSync(memoryDir)) {
    const files = fs
      .readdirSync(memoryDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .sort();
    for (const file of files) {
      const filePath = path.join(memoryDir, file);
      const parsed = fs
        .readFileSync(filePath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map(extractTaggedMemoryLine)
        .filter((candidate): candidate is MemoryCandidate => !!candidate)
        .filter((candidate) =>
          shouldPromoteMemoryLine(candidate.kind, candidate.text),
        );

      const deduped: string[] = [];
      const seen = new Set<string>();
      for (const candidate of parsed) {
        const key = `${candidate.kind}:${normalizeLine(candidate.text).toLowerCase()}`;
        if (seen.has(key)) {
          removedDailyEntries += 1;
          continue;
        }
        seen.add(key);
        deduped.push(
          `${candidate.timestamp ? candidate.timestamp.slice(11, 16) + ' ' : ''}${candidate.kind}: ${candidate.text}`.trim(),
        );
      }

      const nextContent = deduped.join('\n');
      const currentContent = fs.readFileSync(filePath, 'utf8').trim();
      if (nextContent !== currentContent) {
        fs.writeFileSync(filePath, nextContent ? `${nextContent}\n` : '');
        cleanedDailyFiles += 1;
      }
    }
  }

  const compacted = compactMemory(groupFolder);
  return {
    cleanedDailyFiles,
    removedDailyEntries,
    promotedCount: compacted.promotedCount,
    memoryPath: compacted.memoryPath,
  };
}

/**
 * Map MEMORY.md section headings to memory kind.
 * Compacted MEMORY.md uses sections like ## Profile (fact), ## Preferences (pref), etc.
 */
const MEMORY_SECTION_KIND: Record<string, MemoryCandidate['kind']> = {
  profile: 'fact',
  preferences: 'pref',
  projects: 'proj',
  'open loops': 'loop',
  priorities: 'proj',
  'current priorities': 'proj',
  'standing instructions': 'pref',
  context: 'fact',
  background: 'fact',
  notes: 'fact',
};

function kindFromSectionHeading(
  heading: string,
): MemoryCandidate['kind'] | null {
  const normalized = heading.toLowerCase().trim();
  return MEMORY_SECTION_KIND[normalized] ?? null;
}

/** Populate FTS5 index from existing MEMORY.md and daily note files. */
export function populateMemoryIndex(groupFolder: string): number {
  const memoryPath = path.join(GROUPS_DIR, groupFolder, 'MEMORY.md');
  const memoryDir = path.join(GROUPS_DIR, groupFolder, 'memory');
  let count = 0;
  const now = new Date().toISOString();

  // Parse MEMORY.md — handles both tagged lines (kind: text) and
  // section-structured format (## Profile\n- bullet) from compactMemory output.
  if (fs.existsSync(memoryPath)) {
    const lines = fs
      .readFileSync(memoryPath, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    let currentSectionKind: MemoryCandidate['kind'] | null = null;
    for (const line of lines) {
      // Try tagged format first (daily-note style: "pref: text" or "09:10 proj: text")
      const tagged = extractTaggedMemoryLine(line);
      if (tagged) {
        insertMemoryEntry({
          group_folder: groupFolder,
          scope: 'group',
          kind: tagged.kind,
          content: tagged.text,
          source: 'migration',
          origin: 'migration',
          durability: tagged.kind === 'loop' ? 'session' : 'durable',
          confidence: tagged.kind === 'loop' ? 0.7 : 0.8,
          created_at: now,
          last_confirmed_at: now,
          source_file: memoryPath,
        });
        count++;
        continue;
      }

      // Detect section headings (## Profile, ## Preferences, etc.)
      const sectionMatch = line.match(/^##\s+(.+)$/);
      if (sectionMatch) {
        currentSectionKind = kindFromSectionHeading(sectionMatch[1]);
        continue;
      }

      // Plain bullet under a known section
      if (currentSectionKind) {
        const bulletMatch = line.match(/^-+\s*(.+)$/);
        if (bulletMatch) {
          const text = normalizeLine(bulletMatch[1]);
          if (text.length > 3) {
            if (!isUsefulMemoryText(currentSectionKind, text)) continue;
            insertMemoryEntry({
              group_folder: groupFolder,
              scope: 'group',
              kind: currentSectionKind,
              content: text,
              source: 'migration',
              origin: 'migration',
              durability: currentSectionKind === 'loop' ? 'session' : 'durable',
              confidence: currentSectionKind === 'loop' ? 0.7 : 0.8,
              created_at: now,
              last_confirmed_at: now,
              source_file: memoryPath,
            });
            count++;
          }
        }
      }
    }
  }

  // Parse daily note files
  if (fs.existsSync(memoryDir)) {
    const files = fs
      .readdirSync(memoryDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort();
    for (const file of files) {
      const filePath = path.join(memoryDir, file);
      const lines = fs
        .readFileSync(filePath, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      for (const line of lines) {
        const parsed = extractTaggedMemoryLine(line);
        if (parsed) {
          if (!isUsefulMemoryText(parsed.kind, parsed.text)) continue;
          insertMemoryEntry({
            group_folder: groupFolder,
            scope: 'group',
            kind: parsed.kind,
            content: parsed.text,
            source: 'migration',
            origin: 'migration',
            durability: parsed.kind === 'loop' ? 'session' : 'durable',
            confidence: parsed.kind === 'loop' ? 0.7 : 0.8,
            created_at: now,
            last_confirmed_at: now,
            source_file: filePath,
          });
          count++;
        }
      }
    }
  }

  // Record last-indexed mtime for change detection
  const mtimeKey = `memory_index_mtime:${groupFolder}`;
  try {
    if (fs.existsSync(memoryPath)) {
      const mtime = fs.statSync(memoryPath).mtimeMs.toString();
      setRouterState(mtimeKey, mtime);
    }
  } catch {
    /* non-fatal */
  }

  count += syncPinnedCoreMemory(groupFolder);
  return count;
}

/** Delete non-explicit entries and re-index from current MD files. */
export function reindexMemoryForGroup(groupFolder: string): number {
  clearNonExplicitMemoryEntries(groupFolder);
  return populateMemoryIndex(groupFolder);
}

/** Ensure the FTS5 index is populated for this group. Uses mtime to detect hand-edits. */
export function ensureMemoryIndexed(groupFolder: string): void {
  const count = getMemoryEntryCount(groupFolder);
  if (count === 0) {
    // First time — populate from existing MD files
    populateMemoryIndex(groupFolder);
    return;
  }

  // Check if MEMORY.md has changed since last index
  const memoryPath = path.join(GROUPS_DIR, groupFolder, 'MEMORY.md');
  if (!fs.existsSync(memoryPath)) return;
  try {
    const currentMtime = fs.statSync(memoryPath).mtimeMs.toString();
    const mtimeKey = `memory_index_mtime:${groupFolder}`;
    const lastMtime = getRouterState(mtimeKey);
    if (lastMtime !== currentMtime) {
      reindexMemoryForGroup(groupFolder);
    }
  } catch {
    /* non-fatal */
  }
}

export function doctorMemory(groupFolder: string): MemoryDoctorReport {
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  const report: MemoryDoctorReport = {
    groupFolder,
    issues: [],
  };

  for (const fileName of ['USER.md', 'MEMORY.md']) {
    const filePath = path.join(groupDir, fileName);
    if (!fs.existsSync(filePath)) {
      report.issues.push({
        severity: 'info',
        message: `Missing ${fileName}`,
      });
      continue;
    }
    const size = fs.readFileSync(filePath, 'utf8').length;
    if (size > 4_000) {
      report.issues.push({
        severity: 'warn',
        message: `${fileName} is oversized (${size} chars)`,
      });
    }
  }

  const memoryDir = path.join(groupDir, 'memory');
  if (!fs.existsSync(memoryDir)) {
    report.issues.push({
      severity: 'info',
      message: 'No daily memory directory yet',
    });
    return report;
  }

  const recentFiles = fs
    .readdirSync(memoryDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .sort()
    .slice(-7);
  if (recentFiles.length === 0) {
    report.issues.push({
      severity: 'info',
      message: 'No recent daily memory notes found',
    });
  }

  for (const fileName of recentFiles) {
    const lines = fs
      .readFileSync(path.join(memoryDir, fileName), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const untagged = lines.filter(
      (line) => !/^(?:\d{2}:\d{2}\s+)?(pref|fact|proj|loop)\s*:/i.test(line),
    );
    if (untagged.length > 0) {
      report.issues.push({
        severity: 'warn',
        message: `${fileName} has ${untagged.length} untagged note(s)`,
      });
    }
  }

  return report;
}

export function ensureContextFiles(groupFolder: string): string[] {
  const created: string[] = [];
  const globalDir = path.join(GROUPS_DIR, 'global');
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  const templates: Array<{ filePath: string; content: string }> = [
    {
      filePath: path.join(globalDir, 'SOUL.md'),
      content: [
        '# Soul',
        '',
        '- Be grounded, direct, and calm.',
        '- Be a local-first personal assistant.',
        '- Protect the user from destructive or risky mistakes.',
      ].join('\n'),
    },
    {
      filePath: path.join(globalDir, 'IDENTITY.md'),
      content: [
        '# Identity',
        '',
        '- You are MicroClaw, a practical agentic personal assistant.',
        '- You help with projects, decisions, and execution.',
      ].join('\n'),
    },
    {
      filePath: path.join(globalDir, 'USER.md'),
      content: '# User\n\n- Add durable user-wide preferences here.\n',
    },
    {
      filePath: path.join(globalDir, 'TOOLS.md'),
      content: '# Tools\n\n- Add environment-specific tool guidance here.\n',
    },
    {
      filePath: path.join(groupDir, 'USER.md'),
      content:
        '# User\n\n- Add scope-specific preferences for this DM or group.\n',
    },
    {
      filePath: path.join(groupDir, 'MEMORY.md'),
      content: '# Memory\n',
    },
  ];

  for (const template of templates) {
    if (fs.existsSync(template.filePath)) continue;
    ensureDir(template.filePath);
    fs.writeFileSync(template.filePath, `${template.content.trim()}\n`);
    created.push(template.filePath);
  }

  const memoryDir = path.join(groupDir, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  return created;
}
