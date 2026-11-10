import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { SettingsStore } from '../settings';
import {
  legacyIntegrationTargets,
  migrateLegacyIntegrations,
} from './legacy-integrations';

describe('legacy integrations map conversion', () => {
  it('retains hashes, kept choices and separate reminders when two clients shared a skills folder', () => {
    const profile = join(tmpdir(), 'synthetic-profile');
    const file = join(profile, '.agents', 'skills', 'task-plan', 'SKILL.md');
    const converted = legacyIntegrationTargets(
      {
        codex: {
          path: file,
          version: 2,
          sha256: 'hash',
          kept: 'keep',
          installedAt: 'stamp',
          instructions: {
            path: join(profile, '.codex', 'AGENTS.md'),
            sha256: 'block',
          },
        },
        gemini: {
          path: file,
          instructions: {
            path: join(profile, '.gemini', 'GEMINI.md'),
            sha256: 'second',
          },
        },
      },
      profile,
    );
    expect(converted).toHaveLength(2);
    expect(converted[0]).toMatchObject({
      sha256: 'hash',
      kept: 'keep',
      version: 2,
      installedAt: 'stamp',
      instructionSha256: 'block',
      instructionBlock: true,
    });
    expect(converted[1]?.skillDir).toBe(join(profile, '.gemini', 'skills'));
  });
  it('converts the owner-style fixture once, backs up exact bytes, preserves unknown keys and makes Skills writable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-ops-map-migration-'));
    try {
      const original = await readFile(
        'tests/fixtures/settings/owner-legacy-config.json',
        'utf8',
      );
      await writeFile(join(root, 'config.json'), original);
      const store = new SettingsStore({ dataDir: root });
      await store.load();
      const backup = await migrateLegacyIntegrations(
        store,
        join(root, 'profile'),
      );
      expect(backup).toBeDefined();
      expect(await readFile(backup!, 'utf8')).toBe(original);
      expect(store.get().integrations).toBeUndefined(); // Baseline ignores unknown dir/installed-only records.
      expect(store.get().extra.futureFeature).toEqual({
        enabled: true,
        list: [1, 2, 3],
      });
      const after = await readFile(join(root, 'config.json'), 'utf8');
      expect(
        await migrateLegacyIntegrations(store, join(root, 'profile')),
      ).toBeUndefined();
      expect(await readFile(join(root, 'config.json'), 'utf8')).toBe(after);
      expect(await readdir(join(root, 'backups'))).toHaveLength(1);
      // The shared mutation path remains usable after the old map disappears.
      expect(
        (
          await store.mutate((c) => {
            c.integrations = [];
          })
        ).ok,
      ).toBe(true);
      await mkdir(join(root, 'profile'), { recursive: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
