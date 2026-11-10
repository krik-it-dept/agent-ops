import { parentPort, workerData } from 'node:worker_threads';
import { collectOverview, type CollectConfig } from '../plans';

// This entry is emitted as a separate chunk by electron-vite's nodeWorker plugin.
if (parentPort) {
  const port = parentPort;
  void collectOverview(workerData as CollectConfig).then(
    (overview) => port.postMessage({ overview }),
    () => port.postMessage({ failed: true }),
  );
}
