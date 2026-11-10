// Path rules shared by settings, workspaces, the Tasks folder and plan actions.
// They follow the Go baseline: folders compare case-insensitively, without a
// trailing separator, and links and junctions are resolved before a
// containment check.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const isWindows = process.platform === 'win32';

/** cleanPath is path.normalize without a trailing separator, except at a root such as C:\. */
export function cleanPath(p: string): string {
  let clean = path.normalize(p);
  const root = path.parse(clean).root;
  while (clean.length > root.length && /[\\/]$/.test(clean))
    clean = clean.slice(0, -1);
  return clean;
}

/** isAbsolutePath accepts C:\x and \\server\share on Windows; \x and C:x are not absolute there. */
export function isAbsolutePath(p: string): boolean {
  if (!isWindows) return path.isAbsolute(p);
  return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
}

/** isNetworkOrDevicePath reports \\server\share, \\?\ and \\.\ paths, which are refused as folders. */
export function isNetworkOrDevicePath(p: string): boolean {
  return p.startsWith('\\\\') || p.startsWith('//');
}

/** isDriveRoot reports a whole drive such as D:\. */
export function isDriveRoot(p: string): boolean {
  const clean = cleanPath(p);
  return clean.length === 3 && clean[1] === ':';
}

/** pathKey compares folders case-insensitively, without I/O. */
export function pathKey(p: string): string {
  return cleanPath(p).toLowerCase();
}

/** samePath reports two non-empty paths naming the same folder by text. */
export function samePath(a: string, b: string): boolean {
  return a !== '' && b !== '' && pathKey(a) === pathKey(b);
}

/** pathWithin reports whether child lies strictly inside parent. Both must already be keys. */
export function pathWithin(child: string, parent: string): boolean {
  if (child === parent) return false;
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(prefix);
}

/** overlaps reports two keys where one is, or contains, the other. */
export function overlaps(a: string, b: string): boolean {
  return a === b || pathWithin(a, b) || pathWithin(b, a);
}

/**
 * cleanInputPath accepts a pasted or picked path: trimmed, without surrounding
 * quotes, absolute and local. Network and device paths are refused: a device
 * path is not a folder, and an offline share would stall every read.
 */
export function cleanInputPath(raw: string): string | undefined {
  let p = raw.trim();
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"'))
    p = p.slice(1, -1).trim();
  if (
    p === '' ||
    p.includes('\0') ||
    isNetworkOrDevicePath(p) ||
    !isAbsolutePath(p)
  )
    return undefined;
  return cleanPath(p);
}

/** existingAncestor splits a path into its longest existing part and the rest. */
export async function existingAncestor(p: string): Promise<[string, string]> {
  let current = cleanPath(p);
  let rest = '';
  for (;;) {
    try {
      await fs.lstat(current);
      return [current, rest];
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return ['', ''];
      rest =
        rest === ''
          ? path.basename(current)
          : path.join(path.basename(current), rest);
      current = parent;
    }
  }
}

/**
 * realPath resolves every link, junction and short (8.3) name in the existing
 * part of a path; the part that does not exist yet is kept as written.
 * fs.promises.realpath uses the native resolver (GetFinalPathNameByHandle on
 * Windows), which follows junctions as well as symbolic links.
 */
export async function realPath(p: string): Promise<string> {
  const [base, rest] = await existingAncestor(p);
  if (base === '') return cleanPath(p);
  try {
    const resolved = await fs.realpath(base);
    return rest === '' ? cleanPath(resolved) : path.join(resolved, rest);
  } catch {
    return cleanPath(p);
  }
}

/** realKey is the case-insensitive key of realPath. */
export async function realKey(p: string): Promise<string> {
  return pathKey(await realPath(p));
}

/** withinReal reports whether file lies inside dir, also through links and junctions. */
export async function withinReal(file: string, dir: string): Promise<boolean> {
  return pathWithin(await realKey(file), await realKey(dir));
}

/** exists is a stat that never throws. */
export async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** isDirectory is a stat (following links) that never throws. */
export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** errorCode is a short reason without the path, which reports already show. */
export function errorText(err: unknown): string {
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string'
  ) {
    return (err as { code: string }).code;
  }
  return err instanceof Error ? err.message : String(err);
}
