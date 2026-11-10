// Plan actions. Plan sources stay read-only except the owner's confirmed
// Delete, which moves the file to the Windows Recycle Bin through an injected
// trash (Electron shell.trashItem). The file is resolved from the settings and
// the plan key, never from a path the window sends.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  cleanPath,
  errorText,
  pathKey,
  realKey,
  realPath,
} from '../../lib/safe-io/paths';
import { isMissing } from '../../lib/safe-io/safe-io';
import type { AppConfig, Project } from '../settings/config';
import { TASKS_PROJECT_ID } from '../settings/identity';
import { OwnerError, fail, settle, type Result } from '../settings/result';
import type { SettingsStore } from '../settings/config-store';
import { projectRepos } from '../workspaces/discover';
import { MAX_PLAN_BYTES } from './move';

/** PlanRef is the part of a board plan the actions need (see docs/overview-schema.md). */
export interface PlanRef {
  project?: string;
  repo: string;
  name: string;
  status: string;
  /** SHA-256 hex of the file bytes the board read. */
  revision: string;
  /** The repository folder of a legacy plan. */
  root?: string;
  /** The plan file with forward slashes. */
  file?: string;
  source?: string;
}

/** planKey identifies a plan across workspaces; plans from before workspaces keep repo/plan. */
export function planKey(p: Pick<PlanRef, 'project' | 'repo' | 'name'>): string {
  return p.project ? `${p.project}/${p.repo}/${p.name}` : `${p.repo}/${p.name}`;
}

/** stage is the status before " - detail". */
export function stage(status: string): string {
  const i = status.indexOf(' - ');
  return i > 0 ? status.slice(0, i) : status;
}

/**
 * isArchived: an explicit owner choice wins; otherwise a plan is archived when
 * automatic archiving is on and its stage is Done.
 */
export function isArchived(
  p: PlanRef,
  config: Pick<AppConfig, 'planArchive' | 'autoArchiveDone'>,
): boolean {
  const key = planKey(p);
  if (Object.hasOwn(config.planArchive, key))
    return config.planArchive[key] === true;
  return config.autoArchiveDone && stage(p.status) === 'Done';
}

/** archivedKeys returns the keys of the archived plans among plans. */
export function archivedKeys(
  plans: PlanRef[],
  config: Pick<AppConfig, 'planArchive' | 'autoArchiveDone'>,
): string[] {
  return plans.filter((p) => isArchived(p, config)).map(planKey);
}

const CHANGED =
  'The plan file changed. Refresh and review it before trying again.';

function badName(name: string): boolean {
  return (
    name === '' ||
    name === '.' ||
    name === '..' ||
    /[/\\:\0]/.test(name) ||
    name.replace(/[ .]+$/, '') !== name
  );
}

function insideRoot(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith('..' + path.sep) &&
    !path.isAbsolute(rel)
  );
}

async function regularFile(file: string): Promise<string> {
  const info = await fs.lstat(file);
  if (!info.isFile())
    throw new OwnerError(
      'CONFLICT',
      'Only a regular plan file can be moved to the Recycle Bin.',
    );
  return file;
}

async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([
      fs.stat(a, { bigint: true }),
      fs.stat(b, { bigint: true }),
    ]);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/**
 * planActionPath resolves the file of a plan from the enabled workspaces or the
 * Tasks folder and the plan key: only <TasksDir>\<workspace>\<plan>.md or
 * <repository>\.tasks\<plan>.md of an enabled workspace, never a link or a
 * folder redirected elsewhere.
 */
export async function planActionPath(
  p: PlanRef,
  config: AppConfig,
): Promise<string> {
  if (badName(p.name))
    throw new OwnerError('INVALID_REQUEST', 'Invalid plan file name.');
  if (p.project === TASKS_PROJECT_ID) return tasksPlanPath(p, config.tasksDir);
  const project = config.projects.find(
    (x: Project) => x.enabled && x.id === p.project,
  );
  if (!project)
    throw new OwnerError(
      'CONFLICT',
      'The plan is not in a configured workspace.',
    );
  const workspace = await realPath(project.path);
  const repos = await projectRepos(project);
  for (const repo of repos) {
    // The reader records the canonical long root; the configured path may be an
    // 8.3 short name or reach the repository through a link.
    if (
      repo.name !== p.repo ||
      !p.root ||
      (await realKey(repo.path)) !== (await realKey(p.root))
    )
      continue;
    const root = await realPath(repo.path);
    if (
      pathKey(root) !== pathKey(workspace) &&
      !insideRoot(workspace.toLowerCase(), root.toLowerCase())
    ) {
      throw new OwnerError(
        'CONFLICT',
        'The plan is outside the configured workspace.',
      );
    }
    try {
      if (!(await fs.stat(path.join(root, '.git'))).isDirectory()) {
        throw new OwnerError(
          'CONFLICT',
          'Only the original workspace plan folder can be changed.',
        );
      }
    } catch (err) {
      if (err instanceof OwnerError) throw err;
    }
    const dir = path.join(root, '.tasks');
    if ((await realKey(dir)) !== pathKey(dir))
      throw new OwnerError(
        'CONFLICT',
        'The plan folder is redirected outside its workspace.',
      );
    return regularFile(path.join(dir, p.name + '.md'));
  }
  throw new OwnerError(
    'CONFLICT',
    'The plan is not in a configured workspace.',
  );
}

async function tasksPlanPath(p: PlanRef, tasksDir: string): Promise<string> {
  if (tasksDir === '')
    throw new OwnerError('CONFLICT', 'No Tasks folder is chosen.');
  const ws = p.repo;
  if (badName(ws) || ws.startsWith('.'))
    throw new OwnerError('INVALID_REQUEST', 'Invalid workspace folder name.');
  const file = path.join(tasksDir, ws, p.name + '.md');
  // The file the board showed and the resolved one must be the same file.
  if (!p.file || !(await sameFile(path.normalize(p.file), file)))
    throw new OwnerError('CONFLICT', 'The plan is not in the Tasks folder.');
  const root = await realPath(tasksDir);
  const dir = await realPath(path.join(tasksDir, ws));
  if (!insideRoot(root.toLowerCase(), dir.toLowerCase()))
    throw new OwnerError(
      'CONFLICT',
      'The workspace folder is redirected outside the Tasks folder.',
    );
  // Return the canonical long path, like a workspace plan, so the Recycle Bin
  // check compares it with the resolved file even when tasksDir is an 8.3 name.
  return regularFile(path.join(dir, p.name + '.md'));
}

export interface RecycleRequest {
  key: string;
  revision: string;
  confirm: boolean;
}

export interface PlanActionsOptions {
  store: SettingsStore;
  /** lookup returns the plan on the board under key, or undefined. */
  lookup: (key: string) => PlanRef | undefined;
  /** trash moves a file to the Recycle Bin and never deletes it permanently (Electron shell.trashItem). */
  trash: (file: string) => Promise<void>;
  /** changed runs after a plan was moved to the Recycle Bin, so the caller can refresh the board. */
  changed?: () => void;
}

export class PlanActions {
  constructor(private readonly opts: PlanActionsOptions) {}

  /** archive records the owner's choice in the settings only; the plan file is never touched. */
  async archive(key: string, archived: unknown): Promise<Result<AppConfig>> {
    const p = this.opts.lookup(key);
    if (!p)
      return fail(
        'NOT_FOUND',
        'This plan is no longer available. Refresh the list.',
      );
    if (typeof archived !== 'boolean')
      return fail('INVALID_REQUEST', 'Choose Archive or Unarchive.');
    return this.opts.store.mutate((c) => {
      c.planArchive[planKey(p)] = archived;
    });
  }

  /**
   * recycle moves a plan file to the Recycle Bin after the owner confirmed it:
   * the file is resolved from the key, its bytes must still hash to the
   * revision the owner reviewed, and it must be the same file when trashed.
   */
  async recycle(
    req: RecycleRequest,
  ): Promise<Result<{ recycled: true; file: string }>> {
    const p = this.opts.lookup(req.key);
    if (!p)
      return fail(
        'NOT_FOUND',
        'This plan is no longer available. Refresh the list.',
      );
    if (
      req.confirm !== true ||
      typeof req.revision !== 'string' ||
      req.revision === ''
    ) {
      return fail(
        'INVALID_REQUEST',
        'Confirm the file before moving it to the Recycle Bin.',
      );
    }
    const result = await settle(async () => {
      let file: string;
      try {
        file = await planActionPath(p, this.opts.store.get());
      } catch (err) {
        if (err instanceof OwnerError) throw err;
        if (isMissing(err))
          throw new OwnerError(
            'NOT_FOUND',
            'The plan file no longer exists. Refresh the list.',
          );
        throw new OwnerError(
          'CONFLICT',
          `Could not move this plan to the Recycle Bin. The file may be locked or unavailable. ${errorText(err)}`,
        );
      }
      let bytes: Buffer;
      let opened;
      try {
        opened = await fs.open(file, 'r');
      } catch (err) {
        if (isMissing(err))
          throw new OwnerError(
            'NOT_FOUND',
            'The plan file no longer exists. Refresh the list.',
          );
        throw new OwnerError(
          'CONFLICT',
          `Could not move this plan to the Recycle Bin. The file may be locked or unavailable. ${errorText(err)}`,
        );
      }
      try {
        const before = await opened.stat({ bigint: true });
        if (before.size > BigInt(MAX_PLAN_BYTES))
          throw new OwnerError('REVISION_CHANGED', CHANGED);
        bytes = await opened.readFile();
        const sum = createHash('sha256').update(bytes).digest('hex');
        if (sum !== req.revision || req.revision !== p.revision)
          throw new OwnerError('REVISION_CHANGED', CHANGED);
        const current = await fs.stat(file, { bigint: true });
        if (
          current.dev !== before.dev ||
          current.ino !== before.ino ||
          current.mtimeNs !== before.mtimeNs ||
          current.size !== before.size
        ) {
          throw new OwnerError('REVISION_CHANGED', CHANGED);
        }
      } finally {
        await opened.close();
      }
      try {
        await this.opts.trash(file);
      } catch (err) {
        throw new OwnerError(
          'CONFLICT',
          `Could not move this plan to the Recycle Bin. The file may be locked or unavailable. ${errorText(err)}`,
        );
      }
      return { recycled: true as const, file: cleanPath(file) };
    });
    if (result.ok) this.opts.changed?.();
    return result;
  }
}
