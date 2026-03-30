import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { getAgents, createAgent, createChat, getChatMessages, getSetup } from './api';
import type { Agent, ChatMessage } from './api';

interface AgentChat {
  agent: Agent;
  jid: string;
  messages: ChatMessage[];
}

export function Dashboard() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [chats, setChats] = useState<Record<string, AgentChat>>({});
  const [input, setInput] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [defaultModel, setDefaultModel] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Load agents and default model on mount
  useEffect(() => {
    getAgents().then(setAgents).catch(() => {});
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
          const chat = prev[data.chatJid];
          if (!chat) return prev;
          return {
            ...prev,
            [data.chatJid]: {
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
  }, [chats, activeAgentId, isThinking]);

  // Auto-resize textarea
  const handleTextareaInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, []);

  async function selectAgent(agent: Agent) {
    setActiveAgentId(agent.id);

    if (!chats[agent.id]) {
      // Create a chat for this agent
      try {
        const chat = await createChat(agent.name);
        const messages = await getChatMessages(chat.jid);

        // Subscribe to this chat via WebSocket
        wsRef.current?.send(JSON.stringify({ type: 'subscribe', chatJid: chat.jid }));

        setChats(prev => ({
          ...prev,
          [agent.id]: { agent, jid: chat.jid, messages },
        }));
      } catch {
        // Fallback — create local state
        const jid = `dashboard:${agent.name.toLowerCase()}-${Date.now()}`;
        setChats(prev => ({
          ...prev,
          [agent.id]: { agent, jid, messages: [] },
        }));
      }
    }
  }

  function sendMessage() {
    const text = input.trim();
    if (!text || !activeAgentId) return;

    const chat = chats[activeAgentId];
    if (!chat) return;

    // Add user message locally
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
      [activeAgentId!]: {
        ...chat,
        messages: [...chat.messages, userMsg],
      },
    }));

    // Send via WebSocket
    wsRef.current?.send(JSON.stringify({
      type: 'message',
      chatJid: chat.jid,
      content: text,
    }));

    setInput('');
    setIsThinking(true);

    // Reset textarea height
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

  const activeChat = activeAgentId ? chats[activeAgentId] : null;
  const activeAgent = agents.find(a => a.id === activeAgentId);
  const model = activeAgent?.model || 'No model';

  return (
    <div className="dashboard">
      {/* Sidebar */}
      <motion.div
        className="sidebar"
        initial={{ x: -72, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="sidebar-logo">M</div>
        <div className="sidebar-divider" />

        {agents.map((agent, i) => (
          <motion.button
            key={agent.id}
            className={`agent-btn ${activeAgentId === agent.id ? 'active' : ''}`}
            onClick={() => selectAgent(agent)}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.1 + i * 0.05, duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          >
            {agent.name.charAt(0).toUpperCase()}
            <span className="agent-tooltip">{agent.name}</span>
          </motion.button>
        ))}

        <motion.button
          className="agent-btn add"
          onClick={() => setShowCreateModal(true)}
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.2 + agents.length * 0.05, duration: 0.3 }}
        >
          +
          <span className="agent-tooltip">Create Agent</span>
        </motion.button>
      </motion.div>

      {/* Chat Area */}
      <div className="chat-area">
        {activeAgent ? (
          <>
            <motion.div
              className="chat-header"
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
            >
              <span className="chat-header-name">{activeAgent.name}</span>
              <span className="chat-header-status">{activeAgent.model}</span>
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
                    Send a message to {activeAgent.name} below.
                  </motion.p>
                </div>
              )}

              <AnimatePresence>
                {activeChat?.messages.map((msg) => (
                  <motion.div
                    key={msg.id}
                    className={`message ${msg.is_from_me || msg.sender === 'user' ? 'user' : 'agent'}`}
                    initial={{ opacity: 0, y: 12, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <div className="message-bubble">{msg.content}</div>
                    <div className="message-meta">
                      {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
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
              <div className="chat-input-container">
                <div className="chat-input-box">
                  <button className="chat-input-attach" title="Attach file">
                    +
                  </button>
                  <textarea
                    ref={textareaRef}
                    rows={1}
                    placeholder={`Message ${activeAgent.name}...`}
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
            </div>
          </>
        ) : (
          <div className="chat-empty" style={{ height: '100%' }}>
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3, duration: 0.5 }}
            >
              {agents.length === 0 ? 'Create your first agent' : 'Select an agent'}
            </motion.h2>
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4, duration: 0.5 }}
            >
              {agents.length === 0
                ? 'Click the + button in the sidebar to get started.'
                : 'Choose an agent from the sidebar to start chatting.'}
            </motion.p>
          </div>
        )}
      </div>

      {/* Create Agent Modal */}
      <AnimatePresence>
        {showCreateModal && (
          <CreateAgentModal
            defaultModel={defaultModel}
            onClose={() => setShowCreateModal(false)}
            onCreate={async (name) => {
              const agent = await createAgent({ name, model: defaultModel });
              setAgents(prev => [...prev, agent]);
              setShowCreateModal(false);
              selectAgent(agent);
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
