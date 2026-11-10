import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectOverview, type CollectConfig, type Project } from './collect';
import { MAX_PLAN_BYTES, readPlanFile, slash } from './io';
import type { Overview } from './overview';

export const fixtureRoot = fileURLToPath(
  new URL('../../../../tests/fixtures/plans/', import.meta.url),
);
export interface Fixture {
  name: string;
  tasksDir: string;
  projects: Project[] | null;
  dirs: string[] | null;
  unreadable: string[] | null;
  grown: string[] | null;
  oversized: string[] | null;
  /** File times in Unix seconds by relative path; every other file is stamped 0. */
  mtimes?: Record<string, number> | null;
  /** Junctions created in the temporary copy (they cannot be committed). */
  junctions?: { link: string; target: string }[] | null;
  /** Pass the Tasks folder and project paths in their 8.3 short form. */
  shortPaths?: boolean;
}

/** The 8.3 form of an existing folder, or the folder itself when the volume has no short names. */
export function shortPath(dir: string): string {
  if (process.platform !== 'win32') return dir;
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${dir.replace(/'/g, "''")}').ShortPath`,
      ],
      { encoding: 'utf8' },
    ).trim();
    return out === '' ? dir : out;
  } catch {
    return dir;
  }
}

/**
 * Whether this machine can reproduce a fixture: junctions and 8.3 names are
 * Windows features, and a volume may have short names turned off.
 */
export function fixtureSupported(fixture: Fixture): boolean {
  if (!fixture.junctions?.length && !fixture.shortPaths) return true;
  if (process.platform !== 'win32') return false;
  return !fixture.shortPaths || shortNamesAvailable();
}

let shortNames: boolean | undefined;
function shortNamesAvailable(): boolean {
  shortNames ??= (() => {
    const probe = join(tmpdir(), 'agent-ops plans short name probe');
    try {
      mkdirSync(probe, { recursive: true });
      return shortPath(probe).toLowerCase() !== probe.toLowerCase();
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  })();
  return shortNames;
}
export const fixtures = JSON.parse(
  await readFile(join(fixtureRoot, 'manifest.json'), 'utf8'),
) as Fixture[];

export async function withTemp<T>(
  run: (root: string) => Promise<T>,
): Promise<T> {
  // The long, real name: the collector reports long names, and tests compare with this root.
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'agent-ops-plans-ts-')),
  );
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
export async function write(
  root: string,
  file: string,
  text: string | Uint8Array,
): Promise<string> {
  const target = join(root, file);
  await mkdir(resolve(target, '..'), { recursive: true });
  await writeFile(target, text);
  return target;
}
export async function prepareFixture(
  root: string,
  fixture: Fixture,
): Promise<CollectConfig & { aliases: [string, string][] }> {
  await cp(join(fixtureRoot, 'corpus', fixture.name), root, {
    recursive: true,
  });
  for (const dir of fixture.dirs ?? [])
    await mkdir(join(root, dir), { recursive: true });
  for (const name of fixture.oversized ?? []) {
    await write(root, name, '');
    await truncate(join(root, name), MAX_PLAN_BYTES + 1);
  }
  const stamp = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await stamp(path);
      else await utimes(path, new Date(0), new Date(0));
    }
  };
  await stamp(root);
  for (const [name, seconds] of Object.entries(fixture.mtimes ?? {})) {
    const time = new Date(seconds * 1000);
    await utimes(join(root, name), time, time);
  }
  for (const j of fixture.junctions ?? [])
    await symlink(join(root, j.target), join(root, j.link), 'junction');
  // With shortPaths the collector receives 8.3 names; aliases map them back.
  const aliases: [string, string][] = [];
  const configured = (rel: string): string => {
    const long = join(root, rel);
    if (!fixture.shortPaths) return long;
    const short = shortPath(long);
    aliases.push([short, long]);
    return short;
  };
  return {
    tasksDir: fixture.tasksDir ? configured(fixture.tasksDir) : '',
    projects: (fixture.projects ?? []).map((p) => ({
      ...p,
      path: configured(p.path),
    })),
    aliases,
  };
}
export async function collectFixture(
  root: string,
  fixture: Fixture,
): Promise<Overview> {
  const { aliases, ...config } = await prepareFixture(root, fixture);
  const out = await collectOverview(config, {
    git: async (_root, args) =>
      args[0] === 'remote' ? 'git@github.com:owner/sample.git\n' : '',
    readFile: async (file, signal) => {
      if (fixture.unreadable?.includes(basename(file)))
        throw new Error('sharing violation');
      if (fixture.grown?.includes(basename(file)))
        return Buffer.alloc(MAX_PLAN_BYTES + 1);
      return readPlanFile(file, signal);
    },
  });
  if (aliases.length === 0) return out;
  // Configured short paths are echoed in projects[].path and name fallbacks.
  return JSON.parse(
    JSON.stringify(out, (_key, v: unknown) =>
      typeof v === 'string'
        ? aliases.reduce(
            (text, [short, long]) =>
              text
                .replaceAll(short, long)
                .replaceAll(slash(short), slash(long)),
            v,
          )
        : v,
    ),
  ) as Overview;
}
export function normalized(out: Overview, root: string): unknown {
  const copy = structuredClone(out);
  copy.generatedAt = '<TIME>';
  for (const plan of copy.plans) plan.mtime = '<TIME>';
  return JSON.parse(
    JSON.stringify(copy, (_key, v: unknown) =>
      typeof v === 'string'
        ? v.replaceAll(root, '<ROOT>').replaceAll(slash(root), '<ROOT>')
        : v,
    ),
  ) as unknown;
}
