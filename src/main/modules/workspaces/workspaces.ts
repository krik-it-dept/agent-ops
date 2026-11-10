// Workspaces: add, enable or disable, rename and remove. Folder checks can wait
// on a slow drive, so they run before the settings lock; the save re-checks
// overlap by path text only.

import { promises as fs } from 'node:fs';
import {
  cleanPath,
  isAbsolutePath,
  overlaps,
  pathKey,
  pathWithin,
  realKey,
  errorText,
} from '../../lib/safe-io/paths';
import { isMissing } from '../../lib/safe-io/safe-io';
import { MAX_PROJECT_NAME_BYTES, type Project } from '../settings/config';
import {
  PROJECT_ID_PATTERN,
  projectDisplayName,
  projectIdFor,
} from '../settings/identity';
import { OwnerError, fail, settle, type Result } from '../settings/result';
import type { SettingsStore } from '../settings/config-store';
import {
  NO_WORKSPACE_FOLDERS,
  detectKind,
  projectRepos,
  type RepoInfo,
} from './discover';

export interface InspectedWorkspace {
  project: Project;
  repos: RepoInfo[];
}

/** WorkspaceView is a workspace as Settings shows it, with what is on disk now. */
export interface WorkspaceView extends Project {
  exists: boolean;
  error?: string;
  repos: RepoInfo[];
}

/**
 * inspectNewWorkspace validates a folder the owner chose against the existing
 * workspaces and the Tasks folder. Errors are sentences shown inline.
 */
export async function inspectNewWorkspace(
  raw: string,
  existing: Project[],
  tasksDir: string,
  now: Date,
): Promise<InspectedWorkspace> {
  let p = raw.trim();
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"'))
    p = p.slice(1, -1).trim();
  if (p === '' || !isAbsolutePath(p) || p.includes('\0'))
    throw new OwnerError(
      'INVALID_REQUEST',
      'Enter a full folder path, for example C:\\Projects.',
    );
  p = cleanPath(p);
  let info;
  try {
    info = await fs.stat(p);
  } catch (err) {
    if (isMissing(err))
      throw new OwnerError('INVALID_REQUEST', 'This folder does not exist.');
    throw new OwnerError(
      'INVALID_REQUEST',
      `Agent Ops cannot open this folder: ${errorText(err)}`,
    );
  }
  if (!info.isDirectory())
    throw new OwnerError(
      'INVALID_REQUEST',
      'This path is a file. Choose a folder.',
    );
  try {
    await fs.readdir(p);
  } catch (err) {
    throw new OwnerError(
      'INVALID_REQUEST',
      `Agent Ops cannot read this folder: ${errorText(err)}`,
    );
  }
  const resolved = await realKey(p);
  for (const other of existing) {
    const key = await realKey(other.path);
    if (key === resolved)
      throw new OwnerError(
        'INVALID_REQUEST',
        `This folder is already added as “${other.name}”.`,
      );
    if (pathWithin(resolved, key))
      throw new OwnerError(
        'INVALID_REQUEST',
        `This folder is inside the workspace “${other.name}”, which already includes it.`,
      );
    if (pathWithin(key, resolved)) {
      throw new OwnerError(
        'INVALID_REQUEST',
        `This folder contains the workspace “${other.name}”. Remove that workspace first, then add this folder.`,
      );
    }
  }
  if (tasksDir !== '') {
    const tasks = await realKey(tasksDir);
    if (tasks === resolved || pathWithin(tasks, resolved)) {
      throw new OwnerError(
        'INVALID_REQUEST',
        'This folder contains the Tasks folder. Choose the folder of your work, or move the Tasks folder in Settings > Tasks first.',
      );
    }
  }
  const kind = await detectKind(p);
  if (!kind) throw new OwnerError('INVALID_REQUEST', NO_WORKSPACE_FOLDERS);
  const project: Project = {
    id: projectIdFor(p),
    path: p,
    name: projectDisplayName(p),
    kind,
    enabled: true,
    addedAt: now.toISOString(),
  };
  const same = existing.find((e) => e.id === project.id);
  if (same)
    throw new OwnerError(
      'INVALID_REQUEST',
      `This folder is already added as “${same.name}”.`,
    );
  let repos: RepoInfo[];
  try {
    repos = await projectRepos(project);
  } catch (err) {
    throw new OwnerError(
      'INVALID_REQUEST',
      `Agent Ops cannot read this folder: ${errorText(err)}`,
    );
  }
  return { project, repos };
}

/** validProjectName: 1 to 120 bytes, no control characters. */
export function validProjectName(name: string): boolean {
  return (
    name !== '' &&
    Buffer.byteLength(name, 'utf8') <= MAX_PROJECT_NAME_BYTES &&
    !/\p{Cc}/u.test(name)
  );
}

export async function describeWorkspace(p: Project): Promise<WorkspaceView> {
  try {
    return { ...p, exists: true, repos: await projectRepos(p) };
  } catch (err) {
    return {
      ...p,
      exists: false,
      error: isMissing(err) ? 'Folder not found.' : errorText(err),
      repos: [],
    };
  }
}

export interface WorkspaceEvents {
  /** changed runs after a saved change, so the caller can refresh the board. */
  changed?: () => void;
}

export class WorkspaceService {
  constructor(
    private readonly store: SettingsStore,
    private readonly opts: { now?: () => Date } & WorkspaceEvents = {},
  ) {}

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  async list(): Promise<WorkspaceView[]> {
    return Promise.all(this.store.get().projects.map(describeWorkspace));
  }

  /** enabled returns the workspaces read now. */
  enabled(): Project[] {
    return this.store.get().projects.filter((p) => p.enabled);
  }

  async add(raw: string): Promise<Result<InspectedWorkspace>> {
    if (this.store.readOnly !== '')
      return fail('READ_ONLY', this.store.readOnly);
    const before = this.store.get();
    const inspected = await settle(() =>
      inspectNewWorkspace(raw, before.projects, before.tasksDir, this.now()),
    );
    if (!inspected.ok) return inspected;
    const added = inspected.value.project;
    const saved = await this.store.mutate((c) => {
      // Re-check against workspaces added meanwhile, by path only (no I/O).
      for (const p of c.projects) {
        if (
          p.id === added.id ||
          overlaps(pathKey(added.path), pathKey(p.path))
        ) {
          throw new OwnerError(
            'INVALID_REQUEST',
            `This folder overlaps the workspace “${p.name}”, which was just added.`,
          );
        }
      }
      c.projects.push(added);
    });
    if (!saved.ok) return saved;
    this.opts.changed?.();
    return inspected;
  }

  /** edit changes the name and/or the enabled state in one save (workspaces:edit). */
  edit(
    id: string,
    change: { name?: unknown; enabled?: unknown },
  ): Promise<Result<Project>> {
    return this.change(id, (p) => {
      if (change.enabled !== undefined && typeof change.enabled !== 'boolean') {
        throw new OwnerError('INVALID_REQUEST', 'Invalid workspace change.');
      }
      if (change.name !== undefined) {
        const trimmed =
          typeof change.name === 'string' ? change.name.trim() : '';
        if (!validProjectName(trimmed))
          throw new OwnerError(
            'INVALID_REQUEST',
            'Enter a workspace name of 1 to 120 characters.',
          );
        p.name = trimmed;
      }
      if (typeof change.enabled === 'boolean') p.enabled = change.enabled;
    });
  }

  setEnabled(id: string, enabled: boolean): Promise<Result<Project>> {
    return this.edit(id, { enabled });
  }

  rename(id: string, name: string): Promise<Result<Project>> {
    return this.edit(id, { name });
  }

  async remove(id: string): Promise<Result<Project>> {
    if (!PROJECT_ID_PATTERN.test(id))
      return fail('NOT_FOUND', 'Workspace not found.');
    let removed: Project | undefined;
    const saved = await this.store.mutate((c) => {
      const index = c.projects.findIndex((p) => p.id === id);
      if (index < 0)
        throw new OwnerError(
          'NOT_FOUND',
          'Workspace not found. Reload Settings.',
        );
      [removed] = c.projects.splice(index, 1);
    });
    if (!saved.ok) return saved;
    this.opts.changed?.();
    return { ok: true, value: removed! };
  }

  private async change(
    id: string,
    change: (p: Project) => void,
  ): Promise<Result<Project>> {
    if (!PROJECT_ID_PATTERN.test(id))
      return fail('NOT_FOUND', 'Workspace not found.');
    const saved = await this.store.mutate((c) => {
      const p = c.projects.find((x) => x.id === id);
      if (!p)
        throw new OwnerError(
          'NOT_FOUND',
          'Workspace not found. Reload Settings.',
        );
      change(p);
    });
    if (!saved.ok) return saved;
    this.opts.changed?.();
    return { ok: true, value: saved.value.projects.find((p) => p.id === id)! };
  }
}
