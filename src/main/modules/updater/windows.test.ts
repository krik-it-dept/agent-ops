// The app's process layer: it only builds a fixed command line for the shared
// installer helper and turns its result into success or a failure. The helper
// itself is exercised against real throwaway processes in installer-helper.test.ts.
import { describe, expect, it } from 'vitest';

import { parseStopped, powershellProcesses, type RunResult } from './windows';

function recorder(result: RunResult) {
  const calls: { file: string; args: string[] }[] = [];
  const layer = powershellProcesses(
    'C:\\Program Files\\Agent Ops\\resources\\installer-helper.ps1',
    async (file, args) => {
      calls.push({ file, args });
      return result;
    },
  );
  return { calls, layer };
}

describe('process layer', () => {
  it('passes the exact executables as one argument value to the fixed helper', async () => {
    const { calls, layer } = recorder({
      code: 0,
      stdout: 'stopped 12 C:\\x\nstopped=1\r\n',
    });
    const exes = [
      "C:\\Users\\O'Brien $(x)\\.claude\\agent-ops.exe",
      'C:\\Users\\Ünï\\agent-ops.exe',
    ];
    expect(await layer.stopExact(exes)).toBe(1);
    expect(calls).toHaveLength(1);
    const { file, args } = calls[0]!;
    expect(file).toMatch(
      /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i,
    );
    expect(args).not.toContain('-Command');
    expect(args.slice(0, 6)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\Program Files\\Agent Ops\\resources\\installer-helper.ps1',
    ]);
    expect(args.slice(6, 9)).toEqual(['stop', '-Executable', exes.join('|')]);
    expect(args.slice(9)).toEqual(['-KeepPid', String(process.pid)]);
  });

  it('treats an inspection or stop failure, or a missing result line, as a failure', async () => {
    await expect(
      recorder({ code: 1, stdout: 'stopped=0' }).layer.stopExact([
        'C:\\a\\agent-ops.exe',
      ]),
    ).rejects.toThrow('could not be stopped');
    await expect(
      recorder({ code: 2, stdout: 'stopped=0' }).layer.stopExact([
        'C:\\a\\agent-ops.exe',
      ]),
    ).rejects.toThrow('could not be inspected');
    await expect(
      recorder({ code: 0, stdout: 'garbage' }).layer.stopExact([
        'C:\\a\\agent-ops.exe',
      ]),
    ).rejects.toThrow();
  });

  it('refuses folder prefixes, relative, network and separator-bearing paths without running anything', async () => {
    for (const bad of [
      'agent-ops.exe',
      '\\\\server\\share\\agent-ops.exe',
      'C:\\a|C:\\b\\agent-ops.exe',
    ]) {
      const { calls, layer } = recorder({ code: 0, stdout: 'stopped=0' });
      await expect(layer.stopExact([bad])).rejects.toThrow();
      expect(calls).toEqual([]);
    }
    expect(await recorder({ code: 0, stdout: '' }).layer.stopExact([])).toBe(0);
  });

  it('parses the stopped count', () => {
    expect(parseStopped('x\r\nstopped=3\r\n')).toBe(3);
    expect(parseStopped('stopped 3')).toBeNull();
  });
});
