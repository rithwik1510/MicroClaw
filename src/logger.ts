import pino from 'pino';
import path from 'path';

const LOG_FILE_PATH = path.join(process.cwd(), 'logs', 'microclaw.log');

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
  },
  pino.transport({
    targets: [
      {
        target: 'pino-pretty',
        options: { colorize: true },
      },
      {
        target: 'pino/file',
        options: {
          destination: LOG_FILE_PATH,
          mkdir: true,
        },
      },
    ],
  }),
);

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
