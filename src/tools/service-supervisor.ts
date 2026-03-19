import {
  getAllToolServiceProfiles,
  getToolServiceProfile,
  getToolServiceState,
  setToolServiceProfile,
  setToolServiceState,
} from '../db.js';
import { logger } from '../logger.js';
import { ToolServiceProfile, ToolServiceState } from '../types.js';

function nowIso(): string {
  return new Date().toISOString();
}

export async function seedDefaultToolServiceProfiles(): Promise<void> {
  // No default sidecar service is seeded.
}

export function listToolServices(): Array<{
  profile: ToolServiceProfile;
  state?: ToolServiceState;
}> {
  return getAllToolServiceProfiles().map((profile) => ({
    profile,
    state: getToolServiceState(profile.id),
  }));
}

async function probeCustomHttp(profile: ToolServiceProfile): Promise<{
  ok: boolean;
  detail: string;
}> {
  const base = (profile.baseUrl || '').replace(/\/$/, '');
  if (!base) {
    return { ok: false, detail: 'Missing baseUrl' };
  }
  const healthPath = profile.healthPath || '/health';
  try {
    const res = await fetch(`${base}${healthPath}`);
    if (res.ok || res.status === 404) {
      return { ok: true, detail: `HTTP ${res.status}` };
    }
    return { ok: false, detail: `HTTP ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function probeToolService(serviceId: string): Promise<{
  ok: boolean;
  detail: string;
}> {
  const profile = getToolServiceProfile(serviceId);
  if (!profile) {
    return { ok: false, detail: `Tool service not found: ${serviceId}` };
  }
  if (!profile.enabled) {
    return { ok: false, detail: 'Service disabled' };
  }

  if ((profile.kind as string) !== 'custom_http') {
    const detail = `Unsupported tool service kind: ${profile.kind}`;
    setToolServiceState({
      serviceId,
      status: 'unreachable',
      lastProbeAt: nowIso(),
      lastProbeDetail: detail,
      restartCount: getToolServiceState(serviceId)?.restartCount || 0,
      lastError: detail,
    });
    return { ok: false, detail };
  }

  const probe = await probeCustomHttp(profile);
  setToolServiceState({
    serviceId,
    status: probe.ok ? 'healthy' : 'unreachable',
    lastProbeAt: nowIso(),
    lastProbeDetail: probe.detail,
    restartCount: getToolServiceState(serviceId)?.restartCount || 0,
    lastError: probe.ok ? undefined : probe.detail,
  });
  return probe;
}

export async function ensureToolServicesReadyOnStartup(): Promise<{
  ok: boolean;
  detail: string;
  failed: string[];
}> {
  await seedDefaultToolServiceProfiles();
  const profiles = getAllToolServiceProfiles();
  for (const profile of profiles) {
    if ((profile.kind as string) === 'custom_http') continue;
    if (!profile.enabled) continue;
    setToolServiceProfile({
      ...profile,
      enabled: false,
    });
    setToolServiceState({
      serviceId: profile.id,
      status: 'disabled',
      lastProbeAt: nowIso(),
      lastProbeDetail: `Disabled unsupported service kind: ${profile.kind}`,
      restartCount: getToolServiceState(profile.id)?.restartCount || 0,
      lastError: undefined,
    });
  }

  const services = getAllToolServiceProfiles().filter(
    (s) => s.enabled && s.startupMode === 'auto',
  );
  const failed: string[] = [];
  for (const service of services) {
    const probe = await probeCustomHttp(service);
    setToolServiceState({
      serviceId: service.id,
      status: probe.ok ? 'healthy' : 'unreachable',
      lastProbeAt: nowIso(),
      lastProbeDetail: probe.detail,
      restartCount: getToolServiceState(service.id)?.restartCount || 0,
      lastError: probe.ok ? undefined : probe.detail,
    });
    if (!probe.ok) {
      failed.push(`${service.id}: ${probe.detail}`);
    }
  }

  if (failed.length > 0) {
    logger.warn({ failed }, 'One or more tool services failed startup probe');
    return {
      ok: false,
      detail: `${failed.length} tool service(s) failed startup probe`,
      failed,
    };
  }
  return {
    ok: true,
    detail: 'All auto-start tool services healthy',
    failed: [],
  };
}

export function setToolServiceEnabled(
  serviceId: string,
  enabled: boolean,
): void {
  const profile = getToolServiceProfile(serviceId);
  if (!profile) {
    throw new Error(`Tool service not found: ${serviceId}`);
  }
  setToolServiceProfile({
    ...profile,
    enabled,
  });
}
