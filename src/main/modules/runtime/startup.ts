import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { assertNoLegacyInstance } from './legacy-instance';

/**
 * After a completed move the beta runtime has been stopped by its exact path, so
 * its leftover session.json describes no running app. Its process id is soon
 * reused by Windows; checking it on every start would refuse to open Agent Ops
 * whenever an unrelated process holds that id. Keep the file beside the move log.
 */
export function retireLegacySession(dataDir: string, now = new Date()): void {
  const session = join(dataDir, 'session.json');
  if (!existsSync(session)) return;
  const folder = join(dataDir, 'legacy-move');
  mkdirSync(folder, { recursive: true });
  renameSync(
    session,
    join(folder, `session-${now.toISOString().replace(/[:.]/g, '-')}.json`),
  );
}

/** The installed beta runtime must be stopped by the guarded mover before its session is tested. */
export async function prepareDataFolder(options: {
  dataDir: string;
  installed: boolean;
  cleanup: boolean;
  move(): Promise<{ completed: boolean }>;
  guard?: (dataDir: string) => void;
  retire?: (dataDir: string) => void;
}): Promise<void> {
  if (options.installed && !options.cleanup) {
    if (!(await options.move()).completed)
      throw new Error(
        'The earlier installation could not be moved safely. Open the logs and retry.',
      );
    try {
      (options.retire ?? retireLegacySession)(options.dataDir);
    } catch {
      /* The guard below still checks a session file that could not be moved. */
    }
  }
  (options.guard ?? assertNoLegacyInstance)(options.dataDir);
}
