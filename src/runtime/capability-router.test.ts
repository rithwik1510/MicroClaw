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

  it('routes host file requests to the native host-file tool path', () => {
    const prompt = [
      '[Current message - respond to this]',
      'Please list the files in my Desktop folder and open the newest notes file.',
    ].join('\n');

    const route = resolveCapabilityRoute({
      prompt,
      toolPolicy: {
        web: { enabled: true },
        browser: { enabled: true },
      },
    });

    expect(route).toBe('host_file_operation');
  });

  it('routes visibility-style desktop folder prompts to the native host-file tool path', () => {
    const prompt = [
      '[Current message - respond to this]',
      'Can you see my desktop folders?',
    ].join('\n');

    const route = resolveCapabilityRoute({
      prompt,
      toolPolicy: {
        web: { enabled: true },
        browser: { enabled: true },
      },
    });

    expect(route).toBe('host_file_operation');
  });

  it('routes current-events prompts to web lookup mode', () => {
    const prompt = [
      '[Current message - respond to this]',
      "What are today's AI headlines?",
    ].join('\n');

    const route = resolveCapabilityRoute({
      prompt,
      toolPolicy: {
        web: { enabled: true },
        browser: { enabled: true },
      },
    });

    expect(route).toBe('web_lookup');
  });

  it('routes interactive dashboard prompts to browser mode', () => {
    const prompt = [
      '[Current message - respond to this]',
      'Open this dashboard and click login for me.',
    ].join('\n');

    const route = resolveCapabilityRoute({
      prompt,
      toolPolicy: {
        web: { enabled: true },
        browser: { enabled: true },
      },
    });

    expect(route).toBe('browser_operation');
  });

  it('does not route "find the latest news sources" to host_file_operation', () => {
    const prompt = [
      '[Current message - respond to this]',
      'Find the latest news sources about the AI regulation bill.',
    ].join('\n');

    const route = resolveCapabilityRoute({
      prompt,
      toolPolicy: { web: { enabled: true }, browser: { enabled: true } },
    });

    expect(route).not.toBe('host_file_operation');
  });

  it('does not route "search for project updates online" to host_file_operation', () => {
    const prompt = [
      '[Current message - respond to this]',
      'Search for updates on the project timeline online.',
    ].join('\n');

    const route = resolveCapabilityRoute({
      prompt,
      toolPolicy: { web: { enabled: true }, browser: { enabled: true } },
    });

    expect(route).not.toBe('host_file_operation');
  });

  it('routes explicit Windows paths to host_file_operation', () => {
    const prompt = [
      '[Current message - respond to this]',
      'Read C:\\Users\\posan\\Documents\\notes.txt and summarize it.',
    ].join('\n');

    const route = resolveCapabilityRoute({
      prompt,
      toolPolicy: { web: { enabled: true }, browser: { enabled: true } },
    });

    expect(route).toBe('host_file_operation');
  });

  it('routes "organize my Desktop folder" to host_file_operation', () => {
    const prompt = [
      '[Current message - respond to this]',
      'Organize my Desktop folder by moving old files into an archive subfolder.',
    ].join('\n');

    const route = resolveCapabilityRoute({
      prompt,
      toolPolicy: { web: { enabled: true }, browser: { enabled: true } },
    });

    expect(route).toBe('host_file_operation');
  });

  it('does not route "what is the current status of my files uploaded to the website" to host_file_operation', () => {
    const prompt = [
      '[Current message - respond to this]',
      'What is the current status of my files I uploaded to the website?',
    ].join('\n');

    const route = resolveCapabilityRoute({
      prompt,
      toolPolicy: { web: { enabled: true }, browser: { enabled: true } },
    });

    expect(route).not.toBe('host_file_operation');
  });
});
