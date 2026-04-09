import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, LOG_DIR } from '../config.js';
import { getAllRegisteredGroups, initDatabase } from '../db.js';
import { runAgentProcess } from '../execution/backend.js';
import { RegisteredGroup } from '../types.js';
import { collectLaunchCheckReportDeep, LaunchCheckReport } from './health.js';
import {
  resolveRuntimeExecutionAsync,
  resolveRuntimeSelection,
} from '../runtime/manager.js';

export interface DebugCheckResult {
  key: string;
  ok: boolean;
  detail: string;
  durationMs: number;
}

export interface DebugReport {
  pass: boolean;
  checkedAt: string;
  groupJid?: string;
  runtimeProfileId?: string;
  items: DebugCheckResult[];
  failedKeys: string[];
}

function npmRunArgs(args: string[]): { command: string; finalArgs: string[] } {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return {
      command: process.execPath,
      finalArgs: [npmExecPath, ...args],
    };
  }
  return {
    command: process.execPath,
    finalArgs: [
      path.join(process.cwd(), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      ...args,
    ],
  };
}

function timed<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; durationMs: number }> {
  const startedAt = Date.now();
  return fn().then((value) => ({
    value,
    durationMs: Date.now() - startedAt,
  }));
}

function looksBadUserFacingReply(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes(
      'i ran into a runtime issue while processing that request',
    ) ||
    normalized.includes("i couldn't produce a reply for that just now") ||
    normalized.includes('query:') ||
    normalized.includes('fetched source excerpts:') ||
    normalized.includes('search page summary:') ||
    normalized.includes('provider note (')
  );
}

function looksExactSmokeReply(text: string): boolean {
  return text.trim() === 'NANOCLAW_SMOKE_OK';
}

function resolveDebugGroup(explicitJid?: string): {
  jid: string;
  group: RegisteredGroup;
} {
  const groups = getAllRegisteredGroups();
  const selectedJid = explicitJid || Object.keys(groups)[0];
  if (!selectedJid) {
    throw new Error('No registered groups found. Run onboard first.');
  }
  const group = groups[selectedJid];
  if (!group) {
    throw new Error(`Registered group not found for JID: ${selectedJid}`);
  }
  return { jid: selectedJid, group };
}

async function runSmokePrompt(input: {
  jid: string;
  group: RegisteredGroup;
  prompt: string;
}): Promise<{ ok: boolean; detail: string; runtimeProfileId?: string }> {
  const selection = resolveRuntimeSelection(input.group.folder);
  const profile = selection.profiles[0];
  if (!profile) {
    return {
      ok: false,
      detail: 'No runtime profile selected for this group.',
    };
  }

  const resolved = await resolveRuntimeExecutionAsync(profile);
  const output = await runAgentProcess(
    input.group,
    {
      prompt: input.prompt,
      groupFolder: input.group.folder,
      chatJid: input.jid,
      isMain: input.group.isMain === true,
      singleTurn: true,
      assistantName: ASSISTANT_NAME,
      runtimeProfileId: profile.id,
      runtimeConfig: resolved.runtimeConfig,
      retryPolicy: selection.retryPolicy,
      secrets: resolved.secrets,
    },
    {
      onProcess: () => undefined,
    },
  );

  if (output.status !== 'success') {
    return {
      ok: false,
      detail: output.error || 'Unknown smoke failure',
      runtimeProfileId: profile.id,
    };
  }

  return {
    ok: true,
    detail: output.result || '(no result text)',
    runtimeProfileId: profile.id,
  };
}

async function runLaunchCheckDebug(): Promise<DebugCheckResult> {
  const { value, durationMs } = await timed<LaunchCheckReport>(() =>
    collectLaunchCheckReportDeep(),
  );
  return {
    key: 'launch_check_deep',
    ok: value.pass,
    detail:
      value.failedKeys.length === 0
        ? 'Deep launch check passed'
        : `Failed keys: ${value.failedKeys.join(', ')}`,
    durationMs,
  };
}

async function runNeutralSmokeCheck(jid?: string): Promise<DebugCheckResult> {
  const { jid: selectedJid, group } = resolveDebugGroup(jid);
  const { value, durationMs } = await timed(() =>
    runSmokePrompt({
      jid: selectedJid,
      group,
      prompt: 'Reply with exactly: NANOCLAW_SMOKE_OK',
    }),
  );
  const text = value.detail;
  return {
    key: 'smoke_neutral_chat',
    ok:
      value.ok && !looksBadUserFacingReply(text) && looksExactSmokeReply(text),
    detail: value.ok ? `reply="${text.slice(0, 160)}"` : text,
    durationMs,
  };
}

async function runWebSmokeCheck(jid?: string): Promise<DebugCheckResult> {
  const { jid: selectedJid, group } = resolveDebugGroup(jid);
  const { value, durationMs } = await timed(() =>
    runSmokePrompt({
      jid: selectedJid,
      group,
      prompt: 'What are the latest Qwen3 updates?',
    }),
  );
  const text = value.detail;
  return {
    key: 'smoke_web_lookup',
    ok:
      value.ok &&
      !looksBadUserFacingReply(text) &&
      text.trim().length > 30 &&
      !/runtime issue|retry in a moment/i.test(text),
    detail: value.ok ? `reply="${text.slice(0, 180)}"` : text,
    durationMs,
  };
}

function runCommandCheck(input: {
  key: string;
  args: string[];
  okDetail: string;
}): DebugCheckResult {
  const startedAt = Date.now();
  const npm = npmRunArgs(input.args);
  const result = spawnSync(npm.command, npm.finalArgs, {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: false,
  });
  const detail =
    result.status === 0
      ? input.okDetail
      : (result.stderr || result.stdout || `Exited with ${result.status}`)
          .trim()
          .slice(0, 240);
  return {
    key: input.key,
    ok: result.status === 0,
    detail,
    durationMs: Date.now() - startedAt,
  };
}

async function runWebProbeCheck(): Promise<DebugCheckResult> {
  const startedAt = Date.now();
  const result = spawnSync(
    process.execPath,
    [
      './node_modules/tsx/dist/cli.mjs',
      'scripts/probe-web.ts',
      'latest qwen3 updates',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      shell: false,
    },
  );

  if (result.status !== 0) {
    return {
      key: 'probe_web',
      ok: false,
      detail: (result.stderr || result.stdout || `Exited with ${result.status}`)
        .trim()
        .slice(0, 240),
      durationMs: Date.now() - startedAt,
    };
  }

  const match = (result.stdout || '').match(/\{[\s\S]*\}/);
  let preview = '';
  try {
    const parsed = JSON.parse(match?.[0] || '{}') as {
      preview?: string;
      ok?: boolean;
    };
    preview = parsed.preview || '';
    return {
      key: 'probe_web',
      ok: parsed.ok === true && !looksBadUserFacingReply(preview),
      detail: preview
        ? `preview="${preview.slice(0, 180)}"`
        : 'Web probe passed',
      durationMs: Date.now() - startedAt,
    };
  } catch {
    return {
      key: 'probe_web',
      ok: false,
      detail: 'Failed to parse probe:web output',
      durationMs: Date.now() - startedAt,
    };
  }
}

function recentRuntimeErrorCheck(): DebugCheckResult {
  const startedAt = Date.now();
  const logFile = path.join(LOG_DIR, 'microclaw.log');
  if (!fs.existsSync(logFile)) {
    return {
      key: 'recent_runtime_errors',
      ok: true,
      detail: 'No log file found yet',
      durationMs: Date.now() - startedAt,
    };
  }
  const cutoff = Date.now() - 15 * 60_000;
  const tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-400);
  const recentLines = tail.filter((line) => {
    try {
      const parsed = JSON.parse(line) as { time?: number };
      return typeof parsed.time === 'number' && parsed.time >= cutoff;
    } catch {
      return false;
    }
  });
  const recentBlob = recentLines.join('\n');
  const hasRecentFailure =
    /runtime issue while processing that request|Request timeout after .*chat\/completions|Agent error with no output/i.test(
      recentBlob,
    );
  return {
    key: 'recent_runtime_errors',
    ok: !hasRecentFailure,
    detail: hasRecentFailure
      ? 'Recent runtime timeout/error detected in last 15 minutes of logs'
      : 'No recent runtime timeout/error signatures in last 15 minutes of logs',
    durationMs: Date.now() - startedAt,
  };
}

export async function collectDebugReport(input?: {
  jid?: string;
  skipHeavy?: boolean;
}): Promise<DebugReport> {
  initDatabase();
  const { jid, group } = resolveDebugGroup(input?.jid);

  const items: DebugCheckResult[] = [];
  items.push(await runLaunchCheckDebug());
  items.push(await runNeutralSmokeCheck(jid));
  items.push(await runWebSmokeCheck(jid));
  items.push(await runWebProbeCheck());
  items.push(recentRuntimeErrorCheck());

  if (!input?.skipHeavy) {
    items.push(
      runCommandCheck({
        key: 'typecheck',
        args: ['run', 'typecheck'],
        okDetail: 'TypeScript typecheck passed',
      }),
    );
    items.push(
      runCommandCheck({
        key: 'tests_root',
        args: [
          'run',
          'test',
          '--',
          'src/continuity.test.ts',
          'src/db.test.ts',
          'src/routing.test.ts',
          'container/agent-runner/src/runtime/openai.test.ts',
          'container/agent-runner/src/tools/web/actions.test.ts',
        ],
        okDetail: 'Targeted runtime/web/continuity tests passed',
      }),
    );
    items.push(
      runCommandCheck({
        key: 'build_root',
        args: ['run', 'build'],
        okDetail: 'Root build passed',
      }),
    );
    items.push(
      runCommandCheck({
        key: 'build_agent_runner',
        args: ['--prefix', 'container/agent-runner', 'run', 'build'],
        okDetail: 'Agent runner build passed',
      }),
    );
  }

  const failedKeys = items.filter((item) => !item.ok).map((item) => item.key);

  const selection = resolveRuntimeSelection(group.folder);
  return {
    pass: failedKeys.length === 0,
    checkedAt: new Date().toISOString(),
    groupJid: jid,
    runtimeProfileId: selection.profiles[0]?.id,
    items,
    failedKeys,
  };
}

export function printDebugReport(report: DebugReport): void {
  console.log(report.pass ? 'Debug: pass' : 'Debug: failures detected');
  if (report.groupJid) console.log(`group=${report.groupJid}`);
  if (report.runtimeProfileId)
    console.log(`runtime=${report.runtimeProfileId}`);
  for (const item of report.items) {
    console.log(
      `${item.ok ? '[OK]' : '[FAIL]'} ${item.key} (${item.durationMs}ms) - ${item.detail}`,
    );
  }
}

export function debugHelpersForTest(): {
  looksBadUserFacingReply: (text: string) => boolean;
  looksExactSmokeReply: (text: string) => boolean;
} {
  return {
    looksBadUserFacingReply,
    looksExactSmokeReply,
  };
}
