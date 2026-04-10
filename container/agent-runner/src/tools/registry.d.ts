import { ToolHandler } from './types.js';
import { RuntimeToolPolicy } from '../runtime/types.js';
export declare function buildToolRegistry(): ToolHandler[];
export declare function filterToolRegistry(registry: ToolHandler[], toolPolicy: RuntimeToolPolicy | undefined): ToolHandler[];
export declare function toOpenAITools(registry: ToolHandler[]): Array<Record<string, unknown>>;
export declare function findTool(registry: ToolHandler[], name: string): ToolHandler | undefined;
//# sourceMappingURL=registry.d.ts.map