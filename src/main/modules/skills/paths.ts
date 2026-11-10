// Path identity and validation: cleaning pasted paths, comparing folders also
// through links and junctions, and finding a workspace that contains a path.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { SkillsPlatform } from './platform.js';
import type { WorkspaceRef } from './types.js';

/** A normalised path without a trailing separator, except a root such as C:\. */
export function cleanPath(p: string): string {
  const normal = path.normalize(p);
  const root = path.parse(normal).root;
  if (normal === root) {
    return normal;
  }
  return normal.replace(/[\\/]+$/, '');
}

/**
 * An absolute path on a local drive. Network shares (\\server\share) and device
 * paths (\\.\, \\?\) are refused: a device path is not a folder, and an offline
 * share would stall every read.
 */
export function isLocalAbsolute(p: string): boolean {
  if (p.startsWith('\\\\') || p.startsWith('//') || p.includes('\0')) {
    return false;
  }
  if (path.sep === '\\') {
    return /^[A-Za-z]:[\\/]/.test(p);
  }
  return path.isAbsolute(p);
}

/** A pasted or picked path: trimmed, without surrounding quotes, absolute and local; null otherwise. */
export function cleanInputPath(raw: string): string | null {
  let p = raw.trim();
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1).trim();
  }
  if (p === '' || !isLocalAbsolute(p)) {
    return null;
  }
  return cleanPath(p);
}

export async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Path comparisons and resolution that depend on the platform. */
export class PathTools {
  constructor(private readonly platform: SkillsPlatform) {}

  key(p: string): string {
    const clean = cleanPath(p);
    return this.platform.caseInsensitive ? clean.toLowerCase() : clean;
  }

  /** The same path by text (cleaned, case-insensitive on Windows). */
  samePath(a: string | undefined, b: string | undefined): boolean {
    return !!a && !!b && this.key(a) === this.key(b);
  }

  /** child is strictly below parent (both already keys). */
  static within(childKey: string, parentKey: string): boolean {
    if (childKey === parentKey) {
      return false;
    }
    const prefix = /[\\/]$/.test(parentKey) ? parentKey : parentKey + path.sep;
    return childKey.startsWith(prefix);
  }

  /** The deepest existing part of p and the rest below it; base is '' when nothing exists. */
  async existingAncestor(p: string): Promise<{ base: string; rest: string }> {
    let current = cleanPath(p);
    let rest = '';
    for (;;) {
      try {
        await fs.stat(current); // a broken link counts as missing
        return { base: current, rest };
      } catch {
        // look further up
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return { base: '', rest: '' };
      }
      rest =
        rest === ''
          ? path.basename(current)
          : path.join(path.basename(current), rest);
      current = parent;
    }
  }

  /** p with links and junctions in its existing part resolved; the missing part kept as written. */
  async realPath(p: string): Promise<string> {
    const { base, rest } = await this.existingAncestor(p);
    if (base === '') {
      return cleanPath(p);
    }
    try {
      const resolved = await this.platform.finalPath(base);
      return rest === '' ? cleanPath(resolved) : path.join(resolved, rest);
    } catch {
      return cleanPath(p);
    }
  }

  /** Whether two paths name the same folder or file, also through links and junctions. */
  async samePlace(
    a: string | undefined,
    b: string | undefined,
  ): Promise<boolean> {
    if (!a || !b) {
      return false;
    }
    if (this.samePath(a, b)) {
      return true;
    }
    const [pa, pb] = await Promise.all([
      this.existingAncestor(a),
      this.existingAncestor(b),
    ]);
    if (
      pa.base === '' ||
      pb.base === '' ||
      pa.rest.toLowerCase() !== pb.rest.toLowerCase()
    ) {
      return false;
    }
    return this.platform.sameFile(pa.base, pb.base);
  }

  /** The workspace that contains p (or is p), also through links. */
  async insideWorkspace(
    p: string,
    workspaces: readonly WorkspaceRef[],
  ): Promise<WorkspaceRef | null> {
    const key = this.key(await this.realPath(p));
    for (const w of workspaces) {
      if (!w.path) {
        continue;
      }
      const root = this.key(await this.realPath(w.path));
      if (key === root || PathTools.within(key, root)) {
        return w;
      }
      for (let dir = cleanPath(p); ; dir = path.dirname(dir)) {
        if (await this.samePlace(dir, w.path)) {
          return w;
        }
        if (path.dirname(dir) === dir) {
          break;
        }
      }
    }
    return null;
  }

  /**
   * A workspace that holds a skills folder or its task-plan subfolder, where the
   * skill is written, also when either is a link or junction into a workspace.
   */
  async skillFolderInWorkspace(
    dir: string,
    workspaces: readonly WorkspaceRef[],
  ): Promise<WorkspaceRef | null> {
    for (const p of [dir, path.join(dir, 'task-plan')]) {
      for (const candidate of [p, await this.realPath(p)]) {
        const found = await this.insideWorkspace(candidate, workspaces);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }
}
