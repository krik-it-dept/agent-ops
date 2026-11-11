import {
  app,
  clipboard,
  dialog,
  Menu,
  Notification,
  shell,
  Tray,
  type BrowserWindow,
} from 'electron';
import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { release } from 'node:os';
import {
  CrashService,
  createDiagnosticsService,
  installCrashHandlers,
  RotatingLogger,
  type DiagnosticCounts,
  type DiagnosticSettings,
} from '../logging';
import { installSingleInstance } from './activation';
import {
  createNotifier,
  type NotificationEvent,
  type NotificationPort,
} from './notifications';
import {
  PickerService,
  type DialogPort,
  type PickerPreferences,
} from './picker';
import {
  APP_ID,
  ProtocolRegistration,
  registrationAllowed,
  StartupService,
} from './registration';
import { createShellService, type AllowPath } from './shell';
import {
  createTray,
  readTaskbarTheme,
  type TaskbarTheme,
  type TrayCounts,
  type TrayPort,
} from './tray';
import { createWindowController } from './window';
import {
  closeOwnedDialog,
  runCommand,
  UserEnvironmentService,
} from './windows';
import {
  PlatformError,
  type Activation,
  type CommandRunner,
  type RegistrationPolicy,
  type WindowPort,
} from './types';

export function resourceIcons(resourcesDir: string) {
  return {
    window: join(resourcesDir, 'icons', 'app.ico'),
    notification: join(resourcesDir, 'icons', 'app.png'),
    tray: {
      light: join(resourcesDir, 'icons', 'app-light.ico'),
      dark: join(resourcesDir, 'icons', 'app-dark.ico'),
      unknown: join(resourcesDir, 'icons', 'app.ico'),
    },
  };
}
export function electronWindowPort(window: BrowserWindow): WindowPort {
  return {
    isDestroyed: () => window.isDestroyed(),
    isMinimized: () => window.isMinimized(),
    restore: () => window.restore(),
    show: () => window.show(),
    hide: () => window.hide(),
    focus: () => window.focus(),
    setIcon: (path) => window.setIcon(path),
    onClose(callback) {
      window.on('close', callback);
      return () => {
        window.removeListener('close', callback);
      };
    },
    onShow(callback) {
      window.on('show', callback);
      return () => {
        window.removeListener('show', callback);
      };
    },
  };
}
export function electronDialogPort(
  getWindow: () => BrowserWindow | null,
  run: CommandRunner = runCommand,
): DialogPort {
  return {
    available: () => {
      const window = getWindow();
      return !!window && !window.isDestroyed();
    },
    focusOwner() {
      const window = getWindow();
      if (window) {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      }
    },
    open(options) {
      const window = getWindow();
      if (!window || window.isDestroyed())
        throw new Error('Owner unavailable.');
      const handle = window.getNativeWindowHandle();
      const owner =
        handle.length >= 8
          ? handle.readBigUInt64LE()
          : BigInt(handle.readUInt32LE());
      let settled = false;
      const result = dialog.showOpenDialog(window, {
        title: options.title,
        defaultPath: options.defaultPath,
        properties:
          options.kind === 'folder'
            ? ['openDirectory', 'createDirectory', 'dontAddToRecent']
            : ['openFile', 'dontAddToRecent'],
        ...(options.kind === 'markdown'
          ? { filters: [{ name: 'Markdown files', extensions: ['md'] }] }
          : {}),
      });
      void result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      return {
        result,
        async cancel() {
          if (settled) return;
          try {
            await closeOwnedDialog(run, owner, process.pid);
          } catch (error) {
            if (!settled) throw error;
          }
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              result,
              new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(
                  () =>
                    reject(
                      new PlatformError(
                        'IO_ERROR',
                        'The picker did not close.',
                        true,
                      ),
                    ),
                  5000,
                );
              }),
            ]);
          } finally {
            if (timeout) clearTimeout(timeout);
          }
        },
      };
    },
  };
}
export function electronTrayPort(icon: string): TrayPort {
  const tray = new Tray(icon);
  return {
    setImage: (path) => tray.setImage(path),
    setToolTip: (text) => tray.setToolTip(text),
    setMenu: (entries) => tray.setContextMenu(Menu.buildFromTemplate(entries)),
    onClick(callback) {
      tray.on('click', callback);
      return () => {
        tray.removeListener('click', callback);
      };
    },
    destroy: () => tray.destroy(),
  };
}
export function electronNotificationPort(): NotificationPort & {
  dispose(): void;
} {
  const active = new Set<Notification>();
  return {
    supported: () => Notification.isSupported(),
    show(options, click, failure) {
      const notification = new Notification(options);
      active.add(notification);
      notification.once('click', click);
      notification.once('close', () => active.delete(notification));
      notification.once('failed', () => {
        active.delete(notification);
        failure();
      });
      notification.show();
    },
    dispose() {
      for (const notification of active) notification.close();
      active.clear();
    },
  };
}
export interface PlatformSnapshot {
  counts?: Partial<Omit<DiagnosticCounts, 'crashes'>>;
  settings?: Partial<
    Omit<DiagnosticSettings, 'startup' | 'registrationManaged'>
  >;
}
export interface ElectronPlatformOptions {
  dataDir: string;
  resourcesDir: string;
  installedRoot?: string;
  policy?: RegistrationPolicy;
  launchArgs?: readonly string[];
  background?: boolean;
  allowPath: AllowPath;
  pickerPreferences?: Omit<PickerPreferences, 'home' | 'isDirectory'>;
  snapshot?: () => PlatformSnapshot;
  commands?: CommandRunner;
  theme?: () => Promise<TaskbarTheme>;
}

/** Main-process composition only: no IPC handlers, no implicit registry registration. */
export function createPlatformServices(options: ElectronPlatformOptions) {
  if (!isAbsolute(options.dataDir) || !isAbsolute(options.resourcesDir))
    throw new Error('Platform roots must be absolute.');
  const policy: RegistrationPolicy = options.policy ?? {
    platform: process.platform,
    development: !app.isPackaged,
    executable: process.execPath,
    installedRoot:
      options.installedRoot ??
      (process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, 'Programs', 'AgentOps')
        : ''),
    env: process.env,
  };
  const commands = options.commands ?? runCommand;
  const icons = resourceIcons(options.resourcesDir);
  const logger = new RotatingLogger(options.dataDir);
  const crashes = new CrashService(options.dataDir, app.getVersion(), logger);
  const startup = new StartupService(
    {
      read: (value) => {
        const settings = app.getLoginItemSettings(value);
        return {
          openAtLogin: settings.openAtLogin,
          launchItems: (settings.launchItems ?? []).map((item) => ({
            name: item.name,
            path: item.path,
            enabled: item.enabled,
          })),
        };
      },
      write: (value) => app.setLoginItemSettings(value),
    },
    policy,
    options.launchArgs,
  );
  const protocol = new ProtocolRegistration(
    {
      setProtocol: (scheme, path, args) =>
        app.setAsDefaultProtocolClient(scheme, path, args),
      removeProtocol: (scheme, path, args) =>
        app.removeAsDefaultProtocolClient(scheme, path, args),
    },
    policy,
    options.launchArgs,
  );
  const environment = new UserEnvironmentService(commands, policy);
  const folders = createShellService(
    shell,
    options.allowPath,
    logger.directory,
  );
  let chosen = '',
    window: BrowserWindow | null = null;
  const picker = new PickerService(
    electronDialogPort(() => window, commands),
    {
      home: app.getPath('home'),
      getDirectory: options.pickerPreferences?.getDirectory ?? (() => chosen),
      rememberDirectory:
        options.pickerPreferences?.rememberDirectory ??
        (async (path) => {
          chosen = path;
        }),
      isDirectory: async (path) => {
        try {
          return (await stat(path)).isDirectory();
        } catch {
          return false;
        }
      },
    },
    {
      onError: (category) => {
        logger.warn('Picker failure', { category });
      },
    },
  );
  const diagnostics = createDiagnosticsService(() => {
    const snapshot = options.snapshot?.() ?? {};
    let startupEnabled = false;
    try {
      startupEnabled = startup.get().enabled;
    } catch {
      /* Diagnostics remain available. */
    }
    return {
      versions: {
        app: app.getVersion(),
        electron: process.versions.electron ?? '',
        chromium: process.versions.chrome ?? '',
        node: process.versions.node,
        os: release(),
      },
      counts: {
        projects: 0,
        enabledProjects: 0,
        folderProjects: 0,
        plans: 0,
        diagnostics: 0,
        ...snapshot.counts,
        crashes: crashes.readCrash()?.count ?? 0,
      },
      settings: {
        notifications: false,
        tasksConfigured: false,
        setupComplete: false,
        readOnly: false,
        updateChecks: false,
        shortcuts: false,
        ...snapshot.settings,
        startup: startupEnabled,
        registrationManaged: registrationAllowed(policy),
      },
    };
  }, clipboard);
  const notifications = electronNotificationPort();
  let detach = (): void => {};
  let offFailures = (): void => {};
  let attached = false;
  // Process identity is not an OS registration and never writes HKCU in development.
  app.setAppUserModelId(APP_ID);
  return {
    startup,
    protocol,
    environment,
    picker,
    folders,
    logger,
    crashes,
    diagnostics,
    installSingleInstance(
      argv: readonly string[],
      open: (plan?: string) => void,
    ) {
      return installSingleInstance(
        {
          requestLock: () => app.requestSingleInstanceLock(),
          quit: () => app.quit(),
          onSecondInstance(callback) {
            const listener = (_event: Electron.Event, args: string[]): void =>
              callback(args);
            app.on('second-instance', listener);
            return () => {
              app.removeListener('second-instance', listener);
            };
          },
          onOpenURL(callback) {
            const listener = (event: Electron.Event, url: string): void => {
              event.preventDefault();
              callback(url);
            };
            app.on('open-url', listener);
            return () => {
              app.removeListener('open-url', listener);
            };
          },
        },
        argv,
        open,
      );
    },
    installCrashCapture(): () => void {
      offFailures();
      const offProcess = installCrashHandlers(
        {
          onException(callback) {
            process.on('uncaughtException', callback);
            return () => {
              process.removeListener('uncaughtException', callback);
            };
          },
          onRejection(callback) {
            process.on('unhandledRejection', callback);
            return () => {
              process.removeListener('unhandledRejection', callback);
            };
          },
          exit: (code) => process.exit(code),
        },
        crashes,
      );
      const child = (
        _event: Electron.Event,
        details: Electron.Details,
      ): void => {
        if (details.reason !== 'clean-exit')
          crashes.record('child-process-gone', new Error(details.reason));
      };
      app.on('child-process-gone', child);
      offFailures = () => {
        offProcess();
        app.removeListener('child-process-gone', child);
      };
      return offFailures;
    },
    attachWindow(
      owner: BrowserWindow,
      callbacks: {
        activate(target: Activation): void;
        refresh(): void | Promise<void>;
      },
    ) {
      if (attached) throw new Error('The platform window is already attached.');
      attached = true;
      window = owner;
      const controller = createWindowController(electronWindowPort(owner), {
        icon: icons.window,
        background: options.background ?? process.argv.includes('--background'),
        activate: callbacks.activate,
      });
      const beforeQuit = (): void => controller.beforeQuit();
      app.on('before-quit', beforeQuit);
      const tray = createTray({
        create: electronTrayPort,
        icons: icons.tray,
        theme: options.theme ?? (() => readTaskbarTheme(commands)),
        startup,
        open: () => controller.open(),
        settings: () => controller.open({ settings: true }),
        refresh: callbacks.refresh,
        quit: () => {
          controller.beforeQuit();
          app.quit();
        },
        onError: (category) => {
          logger.warn('Tray action failed', { category });
        },
      });
      const notifier = createNotifier({
        port: notifications,
        managed: registrationAllowed(policy),
        icon: icons.notification,
        enabled: () => options.snapshot?.().settings?.notifications === true,
        openPlan: (plan) => controller.open({ plan }),
        onError: () => {
          logger.warn('Notification failed');
        },
      });
      const renderer = (
        _event: Electron.Event,
        details: Electron.RenderProcessGoneDetails,
      ): void => {
        if (details.reason !== 'clean-exit')
          crashes.record('renderer-gone', new Error(details.reason));
      };
      owner.webContents.on('render-process-gone', renderer);
      let disposed = false;
      detach = () => {
        if (disposed) return;
        disposed = true;
        tray.dispose();
        controller.dispose();
        app.removeListener('before-quit', beforeQuit);
        owner.webContents.removeListener('render-process-gone', renderer);
        window = null;
        attached = false;
      };
      return {
        open: controller.open,
        updateTray: (counts: TrayCounts) => tray.update(counts),
        refreshStartupMenu: tray.refreshMenu,
        notify: (events: readonly NotificationEvent[]) =>
          notifier.notify(events),
        testState: () => ({ trayCreated: tray.isCreated() }),
        dispose: detach,
      };
    },
    dispose(): void {
      detach();
      offFailures();
      notifications.dispose();
    },
  };
}
export type PlatformServices = ReturnType<typeof createPlatformServices>;

/** Development layout helper; packaged callers pass their copied resources directory. */
export const developmentResources = (repoRoot: string): string =>
  resolve(repoRoot, 'resources');
