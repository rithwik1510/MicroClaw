import fs from 'fs';
import path from 'path';
const DEFAULT_HEARTBEAT_TEMPLATE = [
    '# Heartbeat Checklist',
    '',
    '## Watch / reminder items',
    '',
    '## Notes',
    '- Prefer silence when nothing actionable is true.',
    '- Notify only for explicit watch, reminder, or notify-worthy items.',
    '',
].join('\n');
function resolveHeartbeatFilePath() {
    const groupDir = process.env.NANOCLAW_GROUP_WORKSPACE_DIR ||
        (typeof process.cwd === 'function' &&
            typeof process.env.NANOCLAW_GROUP_FOLDER === 'string' &&
            process.env.NANOCLAW_GROUP_FOLDER.trim()
            ? path.join(process.cwd(), 'groups', process.env.NANOCLAW_GROUP_FOLDER)
            : '/workspace/group');
    return path.join(groupDir, 'HEARTBEAT.md');
}
function normalizeInstruction(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    return raw.replace(/^[-*]\s+/, '').replace(/\s+/g, ' ').trim();
}
function insertWatchInstruction(existing, instruction) {
    const bullet = `- ${instruction}`;
    if (existing.includes(bullet))
        return existing;
    const sectionMatch = existing.match(/^## Watch \/ reminder items\s*$/m);
    if (!sectionMatch || sectionMatch.index === undefined) {
        const base = existing.trimEnd();
        return [
            base,
            '',
            '## Watch / reminder items',
            bullet,
            '',
        ]
            .filter(Boolean)
            .join('\n');
    }
    const sectionStart = sectionMatch.index + sectionMatch[0].length;
    const remainder = existing.slice(sectionStart);
    const nextHeadingMatch = remainder.match(/\n##\s+/);
    const insertAt = nextHeadingMatch
        ? sectionStart + (nextHeadingMatch.index ?? 0)
        : existing.length;
    const before = existing.slice(0, insertAt).replace(/\s*$/, '');
    const after = existing.slice(insertAt).replace(/^\s*/, '\n');
    return `${before}\n${bullet}\n${after}`.replace(/\n{3,}/g, '\n\n');
}
export async function executeRegisterWatch(args, _ctx) {
    const instruction = normalizeInstruction(args.instruction);
    if (!instruction) {
        return { ok: false, content: 'instruction is required.' };
    }
    if (instruction.length > 400) {
        return {
            ok: false,
            content: 'Instruction too long. Keep heartbeat watches under 400 characters.',
        };
    }
    const heartbeatPath = resolveHeartbeatFilePath();
    try {
        const existing = fs.existsSync(heartbeatPath)
            ? fs.readFileSync(heartbeatPath, 'utf8')
            : DEFAULT_HEARTBEAT_TEMPLATE;
        const updated = insertWatchInstruction(existing, instruction);
        fs.mkdirSync(path.dirname(heartbeatPath), { recursive: true });
        fs.writeFileSync(heartbeatPath, updated.endsWith('\n') ? updated : `${updated}\n`);
    }
    catch (err) {
        return {
            ok: false,
            content: `Failed to register heartbeat watch: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
    return {
        ok: true,
        content: `Registered heartbeat watch: "${instruction}"`,
    };
}
//# sourceMappingURL=watch.js.map