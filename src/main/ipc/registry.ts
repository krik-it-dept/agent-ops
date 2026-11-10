import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { isRendererURL } from '../ipc';
import type { ResponseMap } from '../../shared/contracts';
import { parseResult } from '../../shared/contracts/wire';
import { mapError, ServiceFault, type Result } from './errors';
import {
  jsonValue,
  parseRequest,
  requestSchemas,
  type Channel,
  type Request,
} from './requests';

export type ServiceHandlers = {
  [C in Channel]?: (
    request: Request<C>,
  ) => ResponseMap[C] | Promise<ResponseMap[C]>;
};
export interface RegistryOptions {
  webContents: WebContents;
  rendererURL: string;
  handlers: ServiceHandlers;
  log?(correlationId: string, error: unknown): void;
}
export function createServiceHandler<C extends Channel>(
  channel: C,
  options: RegistryOptions,
): (
  event: IpcMainInvokeEvent,
  payload?: unknown,
  ...extra: unknown[]
) => Promise<Result<ResponseMap[C]>> {
  return async (event, payload, ...extra) => {
    try {
      try {
        if (options.webContents.isDestroyed())
          throw new Error('Destroyed window');
        if (
          event.sender !== options.webContents ||
          !event.senderFrame ||
          event.senderFrame !== options.webContents.mainFrame ||
          !isRendererURL(event.senderFrame.url, options.rendererURL)
        )
          throw new Error('Untrusted sender');
      } catch {
        throw new ServiceFault(
          'FORBIDDEN',
          'This action must come from the Agent Ops window.',
        );
      }
      if (extra.length)
        throw new ServiceFault(
          'INVALID_REQUEST',
          'Send one request at a time.',
        );
      const request = parseRequest(channel, payload);
      const handler = options.handlers[channel];
      if (!handler)
        throw new ServiceFault(
          'UNAVAILABLE',
          'This feature is not ready in this build.',
          true,
        );
      const value = await handler(request);
      if (!jsonValue(value))
        throw new Error(`Invalid service result: ${channel}`);
      return parseResult(channel, { ok: true, value });
    } catch (error) {
      return { ok: false, error: mapError(error, options.log) };
    }
  };
}

/** All domain registrations share request, response and sender validation. */
export function registerApplicationIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  options: RegistryOptions,
): () => void {
  const registered: string[] = [];
  try {
    for (const channel of Object.keys(requestSchemas) as Channel[]) {
      ipc.handle(channel, createServiceHandler(channel, options));
      registered.push(channel);
    }
  } catch (error) {
    for (const channel of registered) ipc.removeHandler(channel);
    throw error;
  }
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    for (const channel of registered) ipc.removeHandler(channel);
  };
}
