import { describe, it, expect, vi } from 'vitest';
import { resolve, join } from 'node:path';
import {
  installSingleInstance,
  parsePlanLink,
  planLink,
  validPlanKey,
} from './activation';
import { createWindowController } from './window';
import { createTray, trayCounts, type MenuEntry, type TrayPort } from './tray';
import { createNotifier, notificationText } from './notifications';
import {
  ProtocolRegistration,
  registrationAllowed,
  StartupService,
} from './registration';
import type { RegistrationPolicy, WindowPort } from './types';

const installedRoot = resolve('synthetic-install');
const installed: RegistrationPolicy = {
  platform: 'win32',
  development: false,
  executable: join(installedRoot, 'agent-ops.exe'),
  installedRoot,
  env: {},
};
describe('OS registration policy and startup', () => {
  it.each([
    [{ ...installed }, true],
    [{ ...installed, development: true }, false],
    [{ ...installed, executable: resolve('elsewhere/app.exe') }, false],
    [
      { ...installed, development: true, env: { AGENT_OPS_REGISTER: '1' } },
      true,
    ],
    [
      {
        ...installed,
        platform: 'linux' as const,
        env: { AGENT_OPS_REGISTER: '1' },
      },
      false,
    ],
    [{ ...installed, installedRoot: '' }, false],
  ])('gates OS registration %#', (policy, expected) =>
    expect(registrationAllowed(policy)).toBe(expected),
  );
  it('reads startup back using exactly the same executable and background arguments', () => {
    let enabled = false;
    const port = {
      read: vi.fn(() => ({ openAtLogin: enabled })),
      write: vi.fn((value: { openAtLogin: boolean }) => {
        enabled = value.openAtLogin;
      }),
    };
    const startup = new StartupService(port, installed);
    expect(startup.get()).toEqual({ enabled: false, managed: true });
    expect(startup.set(true)).toEqual({ enabled: true, managed: true });
    expect(port.write).toHaveBeenCalledWith({
      openAtLogin: true,
      path: installed.executable,
      args: ['--background'],
      name: 'Agent Ops',
    });
    expect(port.read).toHaveBeenLastCalledWith({
      path: installed.executable,
      args: ['--background'],
    });
    expect(startup.set(false).enabled).toBe(false);
  });
  it('never reads or writes startup/protocol registration in ordinary development', () => {
    const read = vi.fn(),
      write = vi.fn(),
      setProtocol = vi.fn(),
      removeProtocol = vi.fn();
    const policy = { ...installed, development: true };
    const startup = new StartupService({ read, write }, policy);
    expect(startup.get()).toEqual({ enabled: false, managed: false });
    expect(() => startup.set(true)).toThrow(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
    const protocol = new ProtocolRegistration(
      { setProtocol, removeProtocol },
      policy,
    );
    expect(protocol.register()).toBe(false);
    expect(protocol.remove()).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(setProtocol).not.toHaveBeenCalled();
    expect(removeProtocol).not.toHaveBeenCalled();
  });
  it('registers and removes only the owned scheme using argument arrays', () => {
    const port = {
      setProtocol: vi.fn(() => true),
      removeProtocol: vi.fn(() => true),
    };
    const registration = new ProtocolRegistration(port, installed, [
      'app entry',
    ]);
    expect(registration.register()).toBe(true);
    expect(registration.remove()).toBe(true);
    expect(port.setProtocol).toHaveBeenCalledWith(
      'agent-ops',
      installed.executable,
      ['app entry'],
    );
    expect(port.removeProtocol).toHaveBeenCalledWith(
      'agent-ops',
      installed.executable,
      ['app entry'],
    );
  });
});
describe('strict links and instance lifecycle', () => {
  it.each(['tasks/Dự án/kế hoạch v1.2', 'abc123/web/plan', 'web/legacy'])(
    'round-trips the plan key %s',
    (key) => {
      expect(validPlanKey(key)).toBe(true);
      expect(parsePlanLink(planLink(key))).toBe(key);
    },
  );
  it.each([
    'other:open?plan=p/r/n',
    'agent-ops:run?plan=p/r/n',
    'agent-ops://open?plan=p/r/n',
    'agent-ops:open?plan=p/r/n#fragment',
    'agent-ops:open?plan=p/r/n&exec=calc',
    'agent-ops:open?plan=p/r/n&plan=p/r/x',
    'agent-ops:open?plan=C%3A%5Cfile',
    'agent-ops:open?plan=p/r/..',
    'agent-ops:open?plan=p/r/%00',
    'agent-ops:open?plan=p/r/%ZZ',
    'agent-ops:open?plan=',
    'agent-ops:open?plan=p/r/a/b',
    'agent-ops:open?plan=p/r/a%0A',
    `agent-ops:open?plan=${'x'.repeat(5000)}`,
  ])('ignores malformed or command-like activation %#', (uri) =>
    expect(parsePlanLink(uri)).toBeNull(),
  );
  it('queues first/warm launches, keeps background starts quiet and removes listeners', () => {
    let second: (args: readonly string[]) => void = () => {},
      url: (value: string) => void = () => {};
    const offSecond = vi.fn(),
      offURL = vi.fn(),
      open = vi.fn(),
      quit = vi.fn();
    const port = {
      requestLock: () => true,
      quit,
      onSecondInstance(callback: typeof second) {
        second = callback;
        return offSecond;
      },
      onOpenURL(callback: typeof url) {
        url = callback;
        return offURL;
      },
    };
    const controller = installSingleInstance(
      port,
      ['app.exe', '--background'],
      open,
    );
    expect(controller.primary).toBe(true);
    expect(open).not.toHaveBeenCalled();
    second(['app.exe', planLink('tasks/web/a')]);
    second(['app.exe', '--background']);
    controller.ready();
    expect(open).toHaveBeenCalledExactlyOnceWith('tasks/web/a');
    second(['app.exe']);
    expect(open).toHaveBeenLastCalledWith(undefined);
    url('other:open?plan=p/r/n');
    expect(open).toHaveBeenCalledTimes(2);
    url(planLink('tasks/web/b'));
    expect(open).toHaveBeenLastCalledWith('tasks/web/b');
    controller.ready();
    expect(open).toHaveBeenCalledTimes(3);
    controller.dispose();
    expect(offSecond).toHaveBeenCalledOnce();
    expect(offURL).toHaveBeenCalledOnce();
  });
  it('quits the second process without installing event listeners', () => {
    const quit = vi.fn(),
      event = vi.fn();
    expect(
      installSingleInstance(
        {
          requestLock: () => false,
          quit,
          onSecondInstance: event,
          onOpenURL: event,
        },
        [],
        vi.fn(),
      ).primary,
    ).toBe(false);
    expect(quit).toHaveBeenCalledOnce();
    expect(event).not.toHaveBeenCalled();
  });
  it('keeps window close in the tray, background hidden and quit explicit', () => {
    let onClose: (event: { preventDefault(): void }) => void = () => {},
      onShow = (): void => {};
    let destroyed = false;
    const host: WindowPort = {
      isDestroyed: () => destroyed,
      isMinimized: () => true,
      restore: vi.fn(),
      show: vi.fn(() => onShow()),
      hide: vi.fn(),
      focus: vi.fn(),
      setIcon: vi.fn(),
      onClose(callback) {
        onClose = callback;
        return vi.fn();
      },
      onShow(callback) {
        onShow = callback;
        return vi.fn();
      },
    };
    const activate = vi.fn(),
      controller = createWindowController(host, {
        background: true,
        icon: 'window.ico',
        activate,
      });
    expect(host.hide).toHaveBeenCalledOnce();
    onShow();
    expect(host.hide).toHaveBeenCalledTimes(2);
    controller.open({ settings: true });
    expect(host.restore).toHaveBeenCalledOnce();
    expect(host.focus).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith({ settings: true });
    const event = { preventDefault: vi.fn() };
    onClose(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    controller.beforeQuit();
    onClose(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    destroyed = true;
    controller.open();
    expect(host.focus).toHaveBeenCalledOnce();
    controller.dispose();
  });
});
describe('tray and notifications through fakes', () => {
  it('creates the complete tray, updates counts/system icons, and dispatches menu actions', async () => {
    let menu: MenuEntry[] = [],
      clicked = (): void => {},
      scheduled = (): void => {},
      enabled = false;
    const fake: TrayPort = {
      setImage: vi.fn(),
      setToolTip: vi.fn(),
      setMenu: (entries) => {
        menu = entries;
      },
      onClick(callback) {
        clicked = callback;
        return vi.fn();
      },
      destroy: vi.fn(),
    };
    const startup = new StartupService(
      {
        read: () => ({ openAtLogin: enabled }),
        write: (value) => {
          enabled = value.openAtLogin;
        },
      },
      installed,
    );
    let theme: 'light' | 'dark' = 'light';
    const open = vi.fn(),
      settings = vi.fn(),
      refresh = vi.fn(),
      quit = vi.fn(),
      stop = vi.fn();
    const tray = createTray({
      create: () => fake,
      icons: { light: 'light.ico', dark: 'dark.ico', unknown: 'app.ico' },
      theme: async () => theme,
      startup,
      open,
      settings,
      refresh,
      quit,
      schedule(callback, ms) {
        expect(ms).toBe(30000);
        scheduled = callback;
        return stop;
      },
    });
    await Promise.resolve();
    expect(fake.setImage).toHaveBeenLastCalledWith('light.ico');
    expect(menu.filter((m) => m.label).map((m) => m.label)).toEqual([
      'Open Agent Ops',
      'Refresh',
      'Settings',
      'Start with Windows',
      'Quit',
    ]);
    clicked();
    menu[0]?.click?.();
    menu[1]?.click?.();
    menu[2]?.click?.();
    menu[4]?.click?.();
    menu[6]?.click?.();
    await Promise.resolve();
    expect(open).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledOnce();
    expect(settings).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
    expect(menu[4]?.checked).toBe(true);
    tray.update(
      trayCounts([
        {
          status: 'Waiting for owner',
          questions: [{ open: true }, { open: false }],
        },
        { status: 'Blocked', questions: [] },
      ]),
    );
    expect(fake.setToolTip).toHaveBeenLastCalledWith(
      'Agent Ops · 2 plans · 2 waiting for you · 1 blocked',
    );
    theme = 'dark';
    scheduled();
    await Promise.resolve();
    expect(fake.setImage).toHaveBeenLastCalledWith('dark.ico');
    tray.dispose();
    tray.dispose();
    expect(stop).toHaveBeenCalledOnce();
    expect(fake.destroy).toHaveBeenCalledOnce();
    expect(tray.isCreated()).toBe(false);
  });
  it('gates notifications, ignores stale/answered questions, and passes hostile text only as data', () => {
    let enabled = true,
      clicks: (() => void)[] = [];
    const show = vi.fn((_options, click: () => void) => {
      clicks.push(click);
    });
    const open = vi.fn();
    const notifier = createNotifier({
      port: { supported: () => true, show },
      enabled: () => enabled,
      managed: true,
      icon: 'app.png',
      openPlan: open,
    });
    const events = [
      {
        kind: 'blocked',
        project: 'tasks',
        repo: 'web',
        plan: 'a',
        text: '"; $(calc) <unsafe> “quotes”',
      },
      {
        kind: 'waiting',
        project: 'p',
        repo: 'web',
        plan: 'b',
        text: 'ignored',
        extra: 'owner reason',
      },
      {
        kind: 'question',
        project: 'p',
        repo: 'web',
        plan: 'c',
        text: 'Ask?',
        extra: 'open',
      },
      {
        kind: 'question',
        project: 'p',
        repo: 'web',
        plan: 'c',
        text: 'Answered?',
        extra: 'yes',
      },
      { kind: 'stale', repo: 'web', plan: 'd', text: 'never show' },
      { kind: 'constructor', repo: 'web', plan: 'd', text: 'never show' },
    ];
    expect(notifier.notify(events)).toBe(3);
    expect(show.mock.calls[0]?.[0]).toEqual({
      title: 'Agent Ops',
      body: 'Bị chặn · a\n"; $(calc) <unsafe> “quotes”',
      icon: 'app.png',
    });
    expect(show.mock.calls[1]?.[0].body).toContain('owner reason');
    clicks[0]?.();
    expect(open).toHaveBeenCalledWith('tasks/web/a');
    enabled = false;
    expect(notifier.notify(events)).toBe(0);
    const disabled = createNotifier({
      port: { supported: () => true, show },
      enabled: () => true,
      managed: false,
      icon: 'x',
      openPlan: open,
    });
    expect(disabled.notify(events)).toBe(0);
    const unsupported = createNotifier({
      port: { supported: () => false, show },
      enabled: () => true,
      managed: true,
      icon: 'x',
      openPlan: open,
    });
    expect(unsupported.notify(events)).toBe(0);
    expect(Array.from(notificationText('😀'.repeat(1200)))).toHaveLength(1000);
    expect(notificationText('a\0b\ufffd')).toBe('ab');
    clicks = [];
  });
});
