import type { CommandRunner, Dispose } from './types';
import type { StartupService } from './registration';

export type TaskbarTheme = 'light' | 'dark' | 'unknown';
export interface TrayCounts {
  plans: number;
  waiting: number;
  blocked: number;
}
export function trayCounts(
  plans: readonly { status: string; questions: readonly { open: boolean }[] }[],
): TrayCounts {
  return {
    plans: plans.length,
    waiting: plans.reduce(
      (total, plan) =>
        total +
        Number(/^waiting for owner/i.test(plan.status)) +
        plan.questions.filter((q) => q.open).length,
      0,
    ),
    blocked: plans.filter((plan) => /^blocked/i.test(plan.status)).length,
  };
}
export interface MenuEntry {
  label?: string;
  type?: 'separator' | 'checkbox';
  checked?: boolean;
  enabled?: boolean;
  click?: () => void;
}
export interface TrayPort {
  setImage(path: string): void;
  setToolTip(text: string): void;
  setMenu(menu: MenuEntry[]): void;
  onClick(callback: () => void): Dispose;
  destroy(): void;
}
export async function readTaskbarTheme(
  run: CommandRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<TaskbarTheme> {
  if (platform !== 'win32') return 'unknown';
  try {
    const result = await run(
      'reg.exe',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
        '/v',
        'SystemUsesLightTheme',
      ],
      { timeoutMs: 5000 },
    );
    if (result.code !== 0) return 'unknown';
    const value =
      /SystemUsesLightTheme\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)\b/i.exec(
        result.stdout,
      )?.[1];
    return value !== undefined && Number(value) === 1
      ? 'light'
      : value !== undefined && Number(value) === 0
        ? 'dark'
        : 'unknown';
  } catch {
    return 'unknown';
  }
}
const count = (value: number): number =>
  Number.isSafeInteger(value) && value >= 0 ? value : 0;
export function createTray(options: {
  create(icon: string): TrayPort;
  icons: Record<TaskbarTheme, string>;
  theme(): Promise<TaskbarTheme>;
  startup: StartupService;
  open(): void;
  refresh(): void | Promise<void>;
  settings(): void;
  quit(): void;
  onError?: (category: string) => void;
  schedule?: (callback: () => void, milliseconds: number) => Dispose;
}) {
  const tray = options.create(options.icons.unknown);
  let disposed = false,
    polling = false;
  const report = (category: string): void => {
    options.onError?.(category);
  };
  const menu = (): void => {
    let startup = { enabled: false, managed: false };
    try {
      startup = options.startup.get();
    } catch {
      report('startup-read');
    }
    tray.setMenu([
      { label: 'Open Agent Ops', click: options.open },
      {
        label: 'Refresh',
        click: () => {
          void Promise.resolve()
            .then(options.refresh)
            .catch(() => report('refresh'));
        },
      },
      { label: 'Settings', click: options.settings },
      { type: 'separator' },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: startup.enabled,
        enabled: startup.managed,
        click: () => {
          try {
            options.startup.set(!startup.enabled);
          } catch {
            report('startup-write');
          }
          menu();
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: options.quit },
    ]);
  };
  const pollTheme = async (): Promise<void> => {
    if (disposed || polling) return;
    polling = true;
    try {
      const theme = await options.theme();
      if (!disposed) tray.setImage(options.icons[theme]);
    } catch {
      if (!disposed) tray.setImage(options.icons.unknown);
    } finally {
      polling = false;
    }
  };
  const update = (counts: TrayCounts): void => {
    if (!disposed)
      tray.setToolTip(
        `Agent Ops · ${count(counts.plans)} plans · ${count(counts.waiting)} waiting for you · ${count(counts.blocked)} blocked`,
      );
  };
  menu();
  update({ plans: 0, waiting: 0, blocked: 0 });
  const offClick = tray.onClick(options.open);
  const schedule =
    options.schedule ??
    ((callback, ms) => {
      const timer = setInterval(callback, ms);
      timer.unref();
      return () => clearInterval(timer);
    });
  const stop = schedule(() => {
    void pollTheme();
  }, 30_000);
  void pollTheme();
  return {
    update,
    refreshMenu: menu,
    pollTheme,
    isCreated: () => !disposed,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stop();
      offClick();
      tray.destroy();
    },
  };
}
