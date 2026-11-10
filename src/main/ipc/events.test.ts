import { describe, expect, it, vi } from 'vitest';
import { activationEvent, publishEvent } from './events';
import { parseEvent } from '../../shared/contracts/wire';
describe('shared event contract at main publication', () => {
  it('routes tray, protocol and foreground activations through the exact renderer envelope', () => {
    for (const [target, expected] of [
      [{}, { plan: null, route: 'overview' }],
      [{ settings: true }, { plan: null, route: 'settings' }],
      [{ plan: 'tasks/team/one' }, { plan: 'tasks/team/one', route: 'plan' }],
    ] as const)
      expect(parseEvent('app:activate', activationEvent(target))).toEqual(
        expected,
      );
    const send = vi.fn();
    const contents = { isDestroyed: () => false, send };
    publishEvent(contents, 'state:changed', { generation: 2 });
    expect(send).toHaveBeenCalledWith('state:changed', { generation: 2 });
    expect(() =>
      publishEvent(contents, 'state:changed', { generation: NaN }),
    ).toThrow();
    publishEvent({ isDestroyed: () => true, send }, 'state:changed', {
      generation: 3,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
