import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { SetupPage } from './SetupPage';
import { Dashboard } from './Dashboard';
import { getSetup } from './api';
import type { SetupData } from './api';
import './styles.css';

type View = 'loading' | 'setup' | 'dashboard';

export function App() {
  const [view, setView] = useState<View>('loading');
  const [existingConfig, setExistingConfig] = useState<SetupData['existing']>(null);

  useEffect(() => {
    getSetup()
      .then(data => {
        setExistingConfig(data.existing);
        setView(data.completed ? 'dashboard' : 'setup');
      })
      .catch(() => setView('setup'));
  }, []);

  return (
    <AnimatePresence mode="wait">
      {view === 'loading' && (
        <motion.div
          key="loading"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            background: '#0a0a0a',
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              background: 'linear-gradient(135deg, #E8613A, #F5A07A)',
              boxShadow: '0 0 40px rgba(232, 97, 58, 0.3)',
            }}
            animate={{ scale: [1, 1.1, 1], rotate: [0, 5, -5, 0] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
          />
        </motion.div>
      )}

      {view === 'setup' && (
        <motion.div
          key="setup"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4 }}
        >
          <SetupPage
            existingConfig={existingConfig}
            onComplete={() => setView('dashboard')}
          />
        </motion.div>
      )}

      {view === 'dashboard' && (
        <motion.div
          key="dashboard"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          style={{ height: '100vh' }}
        >
          <Dashboard />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
