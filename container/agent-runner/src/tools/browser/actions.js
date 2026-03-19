import { sendBrowserBridgeRequest } from './host-bridge.js';
function asString(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function asInt(value, fallback) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.floor(value);
    }
    if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return fallback;
}
function remainingBudgetMs(ctx) {
    const elapsed = Date.now() - ctx.startedAtMs;
    return Math.max(0, (ctx.totalBrowserBudgetMs || 0) - elapsed);
}
function browserOwner(ctx) {
    return {
        groupFolder: ctx.secrets?.NANOCLAW_GROUP_FOLDER || 'unknown-group',
        chatJid: ctx.secrets?.NANOCLAW_CHAT_JID || 'unknown-chat',
        role: 'browser-operator',
    };
}
function browserBridgePolicy(ctx) {
    return {
        allowPersistentSessions: ctx.browserPolicy?.allowPersistentSessions,
        allowAttachedSessions: ctx.browserPolicy?.allowAttachedSessions,
        maxTabsPerSession: ctx.browserPolicy?.maxTabsPerSession,
        idleTimeoutMs: ctx.browserPolicy?.idleTimeoutMs,
    };
}
function mutationsApproved(ctx) {
    return (ctx.secrets?.BROWSER_MUTATION_APPROVED || '').trim().toLowerCase() === 'true';
}
function requireApproval(reason, ctx) {
    if (mutationsApproved(ctx))
        return null;
    return {
        ok: false,
        content: `${reason} This browser action requires approval before it can run.`,
    };
}
function markBrowserStep(ctx) {
    const maxSteps = ctx.maxBrowserActionsPerTurn || 0;
    const current = ctx.browserActionCount || 0;
    if (maxSteps > 0 && current >= maxSteps) {
        return { ok: false, content: 'browser action budget exhausted' };
    }
    if ((ctx.totalBrowserBudgetMs || 0) > 0 && remainingBudgetMs(ctx) <= 0) {
        return { ok: false, content: 'browser total budget exhausted' };
    }
    ctx.browserActionCount = current + 1;
    return null;
}
async function ensureBrowserSession(ctx) {
    if (ctx.browserSession?.id)
        return ctx.browserSession.id;
    const requestedMode = (ctx.secrets?.BROWSER_SESSION_MODE || 'ephemeral').trim().toLowerCase() ===
        'persistent'
        ? 'persistent'
        : 'ephemeral';
    const session = await sendBrowserBridgeRequest({
        action: 'create_session',
        mode: requestedMode,
        owner: browserOwner(ctx),
        policy: browserBridgePolicy(ctx),
        timeoutMs: Math.max(2000, remainingBudgetMs(ctx)),
    });
    ctx.browserSession = {
        id: session.sessionId,
        mode: requestedMode,
        snapshotVersion: undefined,
    };
    return session.sessionId;
}
function formatSnapshot(snapshot) {
    const lines = [
        `Page: ${snapshot.title}`,
        `URL: ${snapshot.url}`,
        `Snapshot version: ${snapshot.snapshotVersion}`,
    ];
    if (snapshot.elements.length > 0) {
        lines.push('Interactive elements:');
        for (const element of snapshot.elements.slice(0, 20)) {
            const descriptor = [
                `[ref=${element.ref}]`,
                element.role || element.tag,
                element.text || element.placeholder || element.href || '',
                element.isSubmitLike ? '(submit)' : '',
                element.isFileInputLike ? '(file-input)' : '',
                element.isExternalLike ? '(external)' : '',
            ]
                .filter(Boolean)
                .join(' ');
            lines.push(descriptor.slice(0, 240));
        }
    }
    if (snapshot.textPreview) {
        lines.push('', `Text preview: ${snapshot.textPreview.slice(0, 1200)}`);
    }
    return lines.join('\n');
}
function approvalAudit(action, approvalRequired, approved, summary) {
    return {
        approvalRequired,
        approved,
        summary: `${action}: ${summary}`.slice(0, 240),
    };
}
export async function executeBrowserOpenUrl(args, ctx) {
    const budget = markBrowserStep(ctx);
    if (budget)
        return budget;
    const url = asString(args.url);
    if (!url)
        return { ok: false, content: 'Missing required arg: url' };
    try {
        const sessionId = await ensureBrowserSession(ctx);
        const opened = await sendBrowserBridgeRequest({
            action: 'open_url',
            sessionId,
            owner: browserOwner(ctx),
            policy: browserBridgePolicy(ctx),
            args: { url },
            audit: approvalAudit('open_url', false, false, url),
            timeoutMs: Math.max(2000, remainingBudgetMs(ctx)),
        });
        if (ctx.browserSession)
            ctx.browserSession.snapshotVersion = undefined;
        return {
            ok: true,
            content: `Opened URL: ${opened.url}\nTitle: ${opened.title}`,
        };
    }
    catch (err) {
        return {
            ok: false,
            content: `Browser open failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
export async function executeBrowserSnapshot(args, ctx) {
    const budget = markBrowserStep(ctx);
    if (budget)
        return budget;
    try {
        const sessionId = await ensureBrowserSession(ctx);
        const snapshot = await sendBrowserBridgeRequest({
            action: 'snapshot',
            sessionId,
            owner: browserOwner(ctx),
            policy: browserBridgePolicy(ctx),
            args: { limit: asInt(args.limit, 30) },
            audit: approvalAudit('snapshot', false, false, 'capture page refs'),
            timeoutMs: Math.max(2000, remainingBudgetMs(ctx)),
        });
        if (ctx.browserSession) {
            ctx.browserSession.snapshotVersion = snapshot.snapshotVersion;
        }
        return {
            ok: true,
            content: formatSnapshot(snapshot),
        };
    }
    catch (err) {
        return {
            ok: false,
            content: `Browser snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
async function browserPageAction(action, args, ctx) {
    const budget = markBrowserStep(ctx);
    if (budget)
        return budget;
    const ref = asString(args.ref);
    if (!ref)
        return { ok: false, content: 'Missing required arg: ref' };
    const requiresGenericApproval = ctx.browserPolicy?.requireApprovalForBrowserMutations === true;
    const summary = action === 'click'
        ? `ref=${ref}`
        : action === 'type'
            ? `ref=${ref} text=${asString(args.text).slice(0, 80)}`
            : `ref=${ref} value=${asString(args.value).slice(0, 80)}`;
    const approval = requiresGenericApproval
        ? requireApproval('Browser mutation is policy-gated.', ctx)
        : null;
    if (approval)
        return approval;
    const expectedSnapshotVersion = ctx.browserSession?.snapshotVersion;
    if (!expectedSnapshotVersion) {
        return { ok: false, content: 'Take a browser snapshot before mutating the page.' };
    }
    try {
        const sessionId = await ensureBrowserSession(ctx);
        const payload = action === 'click'
            ? { ref, expectedSnapshotVersion }
            : action === 'type'
                ? { ref, text: asString(args.text), expectedSnapshotVersion }
                : { ref, value: asString(args.value), expectedSnapshotVersion };
        const result = await sendBrowserBridgeRequest({
            action,
            sessionId,
            owner: browserOwner(ctx),
            policy: browserBridgePolicy(ctx),
            args: payload,
            audit: approvalAudit(action, requiresGenericApproval, mutationsApproved(ctx), summary),
            timeoutMs: Math.max(2000, remainingBudgetMs(ctx)),
        });
        if (ctx.browserSession && action !== 'type') {
            ctx.browserSession.snapshotVersion = undefined;
        }
        return {
            ok: true,
            content: `Browser ${action} completed.\nURL: ${result.url}\nTitle: ${result.title}`,
        };
    }
    catch (err) {
        return {
            ok: false,
            content: `Browser ${action} failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
export function executeBrowserClick(args, ctx) {
    return browserPageAction('click', args, ctx);
}
export function executeBrowserType(args, ctx) {
    return browserPageAction('type', args, ctx);
}
export function executeBrowserSelect(args, ctx) {
    return browserPageAction('select', args, ctx);
}
export async function executeBrowserExtractText(args, ctx) {
    const budget = markBrowserStep(ctx);
    if (budget)
        return budget;
    try {
        const sessionId = await ensureBrowserSession(ctx);
        const result = await sendBrowserBridgeRequest({
            action: 'extract_text',
            sessionId,
            owner: browserOwner(ctx),
            policy: browserBridgePolicy(ctx),
            args: { maxChars: asInt(args.max_chars, 5000) },
            audit: approvalAudit('extract_text', false, false, 'extract current page text'),
            timeoutMs: Math.max(2000, remainingBudgetMs(ctx)),
        });
        return {
            ok: true,
            content: result.text,
        };
    }
    catch (err) {
        return {
            ok: false,
            content: `Browser extract_text failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
export async function executeBrowserTabs(args, ctx) {
    const budget = markBrowserStep(ctx);
    if (budget)
        return budget;
    try {
        const sessionId = await ensureBrowserSession(ctx);
        const action = asString(args.action) || 'list';
        if (action === 'list') {
            const result = await sendBrowserBridgeRequest({
                action: 'list_tabs',
                sessionId,
                owner: browserOwner(ctx),
                policy: browserBridgePolicy(ctx),
                audit: approvalAudit('list_tabs', false, false, 'list browser tabs'),
                timeoutMs: Math.max(2000, remainingBudgetMs(ctx)),
            });
            const header = `Session: ${result.session.mode} | tabs=${result.session.tabCount}`;
            const lines = result.tabs.map((tab) => `${tab.active ? '*' : '-'} [${tab.tabId}] ${tab.title} | ${tab.url}`);
            return {
                ok: true,
                content: [header, ...(lines.length > 0 ? lines : ['No tabs open.'])].join('\n'),
            };
        }
        if (action === 'focus') {
            const tabId = asString(args.tab_id);
            const result = await sendBrowserBridgeRequest({
                action: 'focus_tab',
                sessionId,
                owner: browserOwner(ctx),
                policy: browserBridgePolicy(ctx),
                args: { tabId },
                audit: approvalAudit('focus_tab', false, false, `tab=${tabId}`),
                timeoutMs: Math.max(2000, remainingBudgetMs(ctx)),
            });
            if (ctx.browserSession)
                ctx.browserSession.snapshotVersion = undefined;
            return { ok: true, content: `Focused tab ${tabId}: ${result.title} | ${result.url}` };
        }
        if (action === 'close') {
            const tabId = asString(args.tab_id);
            await sendBrowserBridgeRequest({
                action: 'close_tab',
                sessionId,
                owner: browserOwner(ctx),
                policy: browserBridgePolicy(ctx),
                args: { tabId },
                audit: approvalAudit('close_tab', false, false, `tab=${tabId}`),
                timeoutMs: Math.max(2000, remainingBudgetMs(ctx)),
            });
            if (ctx.browserSession)
                ctx.browserSession.snapshotVersion = undefined;
            return { ok: true, content: `Closed tab ${tabId}.` };
        }
        return { ok: false, content: `Unsupported browser_tabs action "${action}"` };
    }
    catch (err) {
        return {
            ok: false,
            content: `Browser tabs failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
export async function executeBrowserClose(_args, ctx) {
    if (!ctx.browserSession?.id) {
        return { ok: true, content: 'No browser session is currently open.' };
    }
    try {
        await sendBrowserBridgeRequest({
            action: 'close_session',
            sessionId: ctx.browserSession.id,
            owner: browserOwner(ctx),
            policy: browserBridgePolicy(ctx),
            audit: approvalAudit('close_session', false, false, 'close browser session'),
            timeoutMs: 5000,
        });
        ctx.browserSession = undefined;
        return { ok: true, content: 'Closed browser session.' };
    }
    catch (err) {
        return {
            ok: false,
            content: `Browser close failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
export async function executeBrowserScreenshot(args, ctx) {
    const budget = markBrowserStep(ctx);
    if (budget)
        return budget;
    try {
        const sessionId = await ensureBrowserSession(ctx);
        const scope = asString(args.scope) === 'full_page' ? 'full_page' : 'viewport';
        const result = await sendBrowserBridgeRequest({
            action: 'screenshot',
            sessionId,
            owner: browserOwner(ctx),
            policy: browserBridgePolicy(ctx),
            args: { scope },
            audit: approvalAudit('screenshot', false, false, scope),
            timeoutMs: Math.max(2000, remainingBudgetMs(ctx)),
        });
        return {
            ok: true,
            content: `Browser screenshot saved.\nURL: ${result.url}\nTitle: ${result.title}\nScope: ${result.scope}\nPath: ${result.path}`,
        };
    }
    catch (err) {
        return {
            ok: false,
            content: `Browser screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
export async function closeBrowserSessionFromContext(ctx) {
    if (!ctx.browserSession?.id)
        return;
    await sendBrowserBridgeRequest({
        action: 'close_session',
        sessionId: ctx.browserSession.id,
        owner: browserOwner(ctx),
        policy: browserBridgePolicy(ctx),
        audit: approvalAudit('close_session', false, false, 'cleanup'),
        timeoutMs: 5000,
    });
    ctx.browserSession = undefined;
}
//# sourceMappingURL=actions.js.map