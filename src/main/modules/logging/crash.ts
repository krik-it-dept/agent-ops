import { join } from 'node:path';
import { nodeLogStorage, type LogStorage } from './storage';
import type { RotatingLogger } from './logger';

export type CrashKind =
  | 'panic'
  | 'fatal'
  | 'uncaught-exception'
  | 'unhandled-rejection'
  | 'renderer-gone'
  | 'child-process-gone';
export interface CrashNotice {
  time: string;
  kind: CrashKind;
  version: string;
  count: number;
}
const kinds: readonly CrashKind[] = [
  'panic',
  'fatal',
  'uncaught-exception',
  'unhandled-rejection',
  'renderer-gone',
  'child-process-gone',
];
export class CrashService {
  private readonly path: string;
  constructor(
    dataDir: string,
    private readonly version: string,
    private readonly logger: RotatingLogger,
    private readonly storage: LogStorage = nodeLogStorage,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.path = join(dataDir, 'crash.json');
  }
  readCrash(): CrashNotice | null {
    try {
      const raw = this.storage.read(this.path, 64 << 10);
      if (!raw) return null;
      const rec: unknown = JSON.parse(raw);
      if (!rec || typeof rec !== 'object') return null;
      const item = rec as Partial<CrashNotice>;
      if (
        typeof item.time !== 'string' ||
        !/^\d{4}-\d\d-\d\dT/.test(item.time) ||
        !Number.isFinite(Date.parse(item.time)) ||
        !kinds.includes(item.kind as CrashKind) ||
        typeof item.version !== 'string' ||
        item.version.length > 100 ||
        !Number.isSafeInteger(item.count) ||
        item.count! < 1
      )
        return null;
      return {
        time: item.time,
        kind: item.kind!,
        version: item.version,
        count: item.count!,
      };
    } catch {
      return null;
    }
  }
  record(kind: CrashKind, error: unknown): boolean {
    try {
      const count = Math.min(
        (this.readCrash()?.count ?? 0) + 1,
        Number.MAX_SAFE_INTEGER,
      );
      const notice: CrashNotice = {
        time: this.now().toISOString(),
        version: this.version,
        kind,
        count,
      };
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Process failure', {
        kind,
        message,
        stack: error instanceof Error ? (error.stack ?? '') : '',
      });
      this.storage.writeAtomic(this.path, `${JSON.stringify(notice)}\n`);
      return true;
    } catch {
      return false;
    }
  }
  dismissCrash(): void {
    this.storage.remove(this.path);
  }
}
export interface ProcessErrorsPort {
  onException(callback: (error: unknown) => void): () => void;
  onRejection(callback: (error: unknown) => void): () => void;
  exit(code: number): void;
}
export function installCrashHandlers(
  port: ProcessErrorsPort,
  crashes: CrashService,
): () => void {
  let handling = false;
  const fatal = (kind: CrashKind, error: unknown): void => {
    if (handling) {
      port.exit(1);
      return;
    }
    handling = true;
    try {
      crashes.record(kind, error);
    } finally {
      port.exit(1);
    }
  };
  const offException = port.onException((error) =>
    fatal('uncaught-exception', error),
  );
  const offRejection = port.onRejection((error) =>
    fatal('unhandled-rejection', error),
  );
  return () => {
    offException();
    offRejection();
  };
}
