import type { UpdaterService } from '../updater/service';
import type { ServiceHandlers } from '../../ipc/registry';

export type UpdaterPort = Pick<
  UpdaterService,
  | 'getState'
  | 'check'
  | 'apply'
  | 'skip'
  | 'start'
  | 'stop'
  | 'settled'
  | 'onState'
>;
export function updateHandlers(updater: UpdaterPort): ServiceHandlers {
  return {
    'updates:get': () => updater.getState(),
    'updates:check': () => updater.check(),
    'updates:apply': ({ version }) => updater.apply(version),
    'updates:skip': ({ version }) => updater.skip(version),
  };
}
