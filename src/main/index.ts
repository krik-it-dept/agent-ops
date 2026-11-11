import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  shell,
  protocol,
  dialog,
} from 'electron';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { resolveDataDir } from './data-dir';
import { systemExecutable } from './modules/platform/windows';
import { registerApplicationIpc } from './ipc/registry';
import { activationEvent, publishEvent } from './ipc/events';
import { createRuntime } from './modules/runtime/services';
import createCollectorWorker from './modules/ledger/collector.worker?nodeWorker';
import { createWindow } from './window';
import { guardWebContents } from './modules/runtime/security';
import { APP_DOCUMENT, assetHandler } from './modules/runtime/assets';
import {
  installedRuntime,
  requireCleanupScope,
  cleanupManagedSkills,
} from './modules/runtime/cleanup';
import { parseTargets, PathTools, nodePlatform } from './modules/skills';
import {
  createElectronUpdater,
  runLegacyMove,
  regExeRegistry,
  powershellProcesses,
} from './modules/updater';
import {
  createPlatformServices,
  trayCounts,
  type Activation,
} from './modules/platform';
import {
  platformHandlers,
  pathPolicy,
  fixedDriveProbe,
  startupAdapter,
  environmentAdapter,
  diagnosticSnapshot,
  activationKey,
} from './modules/runtime/platform';
import { unwrap } from './modules/runtime/core';
import {
  isolatedTestPorts,
  sampleModeAllowed,
} from './modules/runtime/test-ports';
import { checkHealth } from './modules/runtime/health';
import { prepareDataFolder } from './modules/runtime/startup';
import { REPORT_FLAG, runReport } from './modules/runs';

/**
 * Command mode for agents: record one report and exit. It takes no
 * single-instance lock, opens no window and registers nothing, so it works
 * while the app runs. Chromium profile folders go to a temporary folder.
 */
async function reportMode(): Promise<void> {
  const profile = mkdtempSync(join(tmpdir(), 'agent-ops-report-'));
  app.setPath('appData', profile);
  app.setPath('userData', profile);
  app.setPath('sessionData', join(profile, 'chromium'));
  app.setAppLogsPath(join(profile, 'logs'));
  let outcome;
  try {
    outcome = await runReport(
      process.argv.slice(process.argv.indexOf(REPORT_FLAG) + 1),
      {
        dataDir: resolveDataDir({
          env: process.env,
          development: !app.isPackaged,
          repoDir: resolve(__dirname, '../..'),
        }),
      },
    );
  } catch {
    outcome = {
      code: 1,
      stdout: '',
      stderr:
        'Agent Ops report: the Agent Ops data folder could not be found.\n',
    };
  }
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* A temporary folder left behind is harmless. */
  }
  const write = (stream: NodeJS.WriteStream, text: string) =>
    new Promise<void>((done) =>
      text ? stream.write(text, () => done()) : done(),
    );
  await write(process.stdout, outcome.stdout);
  await write(process.stderr, outcome.stderr);
  app.exit(outcome.code);
}

// Resolve once, before Chromium starts or single-instance locking touches a profile.
async function entry(): Promise<void> {
  if (process.argv.includes(REPORT_FLAG)) return reportMode();
  const dataDir = resolveDataDir({
    env: process.env,
    development: !app.isPackaged,
    repoDir: resolve(__dirname, '../..'),
  });
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
  app.on('web-contents-created', (_event, contents) =>
    guardWebContents(contents),
  );
  app.enableSandbox();
  async function launch(): Promise<void> {
    if (process.argv.includes('--health-check')) {
      // Chromium can create default profile folders even without a window. Keep them away
      // from the data being checked; the health operation itself only reads that data.
      const healthProfile = mkdtempSync(
        join(tmpdir(), 'agent-ops-health-profile-'),
      );
      app.setPath('appData', healthProfile);
      app.setPath('userData', healthProfile);
      app.setPath('sessionData', join(healthProfile, 'chromium'));
      app.setAppLogsPath(join(healthProfile, 'logs'));
      const receipt = await checkHealth({
        dataDir,
        rendererDir: join(__dirname, '../renderer'),
        mainDir: __dirname,
        preloadFile: join(__dirname, '../preload/index.cjs'),
        resourcesDir: app.isPackaged
          ? process.resourcesPath
          : resolve(__dirname, '../../resources'),
        version: app.getVersion(),
      });
      try {
        rmSync(healthProfile, {
          recursive: true,
          force: true,
          maxRetries: 2,
          retryDelay: 10,
        });
      } catch {
        /* Windows may release a temporary framework handle only at process exit. */
      }
      process.stdout.write(JSON.stringify(receipt) + '\n', () =>
        app.exit(receipt.ok ? 0 : 1),
      );
      return;
    }
    const scope = {
      packaged: app.isPackaged,
      dataDir,
      executable: process.execPath,
      localAppData: process.env.LOCALAPPDATA,
      overridden: process.env.AGENT_OPS_DATA_DIR !== undefined,
    };
    const cleanupRequested = process.argv.includes('--cleanup-skills');
    if (installedRuntime(scope) && !cleanupRequested) {
      // Acquire a private Electron lock before migration; no compatible config/activity/cache is opened.
      const coordination = join(dataDir, 'chromium');
      mkdirSync(coordination, { recursive: true });
      app.setPath('userData', coordination);
      app.setPath('sessionData', coordination);
      if (!app.requestSingleInstanceLock()) {
        app.quit();
        return;
      }
    }
    await prepareDataFolder({
      dataDir,
      installed: installedRuntime(scope),
      cleanup: cleanupRequested,
      move: () =>
        runLegacyMove({
          localAppData: process.env.LOCALAPPDATA!,
          userProfile: homedir(),
          dataDir,
          executablePath: process.execPath,
          stubsDir: join(process.resourcesPath, 'legacy-stubs'),
          registry: regExeRegistry(),
          processes: powershellProcesses(),
        }),
    });
    mkdirSync(dataDir, { recursive: true });
    app.setPath('userData', dataDir);
    app.setPath('sessionData', join(dataDir, 'chromium'));
    app.setPath('crashDumps', join(dataDir, 'crashes'));
    app.setAppLogsPath(join(dataDir, 'logs'));
    const testPorts = isolatedTestPorts({
      packaged: app.isPackaged,
      dataDir,
      env: process.env,
    });
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let desktop:
      | ReturnType<ReturnType<typeof createPlatformServices>['attachWindow']>
      | undefined;
    const platform = createPlatformServices({
      dataDir,
      resourcesDir: app.isPackaged
        ? process.resourcesPath
        : resolve(__dirname, '../../resources'),
      policy: {
        platform: process.platform,
        executable: process.execPath,
        development: !installedRuntime(scope),
        installedRoot: process.env.LOCALAPPDATA
          ? join(process.env.LOCALAPPDATA, 'Programs', 'AgentOps')
          : '',
        env: { ...process.env, AGENT_OPS_REGISTER: '0' },
      },
      ...(!installedRuntime(scope)
        ? { theme: async () => 'unknown' as const }
        : {}),
      allowPath: pathPolicy({
        dataDir,
        core: () => runtime?.core,
        ledger: () => runtime?.ledger,
        fixedDrive:
          testPorts?.fixedDrive ??
          fixedDriveProbe(
            (script, env) =>
              new Promise((resolveProbe) => {
                execFile(
                  systemExecutable('powershell.exe'),
                  ['-NoProfile', '-NonInteractive', '-Command', script],
                  { env, windowsHide: true, timeout: 5000, maxBuffer: 4096 },
                  (error) => resolveProbe(error ? 1 : 0),
                );
              }),
          ),
      }),
      snapshot: () =>
        runtime
          ? diagnosticSnapshot(
              runtime.core,
              runtime.ledger,
              installedRuntime(scope),
            )
          : {},
      pickerPreferences: {
        getDirectory: () => runtime?.core.store.get().pickerDirectory ?? '',
        rememberDirectory: async (file) => {
          if (runtime)
            unwrap(
              await runtime.core.store.mutate((draft) => {
                draft.pickerDirectory = file;
              }),
            );
        },
      },
    });
    platform.logger.info('Starting Agent Ops', {
      version: app.getVersion(),
      isolated: !installedRuntime(scope),
    });
    const instance = platform.installSingleInstance(
      cleanupRequested ? [...process.argv, '--background'] : process.argv,
      (plan) => desktop?.open(plan ? { plan } : {}),
    );
    if (!instance.primary) {
      if (cleanupRequested) app.exit(1);
      else app.quit();
    } else {
      let window: BrowserWindow | null = null;
      let shutdown: (() => Promise<void>) | undefined;
      let quitting = false;
      const focus = () => {
        desktop?.open();
      };
      app.on('activate', focus);
      platform.installCrashCapture();
      app.on('before-quit', (event) => {
        if (quitting || !shutdown) return;
        event.preventDefault();
        quitting = true;
        void shutdown().finally(() => app.quit());
      });

      void app
        .whenReady()
        .then(async () => {
          if (cleanupRequested) {
            requireCleanupScope(scope);
            const cleanupRuntime = createRuntime({
              dataDir,
              profileDir: homedir(),
              version: app.getVersion(),
              worker: createCollectorWorker,
              changed: () => {},
            });
            await cleanupRuntime.initialize();
            const listed = await cleanupRuntime.skills.listTargets();
            if (listed.readOnly) throw new Error(listed.readOnly);
            const targets = parseTargets(
              cleanupRuntime.core.store.get().integrations,
              new PathTools(nodePlatform()),
            );
            await cleanupManagedSkills(targets, (id, action) =>
              cleanupRuntime.skills.runAction(id, action),
            );
            await cleanupRuntime.stop();
            platform.dispose();
            instance.dispose();
            app.exit(0);
            return;
          }
          const devURL = app.isPackaged
            ? undefined
            : process.env.ELECTRON_RENDERER_URL;
          if (devURL && !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(devURL))
            throw new Error('Invalid renderer development URL.');
          const rendererURL = devURL ? new URL(devURL).href : APP_DOCUMENT;
          if (!devURL)
            protocol.handle(
              'app',
              await assetHandler(join(__dirname, '../renderer')),
            );
          const profile = session.defaultSession;
          profile.setPermissionRequestHandler(
            (_webContents, _permission, callback) => callback(false),
          );
          profile.setPermissionCheckHandler(() => false);
          profile.on('will-download', (event) => event.preventDefault());
          window = createWindow(app.isPackaged);
          const currentWindow = window;
          let rendererReady = false,
            ledgerReady = false;
          const pendingActivations: Activation[] = [];
          currentWindow.webContents.on('did-start-loading', () => {
            rendererReady = false;
          });
          currentWindow.webContents.on('console-message', (details) => {
            if (
              details.level === 'error' &&
              details.message.startsWith('Agent Ops IPC failure ')
            )
              platform.logger.error('Preload transport failure', {
                detail: details.message,
              });
          });
          desktop = platform.attachWindow(currentWindow, {
            activate: (target: Activation) => {
              let routed = target;
              if (target.plan && runtime) {
                try {
                  routed = {
                    ...target,
                    plan: activationKey(runtime.ledger, target.plan),
                  };
                } catch {
                  /* Preserve an unavailable task route; never treat a key as a path. */
                }
              }
              if (rendererReady)
                publishEvent(
                  currentWindow.webContents,
                  'app:activate',
                  activationEvent(routed),
                );
              else {
                pendingActivations.push(routed);
                if (pendingActivations.length > 32) pendingActivations.shift();
              }
            },
            refresh: () => runtime?.ledger.refresh(),
          });
          // Explicit data overrides and development never discover the real AI profile.
          const profileDir = installedRuntime(scope)
            ? homedir()
            : join(dataDir, 'profile');
          const updater =
            testPorts?.updater(
              () => runtime!.prepareForInstall(),
              () => runtime!.afterInstallFailed(),
            ) ??
            createElectronUpdater({
              dataDir,
              currentVersion: app.getVersion(),
              packaged: installedRuntime(scope),
              beforeInstall: () => runtime!.prepareForInstall(),
              afterInstallFailed: () => runtime!.afterInstallFailed(),
              log: (level, message) => platform.logger.write(level, message),
            });
          const currentRuntime = createRuntime({
            dataDir,
            profileDir,
            version: app.getVersion(),
            worker: createCollectorWorker,
            updater,
            sampleModeAllowed: sampleModeAllowed(app.isPackaged, process.env),
            startup: startupAdapter(platform, () =>
              desktop?.refreshStartupMenu(),
            ),
            ...(installedRuntime(scope)
              ? { environment: environmentAdapter(platform) }
              : {}),
            // A development build runs as electron.exe plus the app folder, which is not one command.
            ...(app.isPackaged ? { reportCommand: process.execPath } : {}),
            trash: (file) => platform.folders.trash(file),
            notify: (events) => {
              desktop?.notify(events);
            },
            crash: () => platform.crashes.readCrash(),
            updateChanged: (state) => {
              publishEvent(currentWindow.webContents, 'updates:changed', state);
            },
            changed: (event) => {
              if (runtime)
                desktop?.updateTray(
                  trayCounts(runtime.ledger.getState().state.plans),
                );
              publishEvent(currentWindow.webContents, 'state:changed', event);
            },
            settingsChanged: (settings) => {
              publishEvent(
                currentWindow.webContents,
                'settings:changed',
                settings,
              );
            },
            handlers: ({ core, ledger }) => ({
              ...platformHandlers({
                platform,
                core,
                ledger,
                senderScope: String(currentWindow.webContents.id),
                activate: (target) => desktop?.open(target),
                openExternal: (url) => shell.openExternal(url),
              }),
              'app:renderer-ready': () => {
                rendererReady = true;
                for (const target of pendingActivations.splice(0))
                  publishEvent(
                    currentWindow.webContents,
                    'app:activate',
                    activationEvent(target),
                  );
                if (ledgerReady) instance.ready();
                return { ready: true };
              },
            }),
            log: (category, error) => {
              platform.logger.error(category, {
                detail:
                  error instanceof Error
                    ? (error.stack ?? error.message)
                    : String(error ?? ''),
              });
            },
          });
          runtime = currentRuntime;
          shutdown = async () => {
            await currentRuntime.stop();
            platform.dispose();
            instance.dispose();
          };
          const cleanup = registerApplicationIpc(ipcMain, {
            webContents: currentWindow.webContents,
            rendererURL,
            handlers: currentRuntime.handlers,
            log: (id, error) => {
              platform.logger.error('IPC failure', {
                id,
                detail:
                  error instanceof Error
                    ? (error.stack ?? error.message)
                    : String(error),
              });
            },
          });
          currentWindow.on('closed', () => {
            cleanup();
            window = null;
          });
          await currentRuntime.initialize();
          if (installedRuntime(scope)) platform.protocol.register();
          await currentWindow.loadURL(rendererURL);
          await currentRuntime.start();
          ledgerReady = true;
          if (rendererReady) instance.ready();
        })
        .catch((error: unknown) => {
          platform.logger.error('Startup failed', {
            detail:
              error instanceof Error
                ? (error.stack ?? error.message)
                : String(error),
          });
          platform.dispose();
          instance.dispose();
          app.exit(1);
        });
    }
  }
  await launch();
}
void entry().catch((error: unknown) => {
  if (process.argv.includes('--health-check')) {
    process.stdout.write(
      JSON.stringify({
        kind: 'agent-ops-health',
        ok: false,
        version: app.getVersion(),
        message: 'The app data folder could not be opened safely.',
      }) + '\n',
      () => app.exit(1),
    );
    return;
  }
  console.error(error);
  if (!process.argv.includes('--health-check'))
    dialog.showErrorBox(
      'Agent Ops',
      error instanceof Error ? error.message : 'Agent Ops could not start.',
    );
  app.exit(1);
});
