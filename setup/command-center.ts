import { spawnSync } from 'child_process';

import { emitStatus } from './status.js';

export async function run(args: string[]): Promise<void> {
  const commandArgs = args.length > 0 ? args : ['init'];
  const res = spawnSync(
    process.execPath,
    ['./node_modules/tsx/dist/cli.mjs', 'src/cli/index.ts', ...commandArgs],
    {
      stdio: 'inherit',
      cwd: process.cwd(),
    },
  );

  emitStatus('COMMAND_CENTER', {
    COMMAND: commandArgs.join(' '),
    STATUS: res.status === 0 ? 'success' : 'failed',
    LOG: 'logs/setup.log',
  });

  if (res.status !== 0) {
    process.exit(res.status || 1);
  }
}

