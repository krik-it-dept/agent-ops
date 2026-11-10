import type { WebContents } from 'electron';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { APP_DOCUMENT, assetHandler, PRODUCTION_CSP } from './assets';
import { guardWebContents } from './security';
import {
  assertNoLegacyInstance,
  LEGACY_RUNNING_MESSAGE,
} from './legacy-instance';
import { createRuntime } from './services';

describe('application-wide origin and legacy-writer boundaries', () => {
  it('denies new contents navigation, redirects, subframes, webviews and window opening', () => {
    const handlers = new Map<
      string,
      (event: { preventDefault(): void }) => void
    >();
    const contents = {
      setWindowOpenHandler: vi.fn(),
      on: (name: string, handler: (e: { preventDefault(): void }) => void) => {
        handlers.set(name, handler);
      },
    };
    guardWebContents(contents as unknown as WebContents);
    expect(contents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({
      action: 'deny',
    });
    for (const event of [
      'will-navigate',
      'will-frame-navigate',
      'will-redirect',
      'will-attach-webview',
    ]) {
      const preventDefault = vi.fn();
      handlers.get(event)!({ preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
    }
  });
  it('serves only the frozen app-origin asset map with response-header CSP, not arbitrary file URLs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-ops-assets-'));
    try {
      const renderer = join(root, 'renderer');
      await mkdir(renderer);
      await writeFile(join(renderer, 'index.html'), '<h1>Safe</h1>');
      await writeFile(join(root, 'private.js'), 'private');
      const handle = await assetHandler(renderer);
      const response = await handle(new Request(APP_DOCUMENT));
      expect(await response.text()).toBe('<h1>Safe</h1>');
      expect(response.headers.get('Content-Security-Policy')).toBe(
        PRODUCTION_CSP,
      );
      for (const url of [
        'file:///C:/private.js',
        'app://foreign/index.html',
        'app://agent-ops/../private.js',
        'app://agent-ops/%2e%2e/private.js',
        'app://agent-ops/index.html?inject=1',
      ])
        expect((await handle(new Request(url))).status).not.toBe(200);
      await writeFile(join(renderer, 'later.js'), 'late');
      expect(
        (await handle(new Request('app://agent-ops/later.js'))).status,
      ).toBe(404);
      expect(
        (await handle(new Request(APP_DOCUMENT, { method: 'POST' }))).status,
      ).toBe(403);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('permits absent/stale legacy sessions but fails closed for a live PID or unreadable/invalid session', () => {
    expect(() =>
      assertNoLegacyInstance('unused', {
        read: () => undefined,
        alive: () => true,
      }),
    ).not.toThrow();
    expect(() =>
      assertNoLegacyInstance('unused', {
        read: () => '{"pid":123}',
        alive: () => false,
      }),
    ).not.toThrow();
    for (const read of [
      () => '{"pid":123}',
      () => '{bad',
      () => '{"pid":0}',
      () => {
        throw new Error('locked');
      },
    ])
      expect(() =>
        assertNoLegacyInstance('unused', { read, alive: () => true }),
      ).toThrow(LEGACY_RUNNING_MESSAGE);
  });
  it('refuses startup without writing config, snapshots, overview or pointers while a real live PID owns a legacy session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-ops-legacy-running-'));
    try {
      const source = JSON.stringify({
        pid: process.pid,
        addr: '127.0.0.1:7790',
        secret: 'a'.repeat(64),
        version: 'v0.4.0',
      });
      await writeFile(join(root, 'session.json'), source);
      const runtime = createRuntime({
        dataDir: root,
        profileDir: join(root, 'profile'),
        version: 'v1.0.0',
        worker: () => {
          throw new Error('must not collect');
        },
        changed: vi.fn(),
      });
      await expect(runtime.start()).rejects.toThrow(LEGACY_RUNNING_MESSAGE);
      await runtime.stop();
      expect(await readdir(root)).toEqual(['session.json']);
      expect(await readFile(join(root, 'session.json'), 'utf8')).toBe(source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
