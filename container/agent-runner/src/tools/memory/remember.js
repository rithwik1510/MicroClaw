import fs from 'fs';
import path from 'path';
const VALID_KINDS = ['pref', 'fact', 'proj', 'loop', 'explicit'];
function resolveMemoryIpcDir() {
    // NANOCLAW_IPC_INPUT_DIR points to {ipcDir}/input — memory dir is a sibling
    const inputDir = process.env.NANOCLAW_IPC_INPUT_DIR || '/workspace/ipc/input';
    return path.join(path.dirname(inputDir), 'memory');
}
function writeIpcFile(dir, data) {
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    const tempPath = path.join(dir, `${filename}.tmp`);
    const finalPath = path.join(dir, filename);
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, finalPath);
}
export async function executeRememberThis(args, _ctx) {
    const content = typeof args.content === 'string' ? args.content.trim() : '';
    if (!content) {
        return { ok: false, content: 'content is required.' };
    }
    if (content.length > 500) {
        return {
            ok: false,
            content: 'Content too long — keep memories concise (under 500 chars).',
        };
    }
    const rawKind = typeof args.kind === 'string' ? args.kind : 'explicit';
    const kind = VALID_KINDS.includes(rawKind)
        ? rawKind
        : 'explicit';
    const pinned = args.pin === true;
    const groupFolder = process.env.NANOCLAW_GROUP_FOLDER ||
        _ctx.secrets?.NANOCLAW_GROUP_FOLDER ||
        '';
    try {
        const memoryDir = resolveMemoryIpcDir();
        writeIpcFile(memoryDir, {
            type: 'remember_this',
            content,
            kind,
            pinned,
            groupFolder,
            scope: 'group',
            timestamp: new Date().toISOString(),
        });
    }
    catch (err) {
        return {
            ok: false,
            content: `Failed to save memory: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
    const preview = content.length > 80 ? `${content.slice(0, 80)}...` : content;
    const pinnedNote = pinned ? ' (pinned — always included)' : '';
    return {
        ok: true,
        content: `Remembered [${kind}]${pinnedNote}: "${preview}"`,
    };
}
//# sourceMappingURL=remember.js.map