import type { RequestMap, ResponseMap, Result } from '../shared/contracts';
import { parseResult } from '../shared/contracts/wire';

/** Typed service refusals pass through; only a missing handler is an unavailable transport. */
export async function invokeValidated<C extends keyof RequestMap>(
  channel: C,
  request: RequestMap[C],
  invoke: (channel: string, request: unknown) => Promise<unknown>,
  log: (id: string, error: unknown) => void,
): Promise<Result<ResponseMap[C]>> {
  try {
    return parseResult(channel, await invoke(channel, request));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes(`No handler registered for '${channel}'`)
    )
      return {
        ok: false,
        error: {
          code: 'UNAVAILABLE',
          message:
            'This feature is not available yet. Try again after the app is ready.',
          retryable: true,
        },
      };
    const correlationId = globalThis.crypto.randomUUID();
    log(correlationId, error);
    return {
      ok: false,
      error: {
        code: 'INTERNAL',
        message:
          'The action could not be completed. Open the logs for details.',
        retryable: false,
        correlationId,
      },
    };
  }
}
