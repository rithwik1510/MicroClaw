export type RuntimeProvider =
  | 'claude'
  | 'openai_compatible';

export type RuntimeToolFamily = 'web' | 'memory' | 'docs' | 'browser' | 'meta';

export interface PlannerCriticConfig {
  enabled: boolean;
  maxRevisionCycles: number;
}
export type CapabilityRoute =
  | 'plain_response'
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

export interface RuntimeRequest {
  prompt: string;
  systemPrompt?: string;
  config: RuntimeConfig;
  secrets?: Record<string, string>;
}

export interface RuntimeResponse {
  result: string;
  sessionId: string;
}

export interface RuntimeAdapter {
  provider: RuntimeProvider;
  run(req: RuntimeRequest): Promise<RuntimeResponse>;
}
