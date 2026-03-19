import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  MAX_CONCURRENT_CONTAINERS,
  MAX_INTERACTIVE_CONTAINERS,
  MAX_BACKGROUND_CONTAINERS,
} from './config.js';
import { logger } from './logger.js';

/**
 * Lane determines scheduling priority.
 *
 * - 'interactive' — user-facing messages. Always get a slot when available.
 *   If all slots are taken by background work, the oldest background container
 *   is preempted (sent _close) to free a slot.
 * - 'background' — heartbeats and scheduled tasks. Run when slots are free,
 *   but never block interactive. Capped at MAX_BACKGROUND_CONTAINERS concurrent.
 */
export type LaneType = 'interactive' | 'background';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
  lane: LaneType;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
  /** Lane of the currently running work in this group. */
  activeLane: LaneType | null;
  /** Timestamp when the current active run started (used for preemption ordering). */
  activeStartedAt: number | null;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private backgroundActiveCount = 0;
  private waitingInteractive: string[] = [];
  private waitingBackground: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
        activeLane: null,
        activeStartedAt: null,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingInteractive.includes(groupJid)) {
        this.waitingInteractive.push(groupJid);
      }
      // Interactive: try to preempt the oldest background container to free a slot.
      this.tryPreemptBackground();
      logger.debug(
        { groupJid, activeCount: this.activeCount },
        'At concurrency limit, interactive message queued (attempting background preemption)',
      );
      return;
    }

    this.runForGroup(groupJid, 'messages', 'interactive').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(
    groupJid: string,
    taskId: string,
    fn: () => Promise<void>,
    options?: { lane?: LaneType },
  ): void {
    if (this.shuttingDown) return;

    const lane: LaneType = options?.lane ?? 'background';
    const state = this.getGroup(groupJid);

    // Prevent double-queuing of the same task
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn, lane });
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
      logger.debug({ groupJid, taskId, lane }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn, lane });
      const waitingList =
        lane === 'interactive'
          ? this.waitingInteractive
          : this.waitingBackground;
      if (!waitingList.includes(groupJid)) {
        waitingList.push(groupJid);
      }
      if (lane === 'interactive') {
        this.tryPreemptBackground();
      }
      logger.debug(
        { groupJid, taskId, lane, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Background lane: enforce its own concurrency limit
    if (
      lane === 'background' &&
      this.backgroundActiveCount >= MAX_BACKGROUND_CONTAINERS
    ) {
      state.pendingTasks.push({ id: taskId, groupJid, fn, lane });
      if (!this.waitingBackground.includes(groupJid)) {
        this.waitingBackground.push(groupJid);
      }
      logger.debug(
        {
          groupJid,
          taskId,
          activeCount: this.activeCount,
          backgroundActiveCount: this.backgroundActiveCount,
        },
        'At background concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn, lane }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  isGroupActive(groupJid: string): boolean {
    return this.getGroup(groupJid).active;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid);
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder || state.isTaskContainer)
      return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle
    // Safety backstop: always schedule a post-run message drain.
    // If the active agent exits before consuming this IPC file, the next
    // drain run will still pick up pending DB messages instead of waiting
    // for the user to send another "?" nudge.
    state.pendingMessages = true;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  /**
   * Attempt to preempt the oldest background container to free a slot for interactive work.
   * Only preempts if we're at the global limit and there are background containers running.
   */
  private tryPreemptBackground(): void {
    if (this.activeCount < MAX_CONCURRENT_CONTAINERS) return;
    if (this.backgroundActiveCount === 0) return;

    // Find the background container that started earliest
    let oldestJid: string | null = null;
    let oldestStartedAt = Infinity;

    for (const [jid, state] of this.groups) {
      if (
        state.active &&
        state.activeLane === 'background' &&
        state.activeStartedAt !== null &&
        state.activeStartedAt < oldestStartedAt
      ) {
        oldestJid = jid;
        oldestStartedAt = state.activeStartedAt;
      }
    }

    if (oldestJid) {
      logger.info(
        { preemptedJid: oldestJid },
        'Preempting background container to free slot for interactive message',
      );
      this.closeStdin(oldestJid);
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
    lane: LaneType = 'interactive',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    state.activeLane = lane;
    state.activeStartedAt = Date.now();
    this.activeCount++;
    if (lane === 'background') this.backgroundActiveCount++;

    logger.debug(
      {
        groupJid,
        reason,
        lane,
        activeCount: this.activeCount,
        backgroundActiveCount: this.backgroundActiveCount,
      },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      const wasBackground = state.activeLane === 'background';
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.activeLane = null;
      state.activeStartedAt = null;
      this.activeCount--;
      if (wasBackground) this.backgroundActiveCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.activeLane = task.lane;
    state.activeStartedAt = Date.now();
    this.activeCount++;
    if (task.lane === 'background') this.backgroundActiveCount++;

    logger.debug(
      {
        groupJid,
        taskId: task.id,
        lane: task.lane,
        activeCount: this.activeCount,
      },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      const wasBackground = state.activeLane === 'background';
      state.active = false;
      state.isTaskContainer = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.activeLane = null;
      state.activeStartedAt = null;
      this.activeCount--;
      if (wasBackground) this.backgroundActiveCount--;
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Tasks first (they won't be re-discovered from SQLite like messages).
    // Prioritize interactive tasks before background.
    const interactiveTasks = state.pendingTasks.filter(
      (t) => t.lane === 'interactive',
    );
    const backgroundTasks = state.pendingTasks.filter(
      (t) => t.lane === 'background',
    );
    const nextTask = interactiveTasks[0] ?? backgroundTasks[0];

    if (nextTask) {
      // Check lane capacity before dispatching
      if (
        nextTask.lane === 'background' &&
        this.backgroundActiveCount >= MAX_BACKGROUND_CONTAINERS
      ) {
        if (!this.waitingBackground.includes(groupJid)) {
          this.waitingBackground.push(groupJid);
        }
        this.drainWaiting();
        return;
      }
      if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
        const waitingList =
          nextTask.lane === 'interactive'
            ? this.waitingInteractive
            : this.waitingBackground;
        if (!waitingList.includes(groupJid)) {
          waitingList.push(groupJid);
        }
        if (nextTask.lane === 'interactive') {
          this.tryPreemptBackground();
        }
        this.drainWaiting();
        return;
      }
      state.pendingTasks.splice(state.pendingTasks.indexOf(nextTask), 1);
      this.runTask(groupJid, nextTask).catch((err) =>
        logger.error(
          { groupJid, taskId: nextTask.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages (always interactive)
    if (state.pendingMessages) {
      if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
        if (!this.waitingInteractive.includes(groupJid)) {
          this.waitingInteractive.push(groupJid);
        }
        this.tryPreemptBackground();
        this.drainWaiting();
        return;
      }
      this.runForGroup(groupJid, 'drain', 'interactive').catch((err) =>
        logger.error(
          { groupJid, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    // Drain interactive waiting groups first (priority)
    while (
      this.waitingInteractive.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingInteractive.shift()!;
      const state = this.getGroup(nextJid);

      const interactiveTasks = state.pendingTasks.filter(
        (t) => t.lane === 'interactive',
      );
      const task = interactiveTasks[0];
      if (task) {
        state.pendingTasks.splice(state.pendingTasks.indexOf(task), 1);
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { groupJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting interactive)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain', 'interactive').catch((err) =>
          logger.error(
            { groupJid: nextJid, err },
            'Unhandled error in runForGroup (waiting interactive)',
          ),
        );
      }
    }

    // Then drain background waiting groups
    while (
      this.waitingBackground.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS &&
      this.backgroundActiveCount < MAX_BACKGROUND_CONTAINERS
    ) {
      const nextJid = this.waitingBackground.shift()!;
      const state = this.getGroup(nextJid);

      const backgroundTasks = state.pendingTasks.filter(
        (t) => t.lane === 'background',
      );
      const task = backgroundTasks[0];
      if (task) {
        state.pendingTasks.splice(state.pendingTasks.indexOf(task), 1);
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { groupJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting background)',
          ),
        );
      }
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
