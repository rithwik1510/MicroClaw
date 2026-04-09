import {
  AuthProfile,
  AuthProvider,
  RuntimeProfile,
  RuntimeProvider,
} from '../types.js';

export function providerForRuntime(runtime: RuntimeProvider): AuthProvider {
  switch (runtime) {
    case 'claude':
      return 'anthropic_setup_token';
    case 'openai_compatible':
      return 'openai_compatible';
    default:
      return 'anthropic_setup_token';
  }
}

export function materializeCredentialEnv(
  profile: AuthProfile,
  credentials: Record<string, string>,
  runtimeProfile?: RuntimeProfile,
): Record<string, string> {
  switch (profile.provider) {
    case 'anthropic_setup_token':
      return {
        CLAUDE_CODE_OAUTH_TOKEN:
          credentials.CLAUDE_CODE_OAUTH_TOKEN || credentials.access_token || '',
        ANTHROPIC_API_KEY: credentials.ANTHROPIC_API_KEY || '',
      };
    case 'openai_compatible': {
      const env: Record<string, string> = {};
      const key = credentials.OPENAI_API_KEY || credentials.api_key || '';
      if (key) env.OPENAI_API_KEY = key;
      if (runtimeProfile?.baseUrl) {
        env.OPENAI_COMPAT_BASE_URL = runtimeProfile.baseUrl;
      }
      return env;
    }
    default:
      return {};
  }
}
