import fs from 'fs';
import path from 'path';

import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';

import { DATA_DIR } from '../config.js';
import { BrowserPermissionTier } from '../types.js';

export type BrowserSessionMode = 'ephemeral' | 'persistent' | 'attached';

export interface BrowserSessionOwner {
  groupFolder: string;
  chatJid: string;
  taskId?: string;
  role: string;
}

export interface BrowserSessionState {
  sessionId: string;
  mode: BrowserSessionMode;
  permissionTier: BrowserPermissionTier;
  owner: BrowserSessionOwner;
  createdAt: string;
  lastActiveAt: string;
  tabCount: number;
  profileName?: string;
  status?: 'active' | 'idle';
}

interface BrowserSessionRecord {
  sessionId: string;
  mode: BrowserSessionMode;
  permissionTier: BrowserPermissionTier;
  owner: BrowserSessionOwner;
  createdAt: string;
  lastActiveAt: string;
  profileName?: string;
  browser?: Browser;
  context: BrowserContext;
  maxTabsPerSession: number;
  idleTimeoutMs: number;
  currentSnapshotVersion?: number;
  operationChain: Promise<void>;
}

export interface BrowserPageSnapshot {
  title: string;
  url: string;
  snapshotVersion: number;
  elements: Array<{
    ref: string;
    tag: string;
    role: string;
    text: string;
    type?: string;
    href?: string;
    placeholder?: string;
    isSubmitLike?: boolean;
    isNavigationLike?: boolean;
    isExternalLike?: boolean;
    isFileInputLike?: boolean;
  }>;
  textPreview: string;
}

export interface BrowserScreenshotResult {
  title: string;
  url: string;
  path: string;
  scope: 'viewport' | 'full_page';
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeSegment(input: string): string {
  return (
    input
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'default'
  );
}

function buildSessionId(owner: BrowserSessionOwner): string {
  return [
    sanitizeSegment(owner.groupFolder),
    sanitizeSegment(owner.role),
    Date.now().toString(36),
    Math.random().toString(36).slice(2, 8),
  ].join('-');
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function headlessEnabled(): boolean {
  return (
    (process.env.NANOCLAW_BROWSER_HEADLESS || 'true').trim().toLowerCase() !==
    'false'
  );
}

function maxSessionsGlobal(): number {
  const parsed = Number.parseInt(
    process.env.NANOCLAW_BROWSER_MAX_CONCURRENT_SESSIONS || '',
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
}

function browserNavigationTimeoutMs(): number {
  const parsed = Number.parseInt(
    process.env.NANOCLAW_BROWSER_NAVIGATION_TIMEOUT_MS || '',
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 45_000;
}

function browserActionTimeoutMs(): number {
  const parsed = Number.parseInt(
    process.env.NANOCLAW_BROWSER_ACTION_TIMEOUT_MS || '',
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20_000;
}

function applyContextTimeouts(context: BrowserContext): void {
  const navTimeout = browserNavigationTimeoutMs();
  const actionTimeout = browserActionTimeoutMs();
  const maybeContext = context as BrowserContext & {
    setDefaultNavigationTimeout?: (timeout: number) => void;
    setDefaultTimeout?: (timeout: number) => void;
  };
  maybeContext.setDefaultNavigationTimeout?.(navTimeout);
  maybeContext.setDefaultTimeout?.(actionTimeout);
}

function ownersMatch(
  left: BrowserSessionOwner | undefined,
  right: BrowserSessionOwner | undefined,
): boolean {
  if (!left || !right) return false;
  return (
    left.groupFolder === right.groupFolder &&
    left.chatJid === right.chatJid &&
    (left.taskId || '') === (right.taskId || '') &&
    left.role === right.role
  );
}

function permissionTierForMode(
  mode: BrowserSessionMode,
): BrowserPermissionTier {
  if (mode === 'persistent') return 'persistent';
  if (mode === 'attached') return 'attached';
  return 'isolated';
}

function screenshotsDir(): string {
  const dir = path.join(DATA_DIR, 'browser-screenshots');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export class BrowserManager {
  private readonly sessions = new Map<string, BrowserSessionRecord>();

  listSessions(): BrowserSessionState[] {
    return [...this.sessions.values()].map((session) => ({
      sessionId: session.sessionId,
      mode: session.mode,
      permissionTier: session.permissionTier,
      owner: session.owner,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      tabCount: session.context.pages().length,
      profileName: session.profileName,
      status: 'active',
    }));
  }

  async createSession(input: {
    mode: BrowserSessionMode;
    owner: BrowserSessionOwner;
    profileName?: string;
    allowPersistentSessions?: boolean;
    allowAttachedSessions?: boolean;
    maxTabsPerSession?: number;
    idleTimeoutMs?: number;
  }): Promise<BrowserSessionState> {
    await this.reapIdleSessions();
    if (this.sessions.size >= maxSessionsGlobal()) {
      throw new Error('Browser session cap reached');
    }
    if (input.mode === 'attached') {
      if (!input.allowAttachedSessions) {
        throw new Error('Attached browser sessions are disabled by policy');
      }
      throw new Error('Attached browser sessions are not implemented yet');
    }
    if (input.mode === 'persistent' && !input.allowPersistentSessions) {
      throw new Error('Persistent browser sessions are disabled by policy');
    }

    const sessionId = buildSessionId(input.owner);
    const createdAt = nowIso();
    const permissionTier = permissionTierForMode(input.mode);
    const maxTabsPerSession =
      input.maxTabsPerSession && input.maxTabsPerSession > 0
        ? input.maxTabsPerSession
        : 3;
    const idleTimeoutMs =
      input.idleTimeoutMs && input.idleTimeoutMs > 0
        ? input.idleTimeoutMs
        : 300_000;
    let browser: Browser | undefined;
    let context: BrowserContext;

    if (input.mode === 'persistent') {
      const profileName = sanitizeSegment(
        input.profileName || input.owner.groupFolder,
      );
      const profileDir = path.join(DATA_DIR, 'browser-profiles', profileName);
      fs.mkdirSync(profileDir, { recursive: true });
      context = await chromium.launchPersistentContext(profileDir, {
        headless: headlessEnabled(),
      });
      applyContextTimeouts(context);
      const session: BrowserSessionRecord = {
        sessionId,
        mode: input.mode,
        permissionTier,
        owner: input.owner,
        createdAt,
        lastActiveAt: createdAt,
        profileName,
        context,
        maxTabsPerSession,
        idleTimeoutMs,
        operationChain: Promise.resolve(),
      };
      this.sessions.set(sessionId, session);
      if (context.pages().length === 0) await context.newPage();
      await this.enforceTabCap(session);
      return this.toState(session);
    }

    browser = await chromium.launch({
      headless: headlessEnabled(),
    });
    context = await browser.newContext();
    applyContextTimeouts(context);
    await context.newPage();
    const session: BrowserSessionRecord = {
      sessionId,
      mode: input.mode,
      permissionTier,
      owner: input.owner,
      createdAt,
      lastActiveAt: createdAt,
      context,
      browser,
      maxTabsPerSession,
      idleTimeoutMs,
      operationChain: Promise.resolve(),
    };
    this.sessions.set(sessionId, session);
    await this.enforceTabCap(session);
    return this.toState(session);
  }

  async closeSession(
    sessionId: string,
    owner?: BrowserSessionOwner,
  ): Promise<void> {
    await this.reapIdleSessions();
    const session = this.requireSession(sessionId, owner);
    this.sessions.delete(sessionId);
    await session.context.close();
    await session.browser?.close();
  }

  async openUrl(
    sessionId: string,
    url: string,
    owner?: BrowserSessionOwner,
  ): Promise<{ title: string; url: string }> {
    return this.runSessionOperation(sessionId, owner, async () => {
      const page = await this.activePage(sessionId, owner);
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: browserNavigationTimeoutMs(),
      });
      this.invalidateSnapshot(sessionId, owner);
      return this.pageInfo(sessionId, page, owner);
    });
  }

  async snapshot(
    sessionId: string,
    limit = 30,
    owner?: BrowserSessionOwner,
  ): Promise<BrowserPageSnapshot> {
    return this.runSessionOperation(sessionId, owner, async () => {
      const page = await this.activePage(sessionId, owner);
      const snapshot = await page.evaluate((maxItems) => {
        const doc = (globalThis as { document?: any }).document;
        const win = (globalThis as { window?: any }).window;
        if (!doc || !win) {
          return {
            title: '(unavailable)',
            url: '',
            snapshotVersion: 0,
            elements: [],
            textPreview: '',
          };
        }

        const priorRefs = Array.from(
          doc.querySelectorAll('[data-microclaw-ref]'),
        ) as any[];
        for (const el of priorRefs) {
          el.removeAttribute('data-microclaw-ref');
        }

        const rawNodes = Array.from(
          doc.querySelectorAll(
            'a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[contenteditable="true"]',
          ),
        ) as any[];
        const nodes: any[] = [];
        for (const el of rawNodes) {
          const style = win.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') {
            continue;
          }
          const rect = el.getBoundingClientRect?.();
          if (!rect || rect.width <= 0 || rect.height <= 0) {
            continue;
          }
          nodes.push(el);
          if (nodes.length >= maxItems) break;
        }

        const elements = nodes.map((el, index) => {
          const ref = String(index + 1);
          el.setAttribute('data-microclaw-ref', ref);
          const tag = el.tagName.toLowerCase();
          const role =
            el.getAttribute('role') ||
            (tag === 'a'
              ? 'link'
              : tag === 'button'
                ? 'button'
                : tag === 'input'
                  ? 'input'
                  : tag);
          const text = (el.textContent || el.value || '').trim();
          const href =
            typeof el.href === 'string' && el.tagName?.toLowerCase() === 'a'
              ? el.href
              : undefined;
          const placeholder =
            'placeholder' in el && typeof el.placeholder === 'string'
              ? el.placeholder
              : undefined;
          const type =
            el.tagName?.toLowerCase() === 'input'
              ? el.type || undefined
              : undefined;
          const isSubmitLike =
            tag === 'button'
              ? /\bsubmit\b/i.test(el.type || '') ||
                /\b(submit|save|send|post|apply|checkout)\b/i.test(text)
              : tag === 'input'
                ? /\bsubmit\b/i.test(type || '')
                : false;
          const isNavigationLike =
            tag === 'a' ||
            /\b(link|navigation)\b/i.test(role) ||
            /^https?:\/\//i.test(href || '');
          let isExternalLike = false;
          if (
            typeof href === 'string' &&
            typeof win.location?.hostname === 'string' &&
            href.length > 0
          ) {
            try {
              isExternalLike =
                new URL(href, win.location.href).hostname !==
                win.location.hostname;
            } catch {
              isExternalLike = false;
            }
          }
          const isFileInputLike =
            tag === 'input' && /\bfile\b/i.test(type || '');
          return {
            ref,
            tag,
            role,
            text,
            href,
            placeholder,
            type,
            isSubmitLike,
            isNavigationLike,
            isExternalLike,
            isFileInputLike,
          };
        });

        return {
          title: doc.title || '(untitled)',
          url: win.location?.href || '',
          elements,
          textPreview: (doc.body?.innerText || '').replace(/\s+/g, ' ').trim(),
        };
      }, limit);

      const version = this.markSnapshot(sessionId, owner);
      this.touchSession(sessionId, owner);
      return {
        title: snapshot.title,
        url: snapshot.url,
        snapshotVersion: version,
        elements: snapshot.elements,
        textPreview: snapshot.textPreview.slice(0, 4000),
      };
    });
  }

  async click(
    sessionId: string,
    ref: string,
    expectedSnapshotVersion?: number,
    owner?: BrowserSessionOwner,
  ): Promise<{ title: string; url: string }> {
    return this.runSessionOperation(sessionId, owner, async () => {
      this.requireCurrentSnapshot(sessionId, expectedSnapshotVersion, owner);
      const page = await this.activePage(sessionId, owner);
      const locator = page.locator(`[data-microclaw-ref="${ref}"]`).first();
      if ((await locator.count()) === 0) {
        throw new Error('Stale or unknown browser ref; take a new snapshot');
      }
      await locator.click({ timeout: browserActionTimeoutMs() });
      this.invalidateSnapshot(sessionId, owner);
      return this.pageInfo(sessionId, page, owner);
    });
  }

  async type(
    sessionId: string,
    ref: string,
    text: string,
    expectedSnapshotVersion?: number,
    owner?: BrowserSessionOwner,
  ): Promise<{ title: string; url: string }> {
    return this.runSessionOperation(sessionId, owner, async () => {
      this.requireCurrentSnapshot(sessionId, expectedSnapshotVersion, owner);
      const page = await this.activePage(sessionId, owner);
      const locator = page.locator(`[data-microclaw-ref="${ref}"]`).first();
      if ((await locator.count()) === 0) {
        throw new Error('Stale or unknown browser ref; take a new snapshot');
      }
      await locator.fill(text, { timeout: browserActionTimeoutMs() });
      return this.pageInfo(sessionId, page, owner);
    });
  }

  async select(
    sessionId: string,
    ref: string,
    value: string,
    expectedSnapshotVersion?: number,
    owner?: BrowserSessionOwner,
  ): Promise<{ title: string; url: string }> {
    return this.runSessionOperation(sessionId, owner, async () => {
      this.requireCurrentSnapshot(sessionId, expectedSnapshotVersion, owner);
      const page = await this.activePage(sessionId, owner);
      const locator = page.locator(`[data-microclaw-ref="${ref}"]`).first();
      if ((await locator.count()) === 0) {
        throw new Error('Stale or unknown browser ref; take a new snapshot');
      }
      try {
        await locator.selectOption(
          { label: value },
          { timeout: browserActionTimeoutMs() },
        );
      } catch {
        await locator.selectOption(value, {
          timeout: browserActionTimeoutMs(),
        });
      }
      this.invalidateSnapshot(sessionId, owner);
      return this.pageInfo(sessionId, page, owner);
    });
  }

  async extractText(
    sessionId: string,
    maxChars = 5000,
    owner?: BrowserSessionOwner,
  ): Promise<string> {
    return this.runSessionOperation(sessionId, owner, async () => {
      const page = await this.activePage(sessionId, owner);
      const text = await page.evaluate(() => {
        const doc = (globalThis as { document?: any }).document;
        return (doc?.body?.innerText || '').replace(/\s+/g, ' ').trim();
      });
      this.touchSession(sessionId, owner);
      return normalizeText(text).slice(0, maxChars);
    });
  }

  async screenshot(
    sessionId: string,
    scope: 'viewport' | 'full_page' = 'viewport',
    owner?: BrowserSessionOwner,
  ): Promise<BrowserScreenshotResult> {
    return this.runSessionOperation(sessionId, owner, async () => {
      const page = await this.activePage(sessionId, owner);
      const filename = `${sessionId}-${Date.now()}-${scope}.png`;
      const outputPath = path.join(screenshotsDir(), filename);
      await page.screenshot({
        path: outputPath,
        fullPage: scope === 'full_page',
        type: 'png',
      });
      const info = await this.pageInfo(sessionId, page, owner);
      return {
        title: info.title,
        url: info.url,
        path: outputPath,
        scope,
      };
    });
  }

  async listTabs(
    sessionId: string,
    owner?: BrowserSessionOwner,
  ): Promise<
    Array<{
      tabId: string;
      title: string;
      url: string;
      active: boolean;
    }>
  > {
    const result = await this.listTabsWithState(sessionId, owner);
    return result.tabs;
  }

  async listTabsWithState(
    sessionId: string,
    owner?: BrowserSessionOwner,
  ): Promise<{
    session: BrowserSessionState;
    tabs: Array<{
      tabId: string;
      title: string;
      url: string;
      active: boolean;
    }>;
  }> {
    return this.runSessionOperation(sessionId, owner, async () => {
      await this.reapIdleSessions();
      const session = this.requireSession(sessionId, owner);
      await this.enforceTabCap(session);
      const activePage = await this.activePage(sessionId, owner);
      this.touchSession(sessionId, owner);
      return {
        session: this.toState(session),
        tabs: await Promise.all(
          session.context.pages().map(async (page, index) => ({
            tabId: String(index),
            title: (await page.title()) || '(untitled)',
            url: page.url(),
            active: page === activePage,
          })),
        ),
      };
    });
  }

  async focusTab(
    sessionId: string,
    tabId: string,
    owner?: BrowserSessionOwner,
  ): Promise<{ title: string; url: string }> {
    return this.runSessionOperation(sessionId, owner, async () => {
      await this.reapIdleSessions();
      const session = this.requireSession(sessionId, owner);
      await this.enforceTabCap(session);
      const index = Number.parseInt(tabId, 10);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= session.context.pages().length
      ) {
        throw new Error(`Unknown tab id: ${tabId}`);
      }
      const page = session.context.pages()[index]!;
      await page.bringToFront();
      this.invalidateSnapshot(sessionId, owner);
      return this.pageInfo(sessionId, page, owner);
    });
  }

  async closeTab(
    sessionId: string,
    tabId: string,
    owner?: BrowserSessionOwner,
  ): Promise<void> {
    await this.runSessionOperation(sessionId, owner, async () => {
      await this.reapIdleSessions();
      const session = this.requireSession(sessionId, owner);
      const index = Number.parseInt(tabId, 10);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= session.context.pages().length
      ) {
        throw new Error(`Unknown tab id: ${tabId}`);
      }
      const page = session.context.pages()[index]!;
      await page.close();
      if (session.context.pages().length === 0) {
        await session.context.newPage();
      }
      await this.enforceTabCap(session);
      this.invalidateSnapshot(sessionId, owner);
      this.touchSession(sessionId, owner);
    });
  }

  getSessionState(
    sessionId: string,
    owner?: BrowserSessionOwner,
  ): BrowserSessionState | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (owner && !ownersMatch(session.owner, owner)) return undefined;
    return this.toState(session);
  }

  private async activePage(
    sessionId: string,
    owner?: BrowserSessionOwner,
  ): Promise<Page> {
    await this.reapIdleSessions();
    const session = this.requireSession(sessionId, owner);
    await this.enforceTabCap(session);
    const page =
      session.context.pages()[0] || (await session.context.newPage());
    this.touchSession(sessionId, owner);
    return page;
  }

  private async pageInfo(
    sessionId: string,
    page: Page,
    owner?: BrowserSessionOwner,
  ): Promise<{ title: string; url: string }> {
    const session = this.requireSession(sessionId, owner);
    await this.enforceTabCap(session);
    this.touchSession(sessionId, owner);
    return {
      title: (await page.title()) || '(untitled)',
      url: page.url(),
    };
  }

  private requireSession(
    sessionId: string,
    owner?: BrowserSessionOwner,
  ): BrowserSessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown browser session: ${sessionId}`);
    }
    if (owner && !ownersMatch(session.owner, owner)) {
      throw new Error('Browser session is owned by another task/chat');
    }
    return session;
  }

  private touchSession(sessionId: string, owner?: BrowserSessionOwner): void {
    const session = this.requireSession(sessionId, owner);
    session.lastActiveAt = nowIso();
  }

  private markSnapshot(sessionId: string, owner?: BrowserSessionOwner): number {
    const session = this.requireSession(sessionId, owner);
    const next = (session.currentSnapshotVersion || 0) + 1;
    session.currentSnapshotVersion = next;
    return next;
  }

  private invalidateSnapshot(
    sessionId: string,
    owner?: BrowserSessionOwner,
  ): void {
    const session = this.requireSession(sessionId, owner);
    session.currentSnapshotVersion = undefined;
  }

  private requireCurrentSnapshot(
    sessionId: string,
    expectedSnapshotVersion: number | undefined,
    owner?: BrowserSessionOwner,
  ): void {
    const session = this.requireSession(sessionId, owner);
    if (!session.currentSnapshotVersion || !expectedSnapshotVersion) {
      throw new Error('Missing browser snapshot version; take a new snapshot');
    }
    if (session.currentSnapshotVersion !== expectedSnapshotVersion) {
      throw new Error('Stale browser snapshot version; take a new snapshot');
    }
  }

  private runSessionOperation<T>(
    sessionId: string,
    owner: BrowserSessionOwner | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const session = this.requireSession(sessionId, owner);
    const result = session.operationChain.then(operation);
    session.operationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async reapIdleSessions(): Promise<void> {
    const now = Date.now();
    const staleSessions = [...this.sessions.values()].filter((session) => {
      if (session.idleTimeoutMs <= 0) return false;
      return now - Date.parse(session.lastActiveAt) >= session.idleTimeoutMs;
    });
    for (const session of staleSessions) {
      this.sessions.delete(session.sessionId);
      await session.context.close();
      await session.browser?.close();
    }
  }

  private async enforceTabCap(session: BrowserSessionRecord): Promise<void> {
    const pages = session.context.pages();
    if (pages.length <= session.maxTabsPerSession) return;
    for (const page of pages.slice(session.maxTabsPerSession)) {
      await page.close();
    }
    if (session.context.pages().length === 0) {
      await session.context.newPage();
    }
  }

  private toState(session: BrowserSessionRecord): BrowserSessionState {
    return {
      sessionId: session.sessionId,
      mode: session.mode,
      permissionTier: session.permissionTier,
      owner: session.owner,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      tabCount: session.context.pages().length,
      profileName: session.profileName,
      status: 'active',
    };
  }
}

let singleton: BrowserManager | undefined;

export function getBrowserManager(): BrowserManager {
  singleton ||= new BrowserManager();
  return singleton;
}
