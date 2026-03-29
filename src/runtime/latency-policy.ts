export type LatencyTurnClass =
  | 'tiny_conversation'
  | 'simple_conversation'
  | 'normal_conversation'
  | 'memory_or_state'
  | 'web_or_browser'
  | 'scheduling';

export interface RuntimeSecretOverrides {
  [key: string]: string | undefined;
  OPENAI_REQUEST_TIMEOUT_MS?: string;
  OPENAI_MAX_OUTPUT_TOKENS?: string;
  OPENAI_INPUT_BUDGET_CHARS?: string;
}

export interface LatencyTurnPolicy {
  skipContextBundle: boolean;
  disableTools: boolean;
  runtimeSecretOverrides: RuntimeSecretOverrides;
}

function endsWithWordLike(text: string): boolean {
  return /[A-Za-z0-9]$/.test(text);
}

function startsWithWordLike(text: string): boolean {
  return /^[A-Za-z0-9]/.test(text);
}

function endsWithSentencePunctuation(text: string): boolean {
  return /[.!?]$/.test(text);
}

export function resolveLatencyTurnPolicy(
  turnClass: LatencyTurnClass,
): LatencyTurnPolicy {
  void turnClass;
  return {
    skipContextBundle: false,
    disableTools: false,
    runtimeSecretOverrides: {},
  };
}

export function appendStreamText(buffer: string, chunk: string): string {
  if (!chunk) return buffer;
  if (!buffer) return chunk;
  if (/^\s/.test(chunk)) return `${buffer}${chunk}`;
  if (endsWithSentencePunctuation(buffer) && startsWithWordLike(chunk)) {
    return `${buffer} ${chunk}`;
  }
  if (endsWithWordLike(buffer) && startsWithWordLike(chunk)) {
    return `${buffer} ${chunk}`;
  }
  return `${buffer}${chunk}`;
}
