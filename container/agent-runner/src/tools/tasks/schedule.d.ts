import { ToolExecutionContext, ToolExecutionResult } from '../types.js';
export declare function executeScheduleTask(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
export declare function executeScheduleOnceTask(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
export declare function executeScheduleRecurringTask(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
export declare function executeScheduleIntervalTask(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
//# sourceMappingURL=schedule.d.ts.map