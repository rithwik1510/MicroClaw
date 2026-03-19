import fs from 'fs';
import os from 'os';
import path from 'path';
function browserIpcBaseDir() {
    const inputDir = process.env.NANOCLAW_IPC_INPUT_DIR;
    if (inputDir) {
        return path.resolve(inputDir, '..', 'browser');
    }
    return path.join(os.tmpdir(), 'nanoclaw-browser-ipc');
}
function writeJsonAtomic(filepath, data) {
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    const tempPath = `${filepath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, filepath);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export async function sendBrowserBridgeRequest(input) {
    const baseDir = browserIpcBaseDir();
    const requestsDir = path.join(baseDir, 'requests');
    const responsesDir = path.join(baseDir, 'responses');
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestPath = path.join(requestsDir, `${id}.json`);
    const responsePath = path.join(responsesDir, `${id}.json`);
    writeJsonAtomic(requestPath, {
        id,
        type: 'browser_request',
        action: input.action,
        sessionId: input.sessionId,
        mode: input.mode,
        profileName: input.profileName,
        owner: input.owner,
        args: input.args,
        policy: input.policy,
        audit: input.audit,
        timestamp: new Date().toISOString(),
    });
    const timeoutMs = Math.max(1000, input.timeoutMs || 15_000);
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (fs.existsSync(responsePath)) {
            const raw = fs.readFileSync(responsePath, 'utf8');
            fs.unlinkSync(responsePath);
            const response = JSON.parse(raw);
            if (!response.ok) {
                throw new Error(response.error || 'Browser bridge request failed');
            }
            return response.data;
        }
        await sleep(100);
    }
    throw new Error(`Browser bridge timed out waiting for ${input.action}`);
}
//# sourceMappingURL=host-bridge.js.map