import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  has,
  mkRepo,
  put,
  read,
  tempDir,
} from '../../lib/safe-io/test-helpers';
import {
  defaultConfig,
  parseConfig,
  serializeConfig,
  validateConfig,
  type AppConfig,
  type Project,
} from './config';
import {
  SettingsStore,
  configFilePath,
  loadOrMigrateConfig,
  readConfig,
  writeConfig,
} from './config-store';
import { projectIdFor } from './identity';

const fixture = path.resolve(
  __dirname,
  '../../../../tests/fixtures/settings/owner-legacy-config.json',
);
const now = new Date(Date.UTC(2026, 10, 10, 9, 30, 0));

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'abc12345',
    path: 'C:\\repos',
    name: 'repos',
    kind: 'folder',
    enabled: true,
    addedAt: '2026-11-10T00:00:00Z',
    ...over,
  };
}

describe('config.json', () => {
  it('round-trips, replaces atomically and rejects invalid content before the disk', async () => {
    const dir = tempDir();
    const file = configFilePath(dir);
    await expect(readConfig(file)).rejects.toMatchObject({ code: 'ENOENT' });
    const c = defaultConfig();
    c.setupComplete = true;
    c.notifications = false;
    c.projects = [project({ path: path.join(dir, 'repos') })];
    await writeConfig(file, c);
    let got = await readConfig(file);
    expect(got.setupComplete).toBe(true);
    expect(got.notifications).toBe(false);
    expect(got.projects[0]?.kind).toBe('folder');
    c.projects[0]!.name = 'renamed';
    await writeConfig(file, c);
    got = await readConfig(file);
    expect(got.projects[0]?.name).toBe('renamed');
    expect(readdirSync(dir)).toEqual(['config.json']);

    put(file, '{"version":1,"setupComplete":false,"projects":[]}');
    expect((await readConfig(file)).notifications).toBe(true);

    const bad: AppConfig = { ...c, projects: [c.projects[0]!, c.projects[0]!] };
    await expect(writeConfig(file, bad)).rejects.toThrow(
      /Duplicate project id/,
    );
    for (const text of [
      '{"version":2,"projects":[]}',
      '{"version":1,"projects":[{"id":"x","path":"relative","name":"x","kind":"repo"}]}',
      '{"version":1,"projects":[{"id":"x","path":"C:\\\\x","name":"x","kind":"other"}]}',
      '{"version":1,"projects":[{"id":"x","path":"C:\\\\x","name":"x","kind":"repo","enabled":"yes"}]}',
      '{"version":1,"projects":{}}',
      '{"version":1.5,"projects":[]}',
      '[]',
    ]) {
      put(file, text);
      await expect(readConfig(file), text).rejects.toThrow();
    }
  });

  it('defaults shortcuts to on and rejects an unknown theme', async () => {
    const file = put(
      path.join(tempDir(), 'config.json'),
      '{"version":1,"setupComplete":true,"projects":[]}',
    );
    const c = await readConfig(file);
    expect(c.shortcuts).toBe(true);
    expect(c.theme).toBe('');
    put(file, '{"version":1,"projects":[],"theme":"purple"}');
    await expect(readConfig(file)).rejects.toThrow(/theme/);
  });

  it('rejects overlapping workspaces on load, but not siblings sharing a prefix', async () => {
    const dir = tempDir();
    const file = configFilePath(dir);
    const outer = path.join(dir, 'R');
    const inner = path.join(dir, 'r', 'app');
    put(
      file,
      JSON.stringify({
        version: 1,
        projects: [
          project({ id: 'outer', path: outer, name: 'R' }),
          project({ id: 'inner', path: inner, name: 'app', kind: 'repo' }),
        ],
      }),
    );
    await expect(readConfig(file)).rejects.toThrow(/overlap/);
    const c = defaultConfig();
    c.projects = [
      project({ id: 'a', path: path.join(dir, 'ab'), kind: 'repo' }),
      project({ id: 'b', path: path.join(dir, 'a'), kind: 'repo' }),
    ];
    expect(validateConfig(c)).toBe('');
  });

  it('reserves the id "tasks" and checks the Tasks folder', () => {
    const c = defaultConfig();
    for (const bad of ['relative', '\\\\server\\share', '//server/share']) {
      c.tasksDir = bad;
      expect(validateConfig(c)).toMatch(/Tasks folder/);
    }
    c.tasksDir = '';
    c.previousTasksDir = '\\\\?\\C:\\tasks';
    expect(validateConfig(c)).toMatch(/Tasks folder/);
    c.previousTasksDir = '';
    c.projects = [project({ id: 'tasks' })];
    expect(validateConfig(c)).toMatch(/invalid id/);
    c.projects = [project({ name: 'x'.repeat(121) })];
    expect(validateConfig(c)).toMatch(/at most 120/);
    // 120 bytes is the limit, as in Go: 40 Vietnamese letters of 3 bytes fit, 41 do not.
    c.projects = [project({ name: 'ễ'.repeat(40) })];
    expect(validateConfig(c)).toBe('');
    c.projects = [project({ name: 'ễ'.repeat(41) })];
    expect(validateConfig(c)).toMatch(/at most 120/);
  });

  it('keeps unknown keys and Skills data, drops stateFile and slotsFile (owner-style legacy config)', async () => {
    const dir = tempDir();
    const file = configFilePath(dir);
    put(file, readFileSync(fixture));
    const c = await readConfig(file);
    expect(c.projects.map((p) => p.id)).toEqual(['1a2b3c4d', '5e6f7a8b']);
    expect(c.projects[1]?.addedAt).toBe('2026-03-15T08:30:00.123456789+07:00');
    expect(c.theme).toBe('dark');
    expect(c.autoArchiveDone).toBe(true);
    expect(c.planArchive).toEqual({
      '1a2b3c4d/web/release-go-live': true,
      'tasks/api/notes': false,
    });
    expect(c.extra).toEqual({
      futureFeature: { enabled: true, list: [1, 2, 3] },
    });
    await writeConfig(file, c);
    const saved = JSON.parse(read(file)) as Record<string, unknown>;
    expect(saved.stateFile).toBeUndefined();
    expect(saved.slotsFile).toBeUndefined();
    expect(saved.futureFeature).toEqual({ enabled: true, list: [1, 2, 3] });
    expect(saved.integrations).toEqual({
      codex: { dir: 'C:\\Users\\owner\\.codex\\skills', installed: true },
    });
    expect(saved.integrationsSeeded).toBe(true);
    expect(Object.keys(saved).slice(0, 3)).toEqual([
      'version',
      'setupComplete',
      'projects',
    ]);
    // A second save is byte for byte the same.
    const first = read(file);
    await writeConfig(file, await readConfig(file));
    expect(read(file)).toBe(first);
  });

  it('serialises with the baseline omissions and a final newline', () => {
    const text = serializeConfig(defaultConfig());
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text)).toEqual({
      version: 1,
      setupComplete: false,
      projects: [],
      notifications: true,
      shortcuts: true,
      autoArchiveDone: false,
    });
    expect(parseConfig(text)).toEqual(defaultConfig());
  });
});

describe('loadOrMigrateConfig', () => {
  it('moves a corrupt file aside with a warning and does not recreate it', async () => {
    const file = put(configFilePath(tempDir()), '{not json');
    const r = await loadOrMigrateConfig(file, {}, now);
    expect(r.config.setupComplete).toBe(false);
    expect(r.warning).toContain('unreadable');
    expect(r.readOnly).toBe('');
    expect(read(`${file}.corrupt-20261110-093000`)).toBe('{not json');
    expect(has(file)).toBe(false);
  });

  it('moves aside a half-written file', async () => {
    const file = put(
      configFilePath(tempDir()),
      '{"version":1,"setupComplete":true,"projects":[{"id":"abc',
    );
    const r = await loadOrMigrateConfig(file, {}, now);
    expect(r.warning).toContain('kept as');
    expect(has(`${file}.corrupt-20261110-093000`)).toBe(true);
  });

  it('migrates the legacy repos folder once', async () => {
    const dir = tempDir();
    const repos = path.join(dir, 'legacy repos');
    mkRepo(path.join(repos, 'one'), 'plan');
    const file = configFilePath(path.join(dir, 'data'));
    const r = await loadOrMigrateConfig(file, { reposDir: repos }, now);
    expect(r.warning).toBe('');
    expect(r.config.setupComplete).toBe(true);
    expect(r.config.projects).toEqual([
      {
        id: projectIdFor(repos),
        path: repos,
        name: 'legacy repos',
        kind: 'folder',
        enabled: true,
        addedAt: now.toISOString(),
      },
    ]);
    expect((await readConfig(file)).projects[0]?.path).toBe(repos);
    expect(read(file)).not.toContain('stateFile');
    const c = await readConfig(file);
    c.projects[0]!.enabled = false;
    await writeConfig(file, c);
    const again = await loadOrMigrateConfig(file, { reposDir: repos }, now);
    expect(again.config.projects[0]?.enabled).toBe(false);
  });

  it('without a legacy folder needs setup and writes nothing', async () => {
    const dir = tempDir();
    const file = configFilePath(dir);
    const r = await loadOrMigrateConfig(
      file,
      { reposDir: path.join(dir, 'missing') },
      now,
    );
    expect(r).toMatchObject({ warning: '', readOnly: '' });
    expect(r.config.setupComplete).toBe(false);
    expect(has(file)).toBe(false);
  });

  it('keeps an unreadable or newer file, migrates nothing over it and goes read-only', async () => {
    const dir = tempDir();
    const repos = path.join(dir, 'legacy');
    mkRepo(path.join(repos, 'one'), 'plan');
    const newer = put(
      configFilePath(path.join(dir, 'newer')),
      '{"version":2,"projects":[],"future":true}',
    );
    const r = await loadOrMigrateConfig(newer, { reposDir: repos }, now);
    expect(r.config.projects).toEqual([]);
    expect(r.warning).toContain('newer Agent Ops');
    expect(r.readOnly).not.toBe('');
    expect(read(newer)).toBe('{"version":2,"projects":[],"future":true}');
    // A folder stands in for a file locked by another program.
    const locked = configFilePath(path.join(dir, 'locked'));
    mkdirSync(locked, { recursive: true });
    const l = await loadOrMigrateConfig(locked, { reposDir: repos }, now);
    expect(l.readOnly).not.toBe('');
    expect(readdirSync(path.dirname(locked))).toEqual(['config.json']);
  });
});

describe('SettingsStore', () => {
  async function store(dir = tempDir()) {
    const s = new SettingsStore({ dataDir: dir, now: () => now });
    await s.load();
    return s;
  }

  it('setup can be skipped with no workspace; theme and shortcuts are saved', async () => {
    const s = await store();
    expect(s.setupRequired).toBe(true);
    const r = await s.update({ setupComplete: true });
    expect(r.ok && r.value.setupComplete).toBe(true);
    expect(s.setupRequired).toBe(false);
    expect((await s.update({ theme: 'dark', shortcuts: false })).ok).toBe(true);
    const saved = await readConfig(s.file);
    expect(saved).toMatchObject({
      theme: 'dark',
      shortcuts: false,
      setupComplete: true,
    });
    for (const bad of ['neon', '']) {
      const r = await s.update({ theme: bad });
      expect(r).toEqual({
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Theme must be system, light or dark.',
          retryable: false,
        },
      });
    }
  });

  it('refuses unknown keys and values of the wrong type', async () => {
    const s = await store();
    for (const bad of [
      { autoArchiveDone: 'true' },
      { stateFile: 'x' },
      null,
      [],
      'x',
    ]) {
      const r = await s.update(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(has(s.file)).toBe(false);
  });

  it('autoArchiveDone persists without touching plans', async () => {
    const s = await store();
    for (const enabled of [true, false]) {
      const r = await s.update({ autoArchiveDone: enabled });
      expect(r.ok && r.value.autoArchiveDone).toBe(enabled);
      expect((await readConfig(s.file)).autoArchiveDone).toBe(enabled);
    }
  });

  it('is read-only while the file is unusable, and never overwrites it', async () => {
    const dir = tempDir();
    put(configFilePath(dir), '{"version":9,"projects":[]}');
    const s = await store(dir);
    expect(s.readOnly).not.toBe('');
    expect(s.setupRequired).toBe(false);
    const r = await s.update({ theme: 'dark' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('READ_ONLY');
    expect(read(configFilePath(dir))).toBe('{"version":9,"projects":[]}');
  });

  it('a refused change saves nothing; changes run one at a time', async () => {
    const s = await store();
    const results = await Promise.all([
      s.mutate((c) => {
        c.pickerDirectory = 'C:\\one';
      }),
      s.mutate((c) => {
        c.projects.push(project({ path: 'relative' }));
      }),
      s.mutate((c) => {
        c.notifications = false;
      }),
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    const saved = await readConfig(s.file);
    expect(saved.pickerDirectory).toBe('C:\\one');
    expect(saved.notifications).toBe(false);
    expect(saved.projects).toEqual([]);
    // get returns a copy.
    s.get().projects.push(project());
    expect(s.get().projects).toEqual([]);
  });
});
