// History written before plan identity included the workspace used repo/plan
// keys. These upgrades keep that history attached after the upgrade.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDirectory } from '../../lib/safe-io/paths';
import {
  readFileRetry,
  writeFileAtomic,
  type SafeIoOptions,
} from '../../lib/safe-io/safe-io';
import type { Project } from '../settings/config';
import { repoNameOf } from '../settings/identity';
import type { ActivityLog } from './activity-log';
import { STORE_FILES } from './activity-log';
import { planKey, type ActivityEvent } from './diff';

/** legacyProjectFor maps a repository name to the one workspace that contains it, or '' when none or ambiguous. */
export async function legacyProjectFor(
  repo: string,
  projects: Project[],
): Promise<string> {
  let found = '';
  for (const p of projects) {
    const match =
      p.kind === 'repo'
        ? repoNameOf(p.path).toLowerCase() === repo.toLowerCase()
        : await isDirectory(path.join(p.path, repo));
    if (!match) continue;
    if (found !== '' && found !== p.id) return '';
    found = p.id;
  }
  return found;
}

function cachedLookup(projects: Project[]) {
  const cache = new Map<string, Promise<string>>();
  return (repo: string) => {
    let id = cache.get(repo);
    if (!id) {
      id = legacyProjectFor(repo, projects);
      cache.set(repo, id);
    }
    return id;
  };
}

/** mapLegacyKeys upgrades the loaded snapshot, events and stale keys of a log in memory. */
export async function mapLegacyKeys(
  log: ActivityLog,
  projects: Project[],
): Promise<void> {
  const lookup = cachedLookup(projects);
  if (log.prev) {
    for (const [k, p] of Object.entries(log.prev)) {
      if (p.project) continue;
      const id = await lookup(p.repo);
      if (id === '') continue;
      delete log.prev[k];
      const mapped = { ...p, project: id };
      log.prev[planKey(mapped)] = mapped;
    }
  }
  for (const e of log.events) {
    if (!e.project && e.repo) {
      const id = await lookup(e.repo);
      if (id !== '') e.project = id;
    }
  }
  for (const [k, t] of Object.entries(log.staleSeen)) {
    const parts = k.split('/');
    if (parts.length !== 2) continue;
    const id = await lookup(parts[0]!);
    if (id === '') continue;
    delete log.staleSeen[k];
    log.staleSeen[`${id}/${k}`] = t;
  }
}

/**
 * upgradeActivityFile writes the workspace into legacy activity lines once, so
 * the mapping does not depend on the workspaces configured at a later start.
 * The original is kept as activity.jsonl.pre-projects; other lines stay byte for byte.
 */
export async function upgradeActivityFile(
  dataDir: string,
  projects: Project[],
  io?: SafeIoOptions,
): Promise<boolean> {
  const file = path.join(dataDir, STORE_FILES.activity);
  let original: Buffer;
  try {
    original = await readFileRetry(file, io);
  } catch {
    return false;
  }
  const lookup = cachedLookup(projects);
  const lines = original.toString('utf8').split('\n');
  let changed = false;
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '') continue;
    let e: ActivityEvent;
    try {
      e = JSON.parse(line) as ActivityEvent;
    } catch {
      continue;
    }
    if (typeof e !== 'object' || e === null || e.project || !e.repo) continue;
    const id = await lookup(e.repo);
    if (id === '') continue;
    lines[i] = JSON.stringify({ ...e, project: id });
    changed = true;
  }
  if (!changed) return false;
  const backup = `${file}.pre-projects`;
  try {
    await fs.writeFile(backup, original, { flag: 'wx' });
  } catch (err) {
    if ((err as { code?: string }).code !== 'EEXIST') throw err;
  }
  await writeFileAtomic(file, lines.join('\n'), io);
  return true;
}
