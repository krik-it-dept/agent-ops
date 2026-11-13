import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { SkillsError } from '../modules/skills';
import { mapError } from './errors';
import {
  createServiceHandler,
  registerApplicationIpc,
  type RegistryOptions,
} from './registry';
import { parseRequest, requestSchemas, type Channel } from './requests';
import type { StateResponse } from '../../shared/contracts';

function context(handlers: RegistryOptions['handlers'] = {}) {
  const frame = { url: 'file:///C:/app/index.html#/list' };
  const webContents = {
    mainFrame: frame,
    isDestroyed: () => false,
  } as unknown as WebContents;
  const event = {
    sender: webContents,
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent;
  return {
    options: {
      webContents,
      rendererURL: 'file:///C:/app/index.html',
      handlers,
    } satisfies RegistryOptions,
    event,
  };
}
describe('application IPC registry', () => {
  it('maps every Skills error code at the boundary', () => {
    for (const [from, to] of [
      ['invalid-input', 'INVALID_REQUEST'],
      ['not-found', 'NOT_FOUND'],
      ['conflict', 'CONFLICT'],
      ['unavailable', 'UNAVAILABLE'],
      ['failed', 'IO_ERROR'],
    ] as const)
      expect(mapError(new SkillsError(from, 'Owner message'))).toMatchObject({
        code: to,
        message: 'Owner message',
      });
  });
  it('rejects foreign/destroyed windows, subframes and changed documents before any service', async () => {
    const action = vi.fn();
    const { options, event } = context({ 'state:get': action });
    const handler = createServiceHandler('state:get', options);
    for (const bad of [
      { ...event, sender: {} },
      { ...event, senderFrame: null },
      { ...event, senderFrame: { url: options.rendererURL } },
    ]) {
      expect(
        await handler(bad as unknown as IpcMainInvokeEvent, {}),
      ).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    Object.assign(options.webContents.mainFrame, {
      url: options.rendererURL + '?other',
    });
    expect(await handler(event, {})).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(action).not.toHaveBeenCalled();
  });
  it('checks one strictly typed bounded payload and maps owner-facing failures', async () => {
    const action = vi.fn(async () => {
      throw new SkillsError('conflict', 'The skill was changed.');
    });
    const { options, event } = context({ 'skills:install': action });
    const handler = createServiceHandler('skills:install', options);
    for (const payload of [
      null,
      undefined,
      { id: '../escape' },
      { id: 'tool', extra: true },
      { id: 'x'.repeat(10000) },
      new Date(),
    ]) {
      expect(await handler(event, payload)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_REQUEST' },
      });
    }
    expect(await handler(event, { id: 'tool' }, {})).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
    expect(action).not.toHaveBeenCalled();
    expect(await handler(event, { id: 'tool' })).toEqual({
      ok: false,
      error: {
        code: 'CONFLICT',
        message: 'The skill was changed.',
        retryable: false,
      },
    });
  });
  it('returns unavailable for unfinished plug-ins, never invented successful data', async () => {
    const { options, event } = context();
    expect(
      await createServiceHandler('updates:get', options)(event, {}),
    ).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
  });
  it('validates results, redacts exceptions and emits correlation ids to local logging', async () => {
    const log = vi.fn();
    const { options, event } = context({
      'state:get': () => ({ bad: 'PRIVATE PLAN' }) as unknown as StateResponse,
    });
    const result = await createServiceHandler('state:get', { ...options, log })(
      event,
      {},
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL', correlationId: expect.any(String) },
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(log).toHaveBeenCalledTimes(1);
  });
  it('registers every domain exactly once, rolls back partial registration and disposes idempotently', () => {
    const { options } = context();
    const registered = new Map<string, unknown>();
    const ipc = {
      handle: (c: string, h: unknown) => registered.set(c, h),
      removeHandler: vi.fn((c: string) => registered.delete(c)),
    } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>;
    const dispose = registerApplicationIpc(ipc, options);
    expect([...registered.keys()].sort()).toEqual(
      Object.keys(requestSchemas).sort(),
    );
    dispose();
    dispose();
    expect(registered.size).toBe(0);
    expect(ipc.removeHandler).toHaveBeenCalledTimes(
      Object.keys(requestSchemas).length,
    );
    const removeHandler = vi.fn();
    let count = 0;
    expect(() =>
      registerApplicationIpc(
        {
          handle: () => {
            if (++count === 3) throw new Error('registration failed');
          },
          removeHandler,
        } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>,
        options,
      ),
    ).toThrow('registration failed');
    expect(removeHandler).toHaveBeenCalledTimes(2);
  });
  it('has request validators for every document channel and rejects empty/oversized or unsafe variants', () => {
    expect(Object.keys(requestSchemas)).toHaveLength(42);
    expect(
      parseRequest('plans:set-status', {
        key: 'tasks/team/plan',
        revision: 'a'.repeat(64),
        status: 'Implementing',
      }),
    ).toMatchObject({ status: 'Implementing' });
    expect(() =>
      parseRequest('plans:set-status', {
        key: 'tasks/team/plan',
        revision: 'a'.repeat(64),
        status: 'Anything',
      }),
    ).toThrow();
    expect(() =>
      parseRequest('plans:set-status', {
        key: 'tasks/team/plan',
        revision: 'a'.repeat(64),
        status: 'Planning',
        path: 'C:/outside.md',
      }),
    ).toThrow();
    expect(parseRequest('tasks:move-legacy', { keys: [] })).toEqual({
      keys: [],
    });
    expect(
      parseRequest('plans:recycle', {
        key: 'tasks/team/plan',
        revision: 'a'.repeat(64),
        confirm: true,
      }),
    ).toMatchObject({ confirm: true });
    expect(
      parseRequest('plans:mark-done', {
        key: 'tasks/team/plan',
        revision: 'a'.repeat(64),
      }),
    ).toEqual({ key: 'tasks/team/plan', revision: 'a'.repeat(64) });
    expect(
      parseRequest('plans:undo-mark-done', {
        key: 'tasks/team/plan',
        token: 'b'.repeat(32),
      }),
    ).toEqual({ key: 'tasks/team/plan', token: 'b'.repeat(32) });
    for (const [channel, payload] of [
      ['settings:set', { theme: null }],
      ['settings:set', { theme: 'auto' }],
      [
        'plans:recycle',
        { key: 'plan', revision: 'a'.repeat(64), confirm: false },
      ],
      ['plans:mark-done', { key: 'plan', revision: 'short' }],
      [
        'plans:mark-done',
        { key: 'plan', revision: 'a'.repeat(64), path: 'C:/plan.md' },
      ],
      [
        'plans:mark-done',
        { key: 'plan', revision: 'a'.repeat(64), status: 'Done' },
      ],
      ['plans:undo-mark-done', { key: 'plan', token: 'not-a-token' }],
      ['plans:undo-mark-done', { key: 'plan' }],
      ['shell:open-folder', { target: 'data', path: 'C:/owner' }],
      ['shell:open-external', { url: 'https://example.com' }],
      ['updates:apply', { version: 'v01.0.0' }],
      ['workspaces:add', { path: 'C:/a\0b' }],
      ['tasks:move-legacy', { keys: Array(2000).fill('x'.repeat(1024)) }],
    ] as const)
      expect(() => parseRequest(channel as Channel, payload)).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => parseRequest('settings:set', cyclic)).toThrow();
  });
});
