// Small JSON files of the updater in the data folder, replaced atomically.
//   update-preferences.json  {"skipped": "v1.2.3"}    the version the owner skipped
//   update-result.json       {"phase", "version", "from", "message", "at"}
//                             what the last apply did, read after the restart

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

export interface UpdatePreferences {
  skipped: string;
}

export interface UpdateResult {
  /** restarting: the installer was started; updated/failed: seen after the restart; error: apply failed. */
  phase: 'restarting' | 'updated' | 'failed' | 'error';
  version: string;
  from: string;
  message: string;
  at: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null; // missing or damaged: treated as empty
  }
}

export async function writeJsonAtomic(
  file: string,
  value: unknown,
): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
    });
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

export class UpdateStore {
  readonly preferencesFile: string;
  readonly resultFile: string;

  constructor(dataDir: string) {
    this.preferencesFile = join(dataDir, 'update-preferences.json');
    this.resultFile = join(dataDir, 'update-result.json');
  }

  async preferences(): Promise<UpdatePreferences> {
    const raw = await readJson(this.preferencesFile);
    return {
      skipped: typeof raw?.['skipped'] === 'string' ? raw['skipped'] : '',
    };
  }

  /** Keeps unknown keys of the file. */
  async savePreferences(next: UpdatePreferences): Promise<void> {
    const raw = (await readJson(this.preferencesFile)) ?? {};
    await writeJsonAtomic(this.preferencesFile, {
      ...raw,
      skipped: next.skipped,
    });
  }

  async result(): Promise<UpdateResult | null> {
    const raw = await readJson(this.resultFile);
    const phase = raw?.['phase'];
    if (
      !raw ||
      (phase !== 'restarting' &&
        phase !== 'updated' &&
        phase !== 'failed' &&
        phase !== 'error')
    ) {
      return null;
    }
    const text = (k: string): string =>
      typeof raw[k] === 'string' ? (raw[k] as string) : '';
    return {
      phase,
      version: text('version'),
      from: text('from'),
      message: text('message'),
      at: text('at'),
    };
  }

  async saveResult(result: UpdateResult): Promise<void> {
    await writeJsonAtomic(this.resultFile, result);
  }
}
