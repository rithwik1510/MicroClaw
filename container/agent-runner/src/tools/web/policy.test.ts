import { describe, expect, it } from 'vitest';

import { looksLikeChallengePage } from './policy.js';

describe('looksLikeChallengePage', () => {
  it('detects strong captcha/challenge pages', () => {
    const text =
      'One last step. Please solve the challenge below to continue. Select all squares containing a duck.';
    expect(looksLikeChallengePage(text)).toBe(true);
  });

  it('detects weak marker combinations', () => {
    const text =
      'Please enable JavaScript and verify you are human before continuing.';
    expect(looksLikeChallengePage(text)).toBe(true);
  });

  it('does not flag normal content with generic phrasing', () => {
    const text =
      'About this page: latest AI announcements, release notes, and model updates.';
    expect(looksLikeChallengePage(text)).toBe(false);
  });
});
