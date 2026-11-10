// Where the list is stored. The Skills module reads and writes only the
// "integrations" and "integrationsSeeded" keys of config.json; every other key
// (owned by other settings) is kept exactly as it is in the file at save time.
// The settings module may provide its own SkillsConfigStore instead.

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { SkillsPlatform } from './platform.js';

export interface SkillsConfigSnapshot {
  /** config.json exists. */
  exists: boolean;
  /** The raw stored "integrations" value (undefined when absent). */
  integrations: unknown;
  integrationsSeeded: boolean;
  /** Why settings cannot be saved now; empty when they can. */
  readOnly: string;
}

/** The stored list changed between load and save (another window or program saved settings). */
export class ConfigChangedError extends Error {
  constructor() {
    super('Settings were changed meanwhile. Reload Settings and try again.');
    this.name = 'ConfigChangedError';
  }
}

export interface SkillsConfigStore {
  load(): Promise<SkillsConfigSnapshot>;
  /**
   * Stores next as "integrations" (undefined removes the key) and sets
   * "integrationsSeeded". Rejects with ConfigChangedError when the stored list
   * is no longer `expected` (the raw value load returned).
   */
  save(
    next: Record<string, unknown>[] | undefined,
    expected: unknown,
  ): Promise<void>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The text without a leading byte order mark. */
function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const UNREADABLE =
  'The settings file could not be read, so the AI tools list cannot be changed now.';

/** config.json in the data folder, replaced atomically on save. */
export class JsonFileSkillsConfigStore implements SkillsConfigStore {
  constructor(
    private readonly file: string,
    private readonly platform: SkillsPlatform,
  ) {}

  private async readObject(): Promise<{
    exists: boolean;
    value: Record<string, unknown> | null;
  }> {
    let bytes: Buffer;
    try {
      bytes = await this.platform.readFile(this.file);
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') {
        return { exists: false, value: {} };
      }
      return { exists: true, value: null };
    }
    try {
      const parsed: unknown = JSON.parse(withoutBom(bytes.toString('utf8')));
      return { exists: true, value: isObject(parsed) ? parsed : null };
    } catch {
      return { exists: true, value: null };
    }
  }

  async load(): Promise<SkillsConfigSnapshot> {
    const { exists, value } = await this.readObject();
    if (value === null) {
      return {
        exists,
        integrations: undefined,
        integrationsSeeded: false,
        readOnly: UNREADABLE,
      };
    }
    return {
      exists,
      integrations: value['integrations'],
      integrationsSeeded: value['integrationsSeeded'] === true,
      readOnly: '',
    };
  }

  async save(
    next: Record<string, unknown>[] | undefined,
    expected: unknown,
  ): Promise<void> {
    const { value } = await this.readObject();
    if (value === null) {
      throw new Error(UNREADABLE);
    }
    if (JSON.stringify(value['integrations']) !== JSON.stringify(expected)) {
      throw new ConfigChangedError();
    }
    const out: Record<string, unknown> = { ...value };
    if (next === undefined || next.length === 0) {
      delete out['integrations'];
    } else {
      out['integrations'] = next;
    }
    out['integrationsSeeded'] = true;
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(
      dir,
      `.config.json.${randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      await fs.writeFile(tmp, `${JSON.stringify(out, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      await this.platform.replaceFile(tmp, this.file);
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }
}
