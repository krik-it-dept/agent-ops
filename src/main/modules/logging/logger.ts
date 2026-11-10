import { join } from 'node:path';
import { nodeLogStorage, type LogStorage } from './storage';

export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Readonly<
  Record<string, string | number | boolean | null>
>;
export const LOG_MAX_BYTES = 1 << 20;
export const LOG_FILE_COUNT = 5;

export class RotatingLogger {
  readonly directory: string;
  private readonly path: string;
  private readonly storage: LogStorage;
  private readonly maxBytes: number;
  private readonly now: () => Date;
  constructor(
    dataDir: string,
    options: {
      storage?: LogStorage;
      maxBytes?: number;
      now?: () => Date;
      name?: 'agent-ops' | 'update';
    } = {},
  ) {
    this.directory = join(dataDir, 'logs');
    this.path = join(this.directory, `${options.name ?? 'agent-ops'}.log`);
    this.storage = options.storage ?? nodeLogStorage;
    this.maxBytes = Math.max(128, options.maxBytes ?? LOG_MAX_BYTES);
    this.now = options.now ?? (() => new Date());
    this.storage.mkdir(this.directory);
  }
  /** Logging failures never recurse into the process error handlers. */
  write(level: LogLevel, message: string, fields: LogFields = {}): boolean {
    try {
      const boundedFields: Record<string, string | number | boolean | null> =
        {};
      for (const [key, value] of Object.entries(fields).slice(0, 20)) {
        boundedFields[key.slice(0, 80)] =
          typeof value === 'string'
            ? value.slice(0, 4000)
            : typeof value === 'number'
              ? Number.isFinite(value)
                ? value
                : null
              : value;
      }
      let line = `${JSON.stringify({ time: this.now().toISOString(), level, message: message.slice(0, 4000), fields: boundedFields })}\n`;
      if (Buffer.byteLength(line) > this.maxBytes)
        line = `${JSON.stringify({ time: this.now().toISOString(), level, message: 'Log entry exceeded the size limit.' })}\n`;
      const size = this.storage.size(this.path);
      if (size && size + Buffer.byteLength(line) > this.maxBytes) {
        const rotated = (index: number): string =>
          this.path.replace(/\.log$/, `.${index}.log`);
        this.storage.remove(rotated(LOG_FILE_COUNT - 1));
        for (let i = LOG_FILE_COUNT - 2; i >= 1; i--)
          this.storage.move(rotated(i), rotated(i + 1));
        this.storage.move(this.path, rotated(1));
      }
      this.storage.append(this.path, line);
      return true;
    } catch {
      return false;
    }
  }
  info(message: string, fields?: LogFields): boolean {
    return this.write('info', message, fields);
  }
  warn(message: string, fields?: LogFields): boolean {
    return this.write('warn', message, fields);
  }
  error(message: string, fields?: LogFields): boolean {
    return this.write('error', message, fields);
  }
}
