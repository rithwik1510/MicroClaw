import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  AuthProfile,
  BrowserActionAuditEntry,
  GroupRuntimePolicy,
  LocalEndpointProfile,
  NewMessage,
  ProviderCapability,
  RegisteredGroup,
  RuntimeEvent,
  RuntimeUsageLog,
  RuntimeProfile,
  ScheduledTask,
  ConversationSummary,
  ToolServiceProfile,
  ToolServiceState,
  TaskRunLog,
  HeartbeatRunLog,
  WizardSessionState,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      requested_prompt TEXT,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS heartbeat_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      actions_taken TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_heartbeat_logs_group
      ON heartbeat_run_logs(group_folder, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      group_folder TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      source_message_count INTEGER NOT NULL DEFAULT 0,
      last_message_timestamp TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS runtime_profiles (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      base_url TEXT,
      endpoint_kind TEXT,
      auth_profile_id TEXT,
      enabled INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 100,
      cost_tier TEXT,
      auth_env_var TEXT,
      tool_policy TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_profiles_enabled_priority
      ON runtime_profiles(enabled, priority);

    CREATE TABLE IF NOT EXISTS group_runtime_policies (
      group_folder TEXT PRIMARY KEY,
      primary_profile_id TEXT NOT NULL,
      fallback_profile_ids TEXT,
      retry_policy TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_events (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_events_ts
      ON runtime_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_runtime_events_group_ts
      ON runtime_events(group_folder, timestamp);

    CREATE TABLE IF NOT EXISTS runtime_usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      profile_id TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      trigger_kind TEXT NOT NULL,
      started_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      usage_source TEXT NOT NULL,
      request_count INTEGER,
      input_cost_usd REAL NOT NULL,
      output_cost_usd REAL NOT NULL,
      total_cost_usd REAL NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_usage_logs_group_ts
      ON runtime_usage_logs(group_folder, created_at);
    CREATE INDEX IF NOT EXISTS idx_runtime_usage_logs_trigger_ts
      ON runtime_usage_logs(trigger_kind, created_at);

    CREATE TABLE IF NOT EXISTS browser_action_audit (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      session_id TEXT,
      owner_group_folder TEXT NOT NULL,
      owner_chat_jid TEXT NOT NULL,
      owner_task_id TEXT,
      owner_role TEXT NOT NULL,
      permission_tier TEXT NOT NULL,
      approval_required INTEGER NOT NULL DEFAULT 0,
      approved INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL,
      outcome TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_browser_action_audit_ts
      ON browser_action_audit(timestamp);
    CREATE INDEX IF NOT EXISTS idx_browser_action_audit_group_ts
      ON browser_action_audit(owner_group_folder, timestamp);

    CREATE TABLE IF NOT EXISTS auth_profiles (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      account_label TEXT,
      scopes TEXT,
      expires_at TEXT,
      provider_account_id TEXT,
      refresh_eligible INTEGER DEFAULT 0,
      token_type TEXT,
      risk_level TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_profiles_provider_status
      ON auth_profiles(provider, status);

    CREATE TABLE IF NOT EXISTS local_endpoint_profiles (
      id TEXT PRIMARY KEY,
      engine TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key_mode TEXT NOT NULL,
      container_reachable_url TEXT NOT NULL,
      health_status TEXT NOT NULL,
      last_checked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_local_endpoint_health
      ON local_endpoint_profiles(health_status, updated_at);

    CREATE TABLE IF NOT EXISTS provider_capabilities_cache (
      cache_key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      base_url TEXT,
      capability_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_service_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      base_url TEXT,
      health_path TEXT,
      enabled INTEGER DEFAULT 1,
      startup_mode TEXT NOT NULL DEFAULT 'auto',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_service_state (
      service_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      last_probe_at TEXT,
      last_probe_detail TEXT,
      restart_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (service_id) REFERENCES tool_service_profiles(id)
    );

    CREATE TABLE IF NOT EXISTS wizard_sessions (
      session_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      current_step TEXT NOT NULL,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wizard_sessions_status_updated
      ON wizard_sessions(status, updated_at);

    CREATE TABLE IF NOT EXISTS auth_refresh_locks (
      auth_profile_id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN requested_prompt TEXT`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // Runtime profile migrations for auth/local endpoint support
  try {
    database.exec(`ALTER TABLE runtime_profiles ADD COLUMN endpoint_kind TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE runtime_profiles ADD COLUMN auth_profile_id TEXT`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(`ALTER TABLE runtime_profiles ADD COLUMN tool_policy TEXT`);
  } catch {
    /* column already exists */
  }

  // Auth profile metadata extensions
  try {
    database.exec(
      `ALTER TABLE auth_profiles ADD COLUMN provider_account_id TEXT`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE auth_profiles ADD COLUMN refresh_eligible INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(`ALTER TABLE auth_profiles ADD COLUMN token_type TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    database.exec(`ALTER TABLE auth_profiles ADD COLUMN risk_level TEXT`);
  } catch {
    /* column already exists */
  }

  // Memory entries table + FTS5 index for retrieval-based context
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'group',
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      content_normalized TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'auto',
      origin TEXT NOT NULL DEFAULT 'conversation',
      durability TEXT NOT NULL DEFAULT 'durable',
      confidence REAL NOT NULL DEFAULT 0.7,
      created_at TEXT NOT NULL,
      last_confirmed_at TEXT,
      superseded_at TEXT,
      source_file TEXT,
      pinned INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_memory_entries_group
      ON memory_entries(group_folder, scope);
    CREATE INDEX IF NOT EXISTS idx_memory_entries_pinned
      ON memory_entries(group_folder, pinned)
      WHERE pinned = 1;
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      content,
      kind,
      content='memory_entries',
      content_rowid='id',
      tokenize='porter unicode61'
    );
  `);

  // FTS5 sync triggers (IF NOT EXISTS requires SQLite >= 3.35, bundled with better-sqlite3 v11)
  try {
    database.exec(`
      CREATE TRIGGER memory_fts_ai AFTER INSERT ON memory_entries BEGIN
        INSERT INTO memory_fts(rowid, content, kind)
        VALUES (new.id, new.content, new.kind);
      END;
    `);
  } catch {
    /* trigger already exists */
  }
  try {
    database.exec(`
      CREATE TRIGGER memory_fts_ad AFTER DELETE ON memory_entries BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, content, kind)
        VALUES ('delete', old.id, old.content, old.kind);
      END;
    `);
  } catch {
    /* trigger already exists */
  }
  try {
    database.exec(`
      CREATE TRIGGER memory_fts_au AFTER UPDATE ON memory_entries BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, content, kind)
        VALUES ('delete', old.id, old.content, old.kind);
        INSERT INTO memory_fts(rowid, content, kind)
        VALUES (new.id, new.content, new.kind);
      END;
    `);
  } catch {
    /* trigger already exists */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Add pinned column to memory_entries for existing databases
  try {
    db.exec(
      `ALTER TABLE memory_entries ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }
  try {
    db.exec(
      `ALTER TABLE memory_entries ADD COLUMN origin TEXT NOT NULL DEFAULT 'conversation'`,
    );
  } catch {
    /* column already exists */
  }
  try {
    db.exec(
      `ALTER TABLE memory_entries ADD COLUMN durability TEXT NOT NULL DEFAULT 'durable'`,
    );
  } catch {
    /* column already exists */
  }
  try {
    db.exec(
      `ALTER TABLE memory_entries ADD COLUMN confidence REAL NOT NULL DEFAULT 0.7`,
    );
  } catch {
    /* column already exists */
  }
  try {
    db.exec(`ALTER TABLE memory_entries ADD COLUMN last_confirmed_at TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    db.exec(`ALTER TABLE memory_entries ADD COLUMN superseded_at TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memory_entries_active
       ON memory_entries(group_folder, kind, superseded_at)`,
    );
  } catch {
    /* index already exists */
  }
  try {
    db.exec(
      `UPDATE memory_entries
       SET origin = CASE source
         WHEN 'explicit' THEN 'explicit_request'
         WHEN 'migration' THEN 'migration'
         ELSE 'conversation'
       END
       WHERE origin IS NULL OR origin = ''`,
    );
  } catch {
    /* best effort backfill */
  }
  try {
    db.exec(
      `UPDATE memory_entries
       SET durability = CASE
         WHEN pinned = 1 THEN 'pinned'
         WHEN source = 'migration' THEN 'durable'
         ELSE 'durable'
       END
       WHERE durability IS NULL OR durability = ''`,
    );
  } catch {
    /* best effort backfill */
  }
  try {
    db.exec(
      `UPDATE memory_entries
       SET last_confirmed_at = created_at
       WHERE last_confirmed_at IS NULL`,
    );
  } catch {
    /* best effort backfill */
  }

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function getRecentMessages(chatJid: string, limit = 16): NewMessage[] {
  const boundedLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const rows = db
    .prepare(
      `
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
      FROM messages
      WHERE chat_jid = ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    `,
    )
    .all(chatJid, boundedLimit) as NewMessage[];

  return rows.reverse();
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, requested_prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.requested_prompt || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

export function logHeartbeatRun(log: HeartbeatRunLog): void {
  db.prepare(
    `
    INSERT INTO heartbeat_run_logs (
      group_folder,
      chat_jid,
      run_at,
      duration_ms,
      status,
      actions_taken,
      error
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.group_folder,
    log.chat_jid,
    log.run_at,
    log.duration_ms,
    log.status,
    log.actions_taken,
    log.error,
  );
}

export function getLastHeartbeatRun(
  groupFolder: string,
): HeartbeatRunLog | undefined {
  return db
    .prepare(
      `
      SELECT group_folder, chat_jid, run_at, duration_ms, status, actions_taken, error
      FROM heartbeat_run_logs
      WHERE group_folder = ?
      ORDER BY run_at DESC
      LIMIT 1
    `,
    )
    .get(groupFolder) as HeartbeatRunLog | undefined;
}

export function getRecentTaskFailuresForGroup(
  groupFolder: string,
  sinceIso?: string,
  limit = 5,
): Array<{
  task_id: string;
  prompt: string;
  run_at: string;
  error: string | null;
}> {
  const boundedLimit = Math.max(1, Math.min(20, Math.floor(limit)));
  if (sinceIso) {
    return db
      .prepare(
        `
        SELECT l.task_id, t.prompt, l.run_at, l.error
        FROM task_run_logs l
        JOIN scheduled_tasks t ON t.id = l.task_id
        WHERE t.group_folder = ? AND l.status = 'error' AND l.run_at > ?
        ORDER BY l.run_at DESC
        LIMIT ?
      `,
      )
      .all(groupFolder, sinceIso, boundedLimit) as Array<{
      task_id: string;
      prompt: string;
      run_at: string;
      error: string | null;
    }>;
  }

  return db
    .prepare(
      `
      SELECT l.task_id, t.prompt, l.run_at, l.error
      FROM task_run_logs l
      JOIN scheduled_tasks t ON t.id = l.task_id
      WHERE t.group_folder = ? AND l.status = 'error'
      ORDER BY l.run_at DESC
      LIMIT ?
    `,
    )
    .all(groupFolder, boundedLimit) as Array<{
    task_id: string;
    prompt: string;
    run_at: string;
    error: string | null;
  }>;
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

export function getConversationSummary(
  groupFolder: string,
): ConversationSummary | undefined {
  const row = db
    .prepare(
      `SELECT group_folder, summary, source_message_count, last_message_timestamp, updated_at
       FROM conversation_summaries
       WHERE group_folder = ?`,
    )
    .get(groupFolder) as
    | {
        group_folder: string;
        summary: string;
        source_message_count: number;
        last_message_timestamp: string | null;
        updated_at: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    groupFolder: row.group_folder,
    summary: row.summary,
    sourceMessageCount: row.source_message_count,
    lastMessageTimestamp: row.last_message_timestamp || undefined,
    updatedAt: row.updated_at,
  };
}

export function setConversationSummary(input: {
  groupFolder: string;
  summary: string;
  sourceMessageCount: number;
  lastMessageTimestamp?: string;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO conversation_summaries
      (group_folder, summary, source_message_count, last_message_timestamp, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    input.groupFolder,
    input.summary,
    input.sourceMessageCount,
    input.lastMessageTimestamp || null,
    now,
  );
}

// --- Runtime profile accessors ---

interface RuntimeProfileRow {
  id: string;
  provider: string;
  model: string;
  base_url: string | null;
  endpoint_kind: string | null;
  auth_profile_id: string | null;
  enabled: number;
  priority: number;
  cost_tier: string | null;
  auth_env_var: string | null;
  tool_policy: string | null;
  created_at: string;
  updated_at: string;
}

function mapRuntimeProfileRow(row: RuntimeProfileRow): RuntimeProfile {
  return {
    id: row.id,
    provider: row.provider as RuntimeProfile['provider'],
    model: row.model,
    baseUrl: row.base_url || undefined,
    endpointKind:
      (row.endpoint_kind as RuntimeProfile['endpointKind']) || undefined,
    authProfileId: row.auth_profile_id || undefined,
    enabled: row.enabled === 1,
    priority: row.priority,
    costTier: row.cost_tier || undefined,
    authEnvVar: row.auth_env_var || undefined,
    toolPolicy: row.tool_policy ? JSON.parse(row.tool_policy) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getRuntimeProfile(id: string): RuntimeProfile | undefined {
  const row = db
    .prepare('SELECT * FROM runtime_profiles WHERE id = ?')
    .get(id) as RuntimeProfileRow | undefined;
  return row ? mapRuntimeProfileRow(row) : undefined;
}

export function getAllRuntimeProfiles(): RuntimeProfile[] {
  const rows = db
    .prepare(
      'SELECT * FROM runtime_profiles ORDER BY enabled DESC, priority ASC',
    )
    .all() as RuntimeProfileRow[];
  return rows.map(mapRuntimeProfileRow);
}

export function setRuntimeProfile(
  profile: Omit<RuntimeProfile, 'createdAt' | 'updatedAt'> & {
    createdAt?: string;
    updatedAt?: string;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT OR REPLACE INTO runtime_profiles
      (id, provider, model, base_url, endpoint_kind, auth_profile_id, enabled, priority, cost_tier, auth_env_var, tool_policy, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM runtime_profiles WHERE id = ?), ?), ?)
  `,
  ).run(
    profile.id,
    profile.provider,
    profile.model,
    profile.baseUrl || null,
    profile.endpointKind || null,
    profile.authProfileId || null,
    profile.enabled ? 1 : 0,
    profile.priority,
    profile.costTier || null,
    profile.authEnvVar || null,
    profile.toolPolicy ? JSON.stringify(profile.toolPolicy) : null,
    profile.id,
    profile.createdAt || now,
    profile.updatedAt || now,
  );
}

export function deleteRuntimeProfile(id: string): void {
  db.prepare('DELETE FROM runtime_profiles WHERE id = ?').run(id);
}

interface GroupRuntimePolicyRow {
  group_folder: string;
  primary_profile_id: string;
  fallback_profile_ids: string | null;
  retry_policy: string | null;
  updated_at: string;
}

function mapGroupRuntimePolicyRow(
  row: GroupRuntimePolicyRow,
): GroupRuntimePolicy {
  return {
    groupFolder: row.group_folder,
    primaryProfileId: row.primary_profile_id,
    fallbackProfileIds: row.fallback_profile_ids
      ? JSON.parse(row.fallback_profile_ids)
      : [],
    retryPolicy: row.retry_policy ? JSON.parse(row.retry_policy) : undefined,
    updatedAt: row.updated_at,
  };
}

export function getGroupRuntimePolicy(
  groupFolder: string,
): GroupRuntimePolicy | undefined {
  const row = db
    .prepare('SELECT * FROM group_runtime_policies WHERE group_folder = ?')
    .get(groupFolder) as GroupRuntimePolicyRow | undefined;
  return row ? mapGroupRuntimePolicyRow(row) : undefined;
}

export function getAllGroupRuntimePolicies(): GroupRuntimePolicy[] {
  const rows = db
    .prepare('SELECT * FROM group_runtime_policies ORDER BY group_folder ASC')
    .all() as GroupRuntimePolicyRow[];
  return rows.map(mapGroupRuntimePolicyRow);
}

export function setGroupRuntimePolicy(
  policy: Omit<GroupRuntimePolicy, 'updatedAt'> & { updatedAt?: string },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT OR REPLACE INTO group_runtime_policies
      (group_folder, primary_profile_id, fallback_profile_ids, retry_policy, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(
    policy.groupFolder,
    policy.primaryProfileId,
    JSON.stringify(policy.fallbackProfileIds || []),
    policy.retryPolicy ? JSON.stringify(policy.retryPolicy) : null,
    policy.updatedAt || now,
  );
}

export function deleteGroupRuntimePolicy(groupFolder: string): void {
  db.prepare('DELETE FROM group_runtime_policies WHERE group_folder = ?').run(
    groupFolder,
  );
}

interface RuntimeEventRow {
  id: string;
  group_folder: string;
  chat_jid: string;
  profile_id: string;
  provider: string;
  event_type: string;
  message: string;
  timestamp: string;
}

function mapRuntimeEventRow(row: RuntimeEventRow): RuntimeEvent {
  return {
    id: row.id,
    groupFolder: row.group_folder,
    chatJid: row.chat_jid,
    profileId: row.profile_id,
    provider: row.provider as RuntimeEvent['provider'],
    eventType: row.event_type as RuntimeEvent['eventType'],
    message: row.message,
    timestamp: row.timestamp,
  };
}

export function logRuntimeEvent(event: RuntimeEvent): void {
  db.prepare(
    `
    INSERT OR REPLACE INTO runtime_events
      (id, group_folder, chat_jid, profile_id, provider, event_type, message, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    event.id,
    event.groupFolder,
    event.chatJid,
    event.profileId,
    event.provider,
    event.eventType,
    event.message,
    event.timestamp,
  );
}

export function getRuntimeEvents(
  groupFolder?: string,
  limit = 50,
): RuntimeEvent[] {
  if (groupFolder) {
    const rows = db
      .prepare(
        `
        SELECT * FROM runtime_events
        WHERE group_folder = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `,
      )
      .all(groupFolder, limit) as RuntimeEventRow[];
    return rows.map(mapRuntimeEventRow);
  }

  const rows = db
    .prepare(
      `
      SELECT * FROM runtime_events
      ORDER BY timestamp DESC
      LIMIT ?
    `,
    )
    .all(limit) as RuntimeEventRow[];
  return rows.map(mapRuntimeEventRow);
}

interface BrowserActionAuditRow {
  id: string;
  action: string;
  session_id: string | null;
  owner_group_folder: string;
  owner_chat_jid: string;
  owner_task_id: string | null;
  owner_role: string;
  permission_tier: string;
  approval_required: number;
  approved: number;
  summary: string;
  outcome: string;
  timestamp: string;
}

function mapBrowserActionAuditRow(
  row: BrowserActionAuditRow,
): BrowserActionAuditEntry {
  return {
    id: row.id,
    action: row.action,
    sessionId: row.session_id || undefined,
    owner: {
      groupFolder: row.owner_group_folder,
      chatJid: row.owner_chat_jid,
      taskId: row.owner_task_id || undefined,
      role: row.owner_role,
    },
    permissionTier:
      row.permission_tier as BrowserActionAuditEntry['permissionTier'],
    approvalRequired: row.approval_required === 1,
    approved: row.approved === 1,
    summary: row.summary,
    outcome: row.outcome as BrowserActionAuditEntry['outcome'],
    timestamp: row.timestamp,
  };
}

export function logBrowserActionAudit(entry: BrowserActionAuditEntry): void {
  db.prepare(
    `
    INSERT OR REPLACE INTO browser_action_audit
      (id, action, session_id, owner_group_folder, owner_chat_jid, owner_task_id, owner_role, permission_tier, approval_required, approved, summary, outcome, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    entry.id,
    entry.action,
    entry.sessionId || null,
    entry.owner.groupFolder,
    entry.owner.chatJid,
    entry.owner.taskId || null,
    entry.owner.role,
    entry.permissionTier,
    entry.approvalRequired ? 1 : 0,
    entry.approved ? 1 : 0,
    entry.summary,
    entry.outcome,
    entry.timestamp,
  );
}

export function getBrowserActionAudit(
  groupFolder?: string,
  limit = 50,
): BrowserActionAuditEntry[] {
  const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  if (groupFolder) {
    const rows = db
      .prepare(
        `
        SELECT * FROM browser_action_audit
        WHERE owner_group_folder = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `,
      )
      .all(groupFolder, boundedLimit) as BrowserActionAuditRow[];
    return rows.map(mapBrowserActionAuditRow);
  }

  const rows = db
    .prepare(
      `
      SELECT * FROM browser_action_audit
      ORDER BY timestamp DESC
      LIMIT ?
    `,
    )
    .all(boundedLimit) as BrowserActionAuditRow[];
  return rows.map(mapBrowserActionAuditRow);
}

// --- Auth profile accessors ---

interface AuthProfileRow {
  id: string;
  provider: string;
  credential_type: string;
  account_label: string | null;
  scopes: string | null;
  expires_at: string | null;
  provider_account_id: string | null;
  refresh_eligible: number | null;
  token_type: string | null;
  risk_level: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function mapAuthProfileRow(row: AuthProfileRow): AuthProfile {
  return {
    id: row.id,
    provider: row.provider as AuthProfile['provider'],
    credentialType: row.credential_type as AuthProfile['credentialType'],
    accountLabel: row.account_label || undefined,
    scopes: row.scopes ? JSON.parse(row.scopes) : undefined,
    expiresAt: row.expires_at || undefined,
    providerAccountId: row.provider_account_id || undefined,
    refreshEligible:
      row.refresh_eligible === null ? undefined : row.refresh_eligible === 1,
    tokenType: row.token_type || undefined,
    riskLevel: (row.risk_level as AuthProfile['riskLevel']) || undefined,
    status: row.status as AuthProfile['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getAuthProfile(id: string): AuthProfile | undefined {
  const row = db.prepare('SELECT * FROM auth_profiles WHERE id = ?').get(id) as
    | AuthProfileRow
    | undefined;
  return row ? mapAuthProfileRow(row) : undefined;
}

export function getAllAuthProfiles(): AuthProfile[] {
  const rows = db
    .prepare('SELECT * FROM auth_profiles ORDER BY updated_at DESC')
    .all() as AuthProfileRow[];
  return rows.map(mapAuthProfileRow);
}

export function setAuthProfile(
  profile: Omit<AuthProfile, 'createdAt' | 'updatedAt'> & {
    createdAt?: string;
    updatedAt?: string;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT OR REPLACE INTO auth_profiles
      (id, provider, credential_type, account_label, scopes, expires_at, provider_account_id, refresh_eligible, token_type, risk_level, status, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM auth_profiles WHERE id = ?), ?), ?)
  `,
  ).run(
    profile.id,
    profile.provider,
    profile.credentialType,
    profile.accountLabel || null,
    profile.scopes ? JSON.stringify(profile.scopes) : null,
    profile.expiresAt || null,
    profile.providerAccountId || null,
    profile.refreshEligible ? 1 : 0,
    profile.tokenType || null,
    profile.riskLevel || null,
    profile.status,
    profile.id,
    profile.createdAt || now,
    profile.updatedAt || now,
  );
}

export function deleteAuthProfile(id: string): void {
  db.prepare('DELETE FROM auth_profiles WHERE id = ?').run(id);
}

// --- Local endpoint profile accessors ---

interface LocalEndpointProfileRow {
  id: string;
  engine: string;
  base_url: string;
  api_key_mode: string;
  container_reachable_url: string;
  health_status: string;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapLocalEndpointProfileRow(
  row: LocalEndpointProfileRow,
): LocalEndpointProfile {
  return {
    id: row.id,
    engine: row.engine as LocalEndpointProfile['engine'],
    baseUrl: row.base_url,
    apiKeyMode: row.api_key_mode as LocalEndpointProfile['apiKeyMode'],
    containerReachableUrl: row.container_reachable_url,
    healthStatus: row.health_status as LocalEndpointProfile['healthStatus'],
    lastCheckedAt: row.last_checked_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getLocalEndpointProfile(
  id: string,
): LocalEndpointProfile | undefined {
  const row = db
    .prepare('SELECT * FROM local_endpoint_profiles WHERE id = ?')
    .get(id) as LocalEndpointProfileRow | undefined;
  return row ? mapLocalEndpointProfileRow(row) : undefined;
}

export function getAllLocalEndpointProfiles(): LocalEndpointProfile[] {
  const rows = db
    .prepare('SELECT * FROM local_endpoint_profiles ORDER BY updated_at DESC')
    .all() as LocalEndpointProfileRow[];
  return rows.map(mapLocalEndpointProfileRow);
}

export function setLocalEndpointProfile(
  profile: Omit<LocalEndpointProfile, 'createdAt' | 'updatedAt'> & {
    createdAt?: string;
    updatedAt?: string;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT OR REPLACE INTO local_endpoint_profiles
      (id, engine, base_url, api_key_mode, container_reachable_url, health_status, last_checked_at, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM local_endpoint_profiles WHERE id = ?), ?), ?)
  `,
  ).run(
    profile.id,
    profile.engine,
    profile.baseUrl,
    profile.apiKeyMode,
    profile.containerReachableUrl,
    profile.healthStatus,
    profile.lastCheckedAt || null,
    profile.id,
    profile.createdAt || now,
    profile.updatedAt || now,
  );
}

export function deleteLocalEndpointProfile(id: string): void {
  db.prepare('DELETE FROM local_endpoint_profiles WHERE id = ?').run(id);
}

// --- Provider capability cache ---

interface CapabilityRow {
  cache_key: string;
  provider: string;
  base_url: string | null;
  capability_json: string;
  updated_at: string;
}

export function makeCapabilityCacheKey(
  provider: string,
  baseUrl: string | undefined,
): string {
  return `${provider}::${baseUrl || ''}`;
}

export function setProviderCapability(
  provider: string,
  baseUrl: string | undefined,
  capability: ProviderCapability,
): void {
  const now = new Date().toISOString();
  const key = makeCapabilityCacheKey(provider, baseUrl);
  db.prepare(
    `
    INSERT OR REPLACE INTO provider_capabilities_cache
      (cache_key, provider, base_url, capability_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(key, provider, baseUrl || null, JSON.stringify(capability), now);
}

export function getProviderCapability(
  provider: string,
  baseUrl: string | undefined,
): ProviderCapability | undefined {
  const key = makeCapabilityCacheKey(provider, baseUrl);
  const row = db
    .prepare(
      'SELECT * FROM provider_capabilities_cache WHERE cache_key = ? LIMIT 1',
    )
    .get(key) as CapabilityRow | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.capability_json) as ProviderCapability;
  } catch {
    return undefined;
  }
}

export function deleteProviderCapabilitiesByProviders(
  providers: string[],
): void {
  if (providers.length === 0) return;
  const placeholders = providers.map(() => '?').join(', ');
  db.prepare(
    `DELETE FROM provider_capabilities_cache WHERE provider IN (${placeholders})`,
  ).run(...providers);
}

export function getAllProviderCapabilities(): Array<{
  provider: string;
  baseUrl?: string;
  capability: ProviderCapability;
}> {
  const rows = db
    .prepare(
      'SELECT * FROM provider_capabilities_cache ORDER BY updated_at DESC',
    )
    .all() as CapabilityRow[];
  return rows
    .map((row) => {
      try {
        return {
          provider: row.provider,
          baseUrl: row.base_url || undefined,
          capability: JSON.parse(row.capability_json) as ProviderCapability,
        };
      } catch {
        return undefined;
      }
    })
    .filter(Boolean) as Array<{
    provider: string;
    baseUrl?: string;
    capability: ProviderCapability;
  }>;
}

export function deleteProviderCapability(
  provider: string,
  baseUrl: string | undefined,
): void {
  const key = makeCapabilityCacheKey(provider, baseUrl);
  db.prepare('DELETE FROM provider_capabilities_cache WHERE cache_key = ?').run(
    key,
  );
}

export function logRuntimeUsage(entry: RuntimeUsageLog): void {
  const createdAt = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO runtime_usage_logs (
      group_folder,
      chat_jid,
      profile_id,
      provider,
      model,
      trigger_kind,
      started_at,
      duration_ms,
      input_tokens,
      output_tokens,
      total_tokens,
      usage_source,
      request_count,
      input_cost_usd,
      output_cost_usd,
      total_cost_usd,
      notes,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    entry.groupFolder,
    entry.chatJid,
    entry.profileId || null,
    entry.provider,
    entry.model,
    entry.triggerKind,
    entry.startedAt,
    entry.durationMs,
    entry.usage.inputTokens,
    entry.usage.outputTokens,
    entry.usage.totalTokens,
    entry.usage.source,
    entry.usage.requests || null,
    entry.inputCostUsd,
    entry.outputCostUsd,
    entry.totalCostUsd,
    entry.notes || null,
    createdAt,
  );
}

// --- Tool service profiles/state ---

interface ToolServiceProfileRow {
  id: string;
  name: string;
  kind: string;
  base_url: string | null;
  health_path: string | null;
  enabled: number;
  startup_mode: string;
  created_at: string;
  updated_at: string;
}

interface ToolServiceStateRow {
  service_id: string;
  status: string;
  last_probe_at: string | null;
  last_probe_detail: string | null;
  restart_count: number;
  last_error: string | null;
  updated_at: string;
}

function mapToolServiceProfileRow(
  row: ToolServiceProfileRow,
): ToolServiceProfile {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ToolServiceProfile['kind'],
    baseUrl: row.base_url || undefined,
    healthPath: row.health_path || undefined,
    enabled: row.enabled === 1,
    startupMode: row.startup_mode as ToolServiceProfile['startupMode'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapToolServiceStateRow(row: ToolServiceStateRow): ToolServiceState {
  return {
    serviceId: row.service_id,
    status: row.status as ToolServiceState['status'],
    lastProbeAt: row.last_probe_at || undefined,
    lastProbeDetail: row.last_probe_detail || undefined,
    restartCount: row.restart_count,
    lastError: row.last_error || undefined,
    updatedAt: row.updated_at,
  };
}

export function getToolServiceProfile(
  id: string,
): ToolServiceProfile | undefined {
  const row = db
    .prepare('SELECT * FROM tool_service_profiles WHERE id = ?')
    .get(id) as ToolServiceProfileRow | undefined;
  return row ? mapToolServiceProfileRow(row) : undefined;
}

export function getAllToolServiceProfiles(): ToolServiceProfile[] {
  const rows = db
    .prepare('SELECT * FROM tool_service_profiles ORDER BY id ASC')
    .all() as ToolServiceProfileRow[];
  return rows.map(mapToolServiceProfileRow);
}

export function setToolServiceProfile(
  profile: Omit<ToolServiceProfile, 'createdAt' | 'updatedAt'> & {
    createdAt?: string;
    updatedAt?: string;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT OR REPLACE INTO tool_service_profiles
      (id, name, kind, base_url, health_path, enabled, startup_mode, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM tool_service_profiles WHERE id = ?), ?), ?)
  `,
  ).run(
    profile.id,
    profile.name,
    profile.kind,
    profile.baseUrl || null,
    profile.healthPath || null,
    profile.enabled ? 1 : 0,
    profile.startupMode,
    profile.id,
    profile.createdAt || now,
    profile.updatedAt || now,
  );
}

export function deleteToolServiceProfile(id: string): void {
  db.prepare('DELETE FROM tool_service_profiles WHERE id = ?').run(id);
}

export function getToolServiceState(
  serviceId: string,
): ToolServiceState | undefined {
  const row = db
    .prepare('SELECT * FROM tool_service_state WHERE service_id = ?')
    .get(serviceId) as ToolServiceStateRow | undefined;
  return row ? mapToolServiceStateRow(row) : undefined;
}

export function getAllToolServiceState(): ToolServiceState[] {
  const rows = db
    .prepare('SELECT * FROM tool_service_state ORDER BY service_id ASC')
    .all() as ToolServiceStateRow[];
  return rows.map(mapToolServiceStateRow);
}

export function setToolServiceState(
  state: Omit<ToolServiceState, 'updatedAt'> & { updatedAt?: string },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT OR REPLACE INTO tool_service_state
      (service_id, status, last_probe_at, last_probe_detail, restart_count, last_error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    state.serviceId,
    state.status,
    state.lastProbeAt || null,
    state.lastProbeDetail || null,
    state.restartCount,
    state.lastError || null,
    state.updatedAt || now,
  );
}

// --- Wizard session accessors ---

interface WizardSessionRow {
  session_id: string;
  status: string;
  current_step: string;
  state_json: string;
  created_at: string;
  updated_at: string;
}

function mapWizardSessionRow(row: WizardSessionRow): WizardSessionState {
  let stateJson: Record<string, unknown> = {};
  try {
    stateJson = JSON.parse(row.state_json) as Record<string, unknown>;
  } catch {
    stateJson = {};
  }
  return {
    sessionId: row.session_id,
    status: row.status as WizardSessionState['status'],
    currentStep: row.current_step as WizardSessionState['currentStep'],
    stateJson,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getWizardSession(
  sessionId: string,
): WizardSessionState | undefined {
  const row = db
    .prepare('SELECT * FROM wizard_sessions WHERE session_id = ?')
    .get(sessionId) as WizardSessionRow | undefined;
  return row ? mapWizardSessionRow(row) : undefined;
}

export function getLatestActiveWizardSession(): WizardSessionState | undefined {
  const row = db
    .prepare(
      `
      SELECT * FROM wizard_sessions
      WHERE status = 'active'
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    )
    .get() as WizardSessionRow | undefined;
  return row ? mapWizardSessionRow(row) : undefined;
}

export function setWizardSession(
  session: Omit<WizardSessionState, 'createdAt' | 'updatedAt'> & {
    createdAt?: string;
    updatedAt?: string;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT OR REPLACE INTO wizard_sessions
      (session_id, status, current_step, state_json, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, COALESCE((SELECT created_at FROM wizard_sessions WHERE session_id = ?), ?), ?)
  `,
  ).run(
    session.sessionId,
    session.status,
    session.currentStep,
    JSON.stringify(session.stateJson || {}),
    session.sessionId,
    session.createdAt || now,
    session.updatedAt || now,
  );
}

export function deleteWizardSession(sessionId: string): void {
  db.prepare('DELETE FROM wizard_sessions WHERE session_id = ?').run(sessionId);
}

// --- Auth refresh lock accessors ---

export function acquireAuthRefreshLock(input: {
  authProfileId: string;
  owner: string;
  ttlMs?: number;
}): boolean {
  const ttl = Math.max(1000, input.ttlMs || 30000);
  const now = Date.now();
  const expiresAt = new Date(now + ttl).toISOString();
  const nowIso = new Date(now).toISOString();

  // Clear stale lock if expired.
  db.prepare(
    `DELETE FROM auth_refresh_locks WHERE auth_profile_id = ? AND expires_at <= ?`,
  ).run(input.authProfileId, nowIso);

  const result = db
    .prepare(
      `
      INSERT OR IGNORE INTO auth_refresh_locks (auth_profile_id, owner, expires_at)
      VALUES (?, ?, ?)
    `,
    )
    .run(input.authProfileId, input.owner, expiresAt);
  return result.changes > 0;
}

export function releaseAuthRefreshLock(
  authProfileId: string,
  owner?: string,
): void {
  if (owner) {
    db.prepare(
      `DELETE FROM auth_refresh_locks WHERE auth_profile_id = ? AND owner = ?`,
    ).run(authProfileId, owner);
    return;
  }
  db.prepare(`DELETE FROM auth_refresh_locks WHERE auth_profile_id = ?`).run(
    authProfileId,
  );
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}

// --- Memory entries (FTS5 retrieval-based memory) ---

export interface MemoryEntryInput {
  group_folder: string;
  scope: 'global' | 'group';
  kind: string;
  content: string;
  source: 'auto' | 'explicit' | 'migration';
  origin?:
    | 'conversation'
    | 'explicit_request'
    | 'migration'
    | 'file_compaction';
  durability?: 'session' | 'durable' | 'pinned';
  confidence?: number;
  created_at: string;
  last_confirmed_at?: string;
  source_file?: string;
  pinned?: boolean;
}

export interface MemoryEntry {
  id: number;
  content: string;
  kind: string;
  source: string;
  origin: string;
  durability: string;
  confidence: number;
  rank: number;
  pinned: number;
  created_at?: string;
  last_confirmed_at?: string;
  superseded_at?: string;
}

const MEMORY_DECAY_HALF_LIFE_DAYS = 30;

function normalizeMemoryContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/^(i |my |user |the user )/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clampConfidence(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0.1, Math.min(1, value as number));
}

function memoryConflictKey(kind: string, content: string): string | null {
  const normalized = normalizeMemoryContent(content);
  const patterns: Array<{ key: string; test: RegExp }> = [
    { key: 'profile:name', test: /\b(preferred name|call me|my name is)\b/ },
    { key: 'profile:timezone', test: /\btimezone|time zone|ist|utc|gmt\b/ },
    { key: 'profile:location', test: /\b(i live|located|based in)\b/ },
    {
      key: 'profile:role',
      test: /\b(i work as|i am a|my role is|working at)\b/,
    },
    {
      key: 'employment:status',
      test: /\b(job|working from|start working|joined|offer|startup company|employment)\b/,
    },
  ];
  for (const pattern of patterns) {
    if (pattern.test.test(normalized)) {
      return `${kind}:${pattern.key}`;
    }
  }
  return null;
}

function resolveMemoryOrigin(
  entry: MemoryEntryInput,
): NonNullable<MemoryEntryInput['origin']> {
  if (entry.origin) return entry.origin;
  if (entry.source === 'explicit') return 'explicit_request';
  if (entry.source === 'migration') return 'migration';
  return 'conversation';
}

function resolveMemoryDurability(
  entry: MemoryEntryInput,
): NonNullable<MemoryEntryInput['durability']> {
  if (entry.pinned) return 'pinned';
  if (entry.durability) return entry.durability;
  return entry.source === 'migration' ? 'durable' : 'durable';
}

function rankMemoryRows(
  rows: MemoryEntry[],
  keywords: string[],
  limit: number,
): MemoryEntry[] {
  const now = Date.now();
  return rows
    .map((row) => {
      const ageMs =
        now -
        new Date(row.last_confirmed_at || row.created_at || now).getTime();
      const ageDays = Math.max(0, ageMs / 86_400_000);
      const decay = Math.exp(
        (-Math.LN2 * ageDays) / MEMORY_DECAY_HALF_LIFE_DAYS,
      );
      const lower = row.content.toLowerCase();
      const exactMatches = keywords.reduce(
        (count, keyword) =>
          count + (lower.includes(keyword.toLowerCase()) ? 1 : 0),
        0,
      );
      const pinnedBoost = row.pinned ? -2.5 : 0;
      const explicitBoost = row.origin === 'explicit_request' ? -0.8 : 0;
      const durableBoost =
        row.durability === 'pinned'
          ? -1.2
          : row.durability === 'durable'
            ? -0.35
            : 0;
      const confidenceBoost = -(row.confidence || 0.7) * 0.6;
      const exactBoost = -Math.min(2.2, exactMatches * 0.45);
      return {
        ...row,
        rank:
          row.rank * decay +
          pinnedBoost +
          explicitBoost +
          durableBoost +
          confidenceBoost +
          exactBoost,
      };
    })
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit);
}

/** Insert a memory entry, deduplicating by normalized content within the group.
 *  If an entry with the same normalized content exists and the new entry is pinned,
 *  upgrades the existing entry to pinned. */
export function insertMemoryEntry(entry: MemoryEntryInput): number {
  const normalized = normalizeMemoryContent(entry.content);
  const origin = resolveMemoryOrigin(entry);
  const durability = resolveMemoryDurability(entry);
  const confidence = clampConfidence(
    entry.confidence,
    origin === 'explicit_request' ? 0.95 : 0.78,
  );
  const lastConfirmedAt = entry.last_confirmed_at || entry.created_at;
  const existing = db
    .prepare(
      `SELECT id, pinned, confidence
       FROM memory_entries
       WHERE group_folder = ? AND content_normalized = ? AND superseded_at IS NULL`,
    )
    .get(entry.group_folder, normalized) as
    | { id: number; pinned: number; confidence: number }
    | undefined;

  if (existing) {
    if (entry.pinned && !existing.pinned) {
      db.prepare(
        `UPDATE memory_entries
         SET pinned = 1,
             durability = 'pinned',
             origin = ?,
             confidence = MAX(confidence, ?),
             last_confirmed_at = ?
         WHERE id = ?`,
      ).run(origin, confidence, lastConfirmedAt, existing.id);
    } else {
      db.prepare(
        `UPDATE memory_entries
         SET confidence = MAX(confidence, ?),
             last_confirmed_at = COALESCE(?, last_confirmed_at)
         WHERE id = ?`,
      ).run(confidence, lastConfirmedAt, existing.id);
    }
    return existing.id;
  }

  const conflictKey = memoryConflictKey(entry.kind, entry.content);
  if (conflictKey) {
    const conflictingIds = (
      db
        .prepare(
          `SELECT id, content
           FROM memory_entries
           WHERE group_folder = ?
             AND kind = ?
             AND superseded_at IS NULL`,
        )
        .all(entry.group_folder, entry.kind) as Array<{
        id: number;
        content: string;
      }>
    )
      .filter(
        (row) => memoryConflictKey(entry.kind, row.content) === conflictKey,
      )
      .map((row) => row.id);

    for (const id of conflictingIds) {
      db.prepare(
        `UPDATE memory_entries
         SET superseded_at = ?
         WHERE id = ?`,
      ).run(entry.created_at, id);
    }
  }

  const result = db
    .prepare(
      `INSERT INTO memory_entries (
         group_folder,
         scope,
         kind,
         content,
         content_normalized,
         source,
         origin,
         durability,
         confidence,
         created_at,
         last_confirmed_at,
         source_file,
         pinned
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.group_folder,
      entry.scope,
      entry.kind,
      entry.content,
      normalized,
      entry.source,
      origin,
      durability,
      confidence,
      entry.created_at,
      lastConfirmedAt,
      entry.source_file ?? null,
      entry.pinned ? 1 : 0,
    );
  return result.lastInsertRowid as number;
}

export function queryMemoryExact(input: {
  groupFolder: string;
  phrases: string[];
  limit?: number;
}): MemoryEntry[] {
  const phrases = input.phrases
    .map((phrase) => normalizeMemoryContent(phrase))
    .filter((phrase) => phrase.length >= 4);
  if (phrases.length === 0) return [];

  const rows = db
    .prepare(
      `SELECT id, content, kind, source, origin, durability, confidence, pinned, created_at, last_confirmed_at, superseded_at, 0 AS rank
       FROM memory_entries
       WHERE (group_folder = ? OR scope = 'global')
         AND superseded_at IS NULL`,
    )
    .all(input.groupFolder) as MemoryEntry[];

  const matches = rows.filter((row) => {
    const normalized = normalizeMemoryContent(row.content);
    return phrases.some(
      (phrase) => normalized.includes(phrase) || phrase.includes(normalized),
    );
  });

  return rankMemoryRows(matches, phrases, input.limit ?? 8);
}

/** Query FTS5 memory index with BM25 ranking. Returns best matches first. */
export function queryMemoryFts(input: {
  groupFolder: string;
  keywords: string[];
  limit?: number;
}): MemoryEntry[] {
  const keywords = input.keywords
    .map((keyword) => normalizeMemoryContent(keyword))
    .filter((keyword) => keyword.length >= 3);
  if (keywords.length === 0) return [];

  const terms = keywords
    .map((keyword) => keyword.replace(/["*^]/g, '').trim())
    .filter(Boolean)
    .map((keyword) => (keyword.includes(' ') ? `"${keyword}"` : keyword));

  if (terms.length === 0) return [];
  const matchExpr = terms.join(' OR ');
  const limit = input.limit ?? 8;

  try {
    // Boost 'explicit' source entries by 1.5x (BM25 rank is negative; multiplying
    // by 1.5 makes it more negative = ranks higher). Pinned entries are excluded
    // here — they are always fetched separately via getPinnedMemoryEntries().
    const rows = db
      .prepare(
        `SELECT me.id,
                me.content,
                me.kind,
                me.source,
                me.origin,
                me.durability,
                me.confidence,
                me.pinned,
                me.created_at,
                me.last_confirmed_at,
                me.superseded_at,
                (memory_fts.rank * CASE WHEN me.source = 'explicit' THEN 1.5 ELSE 1.0 END) AS rank
         FROM memory_fts
         JOIN memory_entries me ON memory_fts.rowid = me.id
         WHERE memory_fts MATCH ?
           AND (me.group_folder = ? OR me.scope = 'global')
           AND me.pinned = 0
           AND me.superseded_at IS NULL
         ORDER BY rank
         LIMIT ?`,
      )
      .all(
        matchExpr,
        input.groupFolder,
        Math.max(limit * 2, limit),
      ) as MemoryEntry[];
    return rankMemoryRows(rows, keywords, limit);
  } catch {
    // FTS5 MATCH can throw on malformed expressions — return empty gracefully
    return [];
  }
}

/** Count memory entries for a group (used for lazy-init check). */
export function getMemoryEntryCount(groupFolder: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as c
       FROM memory_entries
       WHERE group_folder = ?
         AND superseded_at IS NULL`,
    )
    .get(groupFolder) as { c: number };
  return row.c;
}

/** Fetch all pinned entries for a group. Always included regardless of keyword match.
 *  Hard-capped at 5 to prevent abuse. */
export function getPinnedMemoryEntries(groupFolder: string): MemoryEntry[] {
  return db
    .prepare(
      `SELECT id,
              content,
              kind,
              source,
              origin,
              durability,
              confidence,
              pinned,
              created_at,
              last_confirmed_at,
              superseded_at,
              0 AS rank
       FROM memory_entries
       WHERE group_folder = ?
         AND pinned = 1
         AND superseded_at IS NULL
       ORDER BY created_at DESC
       LIMIT 5`,
    )
    .all(groupFolder) as MemoryEntry[];
}

/** Delete all non-explicit entries for a group and re-insert from current MD files. */
export function clearNonExplicitMemoryEntries(groupFolder: string): void {
  db.prepare(
    `DELETE FROM memory_entries WHERE group_folder = ? AND source != 'explicit'`,
  ).run(groupFolder);
}
