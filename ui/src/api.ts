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

export async function getSetup(): Promise<{ completed: boolean }> {
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

export async function createChat(name: string): Promise<{ jid: string; name: string; folder: string }> {
  const res = await fetch(`${BASE}/chats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return res.json();
}

export async function getChatMessages(jid: string, limit = 50): Promise<ChatMessage[]> {
  const res = await fetch(`${BASE}/chats/${encodeURIComponent(jid)}/messages?limit=${limit}`);
  return res.json();
}
