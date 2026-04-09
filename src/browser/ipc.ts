import fs from 'fs';
import path from 'path';

import { logBrowserActionAudit } from '../db.js';
import { BrowserSessionMode, getBrowserManager } from './manager.js';

interface BrowserIpcRequest {
  id: string;
  type: 'browser_request';
  action: string;
  sessionId?: string;
  mode?: BrowserSessionMode;
  profileName?: string;
  owner?: {
    groupFolder: string;
    chatJid: string;
    taskId?: string;
    role: string;
  };
  args?: Record<string, unknown>;
  audit?: {
    approvalRequired?: boolean;
    approved?: boolean;
    summary?: string;
  };
  policy?: {
    allowPersistentSessions?: boolean;
    allowAttachedSessions?: boolean;
    maxTabsPerSession?: number;
    idleTimeoutMs?: number;
  };
}

function writeJsonAtomic(filepath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
}

export async function processBrowserIpcGroup(
  groupIpcDir: string,
): Promise<void> {
  const requestsDir = path.join(groupIpcDir, 'browser', 'requests');
  const responsesDir = path.join(groupIpcDir, 'browser', 'responses');
  if (!fs.existsSync(requestsDir)) return;

  const files = fs
    .readdirSync(requestsDir)
    .filter((file) => file.endsWith('.json'));
  for (const file of files) {
    const requestPath = path.join(requestsDir, file);
    let requestId = path.parse(file).name;
    try {
      const raw = fs.readFileSync(requestPath, 'utf8');
      const request = JSON.parse(raw) as BrowserIpcRequest;
      requestId = request.id || requestId;
      const responsePath = path.join(responsesDir, `${requestId}.json`);
      const manager = getBrowserManager();
      const owner = request.owner || {
        groupFolder: 'unknown',
        chatJid: 'unknown',
        role: 'browser-operator',
      };

      let data: unknown;
      switch (request.action) {
        case 'create_session':
          data = await manager.createSession({
            mode: request.mode || 'ephemeral',
            owner,
            profileName: request.profileName,
            allowPersistentSessions: request.policy?.allowPersistentSessions,
            allowAttachedSessions: request.policy?.allowAttachedSessions,
            maxTabsPerSession: request.policy?.maxTabsPerSession,
            idleTimeoutMs: request.policy?.idleTimeoutMs,
          });
          break;
        case 'close_session':
          if (!request.sessionId) throw new Error('Missing sessionId');
          if (!request.owner) throw new Error('Missing owner');
          await manager.closeSession(request.sessionId, request.owner);
          data = { closed: true };
          break;
        case 'open_url':
          if (!request.sessionId) throw new Error('Missing sessionId');
          if (!request.owner) throw new Error('Missing owner');
          data = await manager.openUrl(
            request.sessionId,
            String(request.args?.url || ''),
            owner,
          );
          break;
        case 'snapshot':
          if (!request.sessionId) throw new Error('Missing sessionId');
          if (!request.owner) throw new Error('Missing owner');
          data = await manager.snapshot(
            request.sessionId,
            Number(request.args?.limit || 30),
            owner,
          );
          break;
        case 'click':
          if (!request.sessionId) throw new Error('Missing sessionId');
          if (!request.owner) throw new Error('Missing owner');
          data = await manager.click(
            request.sessionId,
            String(request.args?.ref || ''),
            Number(request.args?.expectedSnapshotVersion || 0) || undefined,
            owner,
          );
          break;
        case 'type':
          if (!request.sessionId) throw new Error('Missing sessionId');
          if (!request.owner) throw new Error('Missing owner');
          data = await manager.type(
            request.sessionId,
            String(request.args?.ref || ''),
            String(request.args?.text || ''),
            Number(request.args?.expectedSnapshotVersion || 0) || undefined,
            owner,
          );
          break;
        case 'select':
          if (!request.sessionId) throw new Error('Missing sessionId');
          if (!request.owner) throw new Error('Missing owner');
          data = await manager.select(
            request.sessionId,
            String(request.args?.ref || ''),
            String(request.args?.value || ''),
            Number(request.args?.expectedSnapshotVersion || 0) || undefined,
            owner,
          );
          break;
        case 'extract_text':
          if (!request.sessionId) throw new Error('Missing sessionId');
          if (!request.owner) throw new Error('Missing owner');
          data = {
            text: await manager.extractText(
              request.sessionId,
              Number(request.args?.maxChars || 5000),
              owner,
            ),
          };
          break;
        case 'screenshot':
          if (!request.sessionId) throw new Error('Missing sessionId');
          if (!request.owner) throw new Error('Missing owner');
          data = await manager.screenshot(
            request.sessionId,
            request.args?.scope === 'full_page' ? 'full_page' : 'viewport',
            owner,
          );
          break;
        case 'list_tabs':
          if (!request.sessionId) throw new Error('Missing sessionId');
          if (!request.owner) throw new Error('Missing owner');
          data = await manager.listTabsWithState(request.sessionId, owner);
          break;
        case 'focus_tab':
          if (!request.sessionId) throw new Error('Missing sessionId');
          if (!request.owner) throw new Error('Missing owner');
          data = await manager.focusTab(
            request.sessionId,
            String(request.args?.tabId || ''),
            owner,
          );
          break;
        case 'close_tab':
          if (!request.sessionId) throw new Error('Missing sessionId');
          if (!request.owner) throw new Error('Missing owner');
          await manager.closeTab(
            request.sessionId,
            String(request.args?.tabId || ''),
            owner,
          );
          data = { closed: true };
          break;
        default:
          throw new Error(`Unknown browser action: ${request.action}`);
      }

      const state =
        (request.sessionId &&
          manager.getSessionState(request.sessionId, owner)) ||
        (data &&
        typeof data === 'object' &&
        'sessionId' in (data as Record<string, unknown>)
          ? manager.getSessionState(
              String((data as Record<string, unknown>).sessionId),
              owner,
            )
          : undefined);
      logBrowserActionAudit({
        id: `${requestId}-success`,
        action: request.action,
        sessionId: request.sessionId || state?.sessionId,
        owner,
        permissionTier:
          state?.permissionTier ||
          (request.mode === 'persistent'
            ? 'persistent'
            : request.mode === 'attached'
              ? 'attached'
              : 'isolated'),
        timestamp: new Date().toISOString(),
        approvalRequired: request.audit?.approvalRequired === true,
        approved: request.audit?.approved === true,
        summary: request.audit?.summary || request.action,
        outcome: 'success',
      });

      writeJsonAtomic(responsePath, {
        id: requestId,
        ok: true,
        data,
      });
      fs.unlinkSync(requestPath);
    } catch (err) {
      const responsePath = path.join(responsesDir, `${requestId}.json`);
      const owner = (() => {
        try {
          const raw = fs.readFileSync(requestPath, 'utf8');
          const parsed = JSON.parse(raw) as BrowserIpcRequest;
          return (
            parsed.owner || {
              groupFolder: 'unknown',
              chatJid: 'unknown',
              role: 'browser-operator',
            }
          );
        } catch {
          return {
            groupFolder: 'unknown',
            chatJid: 'unknown',
            role: 'browser-operator',
          };
        }
      })();
      logBrowserActionAudit({
        id: `${requestId}-error`,
        action: 'browser_request',
        sessionId: undefined,
        owner,
        permissionTier: 'isolated',
        timestamp: new Date().toISOString(),
        approvalRequired: false,
        approved: false,
        summary: err instanceof Error ? err.message : String(err),
        outcome: 'error',
      });
      writeJsonAtomic(responsePath, {
        id: requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        fs.unlinkSync(requestPath);
      } catch {
        // ignore cleanup failure
      }
    }
  }
}
