import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { app, dialog, Notification, Tray, type BrowserWindow } from 'electron';
import {
  createPlatformServices,
  electronDialogPort,
  electronNotificationPort,
  resourceIcons,
} from './electron';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeTray extends EventEmitter {
    static instances: FakeTray[] = [];
    setImage = vi.fn();
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    destroy = vi.fn();
    constructor(readonly icon: string) {
      super();
      FakeTray.instances.push(this);
    }
  }
  class FakeNotification extends EventEmitter {
    static instances: FakeNotification[] = [];
    static isSupported = () => true;
    show = vi.fn();
    close = vi.fn(() => this.emit('close'));
    constructor(readonly options: unknown) {
      super();
      FakeNotification.instances.push(this);
    }
  }
  return {
    app: Object.assign(new EventEmitter(), {
      isPackaged: false,
      getVersion: () => '0.0.0',
      getPath: () => resolve('synthetic-home'),
      getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
      setLoginItemSettings: vi.fn(),
      setAsDefaultProtocolClient: vi.fn(() => true),
      removeAsDefaultProtocolClient: vi.fn(() => true),
      setAppUserModelId: vi.fn(),
      requestSingleInstanceLock: vi.fn(() => true),
      quit: vi.fn(),
    }),
    clipboard: { writeText: vi.fn() },
    dialog: {
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    },
    Menu: { buildFromTemplate: vi.fn((entries) => entries) },
    Tray: FakeTray,
    Notification: FakeNotification,
    shell: {
      trashItem: vi.fn(async () => {}),
      openPath: vi.fn(async () => ''),
    },
  };
});
function owner(): BrowserWindow {
  return Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    focus: vi.fn(),
    setIcon: vi.fn(),
    getNativeWindowHandle: () => {
      const handle = Buffer.alloc(8);
      handle.writeBigUInt64LE(1234n);
      return handle;
    },
    webContents: new EventEmitter(),
  }) as unknown as BrowserWindow;
}
describe('Electron adapters with all OS surfaces faked', () => {
  it('owns native dialogs and awaits confirmed cancellation', async () => {
    const window = owner();
    let close!: (value: Electron.OpenDialogReturnValue) => void;
    vi.mocked(dialog.showOpenDialog).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          close = resolve;
        }),
    );
    const run = vi.fn(async () => {
      close({ canceled: true, filePaths: [] });
      return { code: 0, stdout: '' };
    });
    const port = electronDialogPort(() => window, run);
    expect(port.available()).toBe(true);
    port.focusOwner();
    const session = port.open({
      title: 'Choose',
      defaultPath: resolve('home'),
      kind: 'markdown',
    });
    expect(dialog.showOpenDialog).toHaveBeenLastCalledWith(
      window,
      expect.objectContaining({
        filters: [{ name: 'Markdown files', extensions: ['md'] }],
        properties: ['openFile', 'dontAddToRecent'],
      }),
    );
    await session.cancel();
    expect(await session.result).toEqual({ canceled: true, filePaths: [] });
    expect(run).toHaveBeenCalledOnce();
    await session.cancel();
    expect(run).toHaveBeenCalledOnce();
    expect(electronDialogPort(() => null).available()).toBe(false);
    expect(() =>
      electronDialogPort(() => null).open({
        title: 'Choose',
        defaultPath: '',
        kind: 'folder',
      }),
    ).toThrow();
  });
  it('does not report cancellation success if the native close command fails', async () => {
    let close!: (value: Electron.OpenDialogReturnValue) => void;
    vi.mocked(dialog.showOpenDialog).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          close = resolve;
        }),
    );
    const session = electronDialogPort(owner, async () => ({
      code: 1,
      stdout: '',
    })).open({ title: 'Choose', defaultPath: resolve('home'), kind: 'folder' });
    await expect(session.cancel()).rejects.toMatchObject({ code: 'IO_ERROR' });
    close({ canceled: true, filePaths: [] });
    await session.result;
  });
  it('passes native toast options as data and retains/disposes the Notification object', () => {
    const port = electronNotificationPort(),
      click = vi.fn(),
      failed = vi.fn();
    port.show(
      { title: 'Agent Ops', body: '$(not code)', icon: 'app.png' },
      click,
      failed,
    );
    const instance = (
      Notification as unknown as {
        instances: (EventEmitter & { options: unknown; close(): void })[];
      }
    ).instances.at(-1)!;
    expect(instance.options).toEqual({
      title: 'Agent Ops',
      body: '$(not code)',
      icon: 'app.png',
    });
    instance.emit('click');
    expect(click).toHaveBeenCalledOnce();
    instance.emit('failed', {}, 'details');
    expect(failed).toHaveBeenCalledOnce();
    port.dispose();
    port.show(
      { title: 'Agent Ops', body: 'data', icon: 'app.png' },
      click,
      failed,
    );
    const active = (
      Notification as unknown as {
        instances: { close: ReturnType<typeof vi.fn> }[];
      }
    ).instances.at(-1)!;
    port.dispose();
    expect(active.close).toHaveBeenCalledOnce();
  });
  it('composes services, creates a tray/test hook, and captures renderer/child failures in an isolated profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-ops-platform-unit-'));
    const baselineListeners = app.listenerCount('child-process-gone');
    const platform = createPlatformServices({
      dataDir: root,
      resourcesDir: resolve('resources'),
      allowPath: () => false,
      theme: async () => 'dark',
      snapshot: () => ({
        counts: { plans: 7 },
        settings: { notifications: true, tasksConfigured: true },
      }),
    });
    try {
      expect(app.setAppUserModelId).toHaveBeenCalledWith('KrikIT.AgentOps');
      expect(platform.protocol.register()).toBe(false);
      expect(platform.startup.get().managed).toBe(false);
      expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
      expect(app.setLoginItemSettings).not.toHaveBeenCalled();
      const window = owner(),
        activate = vi.fn(),
        refresh = vi.fn();
      const attached = platform.attachWindow(window, { activate, refresh });
      expect(attached.testState()).toEqual({ trayCreated: true });
      expect(() =>
        platform.attachWindow(window, { activate, refresh }),
      ).toThrow('already attached');
      expect(window.setIcon).toHaveBeenCalledWith(
        resourceIcons(resolve('resources')).window,
      );
      attached.open({ plan: 'tasks/web/a' });
      expect(activate).toHaveBeenCalledWith({ plan: 'tasks/web/a' });
      attached.updateTray({ plans: 7, waiting: 1, blocked: 2 });
      const tray = (
        Tray as unknown as {
          instances: { setToolTip: ReturnType<typeof vi.fn> }[];
        }
      ).instances.at(-1)!;
      expect(tray.setToolTip).toHaveBeenLastCalledWith(
        'Agent Ops · 7 plans · 1 waiting for you · 2 blocked',
      );
      expect(
        attached.notify([
          { kind: 'blocked', repo: 'web', plan: 'a', text: 'blocked' },
        ]),
      ).toBe(0);
      window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
      expect(platform.crashes.readCrash()).toMatchObject({
        kind: 'renderer-gone',
        count: 1,
      });
      const offFailures = platform.installCrashCapture();
      app.emit('child-process-gone', {}, { reason: 'crashed' });
      expect(platform.crashes.readCrash()).toMatchObject({
        kind: 'child-process-gone',
        count: 2,
      });
      offFailures();
      expect(platform.diagnostics.collectDiagnostics()).toMatchObject({
        counts: { plans: 7, crashes: 2 },
        settings: { registrationManaged: false, tasksConfigured: true },
      });
      expect(platform.diagnostics.copy()).toEqual({ copied: true });
      platform.crashes.dismissCrash();
      expect(platform.crashes.readCrash()).toBeNull();
      attached.dispose();
      expect(attached.testState()).toEqual({ trayCreated: false });
    } finally {
      platform.dispose();
      await rm(root, { recursive: true, force: true });
    }
    expect(app.listenerCount('child-process-gone')).toBe(baselineListeners);
  });
});
