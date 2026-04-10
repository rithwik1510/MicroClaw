import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../src/config.js';
import { cleanupMemoryForGroup } from '../src/context/memory.js';

function groupFolders(): string[] {
  if (!fs.existsSync(GROUPS_DIR)) return [];
  return fs
    .readdirSync(GROUPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'global')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function main(): void {
  const groups = groupFolders();
  if (groups.length === 0) {
    console.log('No group folders found.');
    return;
  }

  let cleanedDailyFiles = 0;
  let removedDailyEntries = 0;
  let promotedCount = 0;

  for (const groupFolder of groups) {
    const result = cleanupMemoryForGroup(groupFolder);
    cleanedDailyFiles += result.cleanedDailyFiles;
    removedDailyEntries += result.removedDailyEntries;
    promotedCount += result.promotedCount;
    console.log(
      [
        `group=${groupFolder}`,
        `cleanedDailyFiles=${result.cleanedDailyFiles}`,
        `removedDailyEntries=${result.removedDailyEntries}`,
        `promotedCount=${result.promotedCount}`,
        `memoryPath=${path.relative(process.cwd(), result.memoryPath)}`,
      ].join(' '),
    );
  }

  console.log(
    [
      'summary',
      `groups=${groups.length}`,
      `cleanedDailyFiles=${cleanedDailyFiles}`,
      `removedDailyEntries=${removedDailyEntries}`,
      `promotedCount=${promotedCount}`,
    ].join(' '),
  );
}

main();
