import { describe, expect, it } from 'vitest';

import { debugHelpersForTest } from './debug.js';

describe('debug helpers', () => {
  const helpers = debugHelpersForTest();

  it('detects leaked internal scaffolding as a bad user-facing reply', () => {
    expect(
      helpers.looksBadUserFacingReply(
        'Query: hello\n\nFetched source excerpts:\n1. Example | https://example.com | text',
      ),
    ).toBe(true);
  });

  it('recognizes the exact neutral smoke reply', () => {
    expect(helpers.looksExactSmokeReply('NANOCLAW_SMOKE_OK')).toBe(true);
    expect(
      helpers.looksExactSmokeReply('Hello! What can I help you with today?'),
    ).toBe(false);
  });
});
