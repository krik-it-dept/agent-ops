// TasksService: choose the Tasks folder, keep its pointers current, and move
// plans into it. Moves run one at a time; a second one is refused as busy.

import path from 'node:path';
import {
  overlaps,
  realKey,
  samePath,
  withinReal,
  errorText,
} from '../../lib/safe-io/paths';
import { promises as fs } from 'node:fs';
import type { AppConfig, Project } from '../settings/config';
import { TASKS_PROJECT_ID } from '../settings/identity';
import { OwnerError, fail, settle, type Result } from '../settings/result';
import type { SettingsStore } from '../settings/config-store';
import { projectRepos } from '../workspaces/discover';
import {
  addResult,
  countTasksPlans,
  emptyReport,
  listPlans,
  movePlanFile,
  newMoveBackup,
  tasksPlanFiles,
  type MoveHooks,
  type MoveReport,
} from './move';
import {
  checkTasksDir,
  suggestedTasksDir,
  syncTasksPointers,
  type UserEnvironment,
} from './tasks-dir';

/** LegacyPlanFile is one plan in a repository's .tasks folder, keyed like the board. */
export interface LegacyPlanFile {
  key: string;
  workspace: string;
  name: string;
  file: string;
  project: Project;
}

export interface SetTasksDirRequest {
  tasksDir: string;
  allowInsideWorkspace?: boolean;
  moveExisting?: boolean;
}

export interface SetTasksDirResult {
  config: AppConfig;
  /** Present with moveExisting: the plans moved from the previous folder (empty when there was none). */
  move?: MoveReport;
  /** Set when moveExisting could not start; no file was touched then. The new folder is saved either way. */
  moveError?: string;
  /** Pointer problems, logged by the caller; the folder is saved either way. */
  pointerProblems: string[];
}

export interface TasksStatus {
  tasksDir: string;
  tasksDirSuggested: string;
  previousTasksDir: string;
  previousPlanCount: number;
}

export interface TasksServiceOptions {
  store: SettingsStore;
  /** homeDir is %USERPROFILE%; the suggestion is <homeDir>\agent-ops\tasks. */
  homeDir: string;
  /** env writes AGENT_OPS_TASKS; give it only to the installed instance. */
  env?: UserEnvironment;
  now?: () => Date;
  hooks?: MoveHooks;
  /** changed runs after the folder changed or plans moved, so the caller can refresh the board. */
  changed?: () => void;
}

export class TasksService {
  private moving = false;

  constructor(private readonly opts: TasksServiceOptions) {}

  private get store(): SettingsStore {
    return this.opts.store;
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  suggestedTasksDir(): string {
    return suggestedTasksDir(this.opts.homeDir);
  }

  async status(): Promise<TasksStatus> {
    const c = this.store.get();
    return {
      tasksDir: c.tasksDir,
      tasksDirSuggested: this.suggestedTasksDir(),
      previousTasksDir: c.previousTasksDir,
      previousPlanCount: await countTasksPlans(c.previousTasksDir),
    };
  }

  /** syncPointers runs at start: an unchanged pointer is not rewritten. */
  syncPointers(): Promise<string[]> {
    return syncTasksPointers(this.store.get().tasksDir, {
      dataDir: this.store.dataDir,
      env: this.opts.env,
      io: this.store.io,
    });
  }

  /** exclusive runs one move at a time; a second request is refused at once. */
  private async exclusive<T>(
    work: () => Promise<Result<T>>,
  ): Promise<Result<T>> {
    if (this.moving)
      return fail(
        'BUSY',
        'Plans are being moved already. Wait for it to finish.',
      );
    this.moving = true;
    try {
      return await work();
    } finally {
      this.moving = false;
    }
  }

  /**
   * setTasksDir validates and creates the folder, saves it, remembers the
   * previous one, updates the pointers and, with moveExisting, moves every plan
   * of the previous folder into the new one.
   */
  setTasksDir(req: SetTasksDirRequest): Promise<Result<SetTasksDirResult>> {
    const run = () => this.setTasksDirNow(req);
    return req.moveExisting ? this.exclusive(run) : run();
  }

  private async setTasksDirNow(
    req: SetTasksDirRequest,
  ): Promise<Result<SetTasksDirResult>> {
    if (typeof req.tasksDir !== 'string')
      return fail('INVALID_REQUEST', 'Invalid settings request.');
    if (this.store.readOnly !== '')
      return fail('READ_ONLY', this.store.readOnly);
    // Folder checks run before the settings lock, as for workspaces.
    const checked = await settle(() =>
      checkTasksDir(req.tasksDir, {
        projects: this.store.get().projects,
        dataDir: this.store.dataDir,
        homeDir: this.opts.homeDir,
        allowInside: req.allowInsideWorkspace === true,
      }),
    );
    if (!checked.ok) return checked;
    const dir = checked.value;
    const saved = await this.store.mutate((c) => {
      if (c.tasksDir !== '' && !samePath(c.tasksDir, dir))
        c.previousTasksDir = c.tasksDir;
      c.tasksDir = dir;
      if (samePath(c.previousTasksDir, dir)) c.previousTasksDir = '';
    });
    if (!saved.ok) return saved;
    const pointerProblems = await syncTasksPointers(dir, {
      dataDir: this.store.dataDir,
      env: this.opts.env,
      io: this.store.io,
    });
    const result: SetTasksDirResult = { config: saved.value, pointerProblems };
    if (req.moveExisting) {
      result.move = emptyReport();
      if (saved.value.previousTasksDir !== '') {
        const moved = await this.movePrevious(
          saved.value.previousTasksDir,
          dir,
        );
        if (moved.ok) result.move = moved.value;
        else result.moveError = moved.error.message;
      }
      result.config = this.store.get();
    }
    this.opts.changed?.();
    return { ok: true, value: result };
  }

  /** beginMove applies the checks every move shares and returns the Tasks folder. */
  private async beginMove(): Promise<string> {
    if (this.store.readOnly !== '')
      throw new OwnerError('READ_ONLY', this.store.readOnly);
    const tasksDir = this.store.get().tasksDir;
    if (tasksDir === '')
      throw new OwnerError(
        'CONFLICT',
        'Choose a Tasks folder in Settings > Tasks first.',
      );
    try {
      await fs.mkdir(tasksDir, { recursive: true });
    } catch (err) {
      throw new OwnerError(
        'CONFLICT',
        `The Tasks folder ${tasksDir} cannot be created: ${errorText(err)}`,
      );
    }
    return tasksDir;
  }

  /**
   * legacyPlanFiles lists the legacy plans of the enabled workspaces. Only
   * files found this way are ever moved, so a request can never name a path.
   */
  async legacyPlanFiles(): Promise<LegacyPlanFile[]> {
    const out: LegacyPlanFile[] = [];
    for (const p of this.store.get().projects.filter((x) => x.enabled)) {
      let repos;
      try {
        repos = await projectRepos(p);
      } catch {
        continue;
      }
      for (const r of repos) {
        let names: string[];
        try {
          names = await listPlans(path.join(r.path, '.tasks'));
        } catch {
          continue;
        }
        for (const name of names) {
          const plan = name.slice(0, -'.md'.length);
          out.push({
            key: `${p.id}/${r.name}/${plan}`,
            workspace: r.name,
            name,
            file: path.join(r.path, '.tasks', name),
            project: p,
          });
        }
      }
    }
    return out;
  }

  /** moveLegacy moves legacy plans into the Tasks folder: the given keys, or every legacy plan without keys. */
  moveLegacy(keys?: string[]): Promise<Result<MoveReport>> {
    return this.exclusive(() =>
      settle(async () => {
        if (
          keys !== undefined &&
          (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string'))
        )
          throw new OwnerError('INVALID_REQUEST', 'Invalid request.');
        const tasksDir = await this.beginMove();
        let backup: string;
        try {
          backup = await newMoveBackup(
            this.store.dataDir,
            'tasks-move-legacy',
            this.now(),
          );
        } catch (err) {
          throw new OwnerError(
            'IO_ERROR',
            `The backup folder could not be created: ${errorText(err)}`,
          );
        }
        const files = await this.legacyPlanFiles();
        const report = emptyReport(backup);
        let selected = files;
        if (keys !== undefined) {
          const byKey = new Map(files.map((f) => [f.key, f]));
          selected = [];
          for (const key of new Set(keys)) {
            const f = byKey.get(key);
            if (f) selected.push(f);
            else
              addResult(
                report,
                { key, from: '', to: '' },
                'This plan is not among the older plans of an enabled workspace.',
              );
          }
        }
        for (const f of selected) {
          const to = path.join(tasksDir, f.workspace, f.name);
          const m = { key: f.key, from: f.file, to };
          if (!(await withinReal(f.file, f.project.path))) {
            addResult(
              report,
              m,
              'The older plan folder leads outside the workspace (a link?); move it by hand.',
            );
            continue;
          }
          addResult(
            report,
            m,
            await movePlanFile(
              f.file,
              to,
              path.join(backup, f.project.id, f.workspace, f.name),
              this.opts.hooks,
            ),
          );
        }
        if (report.moved > 0) this.opts.changed?.();
        return report;
      }),
    );
  }

  /** moveAll moves every plan of the previous Tasks folder into the current one; from must be that folder. */
  moveAll(from: string): Promise<Result<MoveReport>> {
    return this.exclusive(async () => {
      const begun = await settle(() => this.beginMove());
      if (!begun.ok) return begun;
      const previous = this.store.get().previousTasksDir;
      if (
        typeof from !== 'string' ||
        previous === '' ||
        !samePath(from, previous)
      ) {
        return fail(
          'INVALID_REQUEST',
          'Agent Ops only moves plans from the previous Tasks folder.',
        );
      }
      const moved = await this.movePrevious(previous, begun.value);
      if (moved.ok && moved.value.moved > 0) this.opts.changed?.();
      return moved;
    });
  }

  /**
   * movePrevious moves every <previous>\<workspace>\<plan>.md into tasksDir and
   * forgets previous once it holds no plan. A failure is reported before any
   * file was touched.
   */
  private movePrevious(
    previous: string,
    tasksDir: string,
  ): Promise<Result<MoveReport>> {
    return settle(async () => {
      if (overlaps(await realKey(previous), await realKey(tasksDir))) {
        throw new OwnerError(
          'CONFLICT',
          'The previous and the current Tasks folder overlap; move the plans by hand.',
        );
      }
      let files: string[] = [];
      try {
        files = await tasksPlanFiles(previous);
      } catch (err) {
        if ((err as { code?: string }).code !== 'ENOENT') {
          throw new OwnerError(
            'CONFLICT',
            `The previous Tasks folder cannot be read: ${errorText(err)}`,
          );
        }
      }
      let backup: string;
      try {
        backup = await newMoveBackup(
          this.store.dataDir,
          'tasks-move-all',
          this.now(),
        );
      } catch (err) {
        throw new OwnerError(
          'IO_ERROR',
          `The backup folder could not be created: ${errorText(err)}`,
        );
      }
      const report = emptyReport(backup);
      for (const file of files) {
        const rel = path.relative(previous, file);
        const to = path.join(tasksDir, rel);
        const key = `${TASKS_PROJECT_ID}/${path.basename(path.dirname(file))}/${path.basename(file, '.md')}`;
        const m = { key, from: file, to };
        if (!(await withinReal(file, previous))) {
          addResult(
            report,
            m,
            'The workspace folder leads outside the previous Tasks folder (a link?); move it by hand.',
          );
          continue;
        }
        addResult(
          report,
          m,
          await movePlanFile(file, to, path.join(backup, rel), this.opts.hooks),
        );
      }
      if ((await countTasksPlans(previous)) === 0) {
        await this.store.mutate((c) => {
          if (samePath(c.previousTasksDir, previous)) c.previousTasksDir = '';
        });
      }
      return report;
    });
  }
}
