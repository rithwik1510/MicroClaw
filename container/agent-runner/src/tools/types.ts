import { RuntimeToolFamily } from '../runtime/types.js';

export interface ToolExecutionContext {
  secrets?: Record<string, string>;
  maxSearchCallsPerTurn: number;
  maxToolSteps: number;
  searchTimeoutMs: number;
  pageFetchTimeoutMs: number;
  totalWebBudgetMs: number;
  maxBrowserActionsPerTurn?: number;
  totalBrowserBudgetMs?: number;
  startedAtMs: number;
  stepCount: number;
  searchCount: number;
  webSession?: Record<string, unknown>;
  browserActionCount?: number;
  browserSession?: {
    id?: string;
    mode?: 'ephemeral' | 'persistent' | 'attached';
    snapshotVersion?: number;
  };
  browserPolicy?: {
    allowPersistentSessions?: boolean;
    allowAttachedSessions?: boolean;
    allowDesktopControl?: boolean;
    maxTabsPerSession?: number;
    idleTimeoutMs?: number;
    requireApprovalForBrowserMutations?: boolean;
    allowFormSubmission?: boolean;
    allowFileUpload?: boolean;
  };
}

export interface ToolExecutionResult {
  ok: boolean;
  restricted?: boolean;
  usedFallback?: boolean;
  content: string;
}

export interface ToolHandler {
  name: string;
  family: RuntimeToolFamily;
  description: string;
  schema: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}
