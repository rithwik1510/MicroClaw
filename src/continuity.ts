import { NewMessage } from './types.js';
import { formatConversationHistory, formatMessages } from './router.js';

const SYNTHETIC_ASSISTANT_REPLY_PATTERNS = [
  /^i ran into a runtime issue while processing that request\./i,
  /^i couldn't produce a reply for that just now\./i,
  /^hello! what can i help you with today\?$/i,
  /^i'm here with you\./i,
  /^i can help you with that\. let me guide you through/i,
  /^it looks like there was an issue accessing the website\./i,
  /^it seems there was an issue with the web search\./i,
];
const LOW_SIGNAL_ASSISTANT_REPLY_PATTERNS = [
  /^(ok|okay|sure|got it|noted|understood)[.!]*$/i,
  /^(thanks|thank you)[.!]*$/i,
];
const DEFAULT_RECENT_TURN_LIMIT = 8;
const DEFAULT_RECENT_CHAR_BUDGET = 6000;
const DEFAULT_MIN_RECENT_USER_MESSAGES = 3;
const DEFAULT_SUMMARY_MIN_MESSAGES = 8;
const DEFAULT_SUMMARY_MIN_CHARS = 3000;
const DEFAULT_SUMMARY_MAX_CHARS = 2200;
const DEFAULT_CURRENT_MESSAGES_CHAR_BUDGET = 9000;
const DEFAULT_CURRENT_MESSAGE_MAX_CHARS = 8000;

export interface ContinuityPlan {
  summaryToUse: string;
  computedSummary: string;
  shouldPersistSummary: boolean;
  sourceMessageCount: number;
  lastMessageTimestamp?: string;
  recentContextMessages: NewMessage[];
  currentMessages: NewMessage[];
  diagnostics: {
    totalMessages: number;
    normalizedMessages: number;
    droppedSyntheticAssistantMessages: number;
    droppedLowSignalAssistantMessages: number;
    duplicateMessagesCollapsed: number;
    currentMessages: number;
    recentMessages: number;
    olderMessages: number;
    recentChars: number;
    summaryChars: number;
    olderChars: number;
    usedStoredSummary: boolean;
  };
}

function normalizeLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function collapseRepeatedMessages(
  messages: NewMessage[],
  assistantName: string,
): { messages: NewMessage[]; collapsedCount: number } {
  const collapsed: NewMessage[] = [];
  let collapsedCount = 0;

  for (const message of messages) {
    const prev = collapsed[collapsed.length - 1];
    const sameRole =
      !!prev &&
      (prev.is_bot_message === true || prev.sender_name === assistantName) ===
        (message.is_bot_message === true ||
          message.sender_name === assistantName);
    const sameSender = !!prev && prev.sender_name === message.sender_name;
    const sameContent =
      !!prev && normalizeLine(prev.content) === normalizeLine(message.content);

    if (sameRole && sameSender && sameContent) {
      collapsed[collapsed.length - 1] = message;
      collapsedCount += 1;
      continue;
    }

    collapsed.push(message);
  }

  return { messages: collapsed, collapsedCount };
}

function compactSnippet(text: string, maxChars = 180): string {
  const normalized = normalizeLine(text);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

function trimStructuredText(text: string, maxChars: number): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 16)).trimEnd()}\n\n[truncated]`;
}

function trimStructuredTextPreservingEnds(
  text: string,
  maxChars: number,
): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= 32) return trimStructuredText(normalized, maxChars);
  const marker = '\n\n[truncated]\n\n';
  const remaining = Math.max(0, maxChars - marker.length);
  const headChars = Math.ceil(remaining * 0.6);
  const tailChars = Math.max(0, remaining - headChars);
  const head = normalized.slice(0, headChars).trimEnd();
  const tail = tailChars > 0 ? normalized.slice(-tailChars).trimStart() : '';
  return `${head}${marker}${tail}`.trim();
}

function estimateChars(messages: NewMessage[]): number {
  return messages.reduce(
    (sum, message) => sum + normalizeLine(message.content).length,
    0,
  );
}

export function isSyntheticAssistantReply(text: string): boolean {
  const normalized = normalizeLine(text);
  return SYNTHETIC_ASSISTANT_REPLY_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
}

function isLowSignalAssistantReply(text: string): boolean {
  const normalized = normalizeLine(text);
  if (!normalized) return true;
  return LOW_SIGNAL_ASSISTANT_REPLY_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
}

function summaryContainsSyntheticAssistantReply(summary: string): boolean {
  const normalized = normalizeLine(summary).toLowerCase();
  return (
    normalized.includes(
      'i ran into a runtime issue while processing that request',
    ) ||
    normalized.includes("i couldn't produce a reply for that just now") ||
    normalized.includes('hello! what can i help you with today?') ||
    normalized.includes("i'm here with you.")
  );
}

export function isContinuityRelevantMessage(
  message: NewMessage,
  assistantName: string,
): boolean {
  const isAssistant =
    message.is_bot_message === true || message.sender_name === assistantName;
  if (!isAssistant) return true;
  return (
    !isSyntheticAssistantReply(message.content) &&
    !isLowSignalAssistantReply(message.content)
  );
}

function sanitizeSummary(
  summary: string | undefined,
  maxChars = DEFAULT_SUMMARY_MAX_CHARS,
): string {
  if (!summary || summaryContainsSyntheticAssistantReply(summary)) return '';
  return trimStructuredText(summary, maxChars);
}

function formatSummarySection(title: string, bullets: string[]): string {
  const deduped = Array.from(
    new Set(
      bullets.map((bullet) => compactSnippet(bullet, 220)).filter(Boolean),
    ),
  ).slice(0, 5);
  if (deduped.length === 0) return '';
  return [`[${title}]`, ...deduped.map((bullet) => `- ${bullet}`)].join('\n');
}

function bucketSummarySignals(
  messages: NewMessage[],
  assistantName: string,
): string {
  const activeGoals: string[] = [];
  const activeConstraints: string[] = [];
  const openQuestions: string[] = [];
  const decisions: string[] = [];

  for (const message of messages) {
    const content = normalizeLine(message.content);
    if (!content) continue;
    const isAssistant =
      message.is_bot_message === true || message.sender_name === assistantName;
    const lower = content.toLowerCase();
    const speaker = isAssistant ? assistantName : message.sender_name || 'User';

    if (
      /\b(project|build|working on|goal|need to|trying to|ship|fix|implement|implementing|improve|turning)\b/i.test(
        content,
      )
    ) {
      activeGoals.push(`${speaker}: ${content}`);
    }
    if (
      /\b(constraint|blocked|blocker|limit|budget|deadline|compat|must|cannot|can't|wont|won't|issue)\b/i.test(
        content,
      )
    ) {
      activeConstraints.push(`${speaker}: ${content}`);
    }
    if (
      !isAssistant &&
      (content.includes('?') ||
        /\b(how|what|why|can you|should we|not sure|unsure|confused)\b/i.test(
          content,
        ))
    ) {
      openQuestions.push(`${speaker}: ${content}`);
    }
    if (
      (isAssistant &&
        /\b(i will|i can|next|plan|we should|i'm going to|i updated|i fixed|decided|recommend)\b/i.test(
          content,
        )) ||
      (!isAssistant &&
        /\b(let's|we should|i'll|i will|plan is|decided|go with)\b/i.test(
          content,
        ))
    ) {
      decisions.push(`${speaker}: ${content}`);
    }
  }

  const sections = [
    formatSummarySection('Active goals and projects', activeGoals),
    formatSummarySection('Constraints and blockers', activeConstraints),
    formatSummarySection('Open questions', openQuestions),
    formatSummarySection('Recent commitments and decisions', decisions),
  ].filter(Boolean);

  if (sections.length === 0) {
    const fallback = messages.slice(-4).map((message) => {
      const isAssistant =
        message.is_bot_message === true ||
        message.sender_name === assistantName;
      const speaker = isAssistant
        ? assistantName
        : message.sender_name || 'User';
      return `${speaker}: ${normalizeLine(message.content)}`;
    });
    return formatSummarySection('Conversation snapshot', fallback);
  }

  return sections.join('\n\n').trim();
}

function normalizeContinuityMessages(
  messages: NewMessage[],
  assistantName: string,
): {
  messages: NewMessage[];
  droppedSyntheticAssistantMessages: number;
  droppedLowSignalAssistantMessages: number;
  duplicateMessagesCollapsed: number;
} {
  let droppedSyntheticAssistantMessages = 0;
  let droppedLowSignalAssistantMessages = 0;

  const filtered = messages.filter((message) => {
    const isAssistant =
      message.is_bot_message === true || message.sender_name === assistantName;
    if (!isAssistant) return true;
    if (isSyntheticAssistantReply(message.content)) {
      droppedSyntheticAssistantMessages += 1;
      return false;
    }
    if (isLowSignalAssistantReply(message.content)) {
      droppedLowSignalAssistantMessages += 1;
      return false;
    }
    return true;
  });

  const collapsed = collapseRepeatedMessages(filtered, assistantName);
  return {
    messages: collapsed.messages,
    droppedSyntheticAssistantMessages,
    droppedLowSignalAssistantMessages,
    duplicateMessagesCollapsed: collapsed.collapsedCount,
  };
}

function selectRecentMessages(
  messages: NewMessage[],
  maxTurns: number,
  maxChars: number,
  assistantName: string,
  minUserMessages: number = DEFAULT_MIN_RECENT_USER_MESSAGES,
): NewMessage[] {
  const selected: NewMessage[] = [];
  let totalChars = 0;
  let selectedUserMessages = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const nextChars = totalChars + normalizeLine(message.content).length;
    const isAssistant =
      message.is_bot_message === true || message.sender_name === assistantName;
    const wouldSatisfyUserFloor =
      selectedUserMessages >= minUserMessages ||
      (!isAssistant && selectedUserMessages + 1 >= minUserMessages);
    if (
      selected.length >= maxTurns &&
      selectedUserMessages >= minUserMessages
    ) {
      break;
    }
    if (selected.length > 0 && nextChars > maxChars && wouldSatisfyUserFloor) {
      break;
    }
    selected.unshift(message);
    totalChars = nextChars;
    if (!isAssistant) selectedUserMessages += 1;
  }

  return selected;
}

function boundCurrentMessages(
  messages: NewMessage[],
  maxChars: number,
  maxLatestMessageChars: number,
): NewMessage[] {
  if (messages.length === 0) return [];

  const boundedLatest = {
    ...messages[messages.length - 1],
    content: trimStructuredTextPreservingEnds(
      messages[messages.length - 1].content,
      maxLatestMessageChars,
    ),
  };
  const selected: NewMessage[] = [boundedLatest];
  let totalChars = normalizeLine(boundedLatest.content).length;

  for (let index = messages.length - 2; index >= 0; index -= 1) {
    if (selected.length >= messages.length) break;
    if (totalChars >= maxChars) break;

    const remainingBudget = maxChars - totalChars;
    if (remainingBudget < 80) break;

    const candidate = messages[index];
    const boundedCandidate = {
      ...candidate,
      content: trimStructuredText(candidate.content, remainingBudget),
    };
    const candidateChars = normalizeLine(boundedCandidate.content).length;
    if (candidateChars > remainingBudget) break;

    selected.unshift(boundedCandidate);
    totalChars += candidateChars;
  }

  return selected;
}

export function buildContinuityPlan(input: {
  assistantName: string;
  conversationMessages: NewMessage[];
  currentMessages?: NewMessage[];
  storedSummary?: string;
  recentTurnLimit?: number;
  recentCharBudget?: number;
  summaryMinMessages?: number;
  summaryMinChars?: number;
  summaryMaxChars?: number;
}): ContinuityPlan {
  const normalizedConversation = normalizeContinuityMessages(
    input.conversationMessages,
    input.assistantName,
  );
  const normalizedCurrent = collapseRepeatedMessages(
    input.currentMessages || [],
    input.assistantName,
  ).messages;
  const currentIds = new Set(normalizedCurrent.map((message) => message.id));
  const eligibleRecent = normalizedConversation.messages.filter(
    (message) => !currentIds.has(message.id),
  );
  const recentContextMessages = selectRecentMessages(
    eligibleRecent,
    input.recentTurnLimit || DEFAULT_RECENT_TURN_LIMIT,
    input.recentCharBudget || DEFAULT_RECENT_CHAR_BUDGET,
    input.assistantName,
  );
  const recentStartIndex = eligibleRecent.length - recentContextMessages.length;
  const olderMessages =
    recentStartIndex > 0 ? eligibleRecent.slice(0, recentStartIndex) : [];
  const olderChars = estimateChars(olderMessages);
  const shouldSummarizeOlder =
    olderMessages.length >=
      (input.summaryMinMessages || DEFAULT_SUMMARY_MIN_MESSAGES) ||
    olderChars >= (input.summaryMinChars || DEFAULT_SUMMARY_MIN_CHARS);
  const computedSummaryRaw = shouldSummarizeOlder
    ? buildRollingSummary(olderMessages, input.assistantName)
    : '';
  const computedSummary = sanitizeSummary(
    computedSummaryRaw,
    input.summaryMaxChars || DEFAULT_SUMMARY_MAX_CHARS,
  );
  const storedSummary = sanitizeSummary(
    input.storedSummary,
    input.summaryMaxChars || DEFAULT_SUMMARY_MAX_CHARS,
  );
  const summaryToUse = computedSummary || storedSummary;

  return {
    summaryToUse,
    computedSummary,
    shouldPersistSummary: computedSummary.length > 0,
    sourceMessageCount: olderMessages.length,
    lastMessageTimestamp: olderMessages[olderMessages.length - 1]?.timestamp,
    recentContextMessages,
    currentMessages: normalizedCurrent,
    diagnostics: {
      totalMessages: input.conversationMessages.length,
      normalizedMessages: normalizedConversation.messages.length,
      droppedSyntheticAssistantMessages:
        normalizedConversation.droppedSyntheticAssistantMessages,
      droppedLowSignalAssistantMessages:
        normalizedConversation.droppedLowSignalAssistantMessages,
      duplicateMessagesCollapsed:
        normalizedConversation.duplicateMessagesCollapsed,
      currentMessages: normalizedCurrent.length,
      recentMessages: recentContextMessages.length,
      olderMessages: olderMessages.length,
      recentChars: estimateChars(recentContextMessages),
      summaryChars: summaryToUse.length,
      olderChars,
      usedStoredSummary: !computedSummary && !!storedSummary,
    },
  };
}

export function buildRollingSummary(
  messages: NewMessage[],
  assistantName: string,
  maxBullets = 12,
): string {
  const relevantMessages = normalizeContinuityMessages(
    messages,
    assistantName,
  ).messages;
  if (relevantMessages.length === 0) return '';
  return trimStructuredText(
    bucketSummarySignals(
      relevantMessages.slice(-maxBullets * 2),
      assistantName,
    ),
    DEFAULT_SUMMARY_MAX_CHARS,
  );
}

export function buildContinuityPrompt(input: {
  assistantName: string;
  summary?: string;
  recentContextMessages: NewMessage[];
  currentMessages: NewMessage[];
}): string {
  const relevantRecentContextMessages = normalizeContinuityMessages(
    input.recentContextMessages,
    input.assistantName,
  ).messages;
  const currentMessages = collapseRepeatedMessages(
    input.currentMessages,
    input.assistantName,
  ).messages;
  const boundedCurrentMessages = boundCurrentMessages(
    currentMessages,
    DEFAULT_CURRENT_MESSAGES_CHAR_BUDGET,
    DEFAULT_CURRENT_MESSAGE_MAX_CHARS,
  );
  const safeSummary = sanitizeSummary(input.summary);
  const parts = [
    `You are ${input.assistantName}, continuing an ongoing conversation. Use earlier conversation only as background context. Answer only the latest request in the current message section unless the user explicitly asks you to repeat, continue, revisit, or compare with an earlier request. Do not merge older unfinished topics into this reply unless the latest message clearly asks for that.`,
  ];

  if (safeSummary && safeSummary.trim()) {
    parts.push('[Previous conversation summary]', safeSummary.trim());
  }

  if (relevantRecentContextMessages.length > 0) {
    parts.push(
      '[Recent conversation background - context only, not the active request unless referenced below]',
      formatConversationHistory(
        relevantRecentContextMessages,
        input.assistantName,
      ),
    );
  }

  parts.push(
    '[Current message - this is the only request you should answer now]',
    formatMessages(boundedCurrentMessages),
  );

  return parts.join('\n\n');
}
