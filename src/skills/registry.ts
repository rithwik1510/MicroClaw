import fs from 'fs';
import path from 'path';

import { SkillManifest } from '../types.js';

export interface SkillManifestStatus {
  id: string;
  path: string;
  ok: boolean;
  error?: string;
  manifest?: SkillManifest;
}

function parseManifest(filePath: string): SkillManifestStatus {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SkillManifest>;
    if (!parsed.id || !parsed.version) {
      return {
        id: path.basename(path.dirname(filePath)),
        path: filePath,
        ok: false,
        error: 'Missing required fields id/version',
      };
    }
    return {
      id: parsed.id,
      path: filePath,
      ok: true,
      manifest: {
        id: parsed.id,
        version: parsed.version,
        requiredTools: parsed.requiredTools || [],
        permissions: parsed.permissions || [],
        entrypoints: parsed.entrypoints || [],
        healthChecks: parsed.healthChecks || [],
      },
    };
  } catch (err) {
    return {
      id: path.basename(path.dirname(filePath)),
      path: filePath,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function discoverSkillManifests(): SkillManifestStatus[] {
  const roots = [
    path.join(process.cwd(), 'skills'),
    path.join(process.cwd(), 'container', 'skills'),
  ];
  const results: SkillManifestStatus[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      const dir = path.join(root, entry);
      if (!fs.statSync(dir).isDirectory()) continue;
      const manifestPath = path.join(dir, 'SKILL.json');
      if (!fs.existsSync(manifestPath)) continue;
      results.push(parseManifest(manifestPath));
    }
  }
  return results.sort((a, b) => a.id.localeCompare(b.id));
}

export function validateSkillManifests(): {
  ok: boolean;
  items: SkillManifestStatus[];
} {
  const items = discoverSkillManifests();
  const ok = items.every((i) => i.ok);
  return { ok, items };
}
