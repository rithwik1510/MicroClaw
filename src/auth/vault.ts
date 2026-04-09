import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { STORE_DIR } from '../config.js';
import { logger } from '../logger.js';

interface VaultPayload {
  version: 1;
  entries: Record<string, Record<string, string>>;
}

interface VaultEnvelope {
  iv: string;
  tag: string;
  data: string;
}

const AUTH_DIR = path.join(STORE_DIR, 'auth');
const VAULT_FILE = path.join(AUTH_DIR, 'credentials.enc.json');

function getVaultKey(): Buffer {
  const seed =
    process.env.NANOCLAW_CREDENTIALS_KEY ||
    `${os.userInfo().username}|${os.hostname()}|${process.cwd()}|microclaw-vault-v1`;
  return crypto.createHash('sha256').update(seed).digest();
}

function ensureAuthDir(): void {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

function encrypt(payload: VaultPayload): VaultEnvelope {
  const key = getVaultKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decrypt(envelope: VaultEnvelope): VaultPayload {
  const key = getVaultKey();
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const ciphertext = Buffer.from(envelope.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8')) as VaultPayload;
}

function loadPayload(): VaultPayload {
  ensureAuthDir();
  if (!fs.existsSync(VAULT_FILE)) {
    return { version: 1, entries: {} };
  }

  try {
    const envelope = JSON.parse(
      fs.readFileSync(VAULT_FILE, 'utf8'),
    ) as VaultEnvelope;
    const payload = decrypt(envelope);
    if (payload.version !== 1 || typeof payload.entries !== 'object') {
      throw new Error('Invalid vault payload version');
    }
    return payload;
  } catch (err) {
    logger.error({ err }, 'Failed to decrypt auth vault');
    throw new Error(
      'Cannot decrypt auth vault. Set NANOCLAW_CREDENTIALS_KEY if host identity changed.',
    );
  }
}

function savePayload(payload: VaultPayload): void {
  ensureAuthDir();
  const envelope = encrypt(payload);
  fs.writeFileSync(VAULT_FILE, JSON.stringify(envelope, null, 2));
  try {
    fs.chmodSync(VAULT_FILE, 0o600);
  } catch {
    // chmod is not always available on Windows; best effort only.
  }
}

export function saveCredentials(
  authProfileId: string,
  values: Record<string, string>,
): void {
  const payload = loadPayload();
  payload.entries[authProfileId] = {
    ...(payload.entries[authProfileId] || {}),
  };
  for (const [k, v] of Object.entries(values)) {
    if (v) {
      payload.entries[authProfileId][k] = v;
    }
  }
  savePayload(payload);
}

export function getCredentials(
  authProfileId: string,
): Record<string, string> | undefined {
  const payload = loadPayload();
  const entry = payload.entries[authProfileId];
  return entry ? { ...entry } : undefined;
}

export function deleteCredentials(authProfileId: string): void {
  const payload = loadPayload();
  delete payload.entries[authProfileId];
  savePayload(payload);
}
