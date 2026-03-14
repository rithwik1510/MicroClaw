export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs = 120000,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    if (!text) return {};
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof Error) {
      if (err.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeoutMs}ms for ${url}`);
      }
      if (
        /fetch failed/i.test(err.message) ||
        /ECONNREFUSED/i.test(err.message) ||
        /ENOTFOUND/i.test(err.message)
      ) {
        throw new Error(
          `Network request failed for ${url}. Verify local runtime/tool endpoint is running and reachable.`,
        );
      }
      throw new Error(`Request failed for ${url}: ${err.message}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export function makeSessionId(provider: string): string {
  return `${provider}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
