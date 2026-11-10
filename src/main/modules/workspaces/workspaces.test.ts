import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  junction,
  mkRepo,
  onWindows,
  put,
  tempDir,
} from '../../lib/safe-io/test-helpers';
import { SettingsStore, readConfig } from '../settings/config-store';
import type { Project } from '../settings/config';
import { projectIdFor } from '../settings/identity';
import { projectRepos } from './discover';
import {
  WorkspaceService,
  inspectNewWorkspace,
  validProjectName,
} from './workspaces';

const now = new Date(Date.UTC(2026, 10, 10, 9, 30, 0));

async function inspectError(
  raw: string,
  existing: Project[],
  tasksDir = '',
): Promise<string> {
  try {
    await inspectNewWorkspace(raw, existing, tasksDir, now);
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

async function service() {
  const dir = tempDir();
  const store = new SettingsStore({
    dataDir: path.join(dir, 'data'),
    now: () => now,
  });
  await store.load();
  let changes = 0;
  const ws = new WorkspaceService(store, {
    now: () => now,
    changed: () => changes++,
  });
  return { dir, store, ws, changes: () => changes };
}

describe('inspectNewWorkspace', () => {
  it('detects a folder of repositories and a single repository with plan counts', async () => {
    const dir = tempDir();
    const parent = path.join(dir, 'work');
    const repoA = mkRepo(path.join(parent, 'alpha'), 'one', 'two');
    mkRepo(path.join(parent, 'beta'));
    mkdirSync(path.join(parent, 'notes'), { recursive: true });
    put(path.join(repoA, '.tasks', 'tong-hop.md'), 'generated index');
    const folder = await inspectNewWorkspace(`"${parent}"`, [], '', now);
    expect(folder.project).toMatchObject({
      kind: 'folder',
      name: 'work',
      id: projectIdFor(parent),
      enabled: true,
      addedAt: now.toISOString(),
    });
    expect(folder.repos.map((r) => [r.name, r.planCount, r.hasTasks])).toEqual([
      ['alpha', 2, true],
      ['beta', 0, false],
    ]);
    const single = await inspectNewWorkspace(repoA, [], '', now);
    expect(single.project.kind).toBe('repo');
    expect(single.repos).toHaveLength(1);
    expect(single.repos[0]?.planCount).toBe(2);
    // A folder with only .tasks is a repo.
    put(path.join(dir, 'plain', '.tasks', 'p.md'), 'x');
    expect(
      (await inspectNewWorkspace(path.join(dir, 'plain'), [], '', now)).project
        .kind,
    ).toBe('repo');
  });

  it('refuses with plain sentences', async () => {
    const dir = tempDir();
    const parent = path.join(dir, 'work');
    const repoA = mkRepo(path.join(parent, 'alpha'), 'one');
    mkdirSync(path.join(dir, 'empty', 'notes'), { recursive: true });
    const existing = [(await inspectNewWorkspace(parent, [], '', now)).project];
    const cases: [string, string][] = [
      ['relative', 'full folder path'],
      ['', 'full folder path'],
      [path.join(dir, 'nope'), 'does not exist'],
      [parent, 'already added'],
      [parent + '\\', 'already added'],
      [repoA, 'inside the workspace'],
      [dir, 'contains the workspace'],
      [path.join(dir, 'empty'), 'No workspace folders'],
      [path.join(repoA, '.git'), 'inside the workspace'],
    ];
    if (onWindows)
      cases.push(
        [parent.toUpperCase(), 'already added'],
        ['\\x', 'full folder path'],
        ['C:relative', 'full folder path'],
      );
    for (const [p, want] of cases)
      expect(await inspectError(p, existing), p).toContain(want);
    const file = put(path.join(dir, 'file.txt'), 'x');
    expect(await inspectError(file, [])).toContain('is a file');
    await expect(
      projectRepos({ path: path.join(dir, 'gone'), kind: 'folder' }),
    ).rejects.toThrow();
  });

  it('refuses a folder that contains the Tasks folder, but not one beside it', async () => {
    const dir = tempDir();
    const work = path.join(dir, 'work');
    mkRepo(path.join(work, 'web'), 'plan');
    expect(await inspectError(work, [], path.join(work, 'tasks'))).toContain(
      'contains the Tasks folder',
    );
    expect(await inspectError(work, [], path.join(dir, 'tasks'))).toBe('');
  });

  it.skipIf(!onWindows)('sees a workspace through a junction', async () => {
    const dir = tempDir();
    const real = mkRepo(path.join(dir, 'real'), 'plan');
    const link = path.join(dir, 'link');
    if (!junction(link, real)) return;
    const existing = [(await inspectNewWorkspace(real, [], '', now)).project];
    expect(await inspectError(link, existing)).toContain('already added');
    // A path to a new folder inside the linked workspace is inside it.
    mkRepo(path.join(real, 'sub'));
    expect(await inspectError(path.join(link, 'sub'), existing)).toContain(
      'inside the workspace',
    );
  });

  it.skipIf(!onWindows)('refuses a network share', async () => {
    expect(
      await inspectError('\\\\localhost\\c$\\nothing-here-agent-ops', []),
    ).not.toBe('');
  });
});

describe('WorkspaceService', () => {
  it('adds, edits, disables, renames and removes; ids are stable', async () => {
    const { dir, store, ws, changes } = await service();
    const repo = mkRepo(path.join(dir, 'repos', 'web'), 'plan');
    const added = await ws.add(path.join(dir, 'repos'));
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const id = added.value.project.id;
    expect(id).toBe(projectIdFor(path.join(dir, 'repos')));
    expect((await readConfig(store.file)).projects.map((p) => p.id)).toEqual([
      id,
    ]);
    expect(changes()).toBe(1);

    expect((await ws.add(repo)).ok).toBe(false);
    expect((await ws.setEnabled(id, false)).ok).toBe(true);
    expect(ws.enabled()).toEqual([]);
    expect(
      (await ws.edit(id, { enabled: true, name: '  Dự án web  ' })).ok,
    ).toBe(true);
    expect(store.get().projects[0]).toMatchObject({
      enabled: true,
      name: 'Dự án web',
    });
    for (const bad of ['', ' ', 'x'.repeat(121), 'a\u0007b', 42]) {
      const r = await ws.edit(id, { name: bad });
      expect(r.ok ? '' : r.error.code, String(bad)).toBe('INVALID_REQUEST');
    }
    expect((await ws.edit(id, { enabled: 'yes' })).ok).toBe(false);
    for (const missing of ['nope0000', '../x', 'TASKS']) {
      const r = await ws.setEnabled(missing, true);
      expect(r.ok ? '' : r.error.code).toBe('NOT_FOUND');
    }
    const views = await ws.list();
    expect(views[0]).toMatchObject({ id, exists: true });
    expect(views[0]?.repos.map((r) => r.name)).toEqual(['web']);

    expect((await ws.remove(id)).ok).toBe(true);
    expect(store.get().projects).toEqual([]);
    // Added again, the same folder gets the same id, so plan identity is kept.
    const again = await ws.add(path.join(dir, 'repos') + '\\');
    expect(again.ok && again.value.project.id).toBe(id);
  });

  it('reports a missing workspace folder in the list', async () => {
    const { dir, store, ws } = await service();
    const gone = path.join(dir, 'gone');
    await store.mutate((c) => {
      c.projects.push({
        id: projectIdFor(gone),
        path: gone,
        name: 'gone',
        kind: 'folder',
        enabled: true,
        addedAt: now.toISOString(),
      });
    });
    expect((await ws.list())[0]).toMatchObject({
      exists: false,
      error: 'Folder not found.',
      repos: [],
    });
  });

  it('is read-only while the settings file is unusable', async () => {
    const dir = tempDir();
    const data = path.join(dir, 'data');
    put(path.join(data, 'config.json'), '{"version":7}');
    const store = new SettingsStore({ dataDir: data });
    await store.load();
    const r = await new WorkspaceService(store).add(
      mkRepo(path.join(dir, 'r'), 'p'),
    );
    expect(r.ok ? '' : r.error.code).toBe('READ_ONLY');
  });

  it('two adds racing for overlapping folders save only one', async () => {
    const { dir, store, ws } = await service();
    const outer = path.join(dir, 'work');
    const inner = mkRepo(path.join(outer, 'web'), 'p');
    const [a, b] = await Promise.all([ws.add(outer), ws.add(inner)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(store.get().projects).toHaveLength(1);
  });

  it('names are 1 to 120 UTF-8 bytes without control characters', () => {
    expect(validProjectName('ễ'.repeat(40))).toBe(true);
    expect(validProjectName('ễ'.repeat(41))).toBe(false);
    expect(validProjectName('tab\there')).toBe(false);
  });
});
