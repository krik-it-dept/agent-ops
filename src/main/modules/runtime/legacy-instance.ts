import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

export const LEGACY_RUNNING_MESSAGE =
  'An earlier Agent Ops may still be running. Quit it from its tray menu, then open Agent Ops again.';
export interface LegacyInstanceProbe {
  read(file: string): string | undefined;
  alive(pid: number): boolean;
}
const probe: LegacyInstanceProbe = {
  read(file) {
    let handle: number;
    try {
      handle = openSync(file, 'r');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
    try {
      const data = Buffer.alloc(4097);
      const size = readSync(handle, data, 0, data.length, 0);
      if (size > 4096) throw new Error(LEGACY_RUNNING_MESSAGE);
      return data.subarray(0, size).toString('utf8');
    } finally {
      closeSync(handle);
    }
  },
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  },
};
/** Must run before mkdir, Electron userData locking or any config/activity/cache writer. */
export function assertNoLegacyInstance(
  dataDir: string,
  operations = probe,
): void {
  try {
    const source = operations.read(join(dataDir, 'session.json'));
    if (source === undefined) return;
    const session: unknown = JSON.parse(source);
    if (
      !session ||
      typeof session !== 'object' ||
      !('pid' in session) ||
      !Number.isSafeInteger(session.pid) ||
      Number(session.pid) <= 0
    )
      throw new Error(LEGACY_RUNNING_MESSAGE);
    if (operations.alive(Number(session.pid)))
      throw new Error(LEGACY_RUNNING_MESSAGE);
    // A stopped process can leave its session file. Keep it for installer recovery; never trust its address/secret.
  } catch {
    throw new Error(LEGACY_RUNNING_MESSAGE);
  }
}
