import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsStore } from './store';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

describe('atomic settings store (temporary profiles only)', () => {
  let temp: string;
  let store: SettingsStore;
  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'agent-ops-settings-'));
    store = new SettingsStore(temp);
  });
  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });
  it('returns defaults without writing a missing config', async () => {
    expect(await store.get()).toEqual({ theme: 'system' });
    expect(await readdir(temp)).toEqual([]);
  });
  it('preserves unknown keys and creates an atomically replaced JSON file', async () => {
    const legacy = {
      theme: '',
      projects: [{ path: 'example' }],
      future: { enabled: true },
      tasksDir: 'X:\\Tasks',
    };
    await writeFile(join(temp, 'config.json'), JSON.stringify(legacy));
    expect(await store.update({ theme: 'dark' })).toEqual({
      ...legacy,
      theme: 'dark',
    });
    expect(
      JSON.parse(await readFile(join(temp, 'config.json'), 'utf8')),
    ).toEqual({ ...legacy, theme: 'dark' });
    expect(await readdir(temp)).toEqual(['config.json']);
  });
  it('tolerates invalid JSON and keeps a recovery copy before overwriting it', async () => {
    await writeFile(join(temp, 'config.json'), '{broken');
    expect(await store.get()).toEqual({ theme: 'system' });
    expect(await readdir(temp)).toEqual(['config.json']);
    await store.update({ theme: 'light' });
    const backup = (await readdir(temp)).find((name) =>
      name.startsWith('config.json.corrupt-'),
    );
    expect(backup).toBeDefined();
    expect(await readFile(join(temp, backup!), 'utf8')).toBe('{broken');
  });
  it('tolerates non-object config and normalizes an invalid stored theme', async () => {
    await writeFile(join(temp, 'config.json'), '[]');
    expect(await store.get()).toEqual({ theme: 'system' });
    await writeFile(join(temp, 'config.json'), '{"theme":123,"future":true}');
    expect(await store.get()).toEqual({ theme: 'system', future: true });
  });
  it('serializes concurrent updates and reads the final committed value', async () => {
    const results = await Promise.all([
      store.update({ theme: 'light' }),
      store.update({ theme: 'dark' }),
      store.get(),
    ]);
    expect(results.map((settings) => settings.theme)).toEqual([
      'light',
      'dark',
      'dark',
    ]);
  });
  it('leaves the original file intact on a failed rename, cleans up, and recovers', async () => {
    await store.update({ theme: 'dark' });
    vi.mocked(rename).mockRejectedValueOnce(
      new Error('Injected rename failure'),
    );
    await expect(store.update({ theme: 'light' })).rejects.toThrow(
      'Injected rename failure',
    );
    expect(await store.get()).toEqual({ theme: 'dark' });
    expect(await readdir(temp)).toEqual(['config.json']);
    expect(await store.update({ theme: 'system' })).toEqual({
      theme: 'system',
    });
  });
  it('creates nested folders and rejects invalid updates before any write', async () => {
    const nested = new SettingsStore(join(temp, 'nested', 'data'));
    await nested.update({ theme: 'dark' });
    expect(await nested.get()).toEqual({ theme: 'dark' });
    expect(() => store.update({ theme: 'invalid' } as never)).toThrow();
    expect(await readdir(temp)).toEqual(['nested']);
  });
});
