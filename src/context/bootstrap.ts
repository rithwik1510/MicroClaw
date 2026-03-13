import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { getRouterState, setRouterState } from '../db.js';

type BootstrapStep =
  | 'offer'
  | 'intro'
  | 'profile_intro'
  | 'user_context'
  | 'assistant_role'
  | 'personality'
  | 'preferences'
  | 'tools'
  | 'projects'
  | 'review'
  | 'done';

type BootstrapStatus = 'idle' | 'offered' | 'active' | 'skipped' | 'completed';

interface BootstrapAnswers {
  profileIntro?: string;
  userContext?: string;
  assistantRole?: string;
  personality?: string;
  preferences?: string;
  tools?: string;
  projects?: string;
}

type AnswerStep =
  | 'profile_intro'
  | 'user_context'
  | 'assistant_role'
  | 'personality'
  | 'preferences'
  | 'tools'
  | 'projects';

interface BootstrapSession {
  status: BootstrapStatus;
  step: BootstrapStep;
  answers: BootstrapAnswers;
  offeredAt?: string;
  completedAt?: string;
  cooldownUntil?: string;
  updatedAt: string;
}

interface BootstrapReadiness {
  needsSetup: boolean;
  reasons: string[];
}

export interface BootstrapResult {
  handled: boolean;
  suppressMemoryWrite: boolean;
  messageToSend?: string;
}

const BOOTSTRAP_SESSION_PREFIX = 'assistant_bootstrap:';
const BOOTSTRAP_MARKER_START = '<!-- assistant-bootstrap:start -->';
const BOOTSTRAP_MARKER_END = '<!-- assistant-bootstrap:end -->';
const SKIP_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_SOUL_TEMPLATE = `# Soul

- Be calm, direct, and grounded.
- Act like a persistent local-first personal assistant, not a generic chatbot.
- Favor clarity, practical help, and continuity over filler.
- Protect the user from risky or destructive actions by surfacing tradeoffs plainly.
- Keep the tone warm and collaborative without becoming overly formal.
`;

const DEFAULT_USER_TEMPLATE = `# User

- Add durable user-wide preferences and stable facts here.
- Keep this file concise and factual.
`;

const DEFAULT_TOOLS_TEMPLATE = `# Tools

- Local models have limited context windows, so keep retrieved context compact.
- Prefer durable memory over repeating large prompt instructions.
- Treat tool output as evidence, not personality.
`;

const DEFAULT_LOCAL_USER_TEMPLATE = `# User

- Personal DM preferences and stable facts for this chat go here.
`;

const DEFAULT_MEMORY_TEMPLATE = `# Memory
`;

function nowIso(): string {
  return new Date().toISOString();
}

function sessionKey(groupFolder: string): string {
  return `${BOOTSTRAP_SESSION_PREFIX}${groupFolder}`;
}

function readSession(groupFolder: string): BootstrapSession | undefined {
  const raw = getRouterState(sessionKey(groupFolder));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as BootstrapSession & {
      step?: string;
      answers?: BootstrapAnswers;
    };
    const parsedStep: string =
      typeof parsed.step === 'string' ? parsed.step : '';
    const validSteps = new Set<BootstrapStep>([
      'offer',
      'intro',
      'profile_intro',
      'user_context',
      'assistant_role',
      'personality',
      'preferences',
      'tools',
      'projects',
      'review',
      'done',
    ]);
    const normalizedStep =
      parsedStep === 'identity'
        ? 'intro'
        : validSteps.has(parsedStep as BootstrapStep)
          ? (parsedStep as BootstrapStep)
          : 'intro';

    return {
      status: parsed.status || 'idle',
      step: normalizedStep,
      answers: parsed.answers || {},
      offeredAt: parsed.offeredAt,
      completedAt: parsed.completedAt,
      cooldownUntil: parsed.cooldownUntil,
      updatedAt: parsed.updatedAt || nowIso(),
    };
  } catch {
    return undefined;
  }
}

export function hasPendingAssistantBootstrap(groupFolder: string): boolean {
  const session = readSession(groupFolder);
  return session?.status === 'active' || session?.status === 'offered';
}

export function isExplicitAssistantBootstrapRequest(text: string): boolean {
  return isSetupIntent(normalizeInput(text));
}

function writeSession(groupFolder: string, session: BootstrapSession): void {
  setRouterState(sessionKey(groupFolder), JSON.stringify(session));
}

function normalizeInput(text: string): string {
  return text
    .replace(/^@\w+\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function readFile(filePath: string): string {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8').trim();
}

function normalizeTemplate(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function isPlaceholderFile(filePath: string, template: string): boolean {
  const content = normalizeTemplate(readFile(filePath));
  if (!content) return true;
  if (content === normalizeTemplate(template)) return true;
  return (
    content.includes('Add durable user-wide preferences here.') ||
    content.includes(
      'Personal DM preferences and stable facts for this chat go here.',
    ) ||
    content.includes(
      'Shared project or server-specific preferences for this scope go here.',
    ) ||
    content === '# Memory'
  );
}

function bootstrapReadiness(groupFolder: string): BootstrapReadiness {
  const globalDir = path.join(GROUPS_DIR, 'global');
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  const reasons: string[] = [];

  if (
    isPlaceholderFile(path.join(globalDir, 'SOUL.md'), DEFAULT_SOUL_TEMPLATE)
  ) {
    reasons.push('global_soul');
  }
  if (
    isPlaceholderFile(path.join(globalDir, 'USER.md'), DEFAULT_USER_TEMPLATE)
  ) {
    reasons.push('global_user');
  }
  if (
    isPlaceholderFile(path.join(globalDir, 'TOOLS.md'), DEFAULT_TOOLS_TEMPLATE)
  ) {
    reasons.push('global_tools');
  }
  if (
    isPlaceholderFile(
      path.join(groupDir, 'USER.md'),
      DEFAULT_LOCAL_USER_TEMPLATE,
    )
  ) {
    reasons.push('local_user');
  }
  if (
    isPlaceholderFile(path.join(groupDir, 'MEMORY.md'), DEFAULT_MEMORY_TEMPLATE)
  ) {
    reasons.push('local_memory');
  }

  return {
    needsSetup: reasons.length > 0,
    reasons,
  };
}

function isSetupIntent(text: string): boolean {
  return /\b(setup assistant|set up assistant|personalize yourself|personalise yourself|customize yourself|bootstrap|onboard|configure yourself)\b/i.test(
    text,
  );
}

function isAffirmative(text: string): boolean {
  return /^(yes|yeah|yep|sure|ok|okay|start|do it|let's do it|lets do it|continue|go ahead|ready|quick|profile|hybrid)\b/i.test(
    text,
  );
}

function isSkipIntent(text: string): boolean {
  return /^(skip|not now|later|maybe later)\b/i.test(text);
}

function isCancelIntent(text: string): boolean {
  return /^(cancel|stop setup|abort)\b/i.test(text);
}

function isBackIntent(text: string): boolean {
  return /^(back|go back|previous)\b/i.test(text);
}

function isConfirmIntent(text: string): boolean {
  return /^(confirm|save|looks good|yes save|apply)\b/i.test(text);
}

function isRestartIntent(text: string): boolean {
  return /^(restart|restart setup|start over|reset setup)\b/i.test(text);
}

function canOfferAgain(session: BootstrapSession | undefined): boolean {
  if (!session) return true;
  if (session.status === 'completed') return false;
  if (!session.cooldownUntil) return true;
  return new Date(session.cooldownUntil).getTime() <= Date.now();
}

function nextStep(step: BootstrapStep): BootstrapStep {
  switch (step) {
    case 'intro':
      return 'profile_intro';
    case 'profile_intro':
      return 'user_context';
    case 'user_context':
      return 'assistant_role';
    case 'assistant_role':
      return 'personality';
    case 'personality':
      return 'tools';
    case 'tools':
      return 'preferences';
    case 'preferences':
      return 'review';
    default:
      return 'review';
  }
}

function previousStep(step: BootstrapStep): BootstrapStep {
  switch (step) {
    case 'profile_intro':
      return 'intro';
    case 'user_context':
      return 'profile_intro';
    case 'assistant_role':
      return 'user_context';
    case 'personality':
      return 'assistant_role';
    case 'tools':
      return 'personality';
    case 'preferences':
      return 'tools';
    case 'review':
      return 'preferences';
    default:
      return 'intro';
  }
}

function currentQuestion(step: BootstrapStep): string {
  switch (step) {
    case 'intro':
      return [
        'Welcome to MicroClaw setup.',
        '',
        'I am going to save a durable profile for your assistant so it stays consistent across restarts and updates.',
        '',
        'This setup uses one strong flow: a short intro paragraph plus a few focused follow-up questions so I can build a clean personality and memory baseline without overloading the model.',
        '',
        'Reply `continue` when you are ready, or `cancel` to stop.',
      ].join('\n');
    case 'profile_intro':
      return 'Question 1/6: write a short intro about yourself, your goals, and how you want me to help. I will distill it into your profile and memory.';
    case 'user_context':
      return 'Question 2/6: what should I call you, and what timezone should I use?';
    case 'assistant_role':
      return 'Question 3/6: what role should I play for you? For example: personal assistant, coding partner, project operator, researcher, accountability helper.';
    case 'personality':
      return 'Question 4/6: what personality or vibe should I have? For example: concise, warm, direct, playful, detailed, no fluff.';
    case 'preferences':
      return 'Question 6/6: what should I always remember about how you like to work? For example response style, coding preferences, budget sensitivity, pacing, or workflow habits.';
    case 'tools':
      return 'Question 5/6: what tool boundaries should I follow? For example whether I should confirm before shell commands, browser actions, edits, or long-running work.';
    default:
      return '';
  }
}

function isAnswerStep(step: BootstrapStep): step is AnswerStep {
  return (
    step === 'profile_intro' ||
    step === 'user_context' ||
    step === 'assistant_role' ||
    step === 'personality' ||
    step === 'preferences' ||
    step === 'tools' ||
    step === 'projects'
  );
}

function answerKeyForStep(step: AnswerStep): keyof BootstrapAnswers {
  switch (step) {
    case 'profile_intro':
      return 'profileIntro';
    case 'user_context':
      return 'userContext';
    case 'assistant_role':
      return 'assistantRole';
    case 'personality':
      return 'personality';
    case 'preferences':
      return 'preferences';
    case 'tools':
      return 'tools';
    case 'projects':
    default:
      return 'projects';
  }
}

function sentenceCase(text: string): string {
  const trimmed = compactPhrase(text);
  if (!trimmed) return '';
  return trimmed[0].toUpperCase() + trimmed.slice(1);
}

function compactPhrase(text: string): string {
  return normalizeInput(text).replace(/[.]+$/g, '').trim();
}

function uniqueBullets(items: string[], maxItems = 8): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const normalized = compactPhrase(item).toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(sentenceCase(item));
    if (result.length >= maxItems) break;
  }
  return result;
}

function splitSegments(text: string, maxItems = 8): string[] {
  return uniqueBullets(
    text
      .split(/\n|;|•|\.(?=\s|$)/)
      .map((item) => item.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean),
    maxItems,
  );
}

function extractPreferredName(text: string): string | undefined {
  const match = text.match(
    /\b(?:call me|my name is|i am|i'm)\s+([a-z][a-z0-9'_-]{1,39})\b/i,
  );
  return match?.[1] ? sentenceCase(match[1]) : undefined;
}

function extractTimezone(text: string): string | undefined {
  const match = text.match(
    /\b(?:timezone(?: should be| is|:)?|use|assume)\s+([a-z]{2,8}(?:[\/_-][a-z0-9_+-]{2,32})?)\b/i,
  );
  if (match?.[1]) return match[1].toUpperCase();
  const fallback = text.match(
    /\b(?:IST|UTC(?:[+-]\d{1,2})?|GMT(?:[+-]\d{1,2})?)\b/i,
  );
  return fallback?.[0]?.toUpperCase();
}

function classifyProfileSegment(
  segment: string,
): 'profile' | 'preference' | 'project' | 'tool' {
  const lower = segment.toLowerCase();
  if (
    /^(i am|i'm|i live|i study|i work|i am based|i am a|i am an|from )\b/.test(
      lower,
    )
  ) {
    return 'profile';
  }
  if (
    /\b(shell|browser|web|edit|command|terminal|confirm|ask first|permission|autonom)\b/.test(
      lower,
    )
  ) {
    return 'tool';
  }
  if (
    /\b(build|building|project|goal|priority|trying to|working on|launch|ship|job|research|marketing|assistant|app|startup|study)\b/.test(
      lower,
    )
  ) {
    return 'project';
  }
  if (
    /\b(prefer|like|want replies|want response|short|concise|detailed|brief|budget|python|rust|javascript|typescript|pace|workflow|style|tone)\b/.test(
      lower,
    )
  ) {
    return 'preference';
  }
  return 'profile';
}

function parseProfileIntro(text: string): {
  profile: string[];
  preferences: string[];
  projects: string[];
  tools: string[];
} {
  const profile: string[] = [];
  const preferences: string[] = [];
  const projects: string[] = [];
  const tools: string[] = [];

  for (const segment of splitSegments(text, 10)) {
    if (extractPreferredName(segment) || extractTimezone(segment)) {
      continue;
    }
    const lower = segment.toLowerCase();
    if (
      /^(i am|i'm|i live|i study|i work|i am based|i am a|i am an|from )\b/.test(
        lower,
      ) &&
      /\b(build|building|project|goal|priority|trying to|working on|launch|ship|job|research|marketing|assistant|app|startup|study)\b/.test(
        lower,
      )
    ) {
      profile.push(segment);
      projects.push(segment);
      continue;
    }
    switch (classifyProfileSegment(segment)) {
      case 'tool':
        tools.push(segment);
        break;
      case 'project':
        projects.push(segment);
        break;
      case 'preference':
        preferences.push(segment);
        break;
      default:
        profile.push(segment);
        break;
    }
  }

  return {
    profile: uniqueBullets(profile, 6),
    preferences: uniqueBullets(preferences, 6),
    projects: uniqueBullets(projects, 8),
    tools: uniqueBullets(tools, 6),
  };
}

function buildQuickFacts(answer: string, includeRemainder = true): string[] {
  const bullets: string[] = [];
  const name = extractPreferredName(answer);
  const timezone = extractTimezone(answer);
  if (name) bullets.push(`Preferred name: ${name}`);
  if (timezone) bullets.push(`Timezone: ${timezone}`);

  if (includeRemainder) {
    const cleaned = compactPhrase(
      answer
        .replace(
          /\b(?:call me|my name is|i am|i'm)\s+[a-z][a-z0-9'_-]{1,39}\b/gi,
          '',
        )
        .replace(
          /\b(?:timezone(?: should be| is|:)?|use|assume)\s+[a-z]{2,8}(?:[\/_-][a-z0-9_+-]{2,32})?\b/gi,
          '',
        )
        .replace(/\b(?:IST|UTC(?:[+-]\d{1,2})?|GMT(?:[+-]\d{1,2})?)\b/gi, '')
        .replace(/^[\s,.;:-]+/, ''),
    );
    if (cleaned) {
      bullets.push(`Context: ${sentenceCase(cleaned)}`);
    }
  }
  return uniqueBullets(bullets, 4);
}

function combineBullets(...groups: string[][]): string[] {
  return uniqueBullets(groups.flat(), 10);
}

function deriveSoulBullets(answer: string): string[] {
  const lower = answer.toLowerCase();
  const bullets = [
    "Stay consistent with the user's preferences and current context.",
  ];
  if (/\b(concise|brief|short|no fluff)\b/.test(lower)) {
    bullets.push('Keep replies concise and high-signal by default.');
  }
  if (/\b(warm|friendly|helpful|supportive)\b/.test(lower)) {
    bullets.push(
      'Be warm, collaborative, and supportive without becoming wordy.',
    );
  }
  if (/\b(direct|blunt|honest|straight)\b/.test(lower)) {
    bullets.push('Be direct and honest about tradeoffs, risks, and mistakes.');
  }
  if (/\b(playful|snarky|funny|casual)\b/.test(lower)) {
    bullets.push(
      'Use light personality when it fits, but stay useful and respectful.',
    );
  }
  if (/\b(detailed|thorough|deep)\b/.test(lower)) {
    bullets.push('Go deeper when the task needs it, but avoid filler.');
  }
  if (/\b(proactive|initiative|ahead)\b/.test(lower)) {
    bullets.push('Be proactive about next steps and missing details.');
  }
  if (bullets.length === 1) {
    bullets.push(`Preferred tone: ${compactPhrase(answer)}.`);
  }
  return Array.from(new Set(bullets));
}

function deriveToolBullets(
  answer: string,
  introToolHints: string[] = [],
): string[] {
  const mergedAnswer = [answer, ...introToolHints].join(' ').trim();
  const lower = mergedAnswer.toLowerCase();
  const bullets: string[] = [];
  if (/\b(confirm|ask first|check first)\b/.test(lower)) {
    bullets.push(
      'Confirm before potentially risky shell commands, edits, or browser actions.',
    );
  }
  if (
    /\b(no confirmation needed|no need|safe to proceed|trust you)\b/.test(lower)
  ) {
    bullets.push(
      'Move ahead on clearly safe actions without repeated confirmation, but surface risk before acting.',
    );
  }
  if (
    /\b(shell|terminal|command)\b/.test(lower) &&
    !bullets.some((b) => b.includes('shell'))
  ) {
    bullets.push(
      'Treat shell access as a deliberate tool and explain meaningful actions briefly.',
    );
  }
  if (/\b(browser|web)\b/.test(lower)) {
    bullets.push(
      'Use browsing selectively and prefer concise sourced results.',
    );
  }
  if (/\b(auto|autonomous|go ahead)\b/.test(lower)) {
    bullets.push(
      'Be moderately autonomous on safe tasks, but surface risky decisions before acting.',
    );
  }
  if (bullets.length === 0) {
    bullets.push(
      'Use tools deliberately and keep the user aware of meaningful actions.',
    );
  }
  for (const hint of introToolHints) {
    if (bullets.length >= 6) break;
    if (
      !/\b(shell|browser|tool|command|confirm|permission|edit|terminal)\b/i.test(
        hint,
      )
    ) {
      continue;
    }
    bullets.push(`User tool note: ${sentenceCase(hint)}.`);
  }
  return uniqueBullets(bullets, 6);
}

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function upsertManagedContent(filePath: string, fullDocument: string): void {
  ensureDir(filePath);
  const existing = readFile(filePath);
  if (!existing || existing.includes(BOOTSTRAP_MARKER_START)) {
    const next = existing.includes(BOOTSTRAP_MARKER_START)
      ? existing.replace(
          new RegExp(
            `${BOOTSTRAP_MARKER_START}[\\s\\S]*?${BOOTSTRAP_MARKER_END}`,
            'm',
          ),
          `${BOOTSTRAP_MARKER_START}\n${fullDocument.trim()}\n${BOOTSTRAP_MARKER_END}`,
        )
      : `${BOOTSTRAP_MARKER_START}\n${fullDocument.trim()}\n${BOOTSTRAP_MARKER_END}\n`;
    fs.writeFileSync(filePath, `${next.trim()}\n`);
    return;
  }

  if (
    isPlaceholderFile(filePath, DEFAULT_USER_TEMPLATE) ||
    isPlaceholderFile(filePath, DEFAULT_LOCAL_USER_TEMPLATE) ||
    isPlaceholderFile(filePath, DEFAULT_SOUL_TEMPLATE) ||
    isPlaceholderFile(filePath, DEFAULT_TOOLS_TEMPLATE) ||
    isPlaceholderFile(filePath, DEFAULT_MEMORY_TEMPLATE)
  ) {
    fs.writeFileSync(
      filePath,
      `${BOOTSTRAP_MARKER_START}\n${fullDocument.trim()}\n${BOOTSTRAP_MARKER_END}\n`,
    );
    return;
  }

  fs.writeFileSync(
    filePath,
    `${existing.trim()}\n\n${BOOTSTRAP_MARKER_START}\n${fullDocument.trim()}\n${BOOTSTRAP_MARKER_END}\n`,
  );
}

function buildUserDocument(answers: BootstrapAnswers): string {
  const intro = parseProfileIntro(answers.profileIntro || '');
  const quickFacts = combineBullets(
    buildQuickFacts(answers.userContext || ''),
    buildQuickFacts(answers.profileIntro || '', false),
  );
  const profileBullets = combineBullets(quickFacts, intro.profile);
  const preferenceBullets = combineBullets(
    splitSegments(answers.preferences || '', 8),
    intro.preferences,
  );
  const lines = ['# User', '', '## Profile'];
  for (const bullet of profileBullets) lines.push(`- ${bullet}`);
  if (preferenceBullets.length > 0) {
    lines.push('', '## Preferences');
    for (const bullet of preferenceBullets) lines.push(`- ${bullet}`);
  }
  return lines.join('\n');
}

function buildIdentityDocument(answers: BootstrapAnswers): string {
  const role = compactPhrase(answers.assistantRole || '');
  const personality = compactPhrase(answers.personality || '');
  const lines = ['# Identity', '', '## Role'];
  lines.push(
    "- You are MicroClaw, the user's persistent local-first personal assistant.",
  );
  if (role) {
    lines.push(`- Primary role for this user: ${role}.`);
  } else {
    lines.push(
      '- Primary role for this user: personal assistant and project copilot.',
    );
  }
  lines.push('', '## Mission');
  lines.push(
    '- Help the user think clearly, execute reliably, and maintain continuity across sessions.',
  );
  lines.push(
    '- Understand ongoing work, retain durable preferences, and move important tasks forward.',
  );
  if (personality) {
    lines.push('', '## Presentation');
    lines.push(`- Default vibe: ${personality}.`);
  }
  return lines.join('\n');
}

function buildSoulDocument(answers: BootstrapAnswers): string {
  const bullets = deriveSoulBullets(answers.personality || '');
  const lines = ['# Soul', '', '## Core Stance'];
  for (const bullet of bullets) lines.push(`- ${bullet}`);
  lines.push('', '## Reliability');
  lines.push(
    '- Preserve continuity across sessions without pretending to know things the user never said.',
  );
  lines.push(
    '- Prefer clear next steps and grounded help over generic encouragement.',
  );
  return lines.join('\n');
}

function buildToolsDocument(answers: BootstrapAnswers): string {
  const intro = parseProfileIntro(answers.profileIntro || '');
  const bullets = deriveToolBullets(answers.tools || '', intro.tools);
  const lines = ['# Tools', '', '## Operating Rules'];
  for (const bullet of bullets) lines.push(`- ${bullet}`);
  lines.push('', '## Local Model Constraints');
  lines.push('- Keep retrieved context compact and relevant for local models.');
  lines.push('- Treat tool output as evidence, not personality.');
  return lines.join('\n');
}

function buildMemoryDocument(answers: BootstrapAnswers): string {
  const intro = parseProfileIntro(answers.profileIntro || '');
  const projectBullets = combineBullets(
    splitSegments(answers.projects || '', 8),
    intro.projects,
  );
  const preferenceBullets = combineBullets(
    splitSegments(answers.preferences || '', 5),
    intro.preferences,
  );
  const lines = ['# Memory'];
  if (projectBullets.length > 0) {
    lines.push('', '## Current Priorities');
    for (const bullet of projectBullets.slice(0, 4)) lines.push(`- ${bullet}`);
  }
  if (projectBullets.length > 0) {
    lines.push('', '## Projects');
    for (const bullet of projectBullets) lines.push(`- ${bullet}`);
  }
  if (preferenceBullets.length > 0) {
    lines.push('', '## Standing Instructions');
    for (const bullet of preferenceBullets.slice(0, 4))
      lines.push(`- ${bullet}`);
  }
  return lines.join('\n');
}

function buildReview(answers: BootstrapAnswers): string {
  const parts = [
    'Setup summary:',
    '',
    `Intro: ${compactPhrase(answers.profileIntro || '') || '-'}`,
    `Call you / timezone: ${compactPhrase(answers.userContext || '') || '-'}`,
    `My role for you: ${compactPhrase(answers.assistantRole || '') || '-'}`,
    `Style: ${compactPhrase(answers.personality || '') || '-'}`,
    `Preferences: ${compactPhrase(answers.preferences || '') || '-'}`,
    `Tool boundaries: ${compactPhrase(answers.tools || '') || '-'}`,
    `Projects: ${compactPhrase(answers.projects || '') || '-'}`,
    '',
    'Reply `confirm` to save, `back` to revise the previous answer, or `cancel` to stop.',
  ];
  return parts.join('\n');
}

function applyBootstrapFiles(
  groupFolder: string,
  answers: BootstrapAnswers,
): void {
  const globalDir = path.join(GROUPS_DIR, 'global');
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  upsertManagedContent(
    path.join(globalDir, 'IDENTITY.md'),
    buildIdentityDocument(answers),
  );
  upsertManagedContent(
    path.join(globalDir, 'SOUL.md'),
    buildSoulDocument(answers),
  );
  upsertManagedContent(
    path.join(globalDir, 'TOOLS.md'),
    buildToolsDocument(answers),
  );
  upsertManagedContent(
    path.join(groupDir, 'USER.md'),
    buildUserDocument(answers),
  );
  upsertManagedContent(
    path.join(groupDir, 'MEMORY.md'),
    buildMemoryDocument(answers),
  );
}

function startActiveSession(groupFolder: string): BootstrapSession {
  const session: BootstrapSession = {
    status: 'active',
    step: 'intro',
    answers: {},
    updatedAt: nowIso(),
  };
  writeSession(groupFolder, session);
  return session;
}

export function maybeHandleAssistantBootstrap(input: {
  groupFolder: string;
  latestMessageText: string;
  isDm: boolean;
}): BootstrapResult {
  if (!input.isDm) {
    return { handled: false, suppressMemoryWrite: false };
  }

  const readiness = bootstrapReadiness(input.groupFolder);
  const session = readSession(input.groupFolder);
  const text = normalizeInput(input.latestMessageText);
  const explicitSetup = isSetupIntent(text);

  if (session?.status === 'active') {
    if (isRestartIntent(text)) {
      startActiveSession(input.groupFolder);
      return {
        handled: true,
        suppressMemoryWrite: true,
        messageToSend:
          'Setup restarted from scratch.\n\n' + currentQuestion('intro'),
      };
    }

    if (isCancelIntent(text)) {
      writeSession(input.groupFolder, {
        ...session,
        status: 'skipped',
        cooldownUntil: new Date(Date.now() + SKIP_COOLDOWN_MS).toISOString(),
        updatedAt: nowIso(),
      });
      return {
        handled: true,
        suppressMemoryWrite: true,
        messageToSend:
          'Setup cancelled. I will keep chatting normally, and you can restart any time by saying `setup assistant`.',
      };
    }

    if (isBackIntent(text)) {
      const step = previousStep(session.step);
      writeSession(input.groupFolder, {
        ...session,
        step,
        updatedAt: nowIso(),
      });
      return {
        handled: true,
        suppressMemoryWrite: true,
        messageToSend: currentQuestion(step),
      };
    }

    if (session.step === 'intro') {
      if (!isAffirmative(text)) {
        return {
          handled: true,
          suppressMemoryWrite: true,
          messageToSend:
            currentQuestion('intro') +
            '\n\nI am waiting for `continue` before I start.',
        };
      }
      const step = nextStep('intro');
      writeSession(input.groupFolder, {
        ...session,
        step,
        updatedAt: nowIso(),
      });
      return {
        handled: true,
        suppressMemoryWrite: true,
        messageToSend: currentQuestion(step),
      };
    }

    if (session.step === 'review') {
      if (isRestartIntent(text)) {
        startActiveSession(input.groupFolder);
        return {
          handled: true,
          suppressMemoryWrite: true,
          messageToSend:
            'Setup restarted from scratch.\n\n' + currentQuestion('intro'),
        };
      }
      if (isConfirmIntent(text)) {
        applyBootstrapFiles(input.groupFolder, session.answers);
        writeSession(input.groupFolder, {
          ...session,
          status: 'completed',
          step: 'done',
          completedAt: nowIso(),
          updatedAt: nowIso(),
        });
        return {
          handled: true,
          suppressMemoryWrite: true,
          messageToSend:
            "Setup saved. I'll use this personality and context as my durable baseline going forward.",
        };
      }
      return {
        handled: true,
        suppressMemoryWrite: true,
        messageToSend: buildReview(session.answers),
      };
    }

    if (!isAnswerStep(session.step)) {
      return {
        handled: true,
        suppressMemoryWrite: true,
        messageToSend: currentQuestion('intro'),
      };
    }
    const answers = { ...session.answers };
    answers[answerKeyForStep(session.step)] = text;
    const step = nextStep(session.step);
    writeSession(input.groupFolder, {
      ...session,
      answers,
      step,
      updatedAt: nowIso(),
    });
    return {
      handled: true,
      suppressMemoryWrite: true,
      messageToSend:
        step === 'review' ? buildReview(answers) : currentQuestion(step),
    };
  }

  if (
    session?.status === 'skipped' &&
    !canOfferAgain(session) &&
    !explicitSetup
  ) {
    return { handled: false, suppressMemoryWrite: false };
  }

  if (session?.status === 'completed' && !explicitSetup) {
    return { handled: false, suppressMemoryWrite: false };
  }

  if (explicitSetup) {
    startActiveSession(input.groupFolder);
    return {
      handled: true,
      suppressMemoryWrite: true,
      messageToSend: currentQuestion('intro'),
    };
  }

  if (!readiness.needsSetup || !canOfferAgain(session)) {
    return { handled: false, suppressMemoryWrite: false };
  }
  return { handled: false, suppressMemoryWrite: false };
}
