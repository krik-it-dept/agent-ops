import { join } from 'node:path';
import {
  SettingsStore,
  themeOrSystem,
  type AppConfig,
  type Result,
} from '../settings';
import { WorkspaceService } from '../workspaces';
import { TasksService, PlanActions, type UserEnvironment } from '../tasks';
import { ConfigChangedError, type SkillsConfigStore } from '../skills';
import type { LedgerConfiguration, LedgerService } from '../ledger';
import { ServiceFault } from '../../ipc/errors';
import { stat } from 'node:fs/promises';
import { migrateLegacyIntegrations } from '../migration/legacy-integrations';
import type { ServiceHandlers } from '../../ipc/registry';
import type { MoveReport } from '../../../shared/contracts';

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok)
    throw new ServiceFault(
      result.error.code,
      result.error.message,
      result.error.retryable,
    );
  return result.value;
}
export interface StartupPort {
  managed: boolean;
  get(): Promise<boolean>;
  set(enabled: boolean): Promise<void>;
}
export interface CoreOptions {
  dataDir: string;
  profileDir: string;
  version: string;
  ledger(): LedgerService;
  changed(): void;
  settingsChanged?(
    settings: Awaited<ReturnType<CoreServices['settings']>>,
  ): void;
  startup?: StartupPort;
  environment?: UserEnvironment;
  trash?: (file: string) => Promise<void>;
  log?(category: string, error?: unknown): void;
  legacy?: { reposDir?: string };
}

/** Adapts the settings/workspaces/tasks owner's APIs, without moving their business rules. */
export class CoreServices {
  get dataDir(): string {
    return this.options.dataDir;
  }
  readonly store: SettingsStore;
  readonly workspaces: WorkspaceService;
  readonly tasks: TasksService;
  readonly actions: PlanActions;
  private pointerWarnings: string[] = [];
  private sourceActionBusy = false;
  private async planAction<T>(action: () => Promise<T>): Promise<T> {
    if (this.sourceActionBusy)
      throw new ServiceFault(
        'BUSY',
        'Plans are being moved already. Wait for it to finish.',
        true,
      );
    this.sourceActionBusy = true;
    try {
      return await this.options.ledger().withPlanAction(action);
    } finally {
      this.sourceActionBusy = false;
    }
  }
  constructor(private readonly options: CoreOptions) {
    this.store = new SettingsStore({
      dataDir: options.dataDir,
      ...(options.legacy ? { legacy: options.legacy } : {}),
    });
    this.workspaces = new WorkspaceService(this.store, {
      changed: options.changed,
    });
    this.tasks = new TasksService({
      store: this.store,
      homeDir: options.profileDir,
      changed: options.changed,
      ...(options.environment ? { env: options.environment } : {}),
    });
    this.actions = new PlanActions({
      store: this.store,
      lookup: (key) => options.ledger().findPlan(key),
      changed: options.changed,
      trash:
        options.trash ??
        (async () => {
          throw new ServiceFault(
            'UNAVAILABLE',
            'Moving files to the Recycle Bin is not ready in this build.',
          );
        }),
    });
  }
  async initialize(): Promise<void> {
    await this.store.load();
    const backup = await migrateLegacyIntegrations(
      this.store,
      this.options.profileDir,
    );
    if (backup)
      this.options.log?.(
        'Skills list upgraded; config backup retained',
        backup,
      );
    // An unreadable/newer config must not clear the last known Tasks pointer or user variable.
    this.pointerWarnings = this.store.readOnly
      ? []
      : await this.tasks.syncPointers();
    for (const warning of this.pointerWarnings)
      this.options.log?.('Tasks pointer', warning);
  }
  configuration(): LedgerConfiguration {
    if (this.store.readOnly)
      throw new ServiceFault('READ_ONLY', 'Settings cannot be read safely.');
    const config = this.store.get();
    return {
      projects: config.projects,
      tasksDir: config.tasksDir,
      setupRequired: this.store.setupRequired,
      planArchive: config.planArchive,
      warnings: [this.store.warning, ...this.pointerWarnings].filter(Boolean),
    };
  }
  async settings() {
    const c = this.store.get();
    const [projects, tasks, startup] = await Promise.all([
      this.workspaces.list(),
      this.tasks.status(),
      this.options.startup?.get() ?? false,
    ]);
    return {
      setupRequired: this.store.setupRequired,
      setupComplete: c.setupComplete,
      notifications: c.notifications,
      theme: themeOrSystem(c.theme),
      textSize: c.textSize || 'default',
      shortcuts: c.shortcuts,
      autoArchiveDone: c.autoArchiveDone,
      planArchive: c.planArchive,
      startWithWindows: startup,
      startupManaged: this.options.startup?.managed ?? false,
      dataDir: this.options.dataDir,
      configFile: join(this.options.dataDir, 'config.json'),
      ...tasks,
      legacyPlanCount: this.options
        .ledger()
        .getState()
        .state.plans.filter((p) => p.source === 'legacy').length,
      projectsOverridden: '',
      warning: [this.store.warning, ...this.pointerWarnings]
        .filter(Boolean)
        .join(' '),
      readOnly: this.store.readOnly,
      version: this.options.version,
      projects,
    };
  }
  async committed(): Promise<void> {
    this.options.ledger().invalidate();
    await this.options.ledger().settled();
    this.options.settingsChanged?.(await this.settings());
  }
  skillsConfig(): SkillsConfigStore {
    return {
      load: async () => {
        const c = this.store.get();
        const exists = await stat(this.store.file).then(
          (info) => info.isFile(),
          () => false,
        );
        return {
          exists,
          integrations: c.integrations,
          integrationsSeeded: c.integrationsSeeded === true,
          readOnly: this.store.readOnly,
        };
      },
      save: async (next, expected) => {
        let conflict = false;
        const saved = await this.store.mutate((draft) => {
          if (JSON.stringify(draft.integrations) !== JSON.stringify(expected)) {
            conflict = true;
            throw new ConfigChangedError();
          }
          if (next?.length) draft.integrations = structuredClone(next);
          else delete draft.integrations;
          draft.integrationsSeeded = true;
        });
        if (conflict) throw new ConfigChangedError();
        unwrap(saved);
      },
    };
  }
  handlers(): ServiceHandlers {
    return {
      'settings:get': () => this.settings(),
      'settings:set': async ({
        tasksDir,
        allowInsideWorkspace,
        moveExisting,
        startWithWindows,
        ...preferences
      }) => {
        if (this.store.readOnly)
          throw new ServiceFault('READ_ONLY', this.store.readOnly);
        if (startWithWindows !== undefined && !this.options.startup?.managed)
          throw new ServiceFault(
            'CONFLICT',
            'Start with Windows can only be changed in the installed Agent Ops.',
          );
        let moved: {
          move?: MoveReport;
          moveError?: string;
        } = {};
        if (tasksDir !== undefined) {
          const result = unwrap(
            await this.planAction(() =>
              this.tasks.setTasksDir({
                tasksDir,
                ...(allowInsideWorkspace !== undefined
                  ? { allowInsideWorkspace }
                  : {}),
                ...(moveExisting !== undefined ? { moveExisting } : {}),
              }),
            ),
          );
          this.pointerWarnings = result.pointerProblems;
          moved = result;
        }
        if (startWithWindows !== undefined) {
          if (!this.options.startup?.managed)
            throw new ServiceFault(
              'CONFLICT',
              'Start with Windows can only be changed in the installed Agent Ops.',
            );
          await this.options.startup.set(startWithWindows);
        }
        if (Object.keys(preferences).length)
          unwrap(await this.store.update(preferences));
        await this.committed();
        return {
          ...(await this.settings()),
          ...(moved.move ?? {}),
          ...(moved.moveError ? { moveError: moved.moveError } : {}),
        };
      },
      'workspaces:add': async ({ path }) => {
        const added = unwrap(await this.workspaces.add(path));
        await this.committed();
        return {
          ...added,
          name: added.project.name,
          kind: added.project.kind,
          settings: await this.settings(),
        };
      },
      'workspaces:edit': async ({ id, ...patch }) => {
        unwrap(await this.workspaces.edit(id, patch));
        await this.committed();
        return this.settings();
      },
      'workspaces:remove': async ({ id }) => {
        unwrap(await this.workspaces.remove(id));
        await this.committed();
        return this.settings();
      },
      'tasks:move-legacy': async ({ keys }) => {
        const report = unwrap(
          await this.planAction(() => this.tasks.moveLegacy(keys)),
        );
        await this.committed();
        return { ...report, settings: await this.settings() };
      },
      'tasks:move-all': async ({ from }) => {
        const report = unwrap(
          await this.planAction(() => this.tasks.moveAll(from)),
        );
        await this.committed();
        return { ...report, settings: await this.settings() };
      },
      'plans:archive': async ({ key, archived }) => {
        unwrap(await this.actions.archive(key, archived));
        await this.committed();
        return this.settings();
      },
      'plans:recycle': async (request) => {
        unwrap(await this.planAction(() => this.actions.recycle(request)));
        await this.committed();
        return { recycled: true };
      },
    };
  }
}

/** Useful for installer/updater plug-ins without exposing the mutable config object. */
export type CurrentConfig = Readonly<AppConfig>;
