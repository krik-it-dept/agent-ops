// Workspace discovery: which folders are repositories, how many plans each
// holds, and the kind of a newly chosen folder. Mirrors config.go.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exists, isDirectory } from '../../lib/safe-io/paths';
import type { Project, ProjectKind } from '../settings/config';
import { repoNameOf } from '../settings/identity';

/** RepoInfo is one repository a workspace contributes. */
export interface RepoInfo {
  name: string;
  path: string;
  hasTasks: boolean;
  planCount: number;
}

/** isRepoDir: a folder with .git or .tasks. */
export async function isRepoDir(dir: string): Promise<boolean> {
  return (
    (await exists(path.join(dir, '.git'))) ||
    (await exists(path.join(dir, '.tasks')))
  );
}

/** planFiles lists a repository's source plans, never the generated tong-hop.md index. */
export async function planFiles(repo: string): Promise<string[]> {
  const dir = path.join(repo, '.tasks');
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.md') && n.toLowerCase() !== 'tong-hop.md')
    .map((n) => path.join(dir, n));
}

export async function repoInfo(dir: string): Promise<RepoInfo> {
  return {
    name: repoNameOf(dir),
    path: dir,
    hasTasks: await isDirectory(path.join(dir, '.tasks')),
    planCount: (await planFiles(dir)).length,
  };
}

/** byName orders like JavaScript's default sort and the baseline's collector. */
export function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** childRepos lists the direct children of dir that are repositories, in name order. */
export async function childRepos(dir: string): Promise<string[]> {
  const names = (await fs.readdir(dir)).sort(byName);
  const out: string[] = [];
  for (const name of names) {
    const child = path.join(dir, name);
    if ((await isDirectory(child)) && (await isRepoDir(child))) out.push(child);
  }
  return out;
}

/**
 * projectRepos lists the repositories a workspace contributes: the folder
 * itself for a repo, the repository children of a folder. It fails when the
 * folder cannot be opened or is a file.
 */
export async function projectRepos(
  p: Pick<Project, 'path' | 'kind'>,
): Promise<RepoInfo[]> {
  const info = await fs.stat(p.path);
  if (!info.isDirectory())
    throw Object.assign(new Error(`${p.path} is not a folder`), {
      code: 'ENOTDIR',
    });
  if (p.kind === 'repo') return [await repoInfo(p.path)];
  const repos = await Promise.all((await childRepos(p.path)).map(repoInfo));
  return repos.sort((a, b) =>
    byName(a.name.toLowerCase(), b.name.toLowerCase()),
  );
}

export const NO_WORKSPACE_FOLDERS =
  'No workspace folders found here. Choose a folder that contains your work or existing task plans.';

/**
 * detectKind: a Git repository is a repo; otherwise a folder whose direct
 * children are repositories is a folder; a folder with only .tasks is a repo.
 * Returns undefined when the folder holds no work.
 */
export async function detectKind(
  dir: string,
): Promise<ProjectKind | undefined> {
  if (await exists(path.join(dir, '.git'))) return 'repo';
  if ((await childRepos(dir)).length > 0) return 'folder';
  if (await exists(path.join(dir, '.tasks'))) return 'repo';
  return undefined;
}
