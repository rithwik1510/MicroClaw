import { AppCore, _setSingletonCore } from './core.js';
import './channels/index.js';
import { logger } from './logger.js';
import { startServer } from '../server/index.js';
import detectPort from 'detect-port';
import open from 'open';

// Re-export for backwards compatibility
export { escapeXml, formatMessages } from './router.js';
export { AppCore } from './core.js';
export { getAvailableGroups, _setRegisteredGroups } from './core.js';

async function main(): Promise<void> {
  const core = new AppCore();
  _setSingletonCore(core);

  process.on('exit', () => {
    core.stop();
  });

  await core.start();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await core.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Connect messaging channels (zero is OK - dashboard-only mode)
  const connected = await core.connectChannels();
  if (connected.length === 0) {
    logger.info('No messaging channels connected — dashboard-only mode');
  } else {
    logger.info({ count: connected.length }, 'Messaging channels connected');
  }

  // Start subsystems
  core.startSubsystems();

  // Start Express dashboard
  const defaultPort = parseInt(process.env.MICROCLAW_PORT || '3100', 10);
  const port = await detectPort(defaultPort);
  await startServer(core, port);

  const url = `http://localhost:${port}`;
  logger.info(`Dashboard: ${url}`);

  // Auto-open browser (skip if NO_OPEN env is set — useful for dev/CI)
  if (!process.env.NO_OPEN) {
    await open(url);
  }

  // Start polling loop (only useful if messaging channels exist)
  if (connected.length > 0) {
    core.startMessageLoop().catch((err) => {
      logger.fatal({ err }, 'Message loop crashed');
      process.exit(1);
    });
  }

  logger.info(`MicroClaw running — dashboard at ${url}`);
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start MicroClaw');
    process.exit(1);
  });
}
