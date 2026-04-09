import { spawn } from 'child_process';
import path from 'path';

type ProbeOutput = {
  status?: string;
  result?: string | null;
  error?: string;
  newSessionId?: string;
};

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function parseOutput(stdout: string): ProbeOutput | null {
  const start = stdout.indexOf(OUTPUT_START_MARKER);
  const end = stdout.indexOf(OUTPUT_END_MARKER);
  if (start !== -1 && end !== -1 && end > start) {
    const jsonText = stdout
      .slice(start + OUTPUT_START_MARKER.length, end)
      .trim();
    return JSON.parse(jsonText) as ProbeOutput;
  }

  const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
  return lastLine ? (JSON.parse(lastLine) as ProbeOutput) : null;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const runnerPath = path.join(
    root,
    'container',
    'agent-runner',
    'dist',
    'index.js',
  );
  const groupFolder = process.env.PROBE_GROUP_FOLDER || 'discord_dm';
  const chatJid =
    process.env.PROBE_CHAT_JID || 'dc:1473668401544167446';
  const prompt =
    process.env.PROBE_PROMPT ||
    'log into the dashboard of vibelevel.ai and check what their product is about';

  const payload = {
    prompt,
    groupFolder,
    chatJid,
    isMain: false,
    assistantName: 'Andy',
    runtimeConfig: {
      provider: 'openai_compatible',
      model: process.env.PROBE_MODEL || 'qwen/qwen3-8b',
      baseUrl: process.env.PROBE_BASE_URL || 'http://127.0.0.1:1234/v1',
      capabilityRoute: 'browser_operation',
      toolPolicy: {
        web: { enabled: true },
        browser: { enabled: true },
      },
      capabilities: {
        supportsResponses: false,
        supportsChatCompletions: true,
        supportsTools: true,
        supportsStreaming: false,
        requiresApiKey: false,
        checkedAt: new Date().toISOString(),
      },
    },
    secrets: {
      WEB_SEARCH_PROVIDER: 'auto',
      NANOCLAW_GROUP_FOLDER: groupFolder,
      NANOCLAW_CHAT_JID: chatJid,
      OPENAI_REQUEST_TIMEOUT_MS: '30000',
    },
  };

  const proc = spawn(process.execPath, [runnerPath], {
    cwd: root,
    env: {
      ...process.env,
      NANOCLAW_IPC_INPUT_DIR: path.join(root, 'data', 'ipc', groupFolder, 'input'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();

  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => resolve(code ?? 0));
  });

  const parsed = parseOutput(stdout);
  console.log(`exitCode: ${exitCode}`);
  console.log('');
  console.log('stderr tail:');
  console.log(stderr.trim().slice(-2000) || '(empty)');
  console.log('');
  console.log('parsed output:');
  console.log(JSON.stringify(parsed, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
