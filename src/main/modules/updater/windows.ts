// Windows implementations of the legacy move's RegistryLayer and ProcessLayer,
// using reg.exe and PowerShell from System32 (no native module). Only the
// installed app uses them; tests inject in-memory fakes and never reach the
// real registry or processes.

import { execFile } from 'node:child_process';
import { join } from 'node:path';

import type { ProcessLayer, RegistryLayer } from './legacy-move';

export interface RunResult {
  code: number;
  stdout: string;
}

function run(
  file: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        timeout: 30_000,
        env: env ?? process.env,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        if (error && typeof (error as { code?: unknown }).code !== 'number') {
          reject(error);
          return;
        }
        resolve({
          code: error ? Number((error as { code?: unknown }).code) : 0,
          stdout: String(stdout),
        });
      },
    );
  });
}

function system32(file: string): string {
  return join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', file);
}

/** The value of one REG_SZ / REG_EXPAND_SZ line of `reg query` output, or null. */
export function parseRegQuery(output: string, name: string): string | null {
  const label = name === '' ? '(Default)' : name;
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s{4}(.+?)\s{4}(REG_SZ|REG_EXPAND_SZ)(?:\s{4}(.*))?$/.exec(
      line,
    );
    if (m && m[1]?.toLowerCase() === label.toLowerCase()) {
      return m[3] ?? '';
    }
  }
  return null;
}

function nameArgs(name: string): string[] {
  return name === '' ? ['/ve'] : ['/v', name];
}

export function regExeRegistry(): RegistryLayer {
  const reg = system32('reg.exe');
  const key = (k: string): string => `HKCU\\${k}`;
  return {
    async getString(k, name) {
      const r = await run(reg, ['query', key(k), ...nameArgs(name)]);
      return r.code === 0 ? parseRegQuery(r.stdout, name) : null;
    },
    async setString(k, name, value) {
      const r = await run(reg, [
        'add',
        key(k),
        ...nameArgs(name),
        '/t',
        'REG_SZ',
        '/d',
        value,
        '/f',
      ]);
      if (r.code !== 0) {
        throw new Error(`reg add ${key(k)} failed`);
      }
    },
    async deleteValue(k, name) {
      const exists = await run(reg, ['query', key(k), ...nameArgs(name)]);
      if (exists.code !== 0) return;
      const r = await run(reg, ['delete', key(k), ...nameArgs(name), '/f']);
      if (r.code !== 0) {
        throw new Error(`reg delete ${key(k)} failed`);
      }
    },
    async deleteKey(k) {
      const exists = await run(reg, ['query', key(k)]);
      if (exists.code !== 0) return;
      const r = await run(reg, ['delete', key(k), '/f']);
      if (r.code !== 0) {
        throw new Error(`reg delete ${key(k)} failed`);
      }
    },
  };
}

/** Parses the helper's "stopped=<n>" line; null when absent. */
export function parseStopped(output: string): number | null {
  const m = /^stopped=(\d+)\s*$/m.exec(output);
  return m ? Number(m[1]) : null;
}

/**
 * Stops processes whose image is exactly one of the given executables, through
 * the fixed installer helper (resourcesinstaller-helper.ps1, also used by the
 * NSIS installer): identity is checked on an opened process handle and the same
 * handle is terminated and waited for. Never this process. A process that could
 * not be inspected or stopped is an error, never a silent success.
 */
export function powershellProcesses(
  helper = join(process.resourcesPath ?? '', 'installer-helper.ps1'),
  execute: (file: string, args: string[]) => Promise<RunResult> = (
    file,
    args,
  ) => run(file, args),
): ProcessLayer {
  const powershell = system32(
    join('WindowsPowerShell', 'v1.0', 'powershell.exe'),
  );
  return {
    async stopExact(executables) {
      if (executables.length === 0) return 0;
      for (const exe of executables) {
        if (!/^[A-Za-z]:\\/.test(exe) || exe.includes('|')) {
          throw new Error('only full local executable paths can be stopped');
        }
      }
      const r = await execute(powershell, [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        helper,
        'stop',
        '-Executable',
        executables.join('|'),
        '-KeepPid',
        String(process.pid),
      ]);
      const stopped = parseStopped(r.stdout);
      if (r.code !== 0 || stopped === null) {
        throw new Error(
          r.code === 2
            ? 'a running earlier version could not be inspected'
            : 'a running earlier version could not be stopped',
        );
      }
      return stopped;
    },
  };
}
