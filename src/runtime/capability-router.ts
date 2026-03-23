import { CapabilityRoute, RuntimeToolPolicy } from '../types.js';

function currentPromptMessage(prompt: string): string {
  const marker = '[Current message - respond to this]';
  const index = prompt.lastIndexOf(marker);
  if (index === -1) return prompt.trim();
  return prompt.slice(index + marker.length).trim();
}

function hasUrl(text: string): boolean {
  return /https?:\/\//i.test(text);
}

function hasBrowserActionRequest(text: string): boolean {
  return /\b(log in|login|sign in|portal|dashboard|console|open the site|open website|navigate to|click|fill (out )?the form|submit the form|browser|tab|tabs|apply on|book on|checkout|inspect the page|look around)\b/i.test(
    text,
  );
}

function hasExplicitHostPath(text: string): boolean {
  return /([a-z]:\\|[a-z]:\/|~[\\/]|\/users\/|\/home\/|\\\\)/i.test(text);
}

function hasHostFileRequest(text: string): boolean {
  return /\b(file|files|folder|folders|directory|directories|desktop|documents|downloads|onedrive|path|paths|workspace|computer files)\b/i.test(
    text,
  ) && /\b(list|show|open|read|write|edit|create|make|save|update|change|rename|move|copy|search|find|grep|glob|organize)\b/i.test(
    text,
  );
}

function hasWebLookupRequest(text: string): boolean {
  return /\b(latest|current|today|recent|news|source|sources|cite|citation|verify|verification|fact-check|price|release|update|search|lookup|look up|browse the web|find online|check online|read this page|summarize this page|fetch this)\b/i.test(
    text,
  );
}

function hasFutureOrRecurringTaskRequest(text: string): boolean {
  const timeCue =
    /\b(at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|tomorrow|today|tonight|later today|later tonight|in\s+\d+\s+(?:minute|minutes|hour|hours)|every\s+(?:day|weekday|weekdays|week|weekend|weekends|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|daily|weekly|each\s+(?:day|week)|every morning|every evening)\b/i.test(
      text,
    );
  const taskCue =
    /\b(remind|send|check|read|look up|lookup|watch|monitor|notify|message|summarize|summary)\b/i.test(
      text,
    );
  return timeCue && taskCue;
}

function hasExplicitUrlTask(text: string): boolean {
  return (
    hasUrl(text) &&
    /\b(open|check|read|summarize|fetch|look up|lookup|search|verify|inspect|review|analyze|tell me about)\b/i.test(
      text,
    )
  );
}

function looksLikeEmbeddedCodeOrMarkup(text: string): boolean {
  const scriptLike =
    /<script\b|<\/script>|<noscript\b|<\/noscript>|<body\b|<\/body>/i.test(
      text,
    );
  const denseMarkup =
    (text.match(/<[^>]+>/g) || []).length >= 4 ||
    (text.match(/https?:\/\//gi) || []).length >= 2;
  const codeLikePunctuation =
    /[_$][a-z0-9_]+\s*=|window\.[a-z0-9_]+|document\.[a-z0-9_]+|function\s*\(/i.test(
      text,
    );
  return scriptLike || (denseMarkup && codeLikePunctuation);
}

function asksForExplanation(text: string): boolean {
  return /\b(what is this|what does this do|explain|help me understand|what work is this|what exactly is this|i don't know|dont know|understand this)\b/i.test(
    text,
  );
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

const WEB_PATTERNS = [
  /\b(latest|current|today|recent|news|source|sources|cite|citation|verify|verification|fact-check|price|release|update|search|lookup|look up|browse the web|find online|check online|read this page|summarize this page|fetch this)\b/i,
];

const BROWSER_PATTERNS = [
  /\b(log in|login|sign in|portal|dashboard|console|open the site|open website|navigate to|click|fill (out )?the form|submit the form|browser|tab|tabs|apply on|book on|checkout|inspect the page|look around)\b/i,
];

const DENY_PATTERNS = [
  /\b(watch continuously|keep watching|monitor constantly|scrape all|scrape every|crawl the whole site|download all|upload this file|remote desktop|control my computer|move the mouse|press keys)\b/i,
];

export function resolveCapabilityRoute(input: {
  prompt: string;
  toolPolicy?: RuntimeToolPolicy;
}): CapabilityRoute {
  const current = currentPromptMessage(input.prompt);
  const lower = current.toLowerCase();
  const browserEnabled = input.toolPolicy?.browser?.enabled === true;
  const webEnabled = input.toolPolicy?.web?.enabled === true;

  if (hasAny(lower, DENY_PATTERNS)) {
    return 'deny_or_escalate';
  }

  const explanatoryCodePaste =
    looksLikeEmbeddedCodeOrMarkup(current) && asksForExplanation(current);
  if (explanatoryCodePaste) {
    return 'plain_response';
  }

  // Skip future-task detection for scheduled task executions — the execution
  // prompt carries the original user request which often contains time phrases,
  // but the task is already running now and needs its actual tools (web, etc.).
  if (
    !input.toolPolicy?.isScheduledTask &&
    hasFutureOrRecurringTaskRequest(current)
  ) {
    return 'plain_response';
  }

  if (hasExplicitHostPath(current) || hasHostFileRequest(current)) {
    return 'host_file_operation';
  }

  const browserIntent =
    browserEnabled &&
    (hasBrowserActionRequest(current) ||
      (hasExplicitUrlTask(current) && hasAny(lower, BROWSER_PATTERNS)));
  if (browserIntent) {
    return 'browser_operation';
  }

  const webIntent =
    webEnabled &&
    (hasWebLookupRequest(current) ||
      hasAny(lower, WEB_PATTERNS) ||
      hasExplicitUrlTask(current));
  if (webIntent) {
    return 'web_lookup';
  }

  return 'plain_response';
}

export function capabilityRouteSummary(route: CapabilityRoute): string {
  switch (route) {
    case 'host_file_operation':
      return 'Native host-file tools allowed for this turn.';
    case 'browser_operation':
      return 'Interactive browser operation allowed for this turn.';
    case 'web_lookup':
      return 'Lightweight web lookup allowed for this turn.';
    case 'deny_or_escalate':
      return 'Requested capability exceeds current browser/web policy or budget.';
    case 'plain_response':
    default:
      return 'Plain model response path selected.';
  }
}
