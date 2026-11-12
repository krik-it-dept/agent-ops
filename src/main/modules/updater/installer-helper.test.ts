// build/installer-helper.ps1, the fixed script the NSIS installer, the
// uninstaller and the app use for process stopping, path checks and the
// recoverable bootstrap from a Go install. Runs the real script against
// temporary folders and throwaway processes (copies of node.exe named
// agent-ops.exe); never the installer, the registry or a real installation.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const helper = resolve('build/installer-helper.ps1');
const powershell = join(
  process.env['SystemRoot'] ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
    } catch {
      // A just-stopped copy can stay locked briefly (antivirus); temp leftovers are harmless.
    }
  }
});

function run(...args: string[]): { code: number; out: string } {
  const r = spawnSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      helper,
      ...args,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 120_000 },
  );
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

function temp(name = ''): string {
  const root = mkdtempSync(join(tmpdir(), `ao-helper-${name}`));
  roots.push(root);
  return root;
}

/** A throwaway process whose image is a copy of node.exe at exe. */
async function startCopy(exe: string): Promise<ChildProcess> {
  mkdirSync(join(exe, '..'), { recursive: true });
  if (!existsSync(exe)) copyFileSync(process.execPath, exe);
  const child = spawn(exe, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  children.push(child);
  await new Promise<void>((ok, fail) => {
    child.once('spawn', ok);
    child.once('error', fail);
  });
  return child;
}

function alive(child: ChildProcess): boolean {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  try {
    process.kill(child.pid!, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitExit(child: ChildProcess): Promise<void> {
  for (let i = 0; i < 50 && alive(child); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

function junction(link: string, target: string): void {
  mkdirSync(join(link, '..'), { recursive: true });
  symlinkSync(target, link, 'junction');
}

function goInstall(dir: string): void {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'agent-ops.exe'), 'go exe');
  writeFileSync(join(dir, 'NOTICE.md'), 'notice');
  writeFileSync(join(dir, 'scripts', 'install.ps1'), 'script');
}

function newInstall(dir: string, complete = true): void {
  mkdirSync(join(dir, 'resources'), { recursive: true });
  writeFileSync(join(dir, 'agent-ops.exe'), 'electron exe');
  if (complete) writeFileSync(join(dir, 'resources', 'app.asar'), 'asar');
}

function journalState(file: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

describe.skipIf(process.platform !== 'win32')('installer helper', () => {
  it(
    'stops only the exact executable, also in paths with quotes, spaces and non-ASCII letters',
    { timeout: 120_000 },
    async () => {
      const root = temp("O'Brien x ");
      const base = join(root, "Programs 'n' Ünïcode");
      const target = join(base, 'AgentOps', 'agent-ops.exe');
      const sibling = join(base, 'AgentOps-other', 'agent-ops.exe');
      const nested = join(base, 'AgentOps', 'other-copy', 'agent-ops.exe');
      const owned = await startCopy(target);
      const second = await startCopy(target);
      const siblingProcess = await startCopy(sibling);
      const nestedProcess = await startCopy(nested);

      const result = run('stop', '-Executable', target.toUpperCase());
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain('stopped=2');
      await waitExit(owned);
      await waitExit(second);
      expect(alive(owned)).toBe(false);
      expect(alive(second)).toBe(false);
      expect(alive(siblingProcess), 'a sibling folder copy was stopped').toBe(
        true,
      );
      expect(alive(nestedProcess), 'a nested copy was stopped').toBe(true);

      // Nothing running, a missing file, invalid input.
      expect(run('stop', '-Executable', target).out).toContain('stopped=0');
      expect(
        run('stop', '-Executable', join(root, 'missing', 'agent-ops.exe')).code,
      ).toBe(0);
      expect(
        run('stop', '-Executable', '\\\\server\\share\\agent-ops.exe').code,
      ).toBe(3);
      expect(run('stop', '-Executable', 'relative\\agent-ops.exe').code).toBe(
        3,
      );
      expect(run('stop').code).toBe(3);
    },
  );

  it(
    'matches by file identity: a short (8.3) or differently cased path names the same file',
    { timeout: 120_000 },
    async () => {
      const root = temp('short');
      const target = join(root, 'Long Folder Name', 'agent-ops.exe');
      const child = await startCopy(target);
      const short = spawnSync(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(New-Object -ComObject Scripting.FileSystemObject).GetFile($env:AO_TARGET).ShortPath',
        ],
        {
          encoding: 'utf8',
          windowsHide: true,
          env: { ...process.env, AO_TARGET: target },
        },
      ).stdout.trim();
      const result = run('stop', '-Executable', short || target);
      expect(result.code, result.out).toBe(0);
      await waitExit(child);
      expect(alive(child)).toBe(false);
    },
  );

  it(
    'stops a parent process before its child processes so the parent never records child-process-gone',
    { timeout: 120_000 },
    async () => {
      const root = temp('tree');
      const target = join(root, 'AgentOps', 'agent-ops.exe');
      const readyFile = join(root, 'ready.json');
      const crashFile = join(root, 'crash.json');
      mkdirSync(join(target, '..'), { recursive: true });
      copyFileSync(process.execPath, target);

      const parentScript = `
        const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        const kids = [];
        let ready = 0;
        for (let i = 0; i < 6; i++) {
          const k = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            stdio: 'ignore',
            windowsHide: true,
          });
          k.on('exit', () => {
            writeFileSync(process.env.AO_CRASH, JSON.stringify({ childPid: k.pid }));
          });
          k.once('spawn', () => {
            ready++;
            if (ready === 6) {
              writeFileSync(
                process.env.AO_READY,
                JSON.stringify({ mainPid: process.pid, childPids: kids.map((c) => c.pid) }),
              );
            }
          });
          kids.push(k);
        }
        setInterval(() => {}, 1000);
      `;
      const main = spawn(target, ['-e', parentScript], {
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, AO_READY: readyFile, AO_CRASH: crashFile },
      });
      children.push(main);

      for (let i = 0; i < 100 && !existsSync(readyFile); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const { mainPid, childPids } = JSON.parse(
        readFileSync(readyFile, 'utf8'),
      ) as { mainPid: number; childPids: number[] };

      try {
        const result = run('stop', '-Executable', target);
        expect(result.code, result.out).toBe(0);
        expect(
          existsSync(crashFile),
          `parent recorded child exit before parent stopped:\n${result.out}`,
        ).toBe(false);
        const stoppedPids = [...result.out.matchAll(/^stopped (\d+) /gm)].map(
          (m) => Number(m[1]),
        );
        expect(stoppedPids[0]).toBe(mainPid);
        expect(new Set(stoppedPids)).toEqual(new Set([mainPid, ...childPids]));
      } finally {
        for (const pid of [mainPid, ...childPids]) {
          try {
            process.kill(pid);
          } catch {
            // already exited
          }
        }
      }
    },
  );

  it(
    'checks the install folder and refuses links in any existing part of a path',
    { timeout: 120_000 },
    () => {
      const root = temp('paths');
      const expected = join(root, 'Programs', 'AgentOps');
      mkdirSync(expected, { recursive: true });
      expect(
        run(
          'check-paths',
          '-Expected',
          expected,
          '-Actual',
          `${expected.toUpperCase()}\\`,
        ).code,
      ).toBe(0);
      expect(
        run(
          'check-paths',
          '-Expected',
          expected,
          '-Actual',
          join(root, 'Documents', 'workspace'),
        ).code,
      ).toBe(4);
      expect(
        run(
          'check-paths',
          '-Expected',
          expected,
          '-Actual',
          join(root, 'Programs', 'AgentOps-other'),
        ).code,
      ).toBe(4);

      const elsewhere = join(root, 'elsewhere');
      mkdirSync(elsewhere);
      junction(join(root, 'data', 'logs'), elsewhere);
      const linked = run(
        'check-paths',
        '-Plain',
        `${join(root, 'data')}|${join(root, 'data', 'logs', 'installer.log')}`,
      );
      expect(linked.code).toBe(5);
      // The helper reports the long path (.NET expands 8.3 names such as RUNNER~1).
      expect(linked.out.toLowerCase()).toContain(
        join(realpathSync.native(join(root, 'data')), 'logs').toLowerCase(),
      );
      expect(
        run('check-paths', '-Plain', join(root, 'data', 'not-yet', 'file'))
          .code,
      ).toBe(0);
      // A junction installed as the install folder itself.
      junction(join(root, 'P2', 'AgentOps'), elsewhere);
      expect(
        run(
          'check-paths',
          '-Expected',
          join(root, 'P2', 'AgentOps'),
          '-Actual',
          join(root, 'P2', 'AgentOps'),
        ).code,
      ).toBe(5);
      expect(run('check-paths', '-Plain', '\\\\?\\C:\\x').code).toBe(3);
    },
  );

  describe('bootstrap from a Go install', () => {
    function layout() {
      const root = temp('boot');
      const source = join(root, 'Programs', 'AgentOps');
      const data = join(root, 'AgentOps');
      return {
        root,
        source,
        data,
        backups: join(data, 'backups'),
        journal: join(data, 'legacy-move', 'go-install-journal.txt'),
        receipt: join(data, 'legacy-move', 'installer-receipt.txt'),
      };
    }
    const prepare = (l: ReturnType<typeof layout>, stamp = '20261111-010203') =>
      run(
        'bootstrap-prepare',
        '-Source',
        l.source,
        '-BackupRoot',
        l.backups,
        '-Journal',
        l.journal,
        '-Stamp',
        stamp,
      );
    const recover = (l: ReturnType<typeof layout>) =>
      run(
        'bootstrap-recover',
        '-Source',
        l.source,
        '-Journal',
        l.journal,
        '-Receipt',
        l.receipt,
      );

    it(
      'journals before moving, stops the running Go app, moves it whole and commits after a complete install',
      { timeout: 120_000 },
      async () => {
        const l = layout();
        goInstall(l.source);
        rmSync(join(l.source, 'agent-ops.exe'));
        const running = await startCopy(join(l.source, 'agent-ops.exe'));
        const r = prepare(l);
        expect(r.code, r.out).toBe(0);
        expect(r.out.indexOf('prepared')).toBeLessThan(r.out.indexOf('moved'));
        await waitExit(running);
        expect(alive(running)).toBe(false);
        const backup = join(l.backups, 'go-install-20261111-010203');
        expect(journalState(l.journal)).toMatchObject({
          state: 'moved',
          source: l.source,
          backup,
        });
        expect(existsSync(l.source)).toBe(false);
        expect(readFileSync(join(backup, 'NOTICE.md'), 'utf8')).toBe('notice');

        newInstall(l.source);
        const c = run(
          'bootstrap-commit',
          '-Source',
          l.source,
          '-Journal',
          l.journal,
          '-Receipt',
          l.receipt,
        );
        expect(c.code, c.out).toBe(0);
        expect(journalState(l.journal).state).toBe('committed');
        expect(readFileSync(l.receipt, 'utf8')).toBe(
          `goInstallBackup=${backup}\r\n`,
        );
        // A later installer run finds nothing to do, and no Go install to move.
        expect(recover(l).out).toContain('none');
        expect(prepare(l, '2').out).toContain('none');
      },
    );

    it(
      'restores the Go install when extraction failed, keeping the partial new files aside; safe to run twice',
      { timeout: 120_000 },
      () => {
        const l = layout();
        goInstall(l.source);
        expect(prepare(l).code).toBe(0);
        newInstall(l.source, false); // extraction stopped half-way
        const r = recover(l);
        expect(r.code, r.out).toBe(0);
        expect(readFileSync(join(l.source, 'agent-ops.exe'), 'utf8')).toBe(
          'go exe',
        );
        expect(
          readFileSync(join(l.source, 'scripts', 'install.ps1'), 'utf8'),
        ).toBe('script');
        const aside = join(
          l.backups,
          'go-install-20261111-010203-incomplete-new',
        );
        expect(readFileSync(join(aside, 'agent-ops.exe'), 'utf8')).toBe(
          'electron exe',
        );
        expect(journalState(l.journal).state).toBe('restored');
        expect(existsSync(l.receipt)).toBe(false);
        expect(recover(l).out).toContain('none');
        // The next installer run starts a fresh transaction.
        expect(prepare(l, '20261111-020000').code).toBe(0);
        expect(journalState(l.journal)).toMatchObject({
          state: 'moved',
          backup: join(l.backups, 'go-install-20261111-020000'),
        });
      },
    );

    it(
      'restores when the installer quit right after the move, before anything was extracted',
      { timeout: 120_000 },
      () => {
        const l = layout();
        goInstall(l.source);
        expect(prepare(l).code).toBe(0);
        const r = run(
          'bootstrap-restore',
          '-Source',
          l.source,
          '-Journal',
          l.journal,
        );
        expect(r.code, r.out).toBe(0);
        expect(readFileSync(join(l.source, 'agent-ops.exe'), 'utf8')).toBe(
          'go exe',
        );
        expect(readdirSync(l.backups)).toEqual([]);
      },
    );

    it(
      'recovers from what is on disk when the journal write after the move was interrupted',
      { timeout: 120_000 },
      () => {
        const l = layout();
        goInstall(l.source);
        expect(prepare(l).code).toBe(0);
        const stale = journalState(l.journal);
        writeFileSync(
          l.journal,
          `backup=${stale['backup']}\r\nsource=${l.source}\r\nstate=prepared\r\n`,
        );
        writeFileSync(`${l.journal}.tmp`, 'half-written');
        const r = recover(l);
        expect(r.code, r.out).toBe(0);
        expect(readFileSync(join(l.source, 'agent-ops.exe'), 'utf8')).toBe(
          'go exe',
        );
        expect(journalState(l.journal).state).toBe('restored');

        // Interrupted before the move: the Go install is still in place.
        writeFileSync(
          l.journal,
          `backup=${join(l.backups, 'never')}\r\nsource=${l.source}\r\nstate=prepared\r\n`,
        );
        const again = recover(l);
        expect(again.code, again.out).toBe(0);
        expect(again.out).toContain('not moved');
        expect(readFileSync(join(l.source, 'agent-ops.exe'), 'utf8')).toBe(
          'go exe',
        );
      },
    );

    it(
      'commits when the installer finished the files but stopped before its commit',
      { timeout: 120_000 },
      () => {
        const l = layout();
        goInstall(l.source);
        expect(prepare(l).code).toBe(0);
        newInstall(l.source);
        const r = recover(l);
        expect(r.code, r.out).toBe(0);
        expect(journalState(l.journal).state).toBe('committed');
        expect(readFileSync(join(l.source, 'agent-ops.exe'), 'utf8')).toBe(
          'electron exe',
        );
      },
    );

    it(
      'changes nothing when the backup folder is a link or the journal cannot be written',
      { timeout: 120_000 },
      () => {
        const l = layout();
        goInstall(l.source);
        const elsewhere = join(l.root, 'elsewhere');
        mkdirSync(elsewhere);
        junction(l.data, elsewhere);
        const r = prepare(l);
        expect(r.code).toBe(5);
        expect(readFileSync(join(l.source, 'agent-ops.exe'), 'utf8')).toBe(
          'go exe',
        );
        expect(readdirSync(elsewhere)).toEqual([]);

        const m = layout();
        goInstall(m.source);
        mkdirSync(m.journal, { recursive: true }); // a folder where the journal file must go
        const blocked = prepare(m);
        expect(blocked.code).toBe(6);
        expect(readFileSync(join(m.source, 'agent-ops.exe'), 'utf8')).toBe(
          'go exe',
        );
      },
    );

    it(
      'leaves an Electron install and an empty machine alone',
      { timeout: 120_000 },
      () => {
        const l = layout();
        newInstall(l.source);
        expect(prepare(l).out).toContain('none');
        expect(existsSync(l.journal)).toBe(false);
        const empty = layout();
        expect(prepare(empty).out).toContain('none');
        expect(recover(empty).out).toContain('none');
      },
    );
  });
});
