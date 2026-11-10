import { join } from 'node:path';
import skill from '../../../../skills/task-plan/SKILL.md?raw';
import {
  FileOverviewCache,
  LedgerService,
  workerCollector,
  type ActivityPort,
  type LedgerConfiguration,
  type OverviewCache,
  type Collector,
} from '../ledger';
import type { WorkerFactory } from '../ledger/worker-runner';
import {
  SkillsService,
  type SkillsConfigStore,
  type SkillAction,
} from '../skills';
import type { ServiceHandlers } from '../../ipc/registry';
import { ServiceFault } from '../../ipc/errors';
import { CoreServices, type CoreOptions } from './core';
import { activityAdapter } from './activity';
import type { ActivityEvent } from '../activity';
import { assertNoLegacyInstance } from './legacy-instance';
import { MutationGate } from './mutation-gate';
import { updateHandlers, type UpdaterPort } from './updates';
import type { Channel, Request } from '../../ipc/requests';

export interface RuntimeOptions {
  dataDir: string;
  profileDir: string;
  version: string;
  worker: WorkerFactory;
  collector?: Collector;
  changed(event: { generation: number }): void;
  /** Settings owner plugs in its validated current configuration and shared transaction store. */
  configuration?: () => Promise<LedgerConfiguration>;
  skillsConfig?: SkillsConfigStore;
  activity?: ActivityPort;
  cache?: OverviewCache;
  handlers?:
    | ServiceHandlers
    | ((context: {
        core: CoreServices;
        ledger: LedgerService;
      }) => ServiceHandlers);
  log?: (category: string, error?: unknown) => void;
  settingsChanged?: CoreOptions['settingsChanged'];
  startup?: CoreOptions['startup'];
  environment?: CoreOptions['environment'];
  trash?: CoreOptions['trash'];
  notify?: (events: ActivityEvent[]) => void;
  updater?: UpdaterPort;
  updateChanged?: (state: ReturnType<UpdaterPort['getState']>) => void;
  crash?: () => import('../logging/crash').CrashNotice | null;
  legacy?: CoreOptions['legacy'];
  sampleModeAllowed?: boolean;
}

/** Composition adapters only: no duplicate settings, activity or platform business logic. */
export function createRuntime(options: RuntimeOptions) {
  const gate = new MutationGate();
  const core: CoreServices = new CoreServices({
    dataDir: options.dataDir,
    profileDir: options.profileDir,
    version: options.version,
    ledger: () => ledger,
    changed: () => ledger.invalidate(),
    ...(options.settingsChanged
      ? { settingsChanged: options.settingsChanged }
      : {}),
    ...(options.startup ? { startup: options.startup } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.trash ? { trash: options.trash } : {}),
    ...(options.log ? { log: options.log } : {}),
    ...(options.legacy ? { legacy: options.legacy } : {}),
  });
  const configuration =
    options.configuration ?? (async () => core.configuration());
  const activity =
    options.activity ?? activityAdapter(options.dataDir, core, options.notify);
  const ledger: LedgerService = new LedgerService({
    version: options.version,
    configuration,
    collect: options.collector ?? workerCollector(options.worker),
    cache: options.cache ?? new FileOverviewCache(options.dataDir),
    changed: options.changed,
    activity,
    ...(options.log ? { log: options.log } : {}),
  });
  const skills = new SkillsService({
    dataDir: options.dataDir,
    config: options.skillsConfig ?? core.skillsConfig(),
    skill: { content: skill },
    detection: {
      homeDir: options.profileDir,
      roamingAppData: join(options.profileDir, 'AppData', 'Roaming'),
    },
    workspaces: async () =>
      (await configuration()).projects.map((p) => ({
        name: p.name ?? p.path,
        path: p.path,
      })),
  });
  const skillsResponse = async () => ({
    ...(await skills.listTargets()),
    suggestions: await skills.suggestTargets(),
    migration: null,
  });
  const action =
    (kind: SkillAction) =>
    async ({ id }: { id: string }) => {
      await skills.runAction(id, kind);
      return skillsResponse();
    };
  const handlers: ServiceHandlers = {
    'state:get': () => ({
      ...ledger.getState(),
      crash: options.crash?.() ?? null,
    }),
    'state:refresh': async () => {
      await ledger.refresh();
      const state = ledger.getState();
      if (state.error)
        throw new ServiceFault('REFRESH_FAILED', state.error, true);
      return { refreshedAt: state.state.generatedAt };
    },
    'skills:list': skillsResponse,
    'skills:add': async (input) => {
      const added = await skills.addTarget(input);
      return { ...(await skillsResponse()), added: added.id };
    },
    'skills:edit': async ({ id, ...input }) => {
      await skills.updateTarget(id, input);
      return skillsResponse();
    },
    'skills:remove-target': async ({ id }) => {
      await skills.removeTarget(id);
      return skillsResponse();
    },
    'skills:diff': ({ id }) => skills.diffTarget(id),
    'skills:install': action('install'),
    'skills:update': action('update'),
    'skills:replace': action('replace'),
    'skills:keep': action('keep'),
    'skills:remove-skill': action('remove'),
    'skills:instructions-on': action('instructions-on'),
    'skills:instructions-off': action('instructions-off'),
    'app:get-info': () => ({
      version: options.version,
      dataDir: options.dataDir,
      platform: 'win32' as const,
      sampleModeAllowed: options.sampleModeAllowed === true,
    }),
    'app:get-instance': () => ({ pid: process.pid, version: options.version }),
    ...core.handlers(),
    ...(options.updater ? updateHandlers(options.updater) : {}),
    ...(typeof options.handlers === 'function'
      ? options.handlers({ core, ledger })
      : options.handlers),
  };
  const guarded: ServiceHandlers = {};
  function bind<C extends Channel>(channel: C): void {
    const handler = handlers[channel];
    if (!handler) return;
    const readOnly = [
      'state:get',
      'settings:get',
      'skills:list',
      'skills:diff',
      'shell:cancel-pick',
      'app:get-info',
      'app:renderer-ready',
      'app:get-instance',
      'app:open',
      'diagnostics:get',
      'diagnostics:copy',
      'updates:get',
      'updates:check',
      'updates:apply',
    ].includes(channel);
    Object.assign(guarded, {
      [channel]: (request: Request<C>) =>
        readOnly ? handler(request) : gate.run(() => handler(request)),
    });
  }
  for (const channel of Object.keys(handlers) as Channel[]) bind(channel);
  const unsubscribeUpdate = options.updater?.onState((state) => {
    if (state.phase === 'error') {
      gate.reopen();
      ledger.resumeAfterInstallFailure();
    }
    options.updateChanged?.(state);
  });
  let initialized: Promise<void> | undefined;
  const initialize = () =>
    (initialized ??= Promise.resolve().then(() => {
      assertNoLegacyInstance(options.dataDir);
      return core.initialize();
    }));
  return {
    ledger,
    skills,
    core,
    handlers: guarded,
    initialize,
    start: async () => {
      await initialize();
      await ledger.start();
      await options.updater?.start();
    },
    prepareForInstall: async () => {
      await gate.drain();
      await ledger.suspend();
    },
    afterInstallFailed: () => {
      gate.reopen();
      ledger.resumeAfterInstallFailure();
    },
    stop: async () => {
      options.updater?.stop();
      unsubscribeUpdate?.();
      await gate.drain();
      await ledger.stop();
    },
  };
}
