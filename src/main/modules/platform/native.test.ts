import { describe, it, expect, vi } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import {
  PickerService,
  type DialogPort,
  type DialogOptions,
  type PickerPreferences,
} from './picker';
import { createShellService } from './shell';
import { readTaskbarTheme } from './tray';
import {
  BROADCAST_ENVIRONMENT,
  CLOSE_OWNED_DIALOG,
  closeOwnedDialog,
  systemExecutable,
  UserEnvironmentService,
} from './windows';
import type { CommandRunner, RegistrationPolicy } from './types';

const root = resolve('synthetic-test-root');
const policy: RegistrationPolicy = {
  platform: 'win32',
  development: false,
  executable: join(root, 'agent-ops.exe'),
  installedRoot: root,
  env: {},
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function pickerFixture() {
  const selection = deferred<{ canceled: boolean; filePaths: string[] }>();
  const opened = deferred<DialogOptions>();
  const cancel = vi.fn(async () => {
    selection.resolve({ canceled: true, filePaths: [] });
    await selection.promise;
  });
  const preferences: PickerPreferences = {
    home: join(root, 'home'),
    getDirectory: () => join(root, 'last'),
    isDirectory: vi.fn(async () => true),
    rememberDirectory: vi.fn(async () => {}),
  };
  const port: DialogPort = {
    available: () => true,
    focusOwner: vi.fn(),
    open: vi.fn((options) => {
      opened.resolve(options);
      return { result: selection.promise, cancel };
    }),
  };
  return { selection, opened, cancel, preferences, port };
}
describe('owned modal picker service', () => {
  it.each(['workspace', 'skills', 'tasks'] as const)(
    'picks %s folders from the remembered directory',
    async (purpose) => {
      const f = pickerFixture(),
        service = new PickerService(f.port, f.preferences);
      const run = service.pick({ requestId: 'request-1', purpose }, 'sender-1');
      expect(await f.opened.promise).toMatchObject({
        kind: 'folder',
        defaultPath: join(root, 'last'),
      });
      expect(f.port.focusOwner).toHaveBeenCalledOnce();
      f.selection.resolve({
        canceled: false,
        filePaths: [join(root, 'chosen')],
      });
      expect(await run).toEqual({ path: join(root, 'chosen') });
      expect(f.preferences.rememberDirectory).toHaveBeenCalledWith(
        join(root, 'chosen'),
      );
    },
  );
  it('picks Markdown and remembers its parent, preserving the result after a preference error', async () => {
    const f = pickerFixture();
    f.preferences.isDirectory = async () => false;
    f.preferences.rememberDirectory = async () => {
      throw new Error('save failed');
    };
    const onError = vi.fn(),
      service = new PickerService(f.port, f.preferences, { onError });
    const run = service.pick(
      { requestId: 'file', purpose: 'instruction-file' },
      'sender',
    );
    expect(await f.opened.promise).toMatchObject({
      kind: 'markdown',
      defaultPath: f.preferences.home,
    });
    const path = join(root, 'docs/AGENTS.MD');
    f.selection.resolve({ canceled: false, filePaths: [path] });
    expect(await run).toEqual({ path });
    expect(dirname(path)).toBe(join(root, 'docs'));
    expect(onError).toHaveBeenCalledWith('picker-preference');
  });
  it('returns cancellation as a successful typed result', async () => {
    const f = pickerFixture(),
      service = new PickerService(f.port, f.preferences);
    const run = service.pick(
      { requestId: 'cancel', purpose: 'tasks' },
      'sender',
    );
    await f.opened.promise;
    f.selection.resolve({ canceled: true, filePaths: [] });
    expect(await run).toEqual({ cancelled: true });
    expect(await service.cancelPick({ requestId: 'cancel' }, 'sender')).toEqual(
      { cancelled: false },
    );
  });
  it('scopes cancellation to the sender and keeps BUSY until native closure is confirmed', async () => {
    const f = pickerFixture(),
      service = new PickerService(f.port, f.preferences);
    const run = service.pick(
      { requestId: 'one', purpose: 'workspace' },
      'sender',
    );
    await f.opened.promise;
    expect(await service.cancelPick({ requestId: 'one' }, 'foreign')).toEqual({
      cancelled: false,
    });
    expect(await service.cancelPick({ requestId: 'wrong' }, 'sender')).toEqual({
      cancelled: false,
    });
    await expect(
      service.pick({ requestId: 'two', purpose: 'tasks' }, 'sender'),
    ).rejects.toMatchObject({ code: 'BUSY' });
    const cancel = service.cancelPick({ requestId: 'one' }, 'sender');
    expect(await run).toEqual({ cancelled: true });
    expect(await cancel).toEqual({ cancelled: true });
    expect(f.cancel).toHaveBeenCalledOnce();
  });
  it('cancels before the native dialog is opened', async () => {
    const f = pickerFixture(),
      start = deferred<boolean>();
    f.preferences.isDirectory = () => start.promise;
    const service = new PickerService(f.port, f.preferences),
      run = service.pick({ requestId: 'one', purpose: 'tasks' }, 'sender');
    const cancel = service.cancelPick({ requestId: 'one' }, 'sender');
    start.resolve(true);
    expect(await run).toEqual({ cancelled: true });
    expect(await cancel).toEqual({ cancelled: true });
    expect(f.port.open).not.toHaveBeenCalled();
  });
  it('closes the native dialog before returning TIMEOUT', async () => {
    const f = pickerFixture(),
      service = new PickerService(f.port, f.preferences, { timeoutMs: 10 });
    const run = service.pick(
      { requestId: 'timeout', purpose: 'tasks' },
      'sender',
    );
    await expect(run).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(f.cancel).toHaveBeenCalledOnce();
  });
  it('reports a failed close without releasing the native picker lock', async () => {
    const f = pickerFixture();
    f.cancel.mockImplementation(async () => {
      throw new Error('native failure');
    });
    const service = new PickerService(f.port, f.preferences),
      run = service.pick({ requestId: 'one', purpose: 'tasks' }, 'sender');
    await f.opened.promise;
    await expect(
      service.cancelPick({ requestId: 'one' }, 'sender'),
    ).rejects.toMatchObject({ code: 'IO_ERROR' });
    await expect(
      service.pick({ requestId: 'two', purpose: 'tasks' }, 'sender'),
    ).rejects.toMatchObject({ code: 'BUSY' });
    f.selection.resolve({ canceled: true, filePaths: [] });
    expect(await run).toEqual({ cancelled: true });
  });
  it.each(['relative.md', join(root, 'wrong.txt')])(
    'rejects invalid native file choice %s',
    async (path) => {
      const f = pickerFixture(),
        service = new PickerService(f.port, f.preferences);
      const run = service.pick(
        { requestId: 'one', purpose: 'instruction-file' },
        'sender',
      );
      await f.opened.promise;
      f.selection.resolve({ canceled: false, filePaths: [path] });
      await expect(run).rejects.toMatchObject({ code: 'IO_ERROR' });
    },
  );
  it('reports missing owner, invalid request and native errors as fixed typed failures', async () => {
    const f = pickerFixture(),
      service = new PickerService(f.port, f.preferences);
    await expect(
      service.pick({ requestId: '../invalid', purpose: 'tasks' }, 'sender'),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    f.port.available = () => false;
    await expect(
      service.pick({ requestId: 'one', purpose: 'tasks' }, 'sender'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    f.port.available = () => true;
    const run = service.pick({ requestId: 'two', purpose: 'tasks' }, 'sender');
    await f.opened.promise;
    f.selection.reject(new Error('C:\\private\nprivate text'));
    await expect(run).rejects.toMatchObject({
      code: 'IO_ERROR',
      message: 'The picker could not be opened. Paste a path or try again.',
    });
  });
});
describe('validated Shell paths without permanent delete', () => {
  it('calls only trashItem for an explicitly allowed plan and opens only allowed folders', async () => {
    const port = {
        trashItem: vi.fn(async () => {}),
        openPath: vi.fn(async () => ''),
      },
      allow = vi.fn(() => true);
    const service = createShellService(port, allow, join(root, 'logs'));
    await service.trash(join(root, 'plan.md'));
    await service.openFolder(root);
    await service.openLogs();
    expect(port.trashItem).toHaveBeenCalledExactlyOnceWith(
      join(root, 'plan.md'),
    );
    expect(allow).toHaveBeenCalledWith(join(root, 'plan.md'), 'trash');
    expect(allow).toHaveBeenCalledWith(join(root, 'logs'), 'open-logs');
    expect(port.openPath).toHaveBeenCalledTimes(2);
  });
  it('denies relative, NUL and unlisted paths before native effects', async () => {
    const port = { trashItem: vi.fn(), openPath: vi.fn() },
      service = createShellService(port, () => false, root);
    for (const path of ['relative', `${root}\0bad`, root])
      await expect(service.trash(path)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    await expect(service.openLogs()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(port.trashItem).not.toHaveBeenCalled();
    expect(port.openPath).not.toHaveBeenCalled();
  });
  it('reports trash errors and nonempty openPath result strings', async () => {
    const service = createShellService(
      {
        trashItem: async () => {
          throw new Error('recycle unavailable');
        },
        openPath: async () => 'C:\\private failure',
      },
      () => true,
      root,
    );
    await expect(service.trash(root)).rejects.toMatchObject({
      code: 'IO_ERROR',
      message: 'The plan could not be moved to the Recycle Bin.',
    });
    await expect(service.openFolder(root)).rejects.toMatchObject({
      code: 'IO_ERROR',
      message: 'The folder could not be opened.',
    });
  });
});
describe('Windows commands through fakes', () => {
  it.each([
    ['0x1', 'light'],
    ['0x0', 'dark'],
    ['0x2', 'unknown'],
  ] as const)(
    'reads taskbar SystemUsesLightTheme %s',
    async (value, expected) => {
      const run = vi.fn<CommandRunner>(async () => ({
        stdout: `    SystemUsesLightTheme    REG_DWORD    ${value}\r\n`,
        code: 0,
      }));
      expect(await readTaskbarTheme(run, 'win32')).toBe(expected);
      expect(run.mock.calls[0]?.[1]).toContain('SystemUsesLightTheme');
    },
  );
  it('uses the fallback theme for unavailable registry or non-Windows', async () => {
    expect(
      await readTaskbarTheme(async () => {
        throw new Error('no registry');
      }, 'win32'),
    ).toBe('unknown');
    const run = vi.fn();
    expect(await readTaskbarTheme(run, 'linux')).toBe('unknown');
    expect(run).not.toHaveBeenCalled();
  });
  it('does not touch registry, process environment or broadcast in development', async () => {
    const run = vi.fn(),
      original = process.env.AGENT_OPS_TASKS;
    expect(
      await new UserEnvironmentService(run, {
        ...policy,
        development: true,
      }).setUserEnv('AGENT_OPS_TASKS', root),
    ).toEqual({ managed: false, changed: false });
    expect(run).not.toHaveBeenCalled();
    expect(process.env.AGENT_OPS_TASKS).toBe(original);
  });
  it('passes hostile pointer data in reg arguments, broadcasts only on a change, and removes on uninstall', async () => {
    let value: string | null = null;
    const run = vi.fn<CommandRunner>(async (exe, args) => {
      if (exe === 'reg.exe' && args[0] === 'query')
        return {
          code: 0,
          stdout:
            value === null
              ? 'HKEY_CURRENT_USER\\Environment\r\n'
              : `    AGENT_OPS_TASKS    REG_SZ    ${value}\r\n`,
        };
      if (args[0] === 'add') value = args[args.indexOf('/d') + 1]!;
      if (args[0] === 'delete') value = null;
      return { stdout: '', code: 0 };
    });
    const service = new UserEnvironmentService(run, policy),
      data = `${root} "; $(calc) “quotes”`;
    expect(await service.setUserEnv('AGENT_OPS_TASKS', data)).toEqual({
      managed: true,
      changed: true,
    });
    expect(run).toHaveBeenCalledWith(
      'reg.exe',
      [
        'add',
        'HKCU\\Environment',
        '/v',
        'AGENT_OPS_TASKS',
        '/t',
        'REG_SZ',
        '/d',
        data,
        '/f',
      ],
      { timeoutMs: 5000 },
    );
    expect(run).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', BROADCAST_ENVIRONMENT],
      { timeoutMs: 5000 },
    );
    expect(BROADCAST_ENVIRONMENT).not.toContain(data);
    const before = run.mock.calls.length;
    expect(await service.setUserEnv('AGENT_OPS_TASKS', data)).toEqual({
      managed: true,
      changed: false,
    });
    expect(run.mock.calls.length).toBe(before + 1);
    await service.setUserEnv('AGENT_OPS_TASKS', null);
    expect(value).toBeNull();
    expect(run).toHaveBeenCalledWith(
      'reg.exe',
      ['delete', 'HKCU\\Environment', '/v', 'AGENT_OPS_TASKS', '/f'],
      { timeoutMs: 5000 },
    );
  });
  it('keeps the report command pointer separate from the Tasks pointer and refuses other names', async () => {
    const values: Record<string, string> = {
      AGENT_OPS_TASKS: root,
    };
    const run = vi.fn<CommandRunner>(async (_exe, args) => {
      if (args[0] === 'query')
        return {
          code: 0,
          stdout: Object.entries(values)
            .map(([k, v]) => `    ${k}    REG_SZ    ${v}\r\n`)
            .join(''),
        };
      if (args[0] === 'add') values[args[3]!] = args[args.indexOf('/d') + 1]!;
      return { stdout: '', code: 0 };
    });
    const service = new UserEnvironmentService(run, policy);
    const exe = `${root}\\agent-ops.exe`;
    expect(await service.setUserEnv('AGENT_OPS_REPORT', exe)).toEqual({
      managed: true,
      changed: true,
    });
    expect(values).toEqual({ AGENT_OPS_TASKS: root, AGENT_OPS_REPORT: exe });
    expect(await service.setUserEnv('AGENT_OPS_REPORT', exe)).toEqual({
      managed: true,
      changed: false,
    });
    await expect(
      service.setUserEnv('PATH' as 'AGENT_OPS_TASKS', exe),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  it('serializes pointer changes and does not swallow registry/broadcast errors', async () => {
    const calls: string[] = [];
    const run: CommandRunner = async (_exe, args) => {
      calls.push(args[0]!);
      return { stdout: '', code: args[0] === 'query' ? 0 : 1 };
    };
    const service = new UserEnvironmentService(run, policy);
    await expect(
      service.setUserEnv('AGENT_OPS_TASKS', root),
    ).rejects.toMatchObject({ code: 'IO_ERROR' });
    await expect(
      service.setUserEnv('AGENT_OPS_TASKS', `${root}2`),
    ).rejects.toMatchObject({ code: 'IO_ERROR' });
    expect(calls).toEqual(['query', 'add', 'query', 'add']);
    await expect(
      service.setUserEnv('AGENT_OPS_TASKS', 'bad\0value'),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  it('closes only an owned dialog using fixed script and numeric data, with failure acknowledgement', async () => {
    const run = vi.fn<CommandRunner>(async () => ({ code: 0, stdout: '' }));
    await closeOwnedDialog(run, 123456789n, 123);
    expect(run.mock.calls[0]?.[1]).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      CLOSE_OWNED_DIALOG,
    ]);
    expect(run.mock.calls[0]?.[2]?.env).toMatchObject({
      AGENT_OPS_DIALOG_OWNER: '123456789',
      AGENT_OPS_DIALOG_PID: '123',
    });
    expect(CLOSE_OWNED_DIALOG).toContain('target == pid');
    expect(CLOSE_OWNED_DIALOG).toContain('GetWindow(hwnd, 4)');
    await expect(
      closeOwnedDialog(async () => ({ code: 1, stdout: '' }), 1n, 1),
    ).rejects.toMatchObject({ code: 'IO_ERROR' });
  });
});

describe('system executables', () => {
  it('runs reg.exe and powershell.exe only from System32', () => {
    expect(systemExecutable('reg.exe', String.raw`C:\Windows`)).toBe(
      String.raw`C:\Windows\System32\reg.exe`,
    );
    expect(systemExecutable('PowerShell.exe', String.raw`D:\Win`)).toBe(
      String.raw`D:\Win\System32\WindowsPowerShell\v1.0\powershell.exe`,
    );
    expect(
      systemExecutable(String.raw`C:\Tools\x.exe`, String.raw`C:\Windows`),
    ).toBe(String.raw`C:\Tools\x.exe`);
  });
});
