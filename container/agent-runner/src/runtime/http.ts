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

export async function postJsonStream(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  onEvent: (payload: unknown) => Promise<void> | void,
  timeoutMs = 120000,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const decoder = new TextDecoder();
  let sseBuffer = '';

  const flushBuffer = async (flushAll = false): Promise<void> => {
    const delimiter = '\n\n';
    while (true) {
      const boundary = sseBuffer.indexOf(delimiter);
      if (boundary === -1) break;
      const rawEvent = sseBuffer.slice(0, boundary);
      sseBuffer = sseBuffer.slice(boundary + delimiter.length);
      await emitSseEvent(rawEvent);
    }
    if (flushAll && sseBuffer.trim()) {
      const rawEvent = sseBuffer;
      sseBuffer = '';
      await emitSseEvent(rawEvent);
    }
  };

  const emitSseEvent = async (rawEvent: string): Promise<void> => {
    const dataLines = rawEvent
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);

    for (const data of dataLines) {
      if (data === '[DONE]') continue;
      try {
        await onEvent(JSON.parse(data));
      } catch {
        // Ignore malformed stream fragments and continue consuming.
      }
    }
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    if (!res.body) {
      throw new Error(`Streaming response body missing for ${url}`);
    }

    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      await flushBuffer();
    }
    sseBuffer += decoder.decode();
    await flushBuffer(true);
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
