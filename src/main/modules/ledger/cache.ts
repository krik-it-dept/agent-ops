import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileRetry, writeFileAtomic } from '../../lib/safe-io';
import type { Overview } from '../plans';
import { isOverview, type OverviewCache } from './types';

/** Same flushed, retried atomic writes as settings and activity. */
export class FileOverviewCache implements OverviewCache {
  constructor(private readonly dataDir: string) {}
  async load(): Promise<Overview | undefined> {
    const file = join(this.dataDir, 'overview.json');
    try {
      if ((await stat(file)).size > 32 * 1024 * 1024) return undefined;
      const value: unknown = JSON.parse(
        (await readFileRetry(file)).toString('utf8'),
      );
      return isOverview(value) ? value : undefined;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' ||
        error instanceof SyntaxError
      )
        return undefined;
      throw error;
    }
  }
  save(overview: Overview): Promise<void> {
    return writeFileAtomic(
      join(this.dataDir, 'overview.json'),
      JSON.stringify(overview),
    );
  }
}
