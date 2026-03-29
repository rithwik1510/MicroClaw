import { useEffect, useState } from 'react';

interface HealthData {
  status: string;
  uptime: number;
  channels: Array<{ name: string; connected: boolean }>;
  groups: number;
}

export function App() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [setupDone, setSetupDone] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then(r => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));

    fetch('/api/setup')
      .then(r => r.json())
      .then(data => setSetupDone(data.completed))
      .catch(() => setSetupDone(false));
  }, []);

  if (health === null) {
    return <div style={{ padding: 40, fontFamily: 'system-ui' }}>Connecting to MicroClaw...</div>;
  }

  if (!setupDone) {
    return (
      <div style={{ padding: 40, fontFamily: 'system-ui' }}>
        <h1>Welcome to MicroClaw</h1>
        <p>Onboarding wizard will go here.</p>
        <p>Server status: {health.status} (uptime: {Math.round(health.uptime)}s)</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 40, fontFamily: 'system-ui' }}>
      <h1>MicroClaw Dashboard</h1>
      <p>Server status: {health.status} (uptime: {Math.round(health.uptime)}s)</p>
      <p>Chat interface will go here.</p>
    </div>
  );
}
