import { isAbsolute } from 'node:path';
import { PlatformError } from './types';

export type PathAction = 'trash' | 'open-folder' | 'open-logs';
export type AllowPath = (
  path: string,
  action: PathAction,
) => boolean | Promise<boolean>;
export interface ShellPort {
  trashItem(path: string): Promise<void>;
  openPath(path: string): Promise<string>;
}
export function createShellService(
  port: ShellPort,
  allow: AllowPath,
  logsDir: string,
) {
  const check = async (path: string, action: PathAction): Promise<void> => {
    if (
      !isAbsolute(path) ||
      path.includes('\0') ||
      !(await allow(path, action))
    )
      throw new PlatformError('FORBIDDEN', 'This path is not allowed.');
  };
  const open = async (path: string, action: PathAction): Promise<void> => {
    await check(path, action);
    try {
      if (await port.openPath(path))
        throw new Error('Shell rejected the folder.');
    } catch {
      throw new PlatformError(
        'IO_ERROR',
        'The folder could not be opened.',
        true,
      );
    }
  };
  return {
    async trash(path: string): Promise<void> {
      await check(path, 'trash');
      try {
        await port.trashItem(path);
      } catch {
        throw new PlatformError(
          'IO_ERROR',
          'The plan could not be moved to the Recycle Bin.',
          true,
        );
      }
    },
    openFolder: (path: string): Promise<void> => open(path, 'open-folder'),
    openLogs: (): Promise<void> => open(logsDir, 'open-logs'),
  };
}
