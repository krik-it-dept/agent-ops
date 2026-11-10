import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cleanInputPath,
  cleanPath,
  isAbsolutePath,
  isDriveRoot,
  overlaps,
  pathKey,
  pathWithin,
  realKey,
  realPath,
  samePath,
  withinReal,
} from './paths';
import { junction, onWindows, tempDir } from './test-helpers';

describe.skipIf(!onWindows)('Windows path rules', () => {
  it('cleans trailing separators except at a drive root', () => {
    expect(cleanPath('C:\\Work\\')).toBe('C:\\Work');
    expect(cleanPath('C:\\Work\\.\\a\\..')).toBe('C:\\Work');
    expect(cleanPath('C:\\')).toBe('C:\\');
    expect(cleanPath('C:/Work//repo/')).toBe('C:\\Work\\repo');
  });

  it('accepts only drive-absolute and UNC paths as absolute', () => {
    expect(isAbsolutePath('C:\\x')).toBe(true);
    expect(isAbsolutePath('C:/x')).toBe(true);
    expect(isAbsolutePath('\\\\server\\share')).toBe(true);
    expect(isAbsolutePath('\\x')).toBe(false);
    expect(isAbsolutePath('C:x')).toBe(false);
    expect(isAbsolutePath('relative')).toBe(false);
  });

  it('refuses network, device, relative and quoted-empty input', () => {
    expect(cleanInputPath('  "C:\\Tasks\\"  ')).toBe('C:\\Tasks');
    for (const bad of [
      '',
      '""',
      'tasks',
      '\\\\server\\share\\tasks',
      '//server/share',
      '\\\\?\\C:\\tasks',
      '\\\\.\\C:\\x',
      'C:\\a\0b',
    ]) {
      expect(cleanInputPath(bad)).toBeUndefined();
    }
  });

  it('compares case-insensitively and ignores a trailing slash', () => {
    expect(samePath('C:\\Work\\Repo\\', 'c:\\work\\repo')).toBe(true);
    expect(samePath('', '')).toBe(false);
    expect(pathKey('D:\\Dự Án\\')).toBe('d:\\dự án');
    expect(isDriveRoot('D:\\')).toBe(true);
    expect(isDriveRoot('D:\\x')).toBe(false);
  });

  it('a sibling sharing a prefix is not nested', () => {
    expect(pathWithin('c:\\ab', 'c:\\a')).toBe(false);
    expect(pathWithin('c:\\a\\b', 'c:\\a')).toBe(true);
    expect(pathWithin('c:\\a', 'c:\\a')).toBe(false);
    expect(pathWithin('c:\\a\\b', 'c:\\')).toBe(true);
    expect(overlaps('c:\\a', 'c:\\a')).toBe(true);
  });

  it('realPath follows junctions and keeps the missing part as written', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'target');
    mkdirSync(target);
    const link = path.join(dir, 'link');
    if (!junction(link, target)) return;
    expect(await realKey(path.join(link, 'not', 'yet'))).toBe(
      pathKey(path.join(await realPath(target), 'not', 'yet')),
    );
    expect(await withinReal(path.join(link, 'plan.md'), target)).toBe(true);
    expect(
      await withinReal(path.join(link, 'plan.md'), path.join(dir, 'other')),
    ).toBe(false);
  });

  it('realPath expands short 8.3 names', async () => {
    const dir = tempDir();
    const long = path.join(dir, 'A very long folder name');
    mkdirSync(long);
    let short: string;
    try {
      short = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${long.replace(/'/g, "''")}').ShortPath`,
        ],
        { encoding: 'utf8' },
      ).trim();
    } catch {
      return;
    }
    if (short === '' || short.toLowerCase() === long.toLowerCase()) return; // 8.3 names disabled on this volume
    expect(await realKey(short)).toBe(await realKey(long));
  });
});
