const BASE = '/api';

export interface Agent {
  id: string;
  name: string;
  model: string;
  provider: string;
  personality: string | null;
  tools: string;
  created_at: string;
}

export interface HealthData {
  status: string;
  uptime: number;
  channels: Array<{ name: string; connected: boolean }>;
  groups: number;
}

export interface ChatMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

export async function getHealth(): Promise<HealthData> {
  const res = await fetch(`${BASE}/health`);
  return res.json();
}

export interface SetupData {
  completed: boolean;
  existing: {
    provider: string;
    model: string;
    baseUrl: string;
  } | null;
}

export async function getSetup(): Promise<SetupData> {
  const res = await fetch(`${BASE}/setup`);
  return res.json();
}

export async function postSetup(data: {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function testConnection(data: {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(`${BASE}/setup/test-connection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function getAgents(): Promise<Agent[]> {
  const res = await fetch(`${BASE}/agents`);
  return res.json();
}

export async function createAgent(data: {
  name: string;
  model: string;
  provider?: string;
  personality?: string;
}): Promise<Agent> {
  const res = await fetch(`${BASE}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

export interface ExistingGroup {
  jid: string;
  name: string;
  folder: string;
  isMain: boolean;
  requiresTrigger: boolean;
}

export async function getExistingGroups(): Promise<ExistingGroup[]> {
  const res = await fetch(`${BASE}/chats/groups`);
  return res.json();
}

export async function createChat(name: string, existingFolder?: string): Promise<{ jid: string; name: string; folder: string }> {
  const res = await fetch(`${BASE}/chats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, existingFolder }),
  });
  return res.json();
}

export async function getChatMessages(jid: string, limit = 50): Promise<ChatMessage[]> {
  const res = await fetch(`${BASE}/chats/${encodeURIComponent(jid)}/messages?limit=${limit}`);
  return res.json();
}

export interface PersonaFile {
  filename: string;
  description: string;
  content: string;
}

export async function getPersonaFiles(): Promise<PersonaFile[]> {
  const res = await fetch(`${BASE}/persona`);
  return res.json();
}

export async function savePersonaFile(filename: string, content: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/persona/${encodeURIComponent(filename)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  return res.json();
}

// ── Activity ───────────────────────────────────────────────────

export interface ActivityEntry {
  id: string;
  type: 'heartbeat' | 'task' | 'runtime' | 'usage';
  groupFolder: string;
  timestamp: string;
  status: 'ok' | 'acted' | 'success' | 'error';
  summary: string;
  durationMs?: number;
  detail?: string;
  tokenCount?: number;
  costUsd?: number;
}

export interface DailySummary {
  date: string;
  heartbeats: { total: number; acted: number; errors: number };
  tasks: { total: number; succeeded: number; failed: number };
  tokens: { input: number; output: number; total: number };
  costUsd: number;
}

export async function getActivity(params?: {
  group?: string;
  type?: string;
  limit?: number;
  offset?: number;
}): Promise<ActivityEntry[]> {
  const qs = new URLSearchParams();
  if (params?.group) qs.set('group', params.group);
  if (params?.type) qs.set('type', params.type);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  const res = await fetch(`${BASE}/activity?${qs}`);
  return res.json();
}

export async function getActivitySummary(date?: string): Promise<DailySummary> {
  const qs = date ? `?date=${date}` : '';
  const res = await fetch(`${BASE}/activity/summary${qs}`);
  return res.json();
}

// ── Heartbeats ─────────────────────────────────────────────────

export interface HeartbeatConfig {
  groupFolder: string;
  groupName: string;
  hasChecklist: boolean;
  intervalMs: number;
  timeoutMs: number;
  lastRun?: { timestamp: string; status: string; actionsTaken?: string };
  recentRuns: Array<{ timestamp: string; status: string }>;
}

export interface HeartbeatDetail extends HeartbeatConfig {
  content: string;
  runHistory: Array<{
    timestamp: string;
    status: string;
    actionsTaken?: string;
    durationMs: number;
    error?: string;
  }>;
}

export async function getHeartbeats(): Promise<HeartbeatConfig[]> {
  const res = await fetch(`${BASE}/heartbeats`);
  return res.json();
}

export async function getHeartbeatDetail(groupFolder: string): Promise<HeartbeatDetail> {
  const res = await fetch(`${BASE}/heartbeats/${encodeURIComponent(groupFolder)}`);
  return res.json();
}

export async function saveHeartbeat(groupFolder: string, content: string, intervalMs?: number): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/heartbeats/${encodeURIComponent(groupFolder)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, intervalMs }),
  });
  return res.json();
}

export async function triggerHeartbeat(groupFolder: string): Promise<{ queued: boolean }> {
  const res = await fetch(`${BASE}/heartbeats/${encodeURIComponent(groupFolder)}/run`, { method: 'POST' });
  return res.json();
}

export async function deleteHeartbeat(groupFolder: string): Promise<{ deleted: boolean }> {
  const res = await fetch(`${BASE}/heartbeats/${encodeURIComponent(groupFolder)}`, { method: 'DELETE' });
  return res.json();
}

// ── Routines ───────────────────────────────────────────────────

export interface DetectedRoutine {
  keywords: string;
  capability: string;
  timeWindow: string;
  occurrences: number;
}

export async function getRoutines(groupFolder: string): Promise<DetectedRoutine[]> {
  const res = await fetch(`${BASE}/routines/${encodeURIComponent(groupFolder)}`);
  return res.json();
}

export async function automateRoutine(groupFolder: string, description: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/routines/${encodeURIComponent(groupFolder)}/automate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  });
  return res.json();
}

export async function dismissRoutineApi(groupFolder: string, keywords: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/routines/${encodeURIComponent(groupFolder)}/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keywords }),
  });
  return res.json();
}

// ── Lessons ────────────────────────────────────────────────────

export interface Lesson {
  id: number;
  groupFolder: string;
  createdAt: string;
  triggerType: string;
  errorSummary: string;
  lessonText: string;
  timesInjected: number;
}

export async function getLessons(groupFolder: string): Promise<Lesson[]> {
  const res = await fetch(`${BASE}/lessons/${encodeURIComponent(groupFolder)}`);
  return res.json();
}

export async function deleteLesson(id: number): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/lessons/${id}`, { method: 'DELETE' });
  return res.json();
}

// ── Memories ───────────────────────────────────────────────────

export interface MemoryEntry {
  id: number;
  group_folder: string;
  kind: string;
  content: string;
  pinned: boolean;
  confidence: number;
  created_at: string;
  last_confirmed_at: string;
}

export async function getMemories(params?: {
  group?: string;
  kind?: string;
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<MemoryEntry[]> {
  const qs = new URLSearchParams();
  if (params?.group) qs.set('group', params.group);
  if (params?.kind) qs.set('kind', params.kind);
  if (params?.q) qs.set('q', params.q);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  const res = await fetch(`${BASE}/memories?${qs}`);
  return res.json();
}

export async function updateMemory(id: number, content: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/memories/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  return res.json();
}

export async function deleteMemory(id: number): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/memories/${id}`, { method: 'DELETE' });
  return res.json();
}

export async function toggleMemoryPin(id: number, pinned: boolean): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/memories/${id}/pin`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });
  return res.json();
}

// ── Scheduled Tasks ────────────────────────────────────────────

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  created_at: string;
  last_run?: string;
  last_result?: string;
}

export async function getTasks(group?: string): Promise<ScheduledTask[]> {
  const qs = group ? `?group=${encodeURIComponent(group)}` : '';
  const res = await fetch(`${BASE}/tasks${qs}`);
  return res.json();
}

export async function updateTaskStatus(id: string, status: 'active' | 'paused' | 'cancelled'): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/tasks/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  return res.json();
}

export async function deleteTaskApi(id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return res.json();
}
