import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { Settings, SettingsUpdate } from '../../../shared/ipc';
import { parseSettings, parseSettingsUpdate } from '../../../shared/validators';

export class SettingsStore {
  private readonly file: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly dataDir: string) {
    this.file = join(dataDir, 'config.json');
  }

  private async read(): Promise<{ settings: Settings; corrupt: boolean }> {
    let content: string;
    try {
      content = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { settings: { theme: 'system' }, corrupt: false };
      throw error;
    }
    try {
      return { settings: parseSettings(JSON.parse(content)), corrupt: false };
    } catch {
      return { settings: { theme: 'system' }, corrupt: true };
    }
  }

  async get(): Promise<Settings> {
    await this.pending;
    return (await this.read()).settings;
  }

  update(input: SettingsUpdate): Promise<Settings> {
    const patch = parseSettingsUpdate(input);
    const operation = this.pending.then(async () => {
      const { settings, corrupt } = await this.read();
      const next = { ...settings, ...patch };
      await mkdir(this.dataDir, { recursive: true });
      if (corrupt)
        await copyFile(this.file, `${this.file}.corrupt-${randomUUID()}`);
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, {
          flag: 'wx',
          mode: 0o600,
        });
        await rename(temp, this.file);
      } finally {
        await rm(temp, { force: true });
      }
      return next;
    });
    // A failed write must not poison the serialization queue for subsequent requests.
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}
