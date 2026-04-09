export type ContextScope = 'global' | 'group' | 'legacy';

export type ContextSourceKind =
  | 'soul'
  | 'identity'
  | 'user'
  | 'tools'
  | 'memory'
  | 'daily'
  | 'retrieved_memory'
  | 'legacy_claude';

export type ContextTrimMode = 'tail' | 'head' | 'drop';

export interface ContextLayer {
  kind: ContextSourceKind;
  scope: ContextScope;
  label: string;
  filePath: string;
  included: boolean;
  inclusionReason: string;
  trimMode: ContextTrimMode;
  rawChars: number;
  trimmedChars: number;
  content: string;
}

export interface ContextDiagnostics {
  groupFolder: string;
  promptPreview: string;
  strongKeywords: string[];
  charsPerTokenSafetyRatio: number;
  softCapChars: number;
  hardCapChars: number;
  reservedToolChars: number;
  estimatedToolSchemaChars: number;
  totalLayerChars: number;
  finalChars: number;
  estimatedFinalTokens: number;
  layerCount: number;
  layers: ContextLayer[];
  warnings: string[];
}

export interface ContextBundle {
  systemPrompt: string;
  diagnostics: ContextDiagnostics;
}

export interface MemoryCandidate {
  kind: 'pref' | 'fact' | 'proj' | 'loop';
  text: string;
  source: 'user';
  timestamp: string;
}

export interface MemoryDoctorIssue {
  severity: 'info' | 'warn';
  message: string;
}

export interface MemoryDoctorReport {
  groupFolder: string;
  issues: MemoryDoctorIssue[];
}
