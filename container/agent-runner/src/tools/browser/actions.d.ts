import { ToolExecutionContext, ToolExecutionResult } from '../types.js';
export declare function executeBrowserOpenUrl(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
export declare function executeBrowserSnapshot(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
export declare function executeBrowserClick(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
export declare function executeBrowserType(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
export declare function executeBrowserSelect(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
export declare function executeBrowserExtractText(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
export declare function executeBrowserTabs(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
export declare function executeBrowserClose(_args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
export declare function executeBrowserScreenshot(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
export declare function closeBrowserSessionFromContext(ctx: ToolExecutionContext): Promise<void>;
//# sourceMappingURL=actions.d.ts.map