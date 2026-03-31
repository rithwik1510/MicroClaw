import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  getHeartbeats, getHeartbeatDetail, saveHeartbeat, triggerHeartbeat, deleteHeartbeat,
  getActivity, getActivitySummary, getRoutines, automateRoutine, dismissRoutineApi,
  getTasks, updateTaskStatus, deleteTaskApi,
} from './api';
import type {
  HeartbeatConfig, HeartbeatDetail, ActivityEntry, DailySummary, DetectedRoutine,
  ScheduledTask,
} from './api';

/* ── Helpers ─────────────────────────────────────────── */

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}hr ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatInterval(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}hr`;
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'pm' : 'am';
  return `${h % 12 || 12}:${m}${ampm}`;
}

const INTERVAL_OPTIONS = [
  { label: '15m', ms: 15 * 60000 },
  { label: '30m', ms: 30 * 60000 },
  { label: '1hr', ms: 60 * 60000 },
  { label: '2hr', ms: 120 * 60000 },
];

/* ── Component ───────────────────────────────────────── */

interface ActivityPageProps {
  wsRef: React.RefObject<WebSocket | null>;
}

export function ActivityPage({ wsRef }: ActivityPageProps) {
  const [heartbeats, setHeartbeats] = useState<HeartbeatConfig[]>([]);
  const [expandedHb, setExpandedHb] = useState<string | null>(null);
  const [hbDetail, setHbDetail] = useState<HeartbeatDetail | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [editorInterval, setEditorInterval] = useState<number>(0);

  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [expandedActivity, setExpandedActivity] = useState<string | null>(null);
  const [summary, setSummary] = useState<DailySummary | null>(null);

  const [routines, setRoutines] = useState<Record<string, DetectedRoutine[]>>({});
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);

  /* ── Fetch data on mount ──────────────────── */

  useEffect(() => {
    getHeartbeats().then(setHeartbeats).catch(() => {});
    getActivity({ limit: 30 }).then(setActivity).catch(() => {});
    getActivitySummary().then(setSummary).catch(() => {});
    getTasks().then(setTasks).catch(() => {});
  }, []);

  // Fetch routines for each group that has heartbeats
  useEffect(() => {
    heartbeats.forEach(hb => {
      getRoutines(hb.groupFolder).then(r => {
        if (r && r.length > 0) {
          setRoutines(prev => ({ ...prev, [hb.groupFolder]: r }));
        }
      }).catch(() => {});
    });
  }, [heartbeats]);

  /* ── WebSocket: live activity events ──────── */

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;

    const handler = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'activity' && data.entry) {
          setActivity(prev => [data.entry, ...prev].slice(0, 100));
        }
      } catch { /* ignore */ }
    };

    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [wsRef]);

  /* ── Heartbeat expand / editor ───────────── */

  const DEFAULT_TEMPLATE = `# Heartbeat Checklist

## Silent checks
- Review recent failed scheduled tasks. Only notify if something needs attention.

## Watch items
- Add your watch or reminder instructions here.
`;

  const toggleHeartbeat = useCallback(async (groupFolder: string) => {
    if (expandedHb === groupFolder) {
      setExpandedHb(null);
      setHbDetail(null);
      return;
    }
    setExpandedHb(groupFolder);
    try {
      const detail = await getHeartbeatDetail(groupFolder);
      setHbDetail(detail);
      setEditorContent(detail.content || DEFAULT_TEMPLATE);
      setEditorInterval(detail.intervalMs);
    } catch {
      // Group exists but no heartbeat file — show template for creation
      setHbDetail(null);
      setEditorContent(DEFAULT_TEMPLATE);
      setEditorInterval(INTERVAL_OPTIONS[1].ms); // default 30m
    }
  }, [expandedHb]);

  const handleSaveHeartbeat = useCallback(async () => {
    if (!expandedHb) return;
    await saveHeartbeat(expandedHb, editorContent, editorInterval);
    const updated = await getHeartbeats();
    setHeartbeats(updated);
  }, [expandedHb, editorContent, editorInterval]);

  const handleRunNow = useCallback(async () => {
    if (!expandedHb) return;
    await triggerHeartbeat(expandedHb);
  }, [expandedHb]);

  const handleDeleteHeartbeat = useCallback(async () => {
    if (!expandedHb) return;
    await deleteHeartbeat(expandedHb);
    setExpandedHb(null);
    setHbDetail(null);
    const updated = await getHeartbeats();
    setHeartbeats(updated);
  }, [expandedHb]);

  /* ── Routines handlers ───────────────────── */

  const handleAutomate = useCallback(async (groupFolder: string, description: string) => {
    await automateRoutine(groupFolder, description);
    setRoutines(prev => ({
      ...prev,
      [groupFolder]: prev[groupFolder]?.filter(r => r.capability !== description) ?? [],
    }));
  }, []);

  const handleDismiss = useCallback(async (groupFolder: string, keywords: string) => {
    await dismissRoutineApi(groupFolder, keywords);
    setRoutines(prev => ({
      ...prev,
      [groupFolder]: prev[groupFolder]?.filter(r => r.keywords !== keywords) ?? [],
    }));
  }, []);

  /* ── Task handlers ────────────────────────── */

  const handleToggleTask = useCallback(async (id: string, currentStatus: string) => {
    const newStatus = currentStatus === 'active' ? 'paused' : 'active';
    await updateTaskStatus(id, newStatus);
    setTasks(prev => prev.map(t => t.id === id ? { ...t, status: newStatus } : t));
  }, []);

  const handleCancelTask = useCallback(async (id: string) => {
    await updateTaskStatus(id, 'cancelled');
    setTasks(prev => prev.map(t => t.id === id ? { ...t, status: 'cancelled' } : t));
  }, []);

  const handleDeleteTask = useCallback(async (id: string) => {
    await deleteTaskApi(id);
    setTasks(prev => prev.filter(t => t.id !== id));
  }, []);

  /* ── Flatten routines for display ────────── */

  const allRoutines = Object.entries(routines).flatMap(([folder, list]) =>
    list.map(r => ({ ...r, groupFolder: folder }))
  );

  /* ── Token formatting ────────────────────── */

  const fmtTokens = (n: number) => {
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    return String(n);
  };

  /* ── Render ──────────────────────────────── */

  return (
    <div className="activity-page">
      {/* ── Heartbeats ────────────────────── */}
      <section>
        <div className="activity-section-title">
          <span>Heartbeats</span>
        </div>

        {/* Active heartbeats — groups that have a HEARTBEAT.md */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          {heartbeats.filter(hb => hb.hasChecklist).map(hb => (
            <div key={hb.groupFolder}>
              <motion.div
                className="heartbeat-card"
                onClick={() => toggleHeartbeat(hb.groupFolder)}
                layout
              >
                <span className="heartbeat-name">{hb.groupName}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span className="heartbeat-meta">
                    every {formatInterval(hb.intervalMs)}
                    {hb.lastRun ? ` \u00B7 ${relativeTime(hb.lastRun.timestamp)}` : ''}
                  </span>
                  <div className="status-dots">
                    {(hb.recentRuns || []).slice(0, 5).map((run, idx) => (
                      <motion.div
                        key={idx}
                        className={`status-dot ${run.status}`}
                        initial={idx === 0 ? { scale: 0.5, opacity: 0 } : false}
                        animate={idx === 0
                          ? { scale: [1, 1.4, 1], opacity: 1 }
                          : { scale: 1, opacity: 1 }}
                        transition={idx === 0
                          ? { duration: 1.2, repeat: Infinity, repeatDelay: 2 }
                          : { duration: 0.2 }}
                      />
                    ))}
                  </div>
                </div>
              </motion.div>

              <AnimatePresence>
                {expandedHb === hb.groupFolder && hbDetail && (
                  <motion.div
                    className="heartbeat-editor"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                    layout
                  >
                    <textarea
                      value={editorContent}
                      onChange={e => setEditorContent(e.target.value)}
                      spellCheck={false}
                    />
                    <div className="interval-pills">
                      {INTERVAL_OPTIONS.map(opt => (
                        <button
                          key={opt.ms}
                          className={`interval-pill ${editorInterval === opt.ms ? 'active' : ''}`}
                          onClick={() => setEditorInterval(opt.ms)}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                      <button className="btn-small primary" onClick={handleSaveHeartbeat}>Save</button>
                      <button className="btn-small secondary" onClick={handleRunNow}>Run Now</button>
                      <button className="btn-small danger" onClick={handleDeleteHeartbeat}>Delete</button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}

          {heartbeats.filter(hb => hb.hasChecklist).length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', padding: '8px 0' }}>
              No heartbeats configured yet. Add one below.
            </div>
          )}
        </div>

        {/* Unconfigured groups — can add a heartbeat */}
        {heartbeats.filter(hb => !hb.hasChecklist).length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.03em', fontFamily: 'var(--font-body)' }}>
              Add heartbeat
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {heartbeats.filter(hb => !hb.hasChecklist).map(hb => (
                <div key={hb.groupFolder}>
                  <motion.div
                    className="heartbeat-card"
                    style={{ opacity: 0.7 }}
                    onClick={() => toggleHeartbeat(hb.groupFolder)}
                    layout
                  >
                    <span className="heartbeat-name">{hb.groupName}</span>
                    <span className="heartbeat-meta" style={{ color: 'var(--accent)' }}>+ add</span>
                  </motion.div>

                  <AnimatePresence>
                    {expandedHb === hb.groupFolder && (
                      <motion.div
                        className="heartbeat-editor"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                        layout
                      >
                        <textarea
                          value={editorContent}
                          onChange={e => setEditorContent(e.target.value)}
                          placeholder={"# Heartbeat Checklist\n\n## Silent checks\n- Review recent failed scheduled tasks.\n\n## Watch items\n- Add your watch instructions here."}
                          spellCheck={false}
                        />
                        <div className="interval-pills">
                          {INTERVAL_OPTIONS.map(opt => (
                            <button
                              key={opt.ms}
                              className={`interval-pill ${editorInterval === opt.ms ? 'active' : ''}`}
                              onClick={() => setEditorInterval(opt.ms)}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                          <button className="btn-small primary" onClick={handleSaveHeartbeat}>Create</button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── Scheduled Tasks ──────────────────── */}
      {tasks.length > 0 && (
        <section>
          <div className="activity-section-title">
            <span>Scheduled Tasks</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
            {tasks
              .filter(t => t.status !== 'completed')
              .map(t => (
              <motion.div
                key={t.id}
                className="task-card"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <div className="task-card-left">
                  <div className={`status-dot ${t.status === 'active' ? 'ok' : t.status === 'paused' ? 'acted' : 'error'}`} />
                  <div className="task-info">
                    <div className="task-prompt">{t.prompt}</div>
                    <div className="task-meta">
                      {t.schedule_type === 'cron' ? `cron: ${t.schedule_value}` :
                       t.schedule_type === 'interval' ? `every ${formatInterval(parseInt(t.schedule_value))}` :
                       `once: ${new Date(t.schedule_value).toLocaleDateString()}`}
                      {' · '}{t.group_folder}
                      {' · '}<span className={`task-status-label ${t.status}`}>{t.status}</span>
                    </div>
                  </div>
                </div>
                <div className="task-actions">
                  {t.status !== 'cancelled' && (
                    <button
                      className="btn-small secondary"
                      onClick={() => handleToggleTask(t.id, t.status)}
                    >
                      {t.status === 'active' ? 'Pause' : 'Resume'}
                    </button>
                  )}
                  {t.status !== 'cancelled' && (
                    <button
                      className="btn-small danger"
                      onClick={() => handleCancelTask(t.id)}
                    >
                      Cancel
                    </button>
                  )}
                  {t.status === 'cancelled' && (
                    <button
                      className="btn-small danger"
                      onClick={() => handleDeleteTask(t.id)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </motion.div>
            ))}
          </div>
        </section>
      )}

      {/* ── Suggested Routines ─────────────── */}
      {allRoutines.length > 0 && (
        <section>
          <div className="activity-section-title">
            <span>Suggested Routines</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
            {allRoutines.map((r, idx) => (
              <motion.div
                key={`${r.groupFolder}-${idx}`}
                className="routine-card"
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: idx * 0.05 }}
              >
                <div style={{ flex: 1 }}>
                  <span className="routine-text">{r.capability}</span>
                  <span className="routine-count">{r.occurrences}x</span>
                </div>
                <div className="routine-actions">
                  <button
                    className="btn-small primary"
                    onClick={() => handleAutomate(r.groupFolder, r.capability)}
                  >
                    Automate
                  </button>
                  <button
                    className="btn-small danger"
                    onClick={() => handleDismiss(r.groupFolder, r.keywords)}
                  >
                    Dismiss
                  </button>
                </div>
              </motion.div>
            ))}
          </div>
        </section>
      )}

      {/* ── Recent Activity ────────────────── */}
      <section>
        <div className="activity-section-title">
          <span>Recent Activity</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 12 }}>
          <AnimatePresence initial={false}>
            {activity.map((entry, idx) => (
              <motion.div
                key={entry.id}
                className="activity-entry"
                onClick={() => setExpandedActivity(
                  expandedActivity === entry.id ? null : entry.id
                )}
                initial={idx === 0 ? { opacity: 0, y: -12 } : false}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
                layout
              >
                <span className="activity-time">{shortTime(entry.timestamp)}</span>
                <div className={`status-dot ${entry.status}`} style={{ marginTop: 5 }} />
                <div style={{ flex: 1 }}>
                  <div className="activity-summary">{entry.summary}</div>

                  <AnimatePresence>
                    {expandedActivity === entry.id && entry.detail && (
                      <motion.div
                        className="activity-detail"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2 }}
                      >
                        {entry.detail}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {activity.length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', padding: '8px 0' }}>
              No recent activity.
            </div>
          )}
        </div>
      </section>

      {/* ── Stats Bar ──────────────────────── */}
      {summary && (
        <div className="stats-bar">
          <span className="stats-label">Today</span>
          <span className="stats-value">
            {summary.heartbeats.total} hb
            {' \u00B7 '}{summary.tasks.total} tasks
            {' \u00B7 '}{fmtTokens(summary.tokens.total)} tkns
          </span>
        </div>
      )}
    </div>
  );
}
