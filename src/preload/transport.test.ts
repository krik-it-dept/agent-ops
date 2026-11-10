import { describe, expect, it, vi } from 'vitest';
import { invokeValidated } from './transport';
describe('preload invoke failure handling', () => {
  it('preserves every typed Result error including the correlation id', async () => {
    const result = {
      ok: false,
      error: {
        code: 'REVISION_CHANGED',
        message: 'Review the changed plan.',
        retryable: false,
        correlationId: 'server-log-id',
      },
    };
    const log = vi.fn();
    expect(
      await invokeValidated(
        'plans:recycle',
        { key: 'tasks/team/one', revision: 'a'.repeat(64), confirm: true },
        async () => result,
        log,
      ),
    ).toEqual(result);
    expect(log).not.toHaveBeenCalled();
  });
  it('uses UNAVAILABLE only for a missing handler and logs other rejections or malformed replies', async () => {
    const log = vi.fn();
    const call = (response: () => Promise<unknown>) =>
      invokeValidated('state:get', {}, response, log);
    expect(
      await call(async () => {
        throw new Error("No handler registered for 'state:get'");
      }),
    ).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    for (const invoke of [
      async () => {
        throw new Error('private source path');
      },
      async () => ({ ok: true, value: { bad: 'private data' } }),
    ]) {
      const result = await call(invoke);
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'INTERNAL', correlationId: expect.any(String) },
      });
      expect(JSON.stringify(result)).not.toContain('private');
    }
    expect(log).toHaveBeenCalledTimes(2);
  });
});
