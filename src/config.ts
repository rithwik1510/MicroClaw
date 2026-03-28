import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'NANOCLAW_POLL_INTERVAL_MS',
  'NANOCLAW_IPC_POLL_INTERVAL_MS',
  'ONECLI_URL',
  'TZ',
]);

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = parsePositiveInt(
  process.env.NANOCLAW_POLL_INTERVAL_MS || envConfig.NANOCLAW_POLL_INTERVAL_MS,
  400,
);
export const SCHEDULER_POLL_INTERVAL = 60000;
export const HEARTBEAT_POLL_INTERVAL = 60000;
export const HEARTBEAT_INTERVAL = parseInt(
  process.env.HEARTBEAT_INTERVAL || '1800000',
  10,
);
export const HEARTBEAT_TIMEOUT = parseInt(
  process.env.HEARTBEAT_TIMEOUT || '180000',
  10,
);
export const HEARTBEAT_MIN_GAP = parseInt(
  process.env.HEARTBEAT_MIN_GAP || '600000',
  10,
);

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'microclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const LOG_DIR = path.resolve(PROJECT_ROOT, 'logs');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'microclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL =
  process.env.ONECLI_URL || envConfig.ONECLI_URL || 'http://localhost:10254';
export const IPC_POLL_INTERVAL = parsePositiveInt(
  process.env.NANOCLAW_IPC_POLL_INTERVAL_MS ||
    envConfig.NANOCLAW_IPC_POLL_INTERVAL_MS,
  150,
);
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

// Warm session reuse for OpenAI-compatible providers.
// When enabled, the native agent process stays alive between follow-up messages
// instead of spawning a new process and rebuilding full context on every turn.
// Set OPENAI_WARM_SESSIONS=false to revert to single-turn stateless mode.
export const OPENAI_WARM_SESSIONS =
  process.env.OPENAI_WARM_SESSIONS !== 'false';

// How long to keep a warm OpenAI-compatible session alive after the last turn.
// Shorter than IDLE_TIMEOUT because native processes don't need long persistence.
export const OPENAI_SESSION_IDLE_TIMEOUT_MS = parsePositiveInt(
  process.env.OPENAI_SESSION_IDLE_TIMEOUT_MS,
  120_000, // 2 minutes
);

// Workload lane separation: interactive (user messages) vs background (heartbeats, tasks).
// Interactive messages always get priority access to container slots.
export const MAX_INTERACTIVE_CONTAINERS = Math.max(
  1,
  parsePositiveInt(
    process.env.MAX_INTERACTIVE_CONTAINERS,
    Math.max(1, MAX_CONCURRENT_CONTAINERS - 1),
  ),
);
export const MAX_BACKGROUND_CONTAINERS = Math.max(
  1,
  parsePositiveInt(process.env.MAX_BACKGROUND_CONTAINERS, 2),
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
