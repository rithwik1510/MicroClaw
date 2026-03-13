import { describe, expect, it } from 'vitest';

import { resolveCapabilityRoute } from './capability-router.js';

describe('resolveCapabilityRoute', () => {
  it('keeps explanatory pasted tracking-code messages in plain response mode', () => {
    const prompt = [
      '[Current message - respond to this]',
      'My manager sent me this LinkedIn Insight Tag.',
      '<script type="text/javascript"> _linkedin_partner_id = "8816634"; window._linkedin_data_partner_ids = window._linkedin_data_partner_ids || []; window._linkedin_data_partner_ids.push(_linkedin_partner_id); </script>',
      '<script type="text/javascript">(function(l) { if (!l){window.lintrk = function(a,b){window.lintrk.q.push([a,b])}; window.lintrk.q=[]} var s = document.getElementsByTagName("script")[0]; var b = document.createElement("script"); b.src = "https://snap.licdn.com/li.lms-analytics/insight.min.js"; s.parentNode.insertBefore(b, s);})(window.lintrk); </script>',
      '<noscript><img src="https://px.ads.linkedin.com/collect/?pid=8816634&fmt=gif" /></noscript>',
      'I do not know what this work is exactly. Please explain it to me.',
    ].join('\n');

    const route = resolveCapabilityRoute({
      prompt,
      toolPolicy: {
        web: { enabled: true },
        browser: { enabled: true },
      },
    });

    expect(route).toBe('plain_response');
  });

  it('keeps future timed requests in plain response mode so scheduling tools can handle them', () => {
    const prompt = [
      '[Current message - respond to this]',
      'At 12:30 AM today, read the latest AI release news and send me only the important updates.',
    ].join('\n');

    const route = resolveCapabilityRoute({
      prompt,
      toolPolicy: {
        web: { enabled: true },
        browser: { enabled: true },
      },
    });

    expect(route).toBe('plain_response');
  });
});
