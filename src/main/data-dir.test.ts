import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDataDir } from './data-dir';

describe('data folder resolution', () => {
  let temp: string;
  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'agent-ops-data-'));
  });
  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });
  it('prefers an explicit temp folder in development and production', () => {
    for (const development of [true, false])
      expect(
        resolveDataDir({
          development,
          env: { AGENT_OPS_DATA_DIR: temp },
          repoDir: temp,
        }),
      ).toBe(temp);
  });
  it('isolates development from an injected local app data folder', () => {
    expect(
      resolveDataDir({
        development: true,
        env: { LOCALAPPDATA: join(temp, 'local') },
        repoDir: temp,
      }),
    ).toBe(join(temp, '.dev-data'));
  });
  it('uses the injected local app data folder for packaged apps', () => {
    expect(
      resolveDataDir({
        development: false,
        env: { LOCALAPPDATA: temp },
        repoDir: temp,
      }),
    ).toBe(join(temp, 'AgentOps'));
  });
  it('fails closed on invalid overrides or missing production paths', () => {
    for (const value of ['', ' ', 'relative'])
      expect(() =>
        resolveDataDir({
          development: true,
          env: { AGENT_OPS_DATA_DIR: value },
          repoDir: temp,
        }),
      ).toThrow();
    expect(() =>
      resolveDataDir({ development: false, env: {}, repoDir: temp }),
    ).toThrow();
  });
  it('rejects Windows rooted, network and device paths and any development override inside installed data', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\owner\\AppData\\Local' };
    for (const value of [
      '\\data',
      '\\\\server\\share',
      '\\\\?\\C:\\data',
      'C:data',
      'C:\\bad\0path',
      'c:\\users\\OWNER\\appdata\\local\\AgentOps',
      'C:\\Users\\owner\\AppData\\Local\\AgentOps\\child',
    ]) {
      expect(() =>
        resolveDataDir({
          development: true,
          platform: 'win32',
          repoDir: 'D:\\source',
          env: { ...env, AGENT_OPS_DATA_DIR: value },
        }),
      ).toThrow();
    }
    expect(
      resolveDataDir({
        development: true,
        platform: 'win32',
        repoDir: 'D:\\source',
        env: { ...env, AGENT_OPS_DATA_DIR: 'D:\\isolated' },
      }),
    ).toBe('D:\\isolated');
  });
});
