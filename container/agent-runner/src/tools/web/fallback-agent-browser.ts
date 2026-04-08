import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

async function runAgentBrowser(
  args: string[],
  timeoutMs: number,
): Promise<string> {
  const { stdout } = await execFileAsync('agent-browser', args, {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

export async function runAgentBrowserFallback(input: {
  action: string;
  url?: string;
  query?: string;
  timeoutMs: number;
}): Promise<{ ok: boolean; content: string }> {
  try {
    if (input.action === 'search') {
      const query = input.query?.trim() || '';
      const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
      await runAgentBrowser(['open', url], input.timeoutMs);
      const snapshot = await runAgentBrowser(
        ['snapshot', '-c', '-d', '3'],
        input.timeoutMs,
      );
      return {
        ok: true,
        content: snapshot.slice(0, 5000),
      };
    }

    if (input.action === 'open' && input.url) {
      await runAgentBrowser(['open', input.url], input.timeoutMs);
      const snapshot = await runAgentBrowser(
        ['snapshot', '-c', '-d', '3'],
        input.timeoutMs,
      );
      return {
        ok: true,
        content: snapshot.slice(0, 5000),
      };
    }

    return {
      ok: false,
      content: 'agent-browser fallback is only available for search/open actions',
    };
  } catch (err) {
    return {
      ok: false,
      content: err instanceof Error ? err.message : String(err),
    };
  }
}

