import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { emptyOverview } from './types';
import { workerCollector } from './worker-runner';

describe('worker collection boundary', () => {
  it('receives validated overview from a separate thread and terminates it', async () => {
    let worker: Worker | undefined;
    const overview = emptyOverview(new Date());
    const collect = workerCollector(
      () =>
        (worker = new Worker(
          `const {parentPort} = require('node:worker_threads'); parentPort.postMessage({ overview: ${JSON.stringify(overview)} }); setInterval(()=>{},1000);`,
          { eval: true },
        )),
    );
    expect(await collect({}, new AbortController().signal)).toEqual(overview);
    expect(worker?.threadId).toBe(-1);
  });
  it('cancels and waits for termination before settling so another read cannot overlap', async () => {
    let worker: Worker | undefined;
    const collect = workerCollector(
      () => (worker = new Worker('while (true) {}', { eval: true })),
    );
    const controller = new AbortController();
    const pending = collect({}, controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    expect(worker?.threadId).toBe(-1);
  });
  it('rejects crashes and malformed results without hanging the main loop', async () => {
    for (const code of [
      'throw new Error("private failure")',
      'require("node:worker_threads").parentPort.postMessage({ overview: {} })',
      '',
    ]) {
      await expect(
        workerCollector(() => new Worker(code, { eval: true }))(
          {},
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(Error);
    }
  });
});
