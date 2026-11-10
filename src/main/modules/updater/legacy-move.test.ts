// The one-time move from the Go version, with temporary folders as the user
// profile and %LOCALAPPDATA%, and an in-memory registry. Nothing here touches
// the real registry, processes or folders.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  detectLegacy,
  runLegacyMove,
  type LegacyMoveOptions,
  type RegistryLayer,
} from './legacy-move';
import { LEGACY } from './legacy-names';
import { parseRegQuery } from './windows';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

class MemoryRegistry implements RegistryLayer {
  values = new Map<string, Map<string, string>>();
  failOn: string | null = null;
  private k(key: string): string {
    return key.toLowerCase();
  }
  async getString(key: string, name: string): Promise<string | null> {
    return this.values.get(this.k(key))?.get(name.toLowerCase()) ?? null;
  }
  async setString(key: string, name: string, value: string): Promise<void> {
    if (this.failOn === key) throw new Error('access denied');
    const values = this.values.get(this.k(key)) ?? new Map<string, string>();
    values.set(name.toLowerCase(), value);
    this.values.set(this.k(key), values);
  }
  async deleteValue(key: string, name: string): Promise<void> {
    if (this.failOn === key) throw new Error('access denied');
    this.values.get(this.k(key))?.delete(name.toLowerCase());
  }
  async deleteKey(key: string): Promise<void> {
    if (this.failOn === key) throw new Error('access denied');
    for (const k of [...this.values.keys()]) {
      if (k === this.k(key) || k.startsWith(`${this.k(key)}\\`))
        this.values.delete(k);
    }
  }
}

function put(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'agent-ops-legacy-'));
  roots.push(root);
  const profile = join(root, 'profile');
  const local = join(profile, 'AppData', 'Local');
  const data = join(local, 'AgentOps');
  const exe = join(local, 'Programs', 'AgentOps', 'agent-ops.exe');
  const stubs = join(root, 'resources', 'legacy-stubs');
  for (const stub of LEGACY.stubs)
    put(join(stubs, stub), `// new no-op ${stub}\n`);
  const registry = new MemoryRegistry();
  const stopped: string[] = [];
  const lines: string[] = [];
  const options: LegacyMoveOptions = {
    localAppData: local,
    userProfile: profile,
    dataDir: data,
    executablePath: exe,
    stubsDir: stubs,
    registry,
    processes: {
      stopExact: async (executables) => {
        // The journal of the move exists before anything is stopped.
        expect(existsSync(join(data, 'legacy-move', 'runtime-move.json'))).toBe(
          true,
        );
        stopped.push(executables.join('|'));
        return 1;
      },
    },
    now: () => new Date(2026, 10, 10, 9, 8, 7),
    log: (line) => lines.push(line),
  };
  const runtime = join(profile, ...LEGACY.runtimeFolder);
  return {
    root,
    profile,
    local,
    data,
    exe,
    stubs,
    registry,
    stopped,
    lines,
    options,
    runtime,
  };
}

describe('move from the Go version', () => {
  it('finds nothing on a clean machine, and records that once', async () => {
    const t = setup();
    const found = await detectLegacy(t.options);
    expect(found).toEqual({
      runtimeFolder: null,
      runtimeStubsOnly: false,
      goInstallBackup: null,
      goUninstallEntry: false,
      runValueOld: null,
      runValue: null,
      oldProtocol: false,
      oldConfig: null,
    });
    const result = await runLegacyMove(t.options);
    expect(result.completed).toBe(true);
    expect(result.steps.every((s) => s.outcome === 'nothing')).toBe(true);
    expect(t.stopped).toEqual([]);
    expect(t.registry.values.size).toBe(0);
    expect(readdirSync(t.data)).toEqual(['legacy-move']);
    expect(readdirSync(join(t.data, 'legacy-move')).sort()).toEqual([
      'legacy-move.log',
      'result.json',
    ]);
  });

  it('moves a full old install aside, keeps the stubs, its data and the startup choice', async () => {
    const t = setup();
    // The old runtime folder with program files and unknown private files.
    put(join(t.runtime, 'agent-ops.exe'), 'old exe');
    put(join(t.runtime, LEGACY.aliasExe), 'old alias');
    put(join(t.runtime, 'task-sync.mjs'), 'old reporter');
    put(join(t.runtime, 'historical-executions.json'), '{"runs":[1]}');
    // The oldest data folder and a Go install receipt from the installer.
    put(
      join(t.local, LEGACY.dataFolder, 'config.json'),
      '{"projects":["D:\\\\work"]}',
    );
    put(
      join(t.data, 'legacy-move', 'installer-receipt.txt'),
      `goInstallBackup=${join(t.data, 'backups', 'go-install-1')}\r\n`,
    );
    put(join(t.data, 'archive.json'), '{"keep":true}');
    await t.registry.setString(
      LEGACY.runKey,
      LEGACY.runValueOld,
      `"${join(t.runtime, 'agent-ops.exe')}" --background`,
    );
    await t.registry.setString(LEGACY.runKey, 'Other app', 'other.exe');
    await t.registry.setString(LEGACY.protocolKey, '', 'URL:old');
    await t.registry.setString(
      `${LEGACY.protocolKey}\\shell\\open\\command`,
      '',
      'old.exe',
    );
    await t.registry.setString(
      LEGACY.goUninstallKey,
      'UninstallString',
      '"C:\\x\\agent-ops.exe" --uninstall',
    );
    await t.registry.setString(
      'Software\\Classes\\agent-ops',
      '',
      'URL:Agent Ops',
    );

    const found = await detectLegacy(t.options);
    expect(found).toMatchObject({
      runtimeFolder: t.runtime,
      goInstallBackup: join(t.data, 'backups', 'go-install-1'),
      goUninstallEntry: true,
      oldProtocol: true,
      oldConfig: join(t.local, LEGACY.dataFolder, 'config.json'),
    });

    const result = await runLegacyMove(t.options);
    expect(result.completed, JSON.stringify(result.steps)).toBe(true);
    expect(t.stopped).toEqual([
      `${join(t.runtime, 'agent-ops.exe')}|${join(t.runtime, LEGACY.aliasExe)}`,
    ]);
    // Moved next to itself, nothing deleted, unknown files kept.
    const backup = `${t.runtime}.backup-20261110-090807`;
    expect(
      readFileSync(join(backup, 'historical-executions.json'), 'utf8'),
    ).toBe('{"runs":[1]}');
    expect(readFileSync(join(backup, 'agent-ops.exe'), 'utf8')).toBe('old exe');
    // The stubs stay callable at the old path; they are the new no-op ones.
    expect(readdirSync(t.runtime).sort()).toEqual([
      'task-report.mjs',
      'task-sync.mjs',
    ]);
    expect(readFileSync(join(t.runtime, 'task-sync.mjs'), 'utf8')).toBe(
      '// new no-op task-sync.mjs\n',
    );
    // Startup stays on, now for this app; unrelated values untouched.
    expect(
      await t.registry.getString(LEGACY.runKey, LEGACY.runValueOld),
    ).toBeNull();
    expect(await t.registry.getString(LEGACY.runKey, LEGACY.runValue)).toBe(
      `"${t.exe}" --background`,
    );
    expect(await t.registry.getString(LEGACY.runKey, 'Other app')).toBe(
      'other.exe',
    );
    expect(await t.registry.getString(LEGACY.protocolKey, '')).toBeNull();
    expect(
      await t.registry.getString(
        `${LEGACY.protocolKey}\\shell\\open\\command`,
        '',
      ),
    ).toBeNull();
    expect(
      await t.registry.getString(LEGACY.goUninstallKey, 'UninstallString'),
    ).toBeNull();
    expect(await t.registry.getString('Software\\Classes\\agent-ops', '')).toBe(
      'URL:Agent Ops',
    );
    // The oldest config is copied once; existing data untouched.
    expect(readFileSync(join(t.data, 'config.json'), 'utf8')).toBe(
      '{"projects":["D:\\\\work"]}',
    );
    expect(readFileSync(join(t.data, 'archive.json'), 'utf8')).toBe(
      '{"keep":true}',
    );
    expect(existsSync(join(t.local, LEGACY.dataFolder, 'config.json'))).toBe(
      true,
    );
    // Logged, step by step.
    const log = readFileSync(
      join(t.data, 'legacy-move', 'legacy-move.log'),
      'utf8',
    );
    for (const step of [
      'go-install: done',
      'runtime-folder: done',
      'runtime-stubs: done',
      'startup: done',
      'old-protocol: done',
      'go-uninstall-entry: done',
      'old-config: done',
    ]) {
      expect(log).toContain(step);
    }
    expect(t.lines.length).toBe(result.steps.length);

    // A second start does nothing.
    put(join(t.local, LEGACY.dataFolder, 'config.json'), '{"changed":true}');
    const again = await runLegacyMove(t.options);
    expect(again).toEqual(result);
    expect(t.stopped).toHaveLength(1);
    expect(readFileSync(join(t.data, 'config.json'), 'utf8')).toBe(
      '{"projects":["D:\\\\work"]}',
    );
  });

  it('leaves a folder that holds only the stubs alone, and never replaces an existing config', async () => {
    const t = setup();
    put(join(t.runtime, 'task-sync.mjs'), 'stub from v0.4');
    put(join(t.runtime, 'task-report.mjs'), 'stub from v0.4');
    put(join(t.local, LEGACY.dataFolder, 'config.json'), '{"old":true}');
    put(join(t.data, 'config.json'), '{"current":true}');
    await t.registry.setString(
      LEGACY.runKey,
      LEGACY.runValue,
      `"${t.exe}" --background`,
    );
    const found = await detectLegacy(t.options);
    expect(found).toMatchObject({
      runtimeFolder: null,
      runtimeStubsOnly: true,
      oldConfig: null,
    });
    const result = await runLegacyMove(t.options);
    expect(result.completed).toBe(true);
    expect(t.stopped).toEqual([]);
    expect(readFileSync(join(t.runtime, 'task-sync.mjs'), 'utf8')).toBe(
      'stub from v0.4',
    );
    expect(readFileSync(join(t.data, 'config.json'), 'utf8')).toBe(
      '{"current":true}',
    );
    expect(await t.registry.getString(LEGACY.runKey, LEGACY.runValue)).toBe(
      `"${t.exe}" --background`,
    );
  });

  it('keeps Start with Windows off when it was off', async () => {
    const t = setup();
    await t.registry.setString(LEGACY.protocolKey, '', 'URL:old');
    await runLegacyMove(t.options);
    expect(
      await t.registry.getString(LEGACY.runKey, LEGACY.runValue),
    ).toBeNull();
  });

  it('does not remove an Apps & features entry it did not write', async () => {
    const t = setup();
    await t.registry.setString(
      LEGACY.goUninstallKey,
      'UninstallString',
      '"C:\\other\\uninstall.exe"',
    );
    expect((await detectLegacy(t.options)).goUninstallEntry).toBe(false);
    await runLegacyMove(t.options);
    expect(
      await t.registry.getString(LEGACY.goUninstallKey, 'UninstallString'),
    ).toBe('"C:\\other\\uninstall.exe"');
  });

  it('retries a failed step on the next start and repairs missing stubs', async () => {
    const t = setup();
    put(join(t.runtime, 'agent-ops.exe'), 'old exe');
    await t.registry.setString(LEGACY.protocolKey, '', 'URL:old');
    t.registry.failOn = LEGACY.protocolKey;
    const first = await runLegacyMove(t.options);
    expect(first.completed).toBe(false);
    expect(first.steps.find((s) => s.step === 'old-protocol')).toMatchObject({
      outcome: 'failed',
      detail: 'access denied',
    });
    expect(first.steps.find((s) => s.step === 'runtime-folder')?.outcome).toBe(
      'done',
    );
    rmSync(join(t.runtime, 'task-report.mjs'));
    t.registry.failOn = null;
    const second = await runLegacyMove(t.options);
    expect(second.completed).toBe(true);
    expect(second.steps.find((s) => s.step === 'runtime-folder')?.outcome).toBe(
      'nothing',
    );
    expect(second.steps.find((s) => s.step === 'runtime-stubs')).toMatchObject({
      outcome: 'done',
    });
    expect(readdirSync(t.runtime).sort()).toEqual([
      'task-report.mjs',
      'task-sync.mjs',
    ]);
    expect(await t.registry.getString(LEGACY.protocolKey, '')).toBeNull();
    expect(t.stopped).toHaveLength(1);
  });

  it('keeps the folder in place when its processes cannot be stopped or it is locked', async () => {
    const t = setup();
    put(join(t.runtime, 'agent-ops.exe'), 'old exe');
    const result = await runLegacyMove({
      ...t.options,
      processes: {
        stopExact: async () => {
          throw new Error('stopping the earlier version failed');
        },
      },
    });
    expect(result.completed).toBe(false);
    expect(readFileSync(join(t.runtime, 'agent-ops.exe'), 'utf8')).toBe(
      'old exe',
    );
  });

  it('repairs the stub location after an interruption between the rename and the new folder', async () => {
    const t = setup();
    // State left by a run that renamed the old folder and stopped before
    // recreating it: the journal names the backup, the old path is gone.
    const backup = `${t.runtime}.backup-20261110-090807`;
    put(join(backup, 'agent-ops.exe'), 'old exe');
    put(
      join(t.data, 'legacy-move', 'runtime-move.json'),
      JSON.stringify({ backup, stubsPending: true }),
    );
    expect(existsSync(t.runtime)).toBe(false);
    const result = await runLegacyMove(t.options);
    expect(result.completed, JSON.stringify(result.steps)).toBe(true);
    expect(result.steps.find((s) => s.step === 'runtime-stubs')).toMatchObject({
      outcome: 'done',
    });
    expect(readdirSync(t.runtime).sort()).toEqual([
      'task-report.mjs',
      'task-sync.mjs',
    ]);
    expect(existsSync(join(t.data, 'legacy-move', 'runtime-move.json'))).toBe(
      false,
    );
    expect(readFileSync(join(backup, 'agent-ops.exe'), 'utf8')).toBe('old exe');
    expect(t.stopped).toEqual([]);
  });

  it('keeps the journal and retries when the stubs could not be put back', async () => {
    const t = setup();
    put(join(t.runtime, 'agent-ops.exe'), 'old exe');
    const first = await runLegacyMove({
      ...t.options,
      stubsDir: join(t.root, 'missing-stubs'),
    });
    expect(first.completed).toBe(false);
    expect(first.steps.find((s) => s.step === 'runtime-stubs')?.outcome).toBe(
      'failed',
    );
    expect(existsSync(join(t.data, 'legacy-move', 'runtime-move.json'))).toBe(
      true,
    );
    const second = await runLegacyMove(t.options);
    expect(second.completed).toBe(true);
    expect(readdirSync(t.runtime).sort()).toEqual([
      'task-report.mjs',
      'task-sync.mjs',
    ]);
    expect(existsSync(join(t.data, 'legacy-move', 'runtime-move.json'))).toBe(
      false,
    );
  });

  it('never runs for an isolated or development data folder', async () => {
    const t = setup();
    put(join(t.runtime, 'agent-ops.exe'), 'old exe');
    await t.registry.setString(LEGACY.protocolKey, '', 'URL:old');
    const result = await runLegacyMove({
      ...t.options,
      dataDir: join(t.root, 'isolated'),
    });
    expect(result).toMatchObject({
      completed: false,
      steps: [{ step: 'scope', outcome: 'skipped' }],
    });
    expect(existsSync(join(t.root, 'isolated'))).toBe(false);
    expect(readFileSync(join(t.runtime, 'agent-ops.exe'), 'utf8')).toBe(
      'old exe',
    );
    expect(await t.registry.getString(LEGACY.protocolKey, '')).toBe('URL:old');
  });

  it('does not migrate from a portable copy using the default data folder', async () => {
    const t = setup();
    put(join(t.runtime, 'agent-ops.exe'), 'old exe');
    await t.registry.setString(LEGACY.runKey, LEGACY.runValue, 'old command');
    const result = await runLegacyMove({
      ...t.options,
      executablePath: join(t.root, 'Downloads', 'agent-ops.exe'),
    });
    expect(result.completed).toBe(false);
    expect(t.stopped).toEqual([]);
    expect(readFileSync(join(t.runtime, 'agent-ops.exe'), 'utf8')).toBe(
      'old exe',
    );
    expect(await t.registry.getString(LEGACY.runKey, LEGACY.runValue)).toBe(
      'old command',
    );
    expect(existsSync(t.data)).toBe(false);
  });

  it.each(['runtime-parent', 'data', 'old-config'] as const)(
    'refuses a redirected %s path before any registry or process mutation',
    async (kind) => {
      const t = setup();
      const outside = join(t.root, 'unrelated');
      mkdirSync(outside, { recursive: true });
      put(join(outside, 'sentinel.txt'), 'keep');
      if (kind === 'runtime-parent') {
        const parent = dirname(t.runtime);
        mkdirSync(dirname(parent), { recursive: true });
        symlinkSync(outside, parent, 'junction');
        put(join(t.runtime, 'agent-ops.exe'), 'unrelated executable');
      } else if (kind === 'data') {
        mkdirSync(dirname(t.data), { recursive: true });
        symlinkSync(outside, t.data, 'junction');
      } else {
        const oldData = join(t.local, LEGACY.dataFolder);
        mkdirSync(dirname(oldData), { recursive: true });
        symlinkSync(outside, oldData, 'junction');
        put(join(outside, 'config.json'), '{"private":true}');
      }
      await t.registry.setString(LEGACY.runKey, LEGACY.runValue, 'old command');
      const result = await runLegacyMove(t.options);
      expect(result.completed).toBe(false);
      expect(result.steps).toContainEqual(
        expect.objectContaining({ step: 'scope', outcome: 'failed' }),
      );
      expect(t.stopped).toEqual([]);
      expect(await t.registry.getString(LEGACY.runKey, LEGACY.runValue)).toBe(
        'old command',
      );
      expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('keep');
      expect(existsSync(join(outside, 'legacy-move'))).toBe(false);
    },
  );
});

describe('reg.exe output', () => {
  it('reads string values and the default value', () => {
    const output = [
      '',
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '    Agent Ops    REG_SZ    "C:\\Users\\me\\AppData\\Local\\Programs\\AgentOps\\agent-ops.exe" --background',
      '    Other    REG_EXPAND_SZ    %LOCALAPPDATA%\\x.exe',
      '    (Default)    REG_SZ',
      '    Number    REG_DWORD    0x1',
      '',
    ].join('\r\n');
    expect(parseRegQuery(output, 'Agent Ops')).toBe(
      '"C:\\Users\\me\\AppData\\Local\\Programs\\AgentOps\\agent-ops.exe" --background',
    );
    expect(parseRegQuery(output, 'other')).toBe('%LOCALAPPDATA%\\x.exe');
    expect(parseRegQuery(output, '')).toBe('');
    expect(parseRegQuery(output, 'Number')).toBeNull();
    expect(parseRegQuery(output, 'Missing')).toBeNull();
  });
});
