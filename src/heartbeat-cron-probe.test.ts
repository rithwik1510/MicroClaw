/**
 * Integration probe: verifies heartbeat and cron (scheduled task) tool
 * isolation works correctly — heartbeat cannot see scheduling tools,
 * and scheduled tasks still can.
 */
import { describe, expect, it } from 'vitest';
import {
  buildToolRegistry,
  filterToolRegistry,
} from '../container/agent-runner/src/tools/registry.js';

const SCHEDULING_TOOL_NAMES = [
  'schedule_task',
  'schedule_once_task',
  'schedule_recurring_task',
  'schedule_interval_task',
  'register_watch',
];

describe('heartbeat vs cron tool isolation', () => {
  const fullRegistry = buildToolRegistry();

  // ── Heartbeat context ──────────────────────────────────────────────

  it('heartbeat: scheduling tools are stripped when isHeartbeat is true', () => {
    const filtered = filterToolRegistry(fullRegistry, {
      isHeartbeat: true,
      web: { enabled: true },
    });
    const names = filtered.map((t) => t.name);

    for (const blocked of SCHEDULING_TOOL_NAMES) {
      expect(names).not.toContain(blocked);
    }
  });

  it('heartbeat: web and memory tools remain available', () => {
    const filtered = filterToolRegistry(fullRegistry, {
      isHeartbeat: true,
      web: { enabled: true },
    });
    const names = filtered.map((t) => t.name);

    expect(names).toContain('web_search');
    expect(names).toContain('web_fetch');
    expect(names).toContain('remember_this');
    expect(names).toContain('memory_search');
  });

  it('heartbeat: browser tools are stripped (browser disabled)', () => {
    const filtered = filterToolRegistry(fullRegistry, {
      isHeartbeat: true,
      web: { enabled: true },
      browser: { enabled: false },
    });
    const names = filtered.map((t) => t.name);

    expect(names).not.toContain('browser_open_url');
    expect(names).not.toContain('browser_click');
    expect(names).not.toContain('browser_snapshot');
  });

  // ── Cron / scheduled task context ──────────────────────────────────

  it('cron: scheduling tools are available when isHeartbeat is false/unset', () => {
    const filtered = filterToolRegistry(fullRegistry, {
      web: { enabled: true },
    });
    const names = filtered.map((t) => t.name);

    for (const expected of SCHEDULING_TOOL_NAMES) {
      expect(names).toContain(expected);
    }
  });

  it('cron: scheduling tools available with explicit isHeartbeat: false', () => {
    const filtered = filterToolRegistry(fullRegistry, {
      isHeartbeat: false,
      web: { enabled: true },
    });
    const names = filtered.map((t) => t.name);

    for (const expected of SCHEDULING_TOOL_NAMES) {
      expect(names).toContain(expected);
    }
  });

  it('cron: web + memory + meta all present for normal task', () => {
    const filtered = filterToolRegistry(fullRegistry, {
      web: { enabled: true },
    });
    const names = filtered.map((t) => t.name);

    expect(names).toContain('web_search');
    expect(names).toContain('memory_search');
    expect(names).toContain('schedule_task');
    expect(names).toContain('register_watch');
  });

  // ── Normal user message context ────────────────────────────────────

  it('normal: all meta tools available in non-heartbeat context', () => {
    const filtered = filterToolRegistry(fullRegistry, {
      web: { enabled: true },
      browser: { enabled: true },
    });
    const names = filtered.map((t) => t.name);

    // All scheduling tools present
    for (const expected of SCHEDULING_TOOL_NAMES) {
      expect(names).toContain(expected);
    }
    // Browser tools present
    expect(names).toContain('browser_open_url');
    // Web tools present
    expect(names).toContain('web_search');
    // Memory tools present
    expect(names).toContain('remember_this');
  });

  // ── Edge: heartbeat with no web ────────────────────────────────────

  it('heartbeat: only memory tools remain when web is also disabled', () => {
    const filtered = filterToolRegistry(fullRegistry, {
      isHeartbeat: true,
      web: { enabled: false },
      browser: { enabled: false },
    });
    const names = filtered.map((t) => t.name);

    // Only memory tools should survive
    expect(names).toContain('remember_this');
    expect(names).toContain('memory_search');
    // No web
    expect(names).not.toContain('web_search');
    // No scheduling
    for (const blocked of SCHEDULING_TOOL_NAMES) {
      expect(names).not.toContain(blocked);
    }
  });
});
