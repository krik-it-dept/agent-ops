// Test fixtures: every test runs against a temporary folder used as a fake home
// and data folder. Nothing here reads or writes the real AI tool folders, the
// real app data folder or the registry.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, expect } from 'vitest';

import { JsonFileSkillsConfigStore } from '../config-store.js';
import { SkillsError, type SkillsErrorCode } from '../errors.js';
import { nodePlatform } from '../platform.js';
import { SkillsService, type SkillsServiceHooks } from '../service.js';
import type { WorkspaceRef } from '../types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..', '..', '..', '..');
export const fixturesDir = path.join(repoRoot, 'tests', 'fixtures', 'skills');

/** The canonical skill, read-only. */
export const skillText = readFileSync(
  path.join(repoRoot, 'skills', 'task-plan', 'SKILL.md'),
  'utf8',
);

export function fixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), 'utf8');
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

export interface Fixture {
  root: string;
  home: string;
  data: string;
  configFile: string;
  workspaces: WorkspaceRef[];
  hooks: SkillsServiceHooks;
  service: SkillsService;
  restarting: { value: boolean };
  /** A fresh service on the same folders (a new app start). */
  restart(): SkillsService;
}

export function makeFixture(options: { now?: () => Date } = {}): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-ops-skills-'));
  roots.push(root);
  const home = path.join(root, 'profile');
  const data = path.join(root, 'data');
  mkdirSync(home, { recursive: true });
  mkdirSync(data, { recursive: true });
  const platform = nodePlatform({ retryForMs: 200 });
  const workspaces: WorkspaceRef[] = [];
  const hooks: SkillsServiceHooks = {};
  const restarting = { value: false };
  const configFile = path.join(data, 'config.json');
  const create = (): SkillsService =>
    new SkillsService({
      dataDir: data,
      config: new JsonFileSkillsConfigStore(configFile, platform),
      skill: { content: skillText },
      detection: {
        homeDir: home,
        roamingAppData: path.join(home, 'AppData', 'Roaming'),
      },
      workspaces: () => workspaces,
      platform,
      isRestarting: () => restarting.value,
      hooks: {
        afterRead: (file) => hooks.afterRead?.(file),
        beforeReplace: (file) => hooks.beforeReplace?.(file),
      },
      ...(options.now ? { now: options.now } : {}),
    });
  return {
    root,
    home,
    data,
    configFile,
    workspaces,
    hooks,
    restarting,
    service: create(),
    restart: create,
  };
}

export function put(file: string, content: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

export function read(file: string): string {
  return readFileSync(file, 'utf8');
}

export function exists(file: string): boolean {
  return existsSync(file);
}

export function readConfig(f: Fixture): Record<string, unknown> {
  return JSON.parse(read(f.configFile)) as Record<string, unknown>;
}

/** Creates a directory junction (no admin rights needed); returns false when unavailable. */
export function junction(link: string, target: string): boolean {
  mkdirSync(path.dirname(link), { recursive: true });
  try {
    symlinkSync(target, link, 'junction');
    return true;
  } catch {
    return false;
  }
}

export async function expectSkillsError(
  promise: Promise<unknown>,
  code: SkillsErrorCode,
  text?: string,
): Promise<SkillsError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'expected a SkillsError').toBeInstanceOf(SkillsError);
  const se = err as SkillsError;
  expect(se.code, se.message).toBe(code);
  if (text !== undefined) {
    expect(se.message).toContain(text);
  }
  return se;
}
