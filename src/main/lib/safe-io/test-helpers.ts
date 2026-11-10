// Test helpers shared by the settings, workspaces, tasks and activity tests.
// Everything lives in a fresh folder under the OS temp folder; no test touches
// the real data folder, the registry, the Recycle Bin or real plan folders.

import { spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';

const made: string[] = [];

afterEach(() => {
  while (made.length > 0)
    rmSync(made.pop()!, { recursive: true, force: true, maxRetries: 5 });
});

/** tempDir returns a new folder, removed after the test. Its real path is returned (no 8.3 short names). */
export function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-ops-test-'));
  made.push(dir);
  return dir;
}

export function put(file: string, text: string | Buffer): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

export function read(file: string): string {
  return readFileSync(file, 'utf8');
}

export function has(file: string): boolean {
  return existsSync(file);
}

/** mkRepo makes a repository folder with .git and the given plans in .tasks. */
export function mkRepo(dir: string, ...plans: string[]): string {
  mkdirSync(path.join(dir, '.git'), { recursive: true });
  for (const p of plans)
    put(
      path.join(dir, '.tasks', `${p}.md`),
      'Agent: Codex\nStatus: Planning\n',
    );
  return dir;
}

/** junction links link to target as a directory junction (no admin rights needed); false when unsupported. */
export function junction(link: string, target: string): boolean {
  try {
    symlinkSync(target, link, 'junction');
    return true;
  } catch {
    return false;
  }
}

export const onWindows = process.platform === 'win32';

/**
 * holdExclusively opens file with no sharing in another process, like an
 * editor saving or an antivirus scan, and releases it after ms. It resolves
 * once the file is held; the returned promise settles when it is released.
 */
export function holdExclusively(
  file: string,
  ms: number,
): Promise<{ released: Promise<void> }> {
  const script = `$f=[System.IO.File]::Open('${file.replace(/'/g, "''")}','Open','ReadWrite','None'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${ms}; $f.Close()`;
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const released = new Promise<void>((resolve) =>
    child.on('exit', () => resolve()),
  );
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString();
      if (out.includes('held')) resolve({ released });
    });
    child.on('exit', (code) =>
      reject(new Error(`holder exited early (${code}): ${out}`)),
    );
  });
}

/**
 * shortPath returns the 8.3 short name of an existing folder or file (as on CI,
 * where TEMP is C:\Users\RUNNER~1\...), or the path unchanged when the volume
 * has no short names or this is not Windows.
 */
export function shortPath(file: string): string {
  if (process.platform !== 'win32') return file;
  const out = spawnSync(
    'cmd.exe',
    ['/d', '/c', `for %I in ("${file}") do @echo %~sI`],
    { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true },
  );
  const short = out.stdout.trim();
  return out.status === 0 && short && existsSync(short) ? short : file;
}
