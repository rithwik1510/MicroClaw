function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map((p) => Number(p));
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return false;
  }

  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function isLocalHostname(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    lower === 'localhost' ||
    lower === 'host.docker.internal' ||
    lower.endsWith('.local')
  );
}

export interface LocalEndpointValidation {
  ok: boolean;
  reason?: string;
}

export function validateLocalEndpointUrl(
  rawUrl: string,
): LocalEndpointValidation {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'URL is invalid' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Only http/https URLs are allowed' };
  }

  const host = parsed.hostname;
  if (!host) {
    return { ok: false, reason: 'URL host is missing' };
  }

  if (host === '::1') return { ok: true };
  if (isLocalHostname(host)) return { ok: true };
  if (isPrivateIpv4(host)) return { ok: true };

  return {
    ok: false,
    reason:
      'Endpoint must be local (localhost, host.docker.internal, private LAN IP, or .local host)',
  };
}

export function assertLocalEndpointUrl(rawUrl: string): void {
  const validation = validateLocalEndpointUrl(rawUrl);
  if (!validation.ok) {
    throw new Error(validation.reason || 'Endpoint URL is not allowed');
  }
}
