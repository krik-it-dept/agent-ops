import { ServiceFault } from '../../ipc/errors';

/** Gate accepted writes before updater handoff; reads keep the retained view available. */
export class MutationGate {
  private frozen = false;
  private pending = new Set<Promise<unknown>>();
  run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.frozen)
      return Promise.reject(
        new ServiceFault(
          'UNAVAILABLE',
          'Agent Ops is restarting for an update. Try again afterwards.',
          true,
        ),
      );
    const promise = Promise.resolve().then(operation);
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
  async drain(): Promise<void> {
    this.frozen = true;
    await Promise.allSettled([...this.pending]);
  }
  reopen(): void {
    this.frozen = false;
  }
}
