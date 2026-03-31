import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import Markdown from 'react-markdown';
import { getExistingGroups, createChat, getChatMessages, getSetup } from './api';
import type { ExistingGroup, ChatMessage } from './api';
import { PersonaPage } from './PersonaPage';
import { ActivityPage } from './ActivityPage';

interface SidebarItem {
  id: string;       // unique key for sidebar
  name: string;
  folder: string;
  source: 'existing' | 'dashboard';  // where it came from
  jid?: string;     // dashboard JID if chat is active
}

interface ActiveChat {
  item: SidebarItem;
  jid: string;
  messages: ChatMessage[];
}

// Map internal group names to friendly display names
function friendlyName(name: string, folder: string): string {
  // discord_dm → "Sam" (the user's personal assistant)
  if (folder === 'discord_dm') return 'Sam';
  // discord_main → clean up the server name
  if (folder === 'discord_main') return name.replace(/#general/i, '').trim() || 'Main';
  // Already has a good name
  return name;
}

export function Dashboard() {
  const [sidebarItems, setSidebarItems] = useState<SidebarItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [chats, setChats] = useState<Record<string, ActiveChat>>({});
  const [input, setInput] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [defaultModel, setDefaultModel] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeView, setActiveView] = useState<'chat' | 'persona'>('chat');
  const [activeTab, setActiveTab] = useState<'chats' | 'activity'>('chats');
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  // Load existing groups and model on mount
  useEffect(() => {
    getExistingGroups().then(groups => {
      const items: SidebarItem[] = groups
        // Skip orphan dashboard-only groups (no real data)
        .filter(g => !g.folder.startsWith('dashboard_'))
        .map(g => ({
          id: g.folder,
          name: friendlyName(g.name, g.folder),
          folder: g.folder,
          source: g.jid.startsWith('dashboard:') ? 'dashboard' as const : 'existing' as const,
        }));
      setSidebarItems(items);
    }).catch(() => {});
    getSetup().then(data => {
      if (data.existing?.model) setDefaultModel(data.existing.model);
    }).catch(() => {});
  }, []);

  // Connect WebSocket
  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/api/chat/ws`);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'message' && data.chatJid) {
        setChats(prev => {
          const itemId = Object.keys(prev).find(id => prev[id].jid === data.chatJid);
          if (!itemId) return prev;
          const chat = prev[itemId];
          return {
            ...prev,
            [itemId]: {
              ...chat,
              messages: [...chat.messages, {
                id: `ws-${Date.now()}`,
                chat_jid: data.chatJid,
                sender: data.from || 'agent',
                sender_name: data.from || 'Agent',
                content: data.content,
                timestamp: data.timestamp || new Date().toISOString(),
                is_bot_message: true,
              }],
            },
          };
        });
        setIsThinking(false);
      }
      if (data.type === 'status' && data.status === 'thinking') {
        setIsThinking(true);
      }
    };

    return () => ws.close();
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chats, activeId, isThinking]);

  // Close attach menu when clicking outside
  useEffect(() => {
    if (!showAttachMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.attach-menu') && !target.closest('.chat-input-attach')) {
        setShowAttachMenu(false);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [showAttachMenu]);

  // Auto-resize textarea
  const handleTextareaInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }, []);

  async function selectItem(item: SidebarItem) {
    setActiveView('chat');
    setActiveTab('chats');
    setActiveId(item.id);

    if (!chats[item.id]) {
      try {
        // Create dashboard chat linked to the item's folder (existing or new)
        const chat = await createChat(item.name, item.folder);
        const messages = await getChatMessages(chat.jid);
        wsRef.current?.send(JSON.stringify({ type: 'subscribe', chatJid: chat.jid }));
        setChats(prev => ({
          ...prev,
          [item.id]: { item: { ...item, jid: chat.jid }, jid: chat.jid, messages },
        }));
      } catch {
        const jid = `dashboard:${item.name.toLowerCase()}-${Date.now()}`;
        setChats(prev => ({
          ...prev,
          [item.id]: { item, jid, messages: [] },
        }));
      }
    }
  }

  function sendMessage() {
    const text = input.trim();
    if (!text || !activeId) return;

    const chat = chats[activeId];
    if (!chat) return;

    const userMsg: ChatMessage = {
      id: `local-${Date.now()}`,
      chat_jid: chat.jid,
      sender: 'user',
      sender_name: 'You',
      content: text,
      timestamp: new Date().toISOString(),
      is_from_me: true,
    };

    setChats(prev => ({
      ...prev,
      [activeId!]: {
        ...chat,
        messages: [...chat.messages, userMsg],
      },
    }));

    wsRef.current?.send(JSON.stringify({
      type: 'message',
      chatJid: chat.jid,
      content: text,
    }));

    setInput('');
    setIsThinking(true);

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  const activeChat = activeId ? chats[activeId] : null;
  const activeItem = sidebarItems.find(i => i.id === activeId);
  const model = defaultModel || '';

  return (
    <div className="dashboard">
      {/* Sidebar — collapsible, ChatGPT/Claude style */}
      <motion.div
        className={`sidebar ${sidebarOpen ? '' : 'collapsed'}`}
        initial={{ x: -260, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="sidebar-header">
          <div className="sidebar-logo">M</div>
          <span className="sidebar-title">MicroClaw</span>
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarOpen(false)}
            title="Close sidebar"
          >
            &#9776;
          </button>
        </div>

        <div className="sidebar-tabs">
          <button
            className={`sidebar-tab ${activeTab === 'chats' ? 'active' : ''}`}
            onClick={() => setActiveTab('chats')}
          >Chats</button>
          <button
            className={`sidebar-tab ${activeTab === 'activity' ? 'active' : ''}`}
            onClick={() => setActiveTab('activity')}
          >Activity</button>
        </div>

        {activeTab === 'chats' && (
        <>
        <div className="sidebar-section-label">Agents</div>

        <div className="sidebar-agents">
          {sidebarItems.map((item, i) => (
            <motion.button
              key={item.id}
              className={`agent-item ${activeId === item.id ? 'active' : ''}`}
              onClick={() => selectItem(item)}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.05 + i * 0.03, duration: 0.3 }}
            >
              <div className="agent-item-avatar">
                {item.name.charAt(0).toUpperCase()}
              </div>
              <span className="agent-item-name">{item.name}</span>
            </motion.button>
          ))}
        </div>

        <div className="sidebar-bottom">
          <button
            className={`sidebar-bottom-btn ${activeView === 'persona' ? 'active' : ''}`}
            onClick={() => { setActiveView('persona'); setActiveId(null); }}
          >
            <span className="sidebar-bottom-icon">&#9830;</span>
            <span>Persona</span>
          </button>
          <button
            className="sidebar-bottom-btn"
            onClick={() => setShowCreateModal(true)}
          >
            <span className="sidebar-bottom-icon">+</span>
            <span>New Chat</span>
          </button>
        </div>
        </>
        )}
      </motion.div>

      {/* Floating toggle when sidebar is closed */}
      {!sidebarOpen && (
        <motion.button
          className="sidebar-toggle-float"
          onClick={() => setSidebarOpen(true)}
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.2 }}
        >
          &#9776;
        </motion.button>
      )}

      {/* Main Content Area */}
      <div className="chat-area">
        <AnimatePresence mode="wait">
        {activeTab === 'activity' ? (
          <motion.div
            key="activity"
            style={{ flex: 1, display: 'flex', width: '100%' }}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            <ActivityPage wsRef={wsRef} />
          </motion.div>
        ) : activeView === 'persona' ? (
          <PersonaPage />
        ) : activeItem ? (
          <>
            <motion.div
              className="chat-header"
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
            >
              <span className="chat-header-name">{activeItem.name}</span>
              <span className="chat-header-status">{model}</span>
            </motion.div>

            <div className="chat-messages">
              {(!activeChat || activeChat.messages.length === 0) && !isThinking && (
                <div className="chat-empty">
                  <motion.h2
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.1 }}
                  >
                    Start a conversation
                  </motion.h2>
                  <motion.p
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2 }}
                  >
                    Send a message to {activeItem.name} below.
                  </motion.p>
                </div>
              )}

              <AnimatePresence>
                {activeChat?.messages.map((msg) => (
                  <motion.div
                    key={msg.id}
                    className={`message ${!msg.is_bot_message && (msg.sender === 'user' || msg.sender_name === 'User' || msg.sender_name === 'rishi') ? 'user' : 'agent'}`}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                  >
                    {!(!msg.is_bot_message && (msg.sender === 'user' || msg.sender_name === 'User' || msg.sender_name === 'rishi')) && (
                      <div className="message-sender">{activeItem.name}</div>
                    )}
                    <div className="message-bubble">
                      {(!msg.is_bot_message && (msg.sender === 'user' || msg.sender_name === 'User' || msg.sender_name === 'rishi'))
                        ? msg.content
                        : <Markdown>{msg.content}</Markdown>
                      }
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>

              {isThinking && (
                <motion.div
                  className="message agent"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  <div className="message-bubble typing-indicator">
                    <div className="typing-dot" />
                    <div className="typing-dot" />
                    <div className="typing-dot" />
                  </div>
                </motion.div>
              )}

              <div ref={messagesEndRef} />
            </div>

            <div className="chat-input-wrapper">
              {/* Attached files preview */}
              {attachedFiles.length > 0 && (
                <div className="attached-files">
                  {attachedFiles.map((file, i) => (
                    <div key={i} className="attached-file">
                      <span className="attached-file-icon">
                        {file.type.startsWith('image/') ? '🖼' : '📄'}
                      </span>
                      <span className="attached-file-name">{file.name}</span>
                      <button
                        className="attached-file-remove"
                        onClick={() => setAttachedFiles(prev => prev.filter((_, j) => j !== i))}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="chat-input-box">
                <div style={{ position: 'relative' }}>
                  <button
                    className="chat-input-attach"
                    title="Attach"
                    onClick={() => setShowAttachMenu(prev => !prev)}
                  >
                    +
                  </button>

                  <AnimatePresence>
                    {showAttachMenu && (
                      <motion.div
                        className="attach-menu"
                        initial={{ opacity: 0, y: 8, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 8, scale: 0.95 }}
                        transition={{ duration: 0.15 }}
                      >
                        <button
                          className="attach-menu-item"
                          onClick={() => {
                            imageInputRef.current?.click();
                            setShowAttachMenu(false);
                          }}
                        >
                          <span className="attach-menu-icon">🖼</span>
                          Photo & Video
                        </button>
                        <button
                          className="attach-menu-item"
                          onClick={() => {
                            cameraInputRef.current?.click();
                            setShowAttachMenu(false);
                          }}
                        >
                          <span className="attach-menu-icon">📷</span>
                          Camera
                        </button>
                        <button
                          className="attach-menu-item"
                          onClick={() => {
                            fileInputRef.current?.click();
                            setShowAttachMenu(false);
                          }}
                        >
                          <span className="attach-menu-icon">📄</span>
                          Document
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* Hidden file inputs */}
                  <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*,video/*"
                    multiple
                    style={{ display: 'none' }}
                    onChange={e => {
                      if (e.target.files) setAttachedFiles(prev => [...prev, ...Array.from(e.target.files!)]);
                      e.target.value = '';
                    }}
                  />
                  <input
                    ref={cameraInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    style={{ display: 'none' }}
                    onChange={e => {
                      if (e.target.files) setAttachedFiles(prev => [...prev, ...Array.from(e.target.files!)]);
                      e.target.value = '';
                    }}
                  />
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    style={{ display: 'none' }}
                    onChange={e => {
                      if (e.target.files) setAttachedFiles(prev => [...prev, ...Array.from(e.target.files!)]);
                      e.target.value = '';
                    }}
                  />
                </div>
                <textarea
                  ref={textareaRef}
                  rows={1}
                  placeholder={`Message ${activeItem.name}...`}
                  value={input}
                  onChange={e => { setInput(e.target.value); handleTextareaInput(); }}
                  onKeyDown={handleKeyDown}
                />
                <button
                  className="chat-input-send"
                  onClick={sendMessage}
                  disabled={!input.trim()}
                  title="Send"
                >
                  &#8593;
                </button>
              </div>
              <div className="chat-input-model">{model}</div>
            </div>
          </>
        ) : (
          <div className="chat-empty" style={{ height: '100%' }}>
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3, duration: 0.5 }}
            >
              {sidebarItems.length === 0 ? 'No chats yet' : 'Select a chat'}
            </motion.h2>
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4, duration: 0.5 }}
            >
              {sidebarItems.length === 0
                ? 'Click + New Chat in the sidebar to get started.'
                : 'Choose a chat from the sidebar to start.'}
            </motion.p>
          </div>
        )}
        </AnimatePresence>
      </div>

      {/* Create Agent Modal */}
      <AnimatePresence>
        {showCreateModal && (
          <CreateAgentModal
            defaultModel={defaultModel}
            onClose={() => setShowCreateModal(false)}
            onCreate={async (name) => {
              const newItem: SidebarItem = {
                id: `dashboard_${name.toLowerCase().replace(/\s+/g, '_')}`,
                name,
                folder: `dashboard_${name.toLowerCase().replace(/\s+/g, '_')}`,
                source: 'dashboard',
              };
              setSidebarItems(prev => [...prev, newItem]);
              setShowCreateModal(false);
              selectItem(newItem);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function CreateAgentModal({
  defaultModel,
  onClose,
  onCreate,
}: {
  defaultModel: string;
  onClose: () => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState('');

  return (
    <motion.div
      className="modal-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onClose}
    >
      <motion.div
        className="modal-card"
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 20 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        onClick={e => e.stopPropagation()}
      >
        <h2>Create Agent</h2>

        <div className="form-group">
          <label>Name</label>
          <input
            type="text"
            placeholder="e.g. Sam, Raya, Coder..."
            value={name}
            onChange={e => setName(e.target.value)}
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onCreate(name); }}
          />
        </div>

        {defaultModel && (
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 16 }}>
            Using model: {defaultModel}
          </div>
        )}

        <button
          className="setup-btn"
          onClick={() => onCreate(name)}
          disabled={!name.trim()}
        >
          Create
        </button>
        <button className="setup-btn secondary" onClick={onClose}>
          Cancel
        </button>
      </motion.div>
    </motion.div>
  );
}
