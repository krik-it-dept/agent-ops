import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { registrationAllowed } from './registration';
import {
  PlatformError,
  type CommandRunner,
  type RegistrationPolicy,
} from './types';

/**
 * The System32 copy of reg.exe or powershell.exe. A bare name would be searched in
 * the current folder first (libuv), where a planted program could run instead.
 */
export function systemExecutable(
  name: string,
  root = process.env.SystemRoot || 'C:\\Windows',
): string {
  const lower = name.toLowerCase();
  if (lower === 'powershell.exe')
    return win32.join(
      root,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
  if (lower === 'reg.exe') return win32.join(root, 'System32', 'reg.exe');
  return name;
}

export const runCommand: CommandRunner = (executable, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      systemExecutable(executable),
      [...args],
      {
        windowsHide: true,
        timeout: options.timeoutMs ?? 5000,
        maxBuffer: 1 << 20,
        env: options.env ?? process.env,
      },
      (error, stdout) => {
        if (error && typeof error.code !== 'number') reject(error);
        else
          resolve({
            stdout,
            code: typeof error?.code === 'number' ? error.code : 0,
          });
      },
    );
  });

// All scripts are fixed program text. Runtime values travel only as environment data.
export const BROADCAST_ENVIRONMENT = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AgentOpsEnvironment {
 [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, UIntPtr wp, string lp, uint flags, uint timeout, out UIntPtr result);
}
'@
$result = [UIntPtr]::Zero
$sent = [AgentOpsEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 2000, [ref]$result)
if ($sent -eq [IntPtr]::Zero) { exit 1 }
`;

export class UserEnvironmentService {
  readonly managed: boolean;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly run: CommandRunner,
    policy: RegistrationPolicy,
  ) {
    this.managed = registrationAllowed(policy);
  }
  setUserEnv(
    name: 'AGENT_OPS_TASKS',
    value: string | null,
  ): Promise<{ managed: boolean; changed: boolean }> {
    if (
      name !== 'AGENT_OPS_TASKS' ||
      (value !== null && (value.includes('\0') || value.length > 32_000))
    )
      return Promise.reject(
        new PlatformError(
          'INVALID_REQUEST',
          'Invalid Tasks environment pointer.',
        ),
      );
    if (!this.managed)
      return Promise.resolve({ managed: false, changed: false });
    const operation = this.pending.then(async () => {
      try {
        const query = await this.run(
          'reg.exe',
          ['query', 'HKCU\\Environment'],
          { timeoutMs: 5000 },
        );
        if (query.code !== 0)
          throw new Error('Environment key is unavailable.');
        const match =
          /^[ \t]*AGENT_OPS_TASKS[ \t]+REG_(?:EXPAND_)?SZ[ \t]+(.*)$/im.exec(
            query.stdout,
          );
        const current = match?.[1]?.replace(/\r$/, '') ?? null;
        const desired = value || null;
        if (current === desired) return { managed: true, changed: false };
        const args =
          desired === null
            ? ['delete', 'HKCU\\Environment', '/v', name, '/f']
            : [
                'add',
                'HKCU\\Environment',
                '/v',
                name,
                '/t',
                'REG_SZ',
                '/d',
                desired,
                '/f',
              ];
        if ((await this.run('reg.exe', args, { timeoutMs: 5000 })).code !== 0)
          throw new Error('Registry update failed.');
        if (
          (
            await this.run(
              'powershell.exe',
              [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                BROADCAST_ENVIRONMENT,
              ],
              { timeoutMs: 5000 },
            )
          ).code !== 0
        )
          throw new Error('Environment broadcast failed.');
        return { managed: true, changed: true };
      } catch {
        throw new PlatformError(
          'IO_ERROR',
          'The Tasks environment pointer could not be updated.',
          true,
        );
      }
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}

// Close only this process's standard dialog directly owned by the app window.
// Do not use SendKeys, window titles, or broad process/window termination.
export const CLOSE_OWNED_DIALOG = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AgentOpsDialog {
 public delegate bool EnumProc(IntPtr hwnd, IntPtr data);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr data);
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wp, IntPtr lp);
 public static bool Close(long owner, uint pid) {
  bool found = false;
  EnumWindows((hwnd, data) => {
   uint target; GetWindowThreadProcessId(hwnd, out target);
   var name = new StringBuilder(32); GetClassName(hwnd, name, 32);
   if (target == pid && GetWindow(hwnd, 4).ToInt64() == owner && name.ToString() == "#32770") {
    found = PostMessage(hwnd, 0x10, IntPtr.Zero, IntPtr.Zero) || found;
   }
   return true;
  }, IntPtr.Zero);
  return found;
 }
}
'@
$owner = [long]$env:AGENT_OPS_DIALOG_OWNER
$targetPid = [uint32]$env:AGENT_OPS_DIALOG_PID
for ($attempt = 0; $attempt -lt 40; $attempt++) {
 if ([AgentOpsDialog]::Close($owner, $targetPid)) { exit 0 }
 Start-Sleep -Milliseconds 50
}
exit 1
`;
export async function closeOwnedDialog(
  run: CommandRunner,
  owner: bigint,
  pid: number,
): Promise<void> {
  const result = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', CLOSE_OWNED_DIALOG],
    {
      env: {
        ...process.env,
        AGENT_OPS_DIALOG_OWNER: owner.toString(),
        AGENT_OPS_DIALOG_PID: String(pid),
      },
      timeoutMs: 7000,
    },
  );
  if (result.code !== 0)
    throw new PlatformError(
      'IO_ERROR',
      'The picker could not be closed.',
      true,
    );
}
