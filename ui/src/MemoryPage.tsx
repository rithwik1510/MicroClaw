import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { getMemories, updateMemory, deleteMemory, toggleMemoryPin } from './api';
import type { MemoryEntry } from './api';

type KindFilter = undefined | 'fact' | 'pref' | 'proj' | 'loop';

const FILTER_PILLS: { label: string; kind: KindFilter }[] = [
  { label: 'All', kind: undefined },
  { label: 'Facts', kind: 'fact' },
  { label: 'Prefs', kind: 'pref' },
  { label: 'Projects', kind: 'proj' },
  { label: 'Loops', kind: 'loop' },
];

function relativeAge(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function decayFraction(lastConfirmedAt: string): number {
  const now = Date.now();
  const then = new Date(lastConfirmedAt).getTime();
  const daysSince = (now - then) / (1000 * 60 * 60 * 24);
  // freshness: 1 = just confirmed, 0 = 30+ days stale
  return Math.max(0, Math.min(1, 1 - daysSince / 30));
}

export function MemoryPage() {
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [search, setSearch] = useState('');
  const [activeKind, setActiveKind] = useState<KindFilter>(undefined);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editContent, setEditContent] = useState('');
  const [loading, setLoading] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchMemories = useCallback(async (q?: string, kind?: KindFilter) => {
    try {
      const data = await getMemories({
        q: q || undefined,
        kind: kind || undefined,
      });
      setMemories(data);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on mount
  useEffect(() => {
    fetchMemories(search, activeKind);
  }, [activeKind]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced search
  function handleSearchChange(value: string) {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setLoading(true);
      fetchMemories(value, activeKind);
    }, 300);
  }

  function handleFilterChange(kind: KindFilter) {
    setActiveKind(kind);
    setLoading(true);
  }

  // Pin toggle (optimistic)
  async function handleTogglePin(id: number, currentPinned: boolean) {
    setMemories(prev =>
      prev.map(m => (m.id === id ? { ...m, pinned: !currentPinned } : m))
    );
    try {
      await toggleMemoryPin(id, !currentPinned);
    } catch {
      // revert on error
      setMemories(prev =>
        prev.map(m => (m.id === id ? { ...m, pinned: currentPinned } : m))
      );
    }
  }

  // Delete (optimistic)
  async function handleDelete(id: number) {
    const prev = memories;
    setMemories(memories.filter(m => m.id !== id));
    try {
      await deleteMemory(id);
    } catch {
      setMemories(prev);
    }
  }

  // Edit
  function startEdit(mem: MemoryEntry) {
    setEditingId(mem.id);
    setEditContent(mem.content);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditContent('');
  }

  async function saveEdit(id: number) {
    try {
      await updateMemory(id, editContent);
      setMemories(prev =>
        prev.map(m => (m.id === id ? { ...m, content: editContent } : m))
      );
      setEditingId(null);
      setEditContent('');
    } catch {
      // silent
    }
  }

  return (
    <div className="memory-page">
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <h1 style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 400,
          fontSize: '1.5rem',
          color: 'var(--text-primary)',
          letterSpacing: '-0.01em',
          marginBottom: '16px',
        }}>
          Memory
        </h1>
      </motion.div>

      {/* Search */}
      <input
        type="text"
        className="memory-search"
        placeholder="Search memories..."
        value={search}
        onChange={e => handleSearchChange(e.target.value)}
      />

      {/* Filter Pills */}
      <div className="memory-filters">
        {FILTER_PILLS.map((pill, i) => (
          <motion.button
            key={pill.label}
            className={`persona-chip ${activeKind === pill.kind ? 'active' : ''}`}
            onClick={() => handleFilterChange(pill.kind)}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04, duration: 0.25 }}
          >
            {pill.label}
          </motion.button>
        ))}
      </div>

      {/* Memory List */}
      {loading ? (
        <div className="memory-empty">Loading...</div>
      ) : memories.length === 0 ? (
        <div className="memory-empty">No memories found</div>
      ) : (
        <div className="memory-list">
          <AnimatePresence>
            {memories.map((mem, i) => (
              <motion.div
                key={mem.id}
                className={`memory-card ${mem.kind}`}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ delay: i * 0.03, duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                layout
              >
                {/* Pin icon */}
                <button
                  className={`memory-pin ${mem.pinned ? 'pinned' : ''}`}
                  onClick={() => handleTogglePin(mem.id, mem.pinned)}
                  title={mem.pinned ? 'Unpin' : 'Pin'}
                >
                  {mem.pinned ? '\u{1F4CC}' : '\u{1F4CC}'}
                </button>

                {/* Hover actions */}
                <div className="memory-actions">
                  <button
                    className="memory-action-btn"
                    onClick={() => startEdit(mem)}
                    title="Edit"
                  >
                    &#9998;
                  </button>
                  <button
                    className="memory-action-btn"
                    onClick={() => handleDelete(mem.id)}
                    title="Delete"
                  >
                    &#10005;
                  </button>
                </div>

                {/* Content */}
                {editingId === mem.id ? (
                  <div className="memory-edit-area">
                    <textarea
                      value={editContent}
                      onChange={e => setEditContent(e.target.value)}
                      autoFocus
                    />
                    <div className="memory-edit-actions">
                      <button
                        className="persona-save-btn"
                        onClick={() => saveEdit(mem.id)}
                        style={{ width: 'auto', padding: '6px 16px', fontSize: '0.8rem' }}
                      >
                        Save
                      </button>
                      <button
                        className="setup-btn secondary"
                        onClick={cancelEdit}
                        style={{ width: 'auto', padding: '6px 16px', fontSize: '0.8rem', marginTop: 0 }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="memory-content">{mem.content}</div>
                )}

                {/* Meta row */}
                <div className="memory-meta">
                  <span>{mem.group_folder}</span>
                  <span>{relativeAge(mem.created_at)}</span>
                  <div className="memory-decay-bar">
                    <div
                      className="memory-decay-fill"
                      style={{ width: `${decayFraction(mem.last_confirmed_at) * 100}%` }}
                    />
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
