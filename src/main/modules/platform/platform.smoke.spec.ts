import { _electron as electron, expect, test } from '@playwright/test';
import { build } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PlatformServices } from './electron';

interface PlatformSmokeHook {
  services: PlatformServices;
  attached: ReturnType<PlatformServices['attachWindow']>;
  activations: unknown[];
}
declare global {
  var agentOpsPlatformSmoke: PlatformSmokeHook | undefined;
}

test('built app creates its native tray and redacted diagnostics in an isolated profile', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'agent-ops-platform-smoke-'));
  const profile = join(temp, 'profile'),
    bundle = join(temp, 'bundle');
  // Build only the owned service module; integration owns the app's production entry.
  await build({
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    build: {
      outDir: bundle,
      emptyOutDir: true,
      lib: {
        entry: resolve('src/main/modules/platform/index.ts'),
        formats: ['cjs'],
        fileName: () => 'platform.cjs',
      },
      rollupOptions: { external: ['electron', /^node:/] },
    },
  });
  const env: Record<string, string> = Object.fromEntries(
    Object.entries({
      ...process.env,
      AGENT_OPS_DATA_DIR: profile,
      AGENT_OPS_REGISTER: '0',
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const application = await electron.launch({ args: [resolve('.')], env });
  try {
    const page = await application.firstWindow();
    await expect(
      page.getByRole('heading', { name: 'Ledger', exact: true }),
    ).toBeVisible();
    const initial = await application.evaluate(
      ({ BrowserWindow }, parameters) => {
        const load = process
          .getBuiltinModule('node:module')
          .createRequire(parameters.modulePath);
        const module = load(
          parameters.modulePath,
        ) as typeof import('./electron');
        const services = module.createPlatformServices({
          dataDir: parameters.profile,
          resourcesDir: parameters.resources,
          allowPath: () => false,
          theme: async () => 'unknown',
          commands: async () => {
            throw new Error('Smoke must not invoke Windows commands.');
          },
          snapshot: () => ({
            counts: { plans: 3 },
            settings: { notifications: false },
          }),
        });
        const window = BrowserWindow.getAllWindows()[0]!;
        const activations: unknown[] = [];
        const attached = services.attachWindow(window, {
          activate: (value) => {
            activations.push(value);
          },
          refresh: () => {},
        });
        globalThis.agentOpsPlatformSmoke = { services, attached, activations };
        // Equivalent to the queued initial activation after the trusted frame loads.
        attached.open();
        return {
          visible: window.isVisible(),
          tray: attached.testState(),
          diagnostics: services.diagnostics.collectDiagnostics(),
          registration: services.protocol.register(),
          startup: services.startup.get(),
        };
      },
      {
        modulePath: join(bundle, 'platform.cjs'),
        profile,
        resources: resolve('resources'),
      },
    );
    expect(initial.visible).toBe(true);
    expect(initial.tray).toEqual({ trayCreated: true });
    expect(initial.registration).toBe(false);
    expect(initial.startup.managed).toBe(false);
    expect(initial.diagnostics).toMatchObject({
      counts: { plans: 3 },
      settings: { notifications: false, registrationManaged: false },
    });
    expect(JSON.stringify(initial.diagnostics)).not.toContain(temp);
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.close(),
    );
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) => ({
          windows: BrowserWindow.getAllWindows().length,
          visible: BrowserWindow.getAllWindows()[0]?.isVisible(),
        })),
      )
      .toEqual({ windows: 1, visible: false });
    await application.evaluate(() =>
      globalThis.agentOpsPlatformSmoke!.attached.open({ settings: true }),
    );
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.isVisible(),
        ),
      )
      .toBe(true);
    const result = await application.evaluate(() => {
      const hook = globalThis.agentOpsPlatformSmoke!;
      const text = hook.services.diagnostics.get().text;
      hook.services.dispose();
      return {
        activations: hook.activations,
        text,
        tray: hook.attached.testState(),
      };
    });
    expect(result.activations).toEqual([{}, { settings: true }]);
    expect(result.text).toContain('Agent Ops diagnostics');
    expect(result.text).not.toContain(temp);
    expect(result.tray).toEqual({ trayCreated: false });
  } finally {
    await application
      .evaluate(() => {
        globalThis.agentOpsPlatformSmoke?.services.dispose();
        globalThis.agentOpsPlatformSmoke = undefined;
      })
      .catch(() => {});
    await application.close();
    await rm(temp, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});
