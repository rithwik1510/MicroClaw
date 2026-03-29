export type RuntimeProvider =
  | 'claude'
  | 'openai_compatible';

export type RuntimeToolFamily =
  | 'web'
  | 'memory'
  | 'docs'
  | 'browser'
  | 'host_files'
  | 'meta';

export interface PlannerCriticConfig {
  enabled: boolean;
  maxRevisionCycles: number;
}
export type CapabilityRoute =
  | 'plain_response'
  | 'host_file_operation'
  | 'web_lookup'
  | 'browser_operation'
  | 'deny_or_escalate';

export interface RuntimeToolFamilyPolicy {
  enabled?: boolean;
  maxSteps?: number;
  maxSearchCalls?: number;
  totalBudgetMs?: number;
  maxConcurrentSessionsGlobal?: number;
  maxTabsPerSession?: number;
  idleTimeoutMs?: number;
  allowPersistentSessions?: boolean;
  allowAttachedSessions?: boolean;
  allowDesktopControl?: boolean;
  requireApprovalForBrowserMutations?: boolean;
  allowFormSubmission?: boolean;
  allowFileUpload?: boolean;
}

export interface RuntimeToolPolicy {
  web?: RuntimeToolFamilyPolicy;
  memory?: RuntimeToolFamilyPolicy;
  docs?: RuntimeToolFamilyPolicy;
  browser?: RuntimeToolFamilyPolicy;
  /** When true, strip scheduling/watch tools so heartbeat can't create new tasks. */
  isHeartbeat?: boolean;
  /** When true, strip scheduling/watch tools so fired tasks can't re-schedule themselves. */
  isScheduledTask?: boolean;
}

export interface RuntimeConfig {
  provider: RuntimeProvider;
  model: string;
  baseUrl?: string;
  authEnvVar?: string;
  toolPolicy?: RuntimeToolPolicy;
  capabilityRoute?: CapabilityRoute;
  plannerCritic?: PlannerCriticConfig;
  capabilities?: {
    supportsResponses: boolean;
    supportsChatCompletions: boolean;
    supportsTools: boolean;
    supportsStreaming: boolean;
    requiresApiKey: boolean;
    defaultModel?: string;
    checkedAt: string;
  };
}

/** A single message in the conversation history, compatible with OpenAI message format. */
export interface ConversationMessage {
  role: string;
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

export interface RuntimeRequest {
  prompt: string;
  systemPrompt?: string;
  config: RuntimeConfig;
  secrets?: Record<string, string>;
  onPartialText?: (text: string) => Promise<void> | void;
  /**
   * Prior conversation messages from previous warm-session turns.
   * When provided, these are prepended to the messages array so the model
   * has full conversation history without rebuilding context from scratch.
   */
  priorMessages?: ConversationMessage[];
}

export interface RuntimeUsageMetrics {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  source: 'provider' | 'estimated';
  requests?: number;
}

export interface RuntimeResponse {
  result: string;
  sessionId: string;
  usage?: RuntimeUsageMetrics;
  /**
   * Accumulated conversation messages after this turn (user + assistant + tool calls).
   * Returned by warm-session-aware adapters so the caller can pass them as
   * priorMessages on the next turn.
   */
  conversationMessages?: ConversationMessage[];
}

export interface RuntimeAdapter {
  provider: RuntimeProvider;
  run(req: RuntimeRequest): Promise<RuntimeResponse>;
}
