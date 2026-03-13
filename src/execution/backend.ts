import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ContainerInput,
  ContainerOutput,
  readSecretsForAgent,
  runContainerAgent,
} from '../container-runner.js';
import { CONTAINER_MAX_OUTPUT_SIZE, TIMEZONE } from '../config.js';
import { ensureContainerRuntimeRunning } from '../container-runtime.js';
import { readEnvFile } from '../env.js';
import {
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from '../group-folder.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const DEFAULT_NATIVE_AGENT_TIMEOUT_MS = 180_000;
const MIN_NATIVE_AGENT_TIMEOUT_MS = 30_000;
const backendEnv = readEnvFile(['NATIVE_AGENT_TIMEOUT_MS']);

export interface AgentRunnerCallbacks {
  onProcess: (proc: ChildProcess, containerName: string) => void;
  onOutput?: (output: ContainerOutput) => Promise<void>;
}

export type ExecutionBackend = 'native' | 'docker';

const NATIVE_RUNNER_PATH = path.join(
  process.cwd(),
  'container',
  'agent-runner',
  'dist',
  'index.js',
);

function resolveExecutionBackend(input: ContainerInput): ExecutionBackend {
  const forced = process.env.NANOCLAW_EXECUTION_BACKEND?.trim().toLowerCase();
  if (forced === 'docker' || forced === 'native') {
    return forced;
  }

  const provider = input.runtimeConfig?.provider || 'openai_compatible';
  if (provider === 'claude') {
    return 'docker';
  }
  return 'native';
}

export function resolveExecutionBackendForProvider(
  provider: string,
): ExecutionBackend {
  return resolveExecutionBackend({
    prompt: '',
    groupFolder: '__probe__',
    chatJid: '__probe__',
    isMain: true,
    assistantName: 'MicroClaw',
    runtimeConfig: {
      provider: provider as 'claude' | 'openai_compatible',
      model: 'probe',
    },
  });
}

export function probeExecutionBackend(backend: ExecutionBackend): {
  ok: boolean;
  detail: string;
} {
  if (backend === 'native') {
    if (fs.existsSync(NATIVE_RUNNER_PATH)) {
      return {
        ok: true,
        detail: `native runner ready (${NATIVE_RUNNER_PATH})`,
      };
    }
    return {
      ok: false,
      detail:
        'native runner missing (build container/agent-runner with `npm run build`)',
    };
  }

  try {
    ensureContainerRuntimeRunning();
    return { ok: true, detail: 'docker runtime reachable' };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function normalizeLocalBaseUrlForNative(
  raw: string | undefined,
): string | undefined {
  if (!raw) return raw;
  return raw.replace(/host\.docker\.internal/gi, '127.0.0.1');
}

function normalizeInputForNative(input: ContainerInput): ContainerInput {
  const runtimeConfig = input.runtimeConfig
    ? {
        ...input.runtimeConfig,
        baseUrl: normalizeLocalBaseUrlForNative(input.runtimeConfig.baseUrl),
      }
    : undefined;
  const secrets = { ...(input.secrets || {}) };
  if (secrets.OPENAI_BASE_URL) {
    secrets.OPENAI_BASE_URL = normalizeLocalBaseUrlForNative(
      secrets.OPENAI_BASE_URL,
    ) as string;
  }
  return {
    ...input,
    runtimeConfig,
    secrets,
  };
}

function buildNativeRunnerEnv(group: RegisteredGroup): Record<string, string> {
  const ipcDir = resolveGroupIpcPath(group.folder);
  const inputDir = path.join(ipcDir, 'input');
  fs.mkdirSync(inputDir, { recursive: true });
  const groupWorkspaceDir = resolveGroupFolderPath(group.folder);
  return {
    ...process.env,
    NANOCLAW_IPC_INPUT_DIR: inputDir,
    NANOCLAW_GROUP_WORKSPACE_DIR: groupWorkspaceDir,
    NANOCLAW_GROUP_FOLDER: group.folder,
    NANOCLAW_TIMEZONE: TIMEZONE,
  } as Record<string, string>;
}

async function runNativeAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  callbacks: AgentRunnerCallbacks,
): Promise<ContainerOutput> {
  const nativeInput = normalizeInputForNative(input);
  const startTime = Date.now();
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const procName = `microclaw-native-${safeName}-${Date.now()}`;
  const runnerPath = NATIVE_RUNNER_PATH;

  if (!fs.existsSync(runnerPath)) {
    return {
      status: 'error',
      result: null,
      error:
        'Native agent-runner is not built. Run `npm run build` in container/agent-runner first.',
    };
  }

  logger.info(
    { group: group.name, containerName: procName, mode: 'native' },
    'Spawning native agent',
  );

  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [runnerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildNativeRunnerEnv(group),
    });

    callbacks.onProcess(proc, procName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let hadStreamingOutput = false;
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    nativeInput.secrets = {
      ...readSecretsForAgent(),
      NANOCLAW_GROUP_FOLDER: nativeInput.groupFolder,
      NANOCLAW_CHAT_JID: nativeInput.chatJid,
      NANOCLAW_TIMEZONE: TIMEZONE,
      ...(nativeInput.secrets || {}),
    };
    proc.stdin.write(JSON.stringify(nativeInput));
    proc.stdin.end();
    delete nativeInput.secrets;

    const envNativeTimeout = Number.parseInt(
      process.env.NATIVE_AGENT_TIMEOUT_MS ||
        backendEnv.NATIVE_AGENT_TIMEOUT_MS ||
        '',
      10,
    );
    const configuredNativeTimeout =
      Number.isFinite(envNativeTimeout) && envNativeTimeout > 0
        ? envNativeTimeout
        : DEFAULT_NATIVE_AGENT_TIMEOUT_MS;
    // Native mode should fail fast on stuck calls; keep this independent from
    // long idle container lifetimes used by docker mode.
    const timeoutMs = Math.max(
      MIN_NATIVE_AGENT_TIMEOUT_MS,
      Math.min(
        group.containerConfig?.timeout || configuredNativeTimeout,
        configuredNativeTimeout,
      ),
    );
    let timeout = setTimeout(() => {
      timedOut = true;
      logger.warn(
        { group: group.name, procName, timeoutMs },
        'Native agent timed out, forcing process termination',
      );
      proc.kill('SIGKILL');
    }, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, timeoutMs);
    };

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
        } else {
          stdout += chunk;
        }
      }

      if (!callbacks.onOutput) return;
      parseBuffer += chunk;
      let startIdx: number;
      while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
        const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
        if (endIdx === -1) break;
        const jsonStr = parseBuffer
          .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
          .trim();
        parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);
        try {
          const parsed = JSON.parse(jsonStr) as ContainerOutput;
          if (parsed.newSessionId) newSessionId = parsed.newSessionId;
          const hasMeaningfulText =
            typeof parsed.result === 'string' &&
            parsed.result.trim().length > 0;
          if (hasMeaningfulText) {
            hadStreamingOutput = true;
            resetTimeout();
          }
          outputChain = outputChain.then(() => callbacks.onOutput!(parsed));
        } catch (err) {
          logger.warn(
            { group: group.name, err },
            'Failed to parse streamed native output chunk',
          );
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      if (!stderrTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
        if (chunk.length > remaining) {
          stderr += chunk.slice(0, remaining);
          stderrTruncated = true;
        } else {
          stderr += chunk;
        }
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;
      if (stderr.trim()) {
        logger.info(
          {
            group: group.name,
            duration,
            stderr: stderr.slice(-2000),
          },
          'Native agent stderr',
        );
      }
      if (timedOut) {
        resolve({
          status: 'error',
          result: null,
          newSessionId,
          error: `Native agent timed out after ${timeoutMs}ms`,
        });
        return;
      }

      if (code !== 0) {
        resolve({
          status: 'error',
          result: null,
          error: `Native agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      if (callbacks.onOutput) {
        outputChain.then(() =>
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          }),
        );
        return;
      }

      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);
        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1] || '';
        }
        const output = JSON.parse(jsonLine) as ContainerOutput;
        logger.info(
          { group: group.name, duration, status: output.status },
          'Native agent completed',
        );
        resolve(output);
      } catch (err) {
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse native agent output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        status: 'error',
        result: null,
        error: `Native agent spawn error: ${err.message}`,
      });
    });
  });
}

export async function runAgentProcess(
  group: RegisteredGroup,
  input: ContainerInput,
  callbacks: AgentRunnerCallbacks,
): Promise<ContainerOutput> {
  const backend = resolveExecutionBackend(input);
  logger.info(
    {
      group: group.name,
      chatJid: input.chatJid,
      provider: input.runtimeConfig?.provider,
      backend,
    },
    'Execution backend selected',
  );
  if (backend === 'docker') {
    ensureContainerRuntimeRunning();
    return runContainerAgent(
      group,
      input,
      callbacks.onProcess,
      callbacks.onOutput,
    );
  }
  return runNativeAgent(group, input, callbacks);
}
