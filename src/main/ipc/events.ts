import type { WebContents } from 'electron';
import type { EventMap } from '../../shared/contracts';
import { parseEvent } from '../../shared/contracts/wire';
import type { Activation } from '../modules/platform/types';

export function activationEvent(target: Activation): EventMap['app:activate'] {
  return {
    plan: target.plan ?? null,
    route: target.plan ? 'plan' : target.settings ? 'settings' : 'overview',
  };
}
/** Main and preload use the same event contract; malformed events never cross the boundary. */
export function publishEvent<C extends keyof EventMap>(
  contents: Pick<WebContents, 'isDestroyed' | 'send'>,
  channel: C,
  event: EventMap[C],
): void {
  if (!contents.isDestroyed())
    contents.send(channel, parseEvent(channel, event));
}
