import { CapabilityRoute, RuntimeToolPolicy } from '../types.js';

function currentPromptMessage(prompt: string): string {
  const markers = [
    '[Current message - this is the only request you should answer now]',
    '[Current message - respond to this]',
  ];
  for (const marker of markers) {
    const index = prompt.lastIndexOf(marker);
    if (index !== -1) return prompt.slice(index + marker.length).trim();
  }
  return prompt.trim();
}

function hasUrl(text: string): boolean {
  return /https?:\/\//i.test(text);
}

function hasBrowserActionRequest(text: string): boolean {
  return /\b(log in|login|sign in|portal|dashboard|console|open the site|open website|navigate to|click|fill (out )?the form|submit the form|browser|tab|tabs|apply on|book on|checkout|inspect the page|look around|inspect page)\b/i.test(
    text,
  );
}

function hasExplicitHostPath(text: string): boolean {
  return /([a-z]:\\|[a-z]:\/|~[\\/]|\/users\/|\/home\/|\\\\)/i.test(text);
}

function hasHostFileRequest(text: string): boolean {
  // Strong signals: folder names that unambiguously mean local filesystem
  const strongFileNouns =
    /\b(desktop|documents|downloads|onedrive|my computer|computer files|home folder|home directory)\b/i;
  // Weak signals: generic words that need a clear file-action verb
  const weakFileNouns =
    /\b(file|files|folder|folders|directory|directories)\b/i;
  // Verbs that clearly mean local file operations (not "search", "find", "update")
  const fileActions =
    /\b(list|open|read|write|edit|create|make|save|rename|move|copy|organize|sort|clean up|archive|glob|grep)\b/i;
  const visibilityActions =
    /\b(see|view|show me|what(?:'s| is) in|check|look at|access|inspect|browse)\b/i;
  // Web signals that override weak file nouns
  const webSignal =
    /\b(latest|current|today|recent|news|online|web|internet|source|sources|website|uploaded|cloud)\b/i;

  // Strong noun + any action = definitely file
  if (strongFileNouns.test(text) && (fileActions.test(text) || visibilityActions.test(text))) {
    return true;
  }
  // Weak noun + file-specific action, only if no competing web signal
  if (weakFileNouns.test(text) && fileActions.test(text) && !webSignal.test(text)) {
    return true;
  }
  // Weak noun + visibility, only if no competing web signal
  if (weakFileNouns.test(text) && visibilityActions.test(text) && !webSignal.test(text)) {
    return true;
  }
  return false;
}

function hasWebLookupRequest(text: string): boolean {
  return /\b(latest|current|today|recent|news|source|sources|cite|citation|verify|verification|fact-check|price|release|update|search|lookup|look up|browse the web|find online|check online|read this page|summarize this page|fetch this|find on the web|search online)\b/i.test(
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
  /\b(latest|current|today|recent|news|source|sources|cite|citation|verify|verification|fact-check|price|release|update|search|lookup|look up|browse the web|find online|check online|read this page|summarize this page|fetch this|find on the web|search online)\b/i,
];

const BROWSER_PATTERNS = [
  /\b(log in|login|sign in|portal|dashboard|console|open the site|open website|navigate to|click|fill (out )?the form|submit the form|browser|tab|tabs|apply on|book on|checkout|inspect the page|inspect page|look around)\b/i,
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
