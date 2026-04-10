export declare function sendBrowserBridgeRequest<T>(input: {
    action: string;
    sessionId?: string;
    mode?: 'ephemeral' | 'persistent' | 'attached';
    profileName?: string;
    owner?: {
        groupFolder: string;
        chatJid: string;
        taskId?: string;
        role: string;
    };
    args?: Record<string, unknown>;
    policy?: {
        allowPersistentSessions?: boolean;
        allowAttachedSessions?: boolean;
    };
    audit?: {
        approvalRequired?: boolean;
        approved?: boolean;
        summary?: string;
    };
    timeoutMs?: number;
}): Promise<T>;
//# sourceMappingURL=host-bridge.d.ts.map