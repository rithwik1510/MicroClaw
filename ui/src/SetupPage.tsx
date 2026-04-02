import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { postSetup, testConnection } from './api';

interface Props {
  onComplete: () => void;
}

const PROVIDERS = [
  { value: 'openai_compatible', label: 'Ollama / LM Studio (Local)' },
  { value: 'openai_compatible_cloud', label: 'DeepInfra / OpenRouter (Cloud)' },
  { value: 'claude', label: 'Claude (Anthropic)' },
];

export function SetupPage({ onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState('openai_compatible');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const totalSteps = 3;

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testConnection({ provider, model, apiKey, baseUrl });
      setTestResult(result);
    } catch {
      setTestResult({ ok: false, message: 'Could not reach the server' });
    }
    setTesting(false);
  }

  async function handleFinish() {
    setSaving(true);
    try {
      await postSetup({ provider, model, apiKey, baseUrl });
      onComplete();
    } catch {
      setSaving(false);
    }
  }

  return (
    <div className="setup-page">
      <div className="setup-bg-glow" />
      <div className="setup-bg-glow-2" />

      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          className="setup-card"
          initial={{ opacity: 0, y: 24, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -16, scale: 0.97 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        >
          {/* Step indicators */}
          <div className="setup-steps">
            {Array.from({ length: totalSteps }).map((_, i) => (
              <div
                key={i}
                className={`setup-step-dot ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}
              />
            ))}
          </div>

          {step === 0 && (
            <>
              <h1>Welcome to MicroClaw</h1>
              <p className="subtitle">
                Your personal AI agent runtime. Let's connect your model and get you started in under a minute.
              </p>
              <button className="setup-btn" onClick={() => setStep(1)}>
                Get Started
              </button>
            </>
          )}

          {step === 1 && (
            <>
              <h1>Connect Your Model</h1>
              <p className="subtitle">
                Choose your AI provider and configure the connection.
              </p>

              <div className="form-group">
                <label>Provider</label>
                <select value={provider} onChange={e => setProvider(e.target.value)}>
                  {PROVIDERS.map(p => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label>Model</label>
                <input
                  type="text"
                  placeholder={provider === 'claude' ? 'claude-sonnet-4-6' : 'qwen2.5:14b'}
                  value={model}
                  onChange={e => setModel(e.target.value)}
                />
              </div>

              {provider !== 'openai_compatible' && (
                <div className="form-group">
                  <label>API Key</label>
                  <input
                    type="password"
                    placeholder="sk-..."
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                  />
                </div>
              )}

              {provider === 'openai_compatible' && (
                <div className="form-group">
                  <label>Base URL</label>
                  <input
                    type="text"
                    placeholder="http://localhost:11434/v1"
                    value={baseUrl}
                    onChange={e => setBaseUrl(e.target.value)}
                  />
                </div>
              )}

              <button
                className="setup-btn"
                onClick={() => setStep(2)}
                disabled={!model.trim()}
              >
                Continue
              </button>
              <button className="setup-btn secondary" onClick={() => setStep(0)}>
                Back
              </button>
            </>
          )}

          {step === 2 && (
            <>
              <h1>Ready to Go</h1>
              <p className="subtitle">
                Test your connection, then start using MicroClaw.
              </p>

              <div style={{
                background: 'var(--bg-tertiary)',
                borderRadius: 'var(--radius-sm)',
                padding: '16px',
                marginBottom: '20px',
                border: '1px solid var(--border)',
              }}>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 4 }}>Provider</div>
                <div style={{ fontSize: '0.9rem', marginBottom: 12 }}>
                  {PROVIDERS.find(p => p.value === provider)?.label}
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 4 }}>Model</div>
                <div style={{ fontSize: '0.9rem' }}>{model}</div>
              </div>

              {testResult && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  style={{
                    padding: '12px 16px',
                    borderRadius: 'var(--radius-sm)',
                    marginBottom: '16px',
                    fontSize: '0.85rem',
                    background: testResult.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                    border: `1px solid ${testResult.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
                    color: testResult.ok ? '#22c55e' : '#ef4444',
                  }}
                >
                  {testResult.message}
                </motion.div>
              )}

              <button
                className="setup-btn secondary"
                onClick={handleTest}
                disabled={testing}
                style={{ marginTop: 0, marginBottom: 8 }}
              >
                {testing ? 'Testing...' : 'Test Connection'}
              </button>

              <button
                className="setup-btn"
                onClick={handleFinish}
                disabled={saving}
              >
                {saving ? 'Setting up...' : 'Launch Dashboard'}
              </button>

              <button className="setup-btn secondary" onClick={() => setStep(1)}>
                Back
              </button>
            </>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
