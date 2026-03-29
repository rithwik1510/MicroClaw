import { describe, expect, it } from 'vitest';

import {
  appendStreamText,
  resolveLatencyTurnPolicy,
} from './latency-policy.js';

describe('latency policy', () => {
  it('keeps tiny conversation turns on the normal execution path', () => {
    expect(resolveLatencyTurnPolicy('tiny_conversation')).toEqual({
      skipContextBundle: false,
      disableTools: false,
      runtimeSecretOverrides: {},
    });
  });

  it('keeps simple conversation turns on the normal execution path', () => {
    expect(resolveLatencyTurnPolicy('simple_conversation')).toEqual({
      skipContextBundle: false,
      disableTools: false,
      runtimeSecretOverrides: {},
    });
  });

  it('reconstructs streamed word chunks with natural spacing', () => {
    let text = '';
    text = appendStreamText(text, 'Hello');
    text = appendStreamText(text, '!');
    text = appendStreamText(text, 'How');
    text = appendStreamText(text, 'can');
    text = appendStreamText(text, 'I');
    text = appendStreamText(text, 'assist');
    text = appendStreamText(text, 'you');
    text = appendStreamText(text, 'today');
    text = appendStreamText(text, '?');
    expect(text).toBe('Hello! How can I assist you today?');
  });

  it('preserves provider chunks that already contain leading whitespace', () => {
    let text = '';
    text = appendStreamText(text, 'Hello');
    text = appendStreamText(text, ' world');
    text = appendStreamText(text, '!');
    expect(text).toBe('Hello world!');
  });
});
