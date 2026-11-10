import type { Worker, WorkerOptions } from 'node:worker_threads';
import type { Collector } from './types';
import { isOverview } from './types';

export type WorkerFactory = (options: WorkerOptions) => Worker;
/** A cancelled/timed-out worker is terminated before the collection settles. */
export function workerCollector(createWorker: WorkerFactory): Collector {
  return (config, signal) =>
    new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const worker = createWorker({ workerData: config });
      let settled = false;
      const finish = (error?: unknown, value?: unknown): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        // Keep the error listener until termination, avoiding an unhandled late error.
        void worker.terminate().then(() => {
          worker.removeAllListeners();
          if (error) reject(error);
          else if (isOverview(value)) resolve(value);
          else reject(new Error('Invalid plan overview.'));
        }, reject);
      };
      const abort = (): void =>
        finish(signal.reason ?? new Error('Plan read cancelled.'));
      worker.once('message', (message: unknown) => {
        if (message && typeof message === 'object' && 'overview' in message)
          finish(undefined, message.overview);
        else finish(new Error('The plan reader stopped.'));
      });
      worker.once('error', finish);
      worker.once('exit', () => {
        if (!settled) finish(new Error('The plan reader stopped.'));
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
}
