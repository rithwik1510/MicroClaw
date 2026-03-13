import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

import { STORE_DIR } from '../config.js';
import { _initTestDatabase } from '../db.js';
import {
  listAuthProfiles,
  loginWithSecret,
  resolveAuthCredentialHandle,
} from './auth-manager.js';

const vaultPath = path.join(STORE_DIR, 'auth', 'credentials.enc.json');

describe('auth manager', () => {
  beforeEach(() => {
    _initTestDatabase();
    try {
      fs.unlinkSync(vaultPath);
    } catch {
      // ignore
    }
  });

  it('creates auth profile and resolves credential handle', () => {
    const profile = loginWithSecret({
      provider: 'openai_compatible',
      credentialType: 'api_key',
      values: { OPENAI_API_KEY: 'test-key' },
    });

    const all = listAuthProfiles();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(profile.id);

    const handle = resolveAuthCredentialHandle(profile.id);
    expect(handle).toBeDefined();
    expect(handle!.materializedEnv.OPENAI_API_KEY).toBe('test-key');
  });
});
