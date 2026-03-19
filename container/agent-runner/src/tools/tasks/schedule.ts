import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { ToolExecutionContext, ToolExecutionResult } from '../types.js';

const VALID_SCHEDULE_TYPES = ['once', 'interval', 'cron'] as const;
const VALID_CONTEXT_MODES = ['group', 'isolated'] as const;

type ScheduleType = (typeof VALID_SCHEDULE_TYPES)[number];
type ContextMode = (typeof VALID_CONTEXT_MODES)[number];

type ScheduleValueResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

function resolveTasksIpcDir(): string {
  const inputDir =
    process.env.NANOCLAW_IPC_INPUT_DIR || '/workspace/ipc/input';
  return path.join(path.dirname(inputDir), 'tasks');
}

function writeIpcFile(dir: string, data: object): void {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const tempPath = path.join(dir, `${filename}.tmp`);
  const finalPath = path.join(dir, filename);
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, finalPath);
}

function normalizeScheduleType(value: unknown): ScheduleType | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return (VALID_SCHEDULE_TYPES as readonly string[]).includes(normalized)
    ? (normalized as ScheduleType)
    : null;
}

function normalizeContextMode(value: unknown): ContextMode {
  if (typeof value !== 'string') return 'isolated';
  const normalized = value.trim().toLowerCase();
  return (VALID_CONTEXT_MODES as readonly string[]).includes(normalized)
    ? (normalized as ContextMode)
    : 'isolated';
}

function getCurrentTime(ctx: ToolExecutionContext): Date {
  // Set process.env.TZ so all Date methods (setHours, getHours, etc.)
  // operate in the user's timezone, not the system/container default.
  const tz = ctx.secrets?.NANOCLAW_TIMEZONE;
  if (typeof tz === 'string' && tz.trim() && process.env.TZ !== tz) {
    process.env.TZ = tz;
  }

  const hinted = ctx.secrets?.NANOCLAW_CURRENT_TIME_ISO;
  if (typeof hinted === 'string' && hinted.trim()) {
    const parsed = new Date(hinted);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date();
}

function getOriginalPrompt(ctx: ToolExecutionContext): string {
  const raw = ctx.secrets?.NANOCLAW_ORIGINAL_PROMPT;
  return typeof raw === 'string' ? raw.trim() : '';
}

function scheduleFieldCandidates(
  args: Record<string, unknown>,
  fieldNames: string[],
  ctx: ToolExecutionContext,
): string[] {
  const values: string[] = [];
  for (const fieldName of fieldNames) {
    const raw = args[fieldName];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      values.push(String(Math.floor(raw)));
      continue;
    }
    if (typeof raw === 'string' && raw.trim()) {
      values.push(raw.trim());
    }
  }
  const originalPrompt = getOriginalPrompt(ctx);
  if (originalPrompt) {
    values.push(originalPrompt);
  }
  return values;
}

function resolveScheduledPrompt(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): string {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (prompt) {
    return prompt;
  }
  return stripLeadingScheduleClause(getOriginalPrompt(ctx));
}

function resolveRequestedPrompt(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
  normalizedPrompt: string,
): string {
  const explicit =
    typeof args.requested_prompt === 'string' ? args.requested_prompt.trim() : '';
  if (explicit) return explicit;
  const original = getOriginalPrompt(ctx);
  return original || normalizedPrompt;
}

function normalizeOnceValue(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): ScheduleValueResult {
  const now = getCurrentTime(ctx);
  const candidates = scheduleFieldCandidates(
    args,
    ['schedule_value', 'when', 'time_expression', 'time', 'run_at'],
    ctx,
  );

  let sawPastCandidate = false;
  for (const candidate of candidates) {
    const parsed = parseOnceDateTime(candidate, now);
    if (!parsed) continue;
    if (parsed.getTime() <= now.getTime()) {
      sawPastCandidate = true;
      continue;
    }
    return { ok: true, value: parsed.toISOString() };
  }

  if (sawPastCandidate) {
    return {
      ok: false,
      error:
        'The requested one-time schedule resolves to a past time. Use a future time such as "today at 6 PM", "tomorrow at 9 AM", or "in 2 hours".',
    };
  }

  return {
    ok: false,
    error:
      'Could not understand the one-time schedule. Use a natural time like "today at 6 PM", "tomorrow at 9 AM", "in 2 hours", or an ISO timestamp with timezone.',
  };
}

function normalizeIntervalValue(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): ScheduleValueResult {
  const candidates = scheduleFieldCandidates(
    args,
    ['schedule_value', 'every', 'interval', 'interval_expression'],
    ctx,
  );

  for (const candidate of candidates) {
    const numeric =
      /^\d+$/.test(candidate) ? Number.parseInt(candidate, 10) : Number.NaN;
    const ms = Number.isFinite(numeric) && numeric > 0
      ? numeric
      : parseIntervalExpression(candidate);
    if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) {
      return { ok: true, value: String(ms) };
    }
  }

  return {
    ok: false,
    error:
      'Could not understand the interval schedule. Use "every 5 minutes", "every 2 hours", or a positive millisecond value like 3600000.',
  };
}

function normalizeCronValue(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): ScheduleValueResult {
  const candidates = scheduleFieldCandidates(
    args,
    ['schedule_value', 'recurrence', 'recurrence_expression', 'schedule'],
    ctx,
  );

  for (const candidate of candidates) {
    const raw = candidate.trim();
    if (!raw) continue;
    try {
      CronExpressionParser.parse(raw);
      return { ok: true, value: raw };
    } catch {
      const parsed = parseRecurringExpression(raw);
      if (parsed) {
        return { ok: true, value: parsed };
      }
    }
  }

  return {
    ok: false,
    error:
      'Could not understand the recurring schedule. Use "every day at 9 AM", "every weekday at noon", "every Monday at 8:30 AM", or a standard cron string.',
  };
}

function formatScheduleSummary(
  scheduleType: ScheduleType,
  scheduleValue: string,
): string {
  if (scheduleType === 'once') return `once at ${scheduleValue}`;
  if (scheduleType === 'interval') {
    const ms = Number.parseInt(scheduleValue, 10);
    if (ms % 3_600_000 === 0) {
      const hours = ms / 3_600_000;
      return `every ${hours} hour${hours === 1 ? '' : 's'}`;
    }
    if (ms % 60_000 === 0) {
      const minutes = ms / 60_000;
      return `every ${minutes} minute${minutes === 1 ? '' : 's'}`;
    }
    return `every ${scheduleValue} ms`;
  }
  return `with cron "${scheduleValue}"`;
}

function parseOnceDateTime(raw: string, now: Date): Date | null {
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  // If the model passed an ISO timestamp with Z suffix or timezone offset
  // (e.g. "2026-03-15T17:23:00.000Z" or "2026-03-15T17:23:00.000+05:30"),
  // strip the timezone and re-parse as local time. Schedule values are always
  // meant to be local time (matching the MCP path which rejects Z suffixes).
  const isoWithTz = normalized.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)[Zz]$/,
  );
  if (isoWithTz) {
    const localDate = new Date(isoWithTz[1]);
    if (!Number.isNaN(localDate.getTime())) {
      return localDate;
    }
  }
  const isoWithOffset = normalized.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)[+-]\d{2}:\d{2}$/,
  );
  if (isoWithOffset) {
    const localDate = new Date(isoWithOffset[1]);
    if (!Number.isNaN(localDate.getTime())) {
      return localDate;
    }
  }

  const directDate = new Date(normalized);
  if (!Number.isNaN(directDate.getTime())) {
    return directDate;
  }

  const relativeMatch = normalized.match(
    /\bin\s+(\d+)\s+(minute|minutes|hour|hours|day|days)\b/i,
  );
  if (relativeMatch) {
    const amount = Number.parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    const base = new Date(now.getTime());
    if (unit.startsWith('minute')) {
      base.setMinutes(base.getMinutes() + amount);
      return base;
    }
    if (unit.startsWith('hour')) {
      base.setHours(base.getHours() + amount);
      return base;
    }
    base.setDate(base.getDate() + amount);
    return base;
  }

  const explicitDayPatterns: Array<{
    pattern: RegExp;
    build: (match: RegExpMatchArray) => Date | null;
  }> = [
    {
      pattern: /\b(today|tomorrow)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i,
      build: (match) =>
        buildRelativeDayDate(now, match[1], match[2], match[3], match[4]),
    },
    {
      pattern: /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(today|tomorrow)\b/i,
      build: (match) =>
        buildRelativeDayDate(now, match[4], match[1], match[2], match[3]),
    },
    {
      pattern: /\b(today|tomorrow)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i,
      build: (match) =>
        buildRelativeDayDate(now, match[1], match[2], match[3], match[4]),
    },
  ];

  for (const entry of explicitDayPatterns) {
    const match = normalized.match(entry.pattern);
    if (!match) continue;
    const built = entry.build(match);
    if (built) return built;
  }

  const numericDate = parseExplicitDateTime(normalized);
  if (numericDate) return numericDate;

  const monthNameMatch = normalized.match(
    /\b(?:on\s+)?([a-z]{3,9}\s+\d{1,2}(?:,\s*\d{4})?(?:\s+at\s+|\s+)\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i,
  );
  if (monthNameMatch) {
    const candidate = monthNameMatch[1].replace(/\s+at\s+/i, ' ');
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const bareTimeMatch =
    normalized.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i) ||
    normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (bareTimeMatch) {
    const hourIndex = bareTimeMatch.length === 4 ? 1 : 1;
    const converted = convertClockHour(
      Number.parseInt(bareTimeMatch[hourIndex], 10),
      bareTimeMatch[hourIndex + 2] || undefined,
    );
    if (converted !== null) {
      const minute = Number.parseInt(bareTimeMatch[hourIndex + 1] || '0', 10);
      const candidate = new Date(now.getTime());
      candidate.setHours(converted, minute, 0, 0);
      if (candidate.getTime() <= now.getTime()) {
        candidate.setDate(candidate.getDate() + 1);
      }
      return candidate;
    }
  }

  return null;
}

function buildRelativeDayDate(
  now: Date,
  dayWord: string,
  hourRaw: string,
  minuteRaw?: string,
  ampmRaw?: string,
): Date | null {
  const converted = convertClockHour(
    Number.parseInt(hourRaw, 10),
    ampmRaw || undefined,
  );
  if (converted === null) return null;
  const base = new Date(now.getTime());
  if (dayWord.toLowerCase() === 'tomorrow') {
    base.setDate(base.getDate() + 1);
  }
  base.setHours(converted, Number.parseInt(minuteRaw || '0', 10), 0, 0);
  return base;
}

function parseExplicitDateTime(normalized: string): Date | null {
  const numericFormats = [
    /\b(\d{4})-(\d{2})-(\d{2})(?:\s+at\s+|\s+)(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i,
    /\b(\d{4})\/(\d{2})\/(\d{2})(?:\s+at\s+|\s+)(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i,
  ];

  for (const format of numericFormats) {
    const match = normalized.match(format);
    if (!match) continue;
    const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, ampmRaw] = match;
    const converted = convertClockHour(
      Number.parseInt(hourRaw, 10),
      ampmRaw || undefined,
    );
    if (converted === null) continue;
    const date = new Date(
      Number.parseInt(yearRaw, 10),
      Number.parseInt(monthRaw, 10) - 1,
      Number.parseInt(dayRaw, 10),
      converted,
      Number.parseInt(minuteRaw || '0', 10),
      0,
      0,
    );
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  return null;
}

function parseIntervalExpression(raw: string): number | null {
  const match = raw.match(
    /\bevery\s+(\d+)\s+(minute|minutes|hour|hours|day|days)\b/i,
  );
  if (!match) return null;
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  if (unit.startsWith('minute')) return amount * 60_000;
  if (unit.startsWith('hour')) return amount * 3_600_000;
  return amount * 86_400_000;
}

function parseRecurringExpression(raw: string): string | null {
  const normalized = raw.replace(/\s+/g, ' ').trim().toLowerCase();
  const clock = extractClock(normalized);
  if (!clock) return null;

  if (/\b(every day|daily|each day)\b/.test(normalized)) {
    return `${clock.minute} ${clock.hour} * * *`;
  }
  if (/\b(every weekday|every weekdays)\b/.test(normalized)) {
    return `${clock.minute} ${clock.hour} * * 1-5`;
  }
  if (/\b(every weekend|every weekends)\b/.test(normalized)) {
    return `${clock.minute} ${clock.hour} * * 0,6`;
  }

  const dayMap: Record<string, string> = {
    sunday: '0',
    monday: '1',
    tuesday: '2',
    wednesday: '3',
    thursday: '4',
    friday: '5',
    saturday: '6',
  };
  for (const [dayName, dayNumber] of Object.entries(dayMap)) {
    if (new RegExp(`\\bevery\\s+${dayName}\\b`).test(normalized)) {
      return `${clock.minute} ${clock.hour} * * ${dayNumber}`;
    }
  }

  return null;
}

function extractClock(
  raw: string,
): { hour: number; minute: number } | null {
  const match = raw.match(
    /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i,
  );
  if (!match) return null;
  const converted = convertClockHour(
    Number.parseInt(match[1], 10),
    match[3] || undefined,
  );
  if (converted === null) return null;
  return {
    hour: converted,
    minute: Number.parseInt(match[2] || '0', 10),
  };
}

function stripLeadingScheduleClause(prompt: string): string {
  if (!prompt) return '';
  return prompt
    .replace(
      /^\s*(?:at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?(?:\s+(?:today|tomorrow))?|(?:today|tomorrow)\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?|in\s+\d+\s+(?:minute|minutes|hour|hours|day|days)|every\s+[^,]+?|daily(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?)(?:,\s*|\s+)/i,
      '',
    )
    .trim();
}

function convertClockHour(hour: number, ampm?: string): number | null {
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  if (!ampm) return hour;

  const meridiem = ampm.toLowerCase();
  if (hour < 1 || hour > 12) return null;
  if (meridiem === 'am') return hour === 12 ? 0 : hour;
  if (meridiem === 'pm') return hour === 12 ? 12 : hour + 12;
  return null;
}

async function executeScheduleTaskInternal(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
  forcedScheduleType?: ScheduleType,
): Promise<ToolExecutionResult> {
  const prompt = resolveScheduledPrompt(args, ctx);
  if (!prompt) {
    return { ok: false, content: 'prompt is required.' };
  }
  if (prompt.length > 1200) {
    return {
      ok: false,
      content:
        'Prompt too long. Keep scheduled task prompts under 1200 characters.',
    };
  }
  const requestedPrompt = resolveRequestedPrompt(args, ctx, prompt);

  const scheduleType =
    forcedScheduleType || normalizeScheduleType(args.schedule_type);
  if (!scheduleType) {
    return {
      ok: false,
      content: 'schedule_type must be one of: once, interval, cron.',
    };
  }

  const normalizedValue =
    scheduleType === 'once'
      ? normalizeOnceValue(args, ctx)
      : scheduleType === 'interval'
        ? normalizeIntervalValue(args, ctx)
        : normalizeCronValue(args, ctx);
  if (!normalizedValue.ok) {
    return { ok: false, content: normalizedValue.error };
  }

  const contextMode = normalizeContextMode(args.context_mode);
  const targetJid =
    process.env.NANOCLAW_CHAT_JID ||
    (ctx.secrets?.NANOCLAW_CHAT_JID as string | undefined) ||
    '';
  if (!targetJid) {
    return {
      ok: false,
      content:
        'Current chat is unknown, so the task could not be scheduled safely.',
    };
  }

  try {
    writeIpcFile(resolveTasksIpcDir(), {
      type: 'schedule_task',
      prompt,
      requested_prompt: requestedPrompt,
      schedule_type: scheduleType,
      schedule_value: normalizedValue.value,
      context_mode: contextMode,
      targetJid,
    });
  } catch (err) {
    return {
      ok: false,
      content: `Failed to queue scheduled task: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    ok: true,
    content: `Scheduled task for this chat (${formatScheduleSummary(scheduleType, normalizedValue.value)}).`,
  };
}

export async function executeScheduleTask(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  return executeScheduleTaskInternal(args, ctx);
}

export async function executeScheduleOnceTask(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  return executeScheduleTaskInternal(args, ctx, 'once');
}

export async function executeScheduleRecurringTask(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  return executeScheduleTaskInternal(args, ctx, 'cron');
}

export async function executeScheduleIntervalTask(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  return executeScheduleTaskInternal(args, ctx, 'interval');
}
