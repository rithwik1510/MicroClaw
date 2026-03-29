/**
 * Setup script: configure host file access for NanoClaw native mode.
 *
 * Usage:
 *   npx tsx scripts/setup-host-files.ts --paths "~/Documents,~/Desktop,~/projects"
 *   npx tsx scripts/setup-host-files.ts --paths "C:/Users/posan/Documents" --readonly
 *   npx tsx scripts/setup-host-files.ts --dry-run --paths "~/Documents"
 *   npx tsx scripts/setup-host-files.ts --paths "~/Documents" --backend native
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

interface HostDirectory {
  path: string;
  label: string;
  readonly: boolean;
}

const CONFIG_DIR = path.join(os.homedir(), '.config', 'microclaw');
const CONFIG_PATH = path.join(CONFIG_DIR, 'host-directories.json');
const ENV_PATH = path.join(process.cwd(), '.env');

function expandHome(p: string): string {
  const trimmed = p.trim();
  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(1));
  }
  return trimmed;
}

function labelFromPath(p: string): string {
  return path.basename(p) || p;
}

function parseArgs(): {
  paths: string[];
  readonly: boolean;
  dryRun: boolean;
  setBackendNative: boolean;
} {
  const args = process.argv.slice(2);
  let rawPaths = '';
  let readonly = false;
  let dryRun = false;
  let setBackendNative = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--paths':
        rawPaths = args[++i] || '';
        break;
      case '--readonly':
        readonly = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--backend':
        if (args[i + 1] === 'native') {
          setBackendNative = true;
          i++;
        }
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!rawPaths) {
    console.error('Error: --paths is required.');
    console.error(
      'Example: npx tsx scripts/setup-host-files.ts --paths "~/Documents,~/Desktop" --backend native',
    );
    process.exit(1);
  }

  const paths = rawPaths
    .split(',')
    .map((p) => expandHome(p))
    .filter(Boolean);

  return { paths, readonly, dryRun, setBackendNative };
}

function validatePaths(paths: string[]): HostDirectory[] {
  const dirs: HostDirectory[] = [];
  const missing: string[] = [];

  for (const p of paths) {
    const resolved = path.resolve(p);
    if (!fs.existsSync(resolved)) {
      missing.push(resolved);
    } else {
      dirs.push({
        path: resolved.replace(/\\/g, '/'), // normalize to forward slashes
        label: labelFromPath(resolved),
        readonly: false, // will be overridden by --readonly flag
      });
    }
  }

  if (missing.length > 0) {
    console.error('\nThe following paths do not exist:');
    for (const m of missing) {
      console.error(`  ${m}`);
    }
    console.error('\nFix the paths and re-run.');
    process.exit(1);
  }

  return dirs;
}

function updateEnvFile(envPath: string, key: string, value: string): void {
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    // file doesn't exist yet
  }

  const lines = content.split('\n');
  const keyPrefix = `${key}=`;
  const idx = lines.findIndex((l) => l.startsWith(keyPrefix));

  if (idx !== -1) {
    lines[idx] = `${key}=${value}`;
  } else {
    lines.push(`${key}=${value}`);
  }

  fs.writeFileSync(envPath, lines.join('\n'));
}

function main(): void {
  const { paths, readonly, dryRun, setBackendNative } = parseArgs();

  console.log('\nNanoClaw Host File Access Setup');
  console.log('================================\n');

  const dirs = validatePaths(paths);

  // Apply readonly flag
  const finalDirs: HostDirectory[] = dirs.map((d) => ({ ...d, readonly }));

  const config = { directories: finalDirs };

  console.log('Directories to configure:');
  for (const d of finalDirs) {
    console.log(`  ${d.label}/  →  ${d.path}  [${d.readonly ? 'read-only' : 'read-write'}]`);
  }

  console.log(`\nConfig file: ${CONFIG_PATH}`);

  if (setBackendNative) {
    console.log(`Execution backend: native (will update ${ENV_PATH})`);
  }

  if (dryRun) {
    console.log('\n[Dry run] No files were written.');
    console.log('\nConfig that would be written:');
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  // Write config
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  console.log('\nConfig written successfully.');

  // Update .env if requested
  if (setBackendNative) {
    updateEnvFile(ENV_PATH, 'NANOCLAW_EXECUTION_BACKEND', 'native');
    console.log('.env updated: NANOCLAW_EXECUTION_BACKEND=native');
  }

  console.log('\nNext steps:');
  console.log('  1. Build the agent runner:');
  console.log('       cd container/agent-runner && npm run build');
  console.log('  2. Restart NanoClaw:');
  console.log('       npm run dev');
  console.log('  3. From Discord, send: "list my files"');
  console.log('     The agent will call list_host_directories and show your configured directories.\n');
}

main();
