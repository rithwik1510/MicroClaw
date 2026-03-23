export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/microclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  requested_prompt?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

export interface HeartbeatRunLog {
  group_folder: string;
  chat_jid: string;
  run_at: string;
  duration_ms: number;
  status: 'ok' | 'acted' | 'error';
  actions_taken: string | null;
  error: string | null;
}

export interface RuntimeUsageMetrics {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  source: 'provider' | 'estimated';
  requests?: number;
}

export interface RuntimeUsageLog {
  groupFolder: string;
  chatJid: string;
  profileId?: string;
  provider: RuntimeProvider;
  model: string;
  triggerKind: 'message' | 'scheduled_task' | 'heartbeat' | 'cli';
  startedAt: string;
  durationMs: number;
  usage: RuntimeUsageMetrics;
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
  notes?: string;
}

// --- Runtime and routing contracts ---

export type RuntimeProvider = 'claude' | 'openai_compatible';

export type EndpointKind = 'cloud' | 'lmstudio' | 'ollama' | 'custom_openai';

export type AuthProvider = 'anthropic_setup_token' | 'openai_compatible';

export type AuthCredentialType =
  | 'oauth_access_token'
  | 'api_key'
  | 'setup_token'
  | 'none';

export type AuthProfileStatus = 'active' | 'expired' | 'revoked' | 'error';
export type AuthRiskLevel = 'standard' | 'advanced' | 'experimental';

export type LocalEndpointEngine = 'lmstudio' | 'ollama' | 'custom_openai';

export type LocalApiKeyMode = 'none' | 'optional' | 'required' | 'dummy';

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  retryableErrors: string[];
  timeoutMs: number;
}

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
export type BrowserPermissionTier = 'isolated' | 'persistent' | 'attached';

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

export interface RuntimeProfile {
  id: string;
  provider: RuntimeProvider;
  model: string;
  baseUrl?: string;
  endpointKind?: EndpointKind;
  authProfileId?: string;
  enabled: boolean;
  priority: number;
  costTier?: string;
  authEnvVar?: string;
  toolPolicy?: RuntimeToolPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeExecutionConfig {
  provider: RuntimeProvider;
  model: string;
  baseUrl?: string;
  authEnvVar?: string;
  toolPolicy?: RuntimeToolPolicy;
  capabilityRoute?: CapabilityRoute;
  plannerCritic?: PlannerCriticConfig;
  capabilities?: ProviderCapability;
}

export interface AuthProfile {
  id: string;
  provider: AuthProvider;
  credentialType: AuthCredentialType;
  accountLabel?: string;
  scopes?: string[];
  expiresAt?: string;
  tokenType?: string;
  refreshEligible?: boolean;
  providerAccountId?: string;
  riskLevel?: AuthRiskLevel;
  status: AuthProfileStatus;
  createdAt: string;
  updatedAt: string;
}

export interface OAuthCredentialEnvelope {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scopes?: string[];
  accountId?: string;
  tokenType?: string;
}

export interface AuthCredentialHandle {
  profileId: string;
  materializedHeaders: Record<string, string>;
  materializedEnv: Record<string, string>;
}

export interface AuthRefreshResult {
  refreshed: boolean;
  profileId: string;
  expiresAt?: string;
  accountId?: string;
  message: string;
}

export interface ProviderCapability {
  supportsResponses: boolean;
  supportsChatCompletions: boolean;
  supportsTools: boolean;
  supportsStreaming: boolean;
  requiresApiKey: boolean;
  supportsNativeRuntime?: boolean;
  requiresContainerIsolation?: boolean;
  defaultModel?: string;
  checkedAt: string;
}

export interface LocalEndpointProfile {
  id: string;
  engine: LocalEndpointEngine;
  baseUrl: string;
  apiKeyMode: LocalApiKeyMode;
  containerReachableUrl: string;
  healthStatus: 'healthy' | 'degraded' | 'unreachable' | 'unknown';
  lastCheckedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ToolServiceKind = 'custom_http';

export interface ToolServiceProfile {
  id: string;
  name: string;
  kind: ToolServiceKind;
  baseUrl?: string;
  healthPath?: string;
  enabled: boolean;
  startupMode: 'auto' | 'manual';
  createdAt: string;
  updatedAt: string;
}

export interface ToolServiceState {
  serviceId: string;
  status: 'healthy' | 'degraded' | 'unreachable' | 'disabled' | 'unknown';
  lastProbeAt?: string;
  lastProbeDetail?: string;
  restartCount: number;
  lastError?: string;
  updatedAt: string;
}

export interface SkillManifest {
  id: string;
  version: string;
  requiredTools: string[];
  permissions: string[];
  entrypoints: string[];
  healthChecks: string[];
}

export interface GroupRuntimePolicy {
  groupFolder: string;
  primaryProfileId: string;
  fallbackProfileIds: string[];
  retryPolicy?: RetryPolicy;
  updatedAt: string;
}

export interface ConversationSummary {
  groupFolder: string;
  summary: string;
  sourceMessageCount: number;
  lastMessageTimestamp?: string;
  updatedAt: string;
}

export interface RuntimeEvent {
  id: string;
  groupFolder: string;
  chatJid: string;
  profileId: string;
  provider: RuntimeProvider;
  eventType:
    | 'attempt'
    | 'success'
    | 'failover'
    | 'error'
    | 'timeout'
    | 'auth_error'
    | 'rate_limited'
    | 'auth_profile_selected'
    | 'token_refreshed'
    | 'endpoint_unreachable'
    | 'provider_capability_mismatch'
    | 'tool_attempt'
    | 'tool_success'
    | 'tool_error'
    | 'tool_restricted'
    | 'tool_fallback';
  message: string;
  timestamp: string;
}

export interface RoutingRule {
  id: string;
  match: {
    channel?: string;
    chatJid?: string;
    groupFolder?: string;
  };
  targetProfileId: string;
  priority: number;
  enabled: boolean;
}

export interface PairingPolicy {
  mode: 'open' | 'pairing_required';
  allowUnknownDm: boolean;
  requirePairingCode: boolean;
  allowedSenders: string[];
}

export interface PresenceState {
  state: 'idle' | 'thinking' | 'running_task' | 'completed' | 'error';
  detail?: string;
  startedAt: string;
  updatedAt: string;
}

export interface BrowserActionAuditEntry {
  id: string;
  action: string;
  sessionId?: string;
  owner: {
    groupFolder: string;
    chatJid: string;
    taskId?: string;
    role: string;
  };
  permissionTier: BrowserPermissionTier;
  timestamp: string;
  approvalRequired: boolean;
  approved: boolean;
  summary: string;
  outcome: 'success' | 'denied' | 'error';
}

export interface UpgradePlan {
  fromVersion: string;
  toVersion: string;
  migrations: string[];
  rollbackSteps: string[];
}

export interface RollbackPlan {
  targetVersion: string;
  steps: string[];
}

export interface AgentRuntimeInput {
  prompt: string;
  systemPrompt?: string;
  sessionId?: string;
  resumeAt?: string;
}

export interface AgentRuntimeOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  lastAssistantUuid?: string;
  error?: string;
  isPartial?: boolean;
}

export interface AgentRuntime {
  provider: RuntimeProvider;
  run(input: AgentRuntimeInput): Promise<AgentRuntimeOutput>;
  resume(input: AgentRuntimeInput): Promise<AgentRuntimeOutput>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
  supports(feature: string): boolean;
}

export interface CommandCenterCommand {
  name:
    | 'init'
    | 'onboard'
    | 'auth'
    | 'models'
    | 'skills'
    | 'tools'
    | 'backend'
    | 'gates'
    | 'local'
    | 'status'
    | 'doctor'
    | 'launch-check'
    | 'web'
    | 'logs'
    | 'pair'
    | 'policy'
    | 'tui';
  description: string;
}

export type WizardStepId =
  | 'welcome'
  | 'config_detect'
  | 'model_provider'
  | 'auth_method'
  | 'auth_flow'
  | 'model_choice'
  | 'channel_choice'
  | 'channel_auth'
  | 'web_tool_setup'
  | 'review'
  | 'apply'
  | 'health';

export interface WizardSessionState {
  sessionId: string;
  status: 'active' | 'completed' | 'cancelled' | 'failed';
  currentStep: WizardStepId;
  stateJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<ChannelMessageRef | null>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  updateMessage?(
    jid: string,
    ref: ChannelMessageRef,
    text: string,
  ): Promise<void>;
  deleteMessage?(jid: string, ref: ChannelMessageRef): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
}

export interface ChannelMessageRef {
  id: string;
  jid: string;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
