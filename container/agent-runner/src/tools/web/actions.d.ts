import { ToolExecutionContext, ToolExecutionResult } from '../types.js';
export declare function executeWebSearch(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
export declare function executeWebFetch(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
export declare function executeWebOpenUrl(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
export declare function executeWebExtractText(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
export declare function executeWebGetLinks(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
export declare function executeWebClose(_args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
export declare function closeWebSessionFromContext(ctx: ToolExecutionContext): Promise<void>;
//# sourceMappingURL=actions.d.ts.map