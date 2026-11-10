import { describe, expect, it, vi } from 'vitest';
import { createBridge, type Invoker, type Subscriber } from './bridge';
import { parseEvent, parseResult } from './wire';
import { fixtureData } from '../../renderer/dev/fixture-bridge';

describe('final method-specific contract', () => {
  it('maps public methods to final channel names and exact request payloads', async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      value: {},
    })) as unknown as Invoker;
    const subscribe = vi.fn(() => vi.fn()) as unknown as Subscriber;
    const bridge = createBridge(invoke, subscribe);
    await bridge.app.getInfo({});
    await bridge.state.get({});
    await bridge.settings.set({ theme: 'dark' });
    await bridge.plans.recycle({
      key: 'studio/Ledger/one',
      revision: 'a'.repeat(64),
      confirm: true,
    });
    await bridge.skills.removeSkill({ id: 'codex' });
    await bridge.shell.openExternal({ target: 'release', version: 'v1.0.0' });
    expect(vi.mocked(invoke).mock.calls.map(([channel]) => channel)).toEqual([
      'app:get-info',
      'state:get',
      'settings:set',
      'plans:recycle',
      'skills:remove-skill',
      'shell:open-external',
    ]);
    bridge.settings.onChanged(() => undefined);
    expect(subscribe).toHaveBeenCalledWith(
      'settings:changed',
      expect.any(Function),
    );
    expect(Object.keys(bridge.settings)).toEqual(['get', 'set', 'onChanged']);
    expect(bridge).not.toHaveProperty('invoke');
  });
  it('accepts coherent state/settings/update envelopes and safe errors', () => {
    const data = fixtureData();
    for (const [channel, value] of [
      ['state:get', data.snapshot],
      ['settings:get', data.settings],
      ['updates:get', data.update],
    ] as const)
      expect(parseResult(channel, { ok: true, value })).toEqual({
        ok: true,
        value,
      });
    expect(
      parseResult('state:get', {
        ok: false,
        error: {
          code: 'REFRESH_FAILED',
          message: 'Try again.',
          retryable: true,
        },
      }).ok,
    ).toBe(false);
  });
  it.each([
    null,
    {},
    [],
    { ok: true },
    { ok: true, value: null },
    { ok: false, error: { code: 'raw', message: 'x', retryable: true } },
    { ok: false, error: { code: 'IO_ERROR', message: 'x', retryable: 'true' } },
  ])('rejects malformed envelopes: %j', (value) => {
    expect(() => parseResult('state:get', value)).toThrow();
  });
  it('rejects non-JSON responses, unsafe numeric generations and malformed events', () => {
    const data = fixtureData();
    expect(() =>
      parseResult('state:get', {
        ok: true,
        value: { ...data.snapshot, generation: Infinity },
      }),
    ).toThrow();
    expect(() =>
      parseResult('settings:get', {
        ok: true,
        value: { ...data.settings, extension: () => undefined },
      }),
    ).toThrow();
    expect(parseEvent('state:changed', { generation: 2 })).toEqual({
      generation: 2,
    });
    expect(parseEvent('settings:changed', data.settings)).toBe(data.settings);
    expect(parseEvent('updates:changed', data.update)).toBe(data.update);
    for (const value of [
      { generation: -1 },
      { generation: 1.5 },
      { generation: 2, unexpected: true },
      null,
    ])
      expect(() => parseEvent('state:changed', value)).toThrow();
    expect(() =>
      parseEvent('app:activate', { plan: 'x', route: 'execute' }),
    ).toThrow();
  });
});
