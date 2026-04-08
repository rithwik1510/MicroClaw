import { OpenAIRuntimeAdapter } from './openai.js';
import { RuntimeAdapter, RuntimeConfig } from './types.js';

export function createRuntimeAdapter(config: RuntimeConfig): RuntimeAdapter {
  switch (config.provider) {
    case 'openai_compatible':
      return new OpenAIRuntimeAdapter();
    case 'claude':
    default:
      throw new Error('Claude runtime uses the native Claude SDK path');
  }
}
