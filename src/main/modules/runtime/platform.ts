import { createHash } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve, win32 } from 'node:path';
import type {
  PlatformServices,
  AllowPath,
  Activation,
  PlatformSnapshot,
} from '../platform';
import { validPlanKey } from '../platform/activation';
import { USER_ENV_NAMES, type UserEnvName } from '../platform/windows';
import { planActionPath } from '../tasks';
import type { UserEnvironment } from '../tasks';
import { readPlanFile } from '../plans';
import type { CoreServices, StartupPort } from './core';
import type { LedgerService } from '../ledger';
import type { ServiceHandlers } from '../../ipc/registry';
import { ServiceFault } from '../../ipc/errors';

export const RELEASES =
  'https://github.com/krik-it-dept/agent-ops/releases/tag/';
const pathKey = (file: string) => resolve(file).toLowerCase();

/** Scope is the trusted main WebContents id, never a renderer-provided owner token. */
export function platformHandlers(options: {
  platform: PlatformServices;
  core: CoreServices;
  ledger: LedgerService;
  senderScope: string;
  activate(target: Activation): void;
  openExternal(url: string): Promise<void>;
}): ServiceHandlers {
  const { platform, core, ledger } = options;
  return {
    'shell:pick': (input) => platform.picker.pick(input, options.senderScope),
    'shell:cancel-pick': (input) =>
      platform.picker.cancelPick(input, options.senderScope),
    'shell:open-folder': async (input) => {
      const config = core.store.get();
      if (input.target === 'plan') {
        const plan = ledger.findPlan(activationKey(ledger, input.key));
        if (!plan)
          throw new ServiceFault(
            'NOT_FOUND',
            'This plan is no longer available.',
          );
        await platform.folders.openFolder(
          dirname(await planActionPath(plan, config)),
        );
      } else if (input.target === 'logs') await platform.folders.openLogs();
      else {
        const file =
          input.target === 'data'
            ? core.dataDir
            : input.target === 'tasks'
              ? config.tasksDir
              : 'id' in input
                ? config.projects.find((p) => p.id === input.id)?.path
                : undefined;
        if (!file)
          throw new ServiceFault(
            'NOT_FOUND',
            'This folder is no longer available.',
          );
        await platform.folders.openFolder(file);
      }
      return { opened: true };
    },
    'shell:open-external': async (input) => {
      let url: string;
      if (input.target === 'release') url = RELEASES + input.version;
      else {
        const plan = ledger.findPlan(input.key);
        // The reader stores the repository as https://github.com/<owner>/<repo>.
        const repo =
          /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)$/.exec(
            plan?.gh ?? '',
          )?.[1];
        if (!repo || repo.split('/').some((part) => /^\.+$/.test(part)))
          throw new ServiceFault(
            'NOT_FOUND',
            'This link is no longer available.',
          );
        url = `https://github.com/${repo}/pull/${input.number}`;
      }
      await options.openExternal(url);
      return { opened: true };
    },
    'diagnostics:get': () => platform.diagnostics.get(),
    'diagnostics:copy': () => platform.diagnostics.copy(),
    'diagnostics:dismiss-crash': () => {
      platform.crashes.dismissCrash();
      return { dismissed: true };
    },
    'app:open': ({ plan }) => {
      options.activate(plan ? { plan: activationKey(ledger, plan) } : {});
      return { pid: process.pid };
    },
  };
}

/** Legacy two-component links resolve only when exactly one current plan matches. */
export function activationKey(ledger: LedgerService, key: string): string {
  if (!validPlanKey(key))
    throw new ServiceFault('INVALID_REQUEST', 'This task link is not valid.');
  const plans = ledger.getState().state.plans;
  const matches = plans.filter((p) =>
    key.split('/').length === 3
      ? `${p.project}/${p.repo}/${p.name}` === key
      : `${p.repo}/${p.name}` === key,
  );
  if (matches.length !== 1)
    throw new ServiceFault(
      'NOT_FOUND',
      'This task is no longer available. Refresh the list.',
    );
  const p = matches[0]!;
  return `${p.project}/${p.repo}/${p.name}`;
}

export function startupAdapter(
  platform: PlatformServices,
  changed: () => void,
): StartupPort {
  return {
    managed: platform.startup.managed,
    get: async () => platform.startup.get().enabled,
    set: async (enabled) => {
      platform.startup.set(enabled);
      changed();
    },
  };
}

function pointerName(name: string): UserEnvName {
  if (!(USER_ENV_NAMES as readonly string[]).includes(name))
    throw new Error('Unknown environment pointer.');
  return name as UserEnvName;
}

/** The platform writer already queries HKCU, deduplicates and broadcasts atomically per request. */
export function environmentAdapter(
  platform: PlatformServices,
): UserEnvironment {
  return {
    // Force delegation even for clearing an existing value; the platform owns the real read.
    get: async () => '\0',
    set: async (name, value) => {
      await platform.environment.setUserEnv(pointerName(name), value);
    },
    delete: async (name) => {
      await platform.environment.setUserEnv(pointerName(name), null);
    },
    broadcast: () => {},
  };
}

export function diagnosticSnapshot(
  core: CoreServices,
  ledger: LedgerService,
  updateChecks: boolean,
): PlatformSnapshot {
  const config = core.store.get();
  const overview = ledger.getState().state;
  return {
    counts: {
      projects: config.projects.length,
      enabledProjects: config.projects.filter((p) => p.enabled).length,
      folderProjects: config.projects.filter((p) => p.kind === 'folder').length,
      plans: overview.plans.length,
      diagnostics: overview.diagnostics.length,
    },
    settings: {
      notifications: config.notifications,
      tasksConfigured: !!config.tasksDir,
      setupComplete: config.setupComplete,
      readOnly: !!core.store.readOnly,
      updateChecks,
      shortcuts: config.shortcuts,
    },
  };
}

/** Known directories only; trash is re-resolved and hash-checked against the retained overview. */
export function pathPolicy(options: {
  dataDir: string;
  core(): CoreServices | undefined;
  ledger(): LedgerService | undefined;
  fixedDrive(file: string): Promise<boolean>;
}): AllowPath {
  return async (file, action) => {
    try {
      const core = options.core();
      if (!core) return false;
      const config = core.store.get();
      if (action !== 'trash') {
        const known = [
          options.dataDir,
          join(options.dataDir, 'logs'),
          config.tasksDir,
          ...config.projects.map((p) => p.path),
        ].filter(Boolean);
        for (const plan of options.ledger()?.getState().state.plans ?? []) {
          const file = await planActionPath(plan, config).catch(() => '');
          if (file) known.push(dirname(file));
        }
        return (
          known.some((p) => pathKey(p) === pathKey(file)) &&
          (await stat(file)).isDirectory()
        );
      }
      // Reject device/UNC/mapped network/removable locations before invoking the shell.
      if (
        !/^[a-z]:[\\/]/i.test(file) ||
        file.startsWith('\\\\') ||
        !(await options.fixedDrive(file))
      )
        return false;
      if (!(await lstat(file)).isFile()) return false;
      // Compare canonical long paths: an 8.3 short name (C:\Users\RUNNER~1) and
      // its long name are the same file; a link must resolve to the plan file.
      const actual = pathKey(await realpath(file));
      const ledger = options.ledger();
      if (!ledger) return false;
      for (const plan of ledger.getState().state.plans) {
        const candidate = await planActionPath(plan, config).catch(() => '');
        if (
          !candidate ||
          pathKey(await realpath(candidate).catch(() => '')) !== actual
        )
          continue;
        return (
          createHash('sha256')
            .update(await readPlanFile(file))
            .digest('hex') === plan.revision
        );
      }
      return false;
    } catch {
      return false;
    }
  };
}

export const FIXED_DRIVE_SCRIPT =
  "$ErrorActionPreference='Stop'; $drive=[System.IO.DriveInfo]::new($env:AGENT_OPS_DRIVE); if ($drive.IsReady -and $drive.DriveType -eq [System.IO.DriveType]::Fixed) { exit 0 }; exit 1";
export function fixedDriveProbe(
  run: (script: string, env: NodeJS.ProcessEnv) => Promise<number>,
) {
  return async (file: string): Promise<boolean> => {
    const root = win32.parse(file).root;
    if (!/^[a-z]:\\$/i.test(root)) return false;
    return (
      (await run(FIXED_DRIVE_SCRIPT, {
        ...process.env,
        AGENT_OPS_DRIVE: root,
      })) === 0
    );
  };
}
