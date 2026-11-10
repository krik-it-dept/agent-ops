// Stable workspace identity, compatible with the Go baseline and plan-reader.mjs.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { cleanPath } from '../../lib/safe-io/paths';

/** The project id of plans in the Tasks folder; no workspace may use it. */
export const TASKS_PROJECT_ID = 'tasks';

export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * projectPathForId is a cleaned path without a trailing separator, except a
 * drive root such as D:\ (projectPathForId in plan-reader.mjs).
 */
export function projectPathForId(p: string): string {
  const clean = path.normalize(p);
  if (clean.length === 3 && clean[1] === ':') return clean;
  return clean.replace(/[\\/]+$/, '');
}

/**
 * projectIdFor derives a stable id from the folder, so plan identity is kept
 * when the same folder is removed and added again: the first 8 hex digits of
 * SHA-256 over the lower-cased path.
 */
export function projectIdFor(p: string): string {
  return createHash('sha256')
    .update(projectPathForId(p).toLowerCase(), 'utf8')
    .digest('hex')
    .slice(0, 8);
}

/** repoNameOf names the repository of a repo project; a drive or share root uses its letter or share name. */
export function repoNameOf(p: string): string {
  const clean = projectPathForId(p);
  const name = path.basename(clean);
  if (name !== '' && name !== '.' && !/[\\/:]/.test(name)) return name;
  const parts = clean
    .replace(/[\\/:]+$/, '')
    .split(/[\\/]+/)
    .filter((s) => s !== '');
  return parts.length > 0 ? parts[parts.length - 1]! : 'root';
}

/** projectDisplayName is the folder name, or the whole path for a drive root. */
export function projectDisplayName(p: string): string {
  const clean = cleanPath(p);
  const name = path.basename(clean);
  if (name === '' || name === '.' || name === path.sep || /:\\?$/.test(name))
    return clean;
  return name;
}
