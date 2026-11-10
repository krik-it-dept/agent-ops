import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FixtureMode } from '../src/renderer/dev/fixture-bridge';

export interface FixtureApp {
  app: ElectronApplication;
  page: Page;
  temp: string;
  errors: string[];
  close(): Promise<void>;
}
export async function launchFixture(
  mode: FixtureMode = 'demo',
  theme: 'light' | 'dark' | 'system' = 'light',
): Promise<FixtureApp> {
  const temp = await mkdtemp(join(tmpdir(), 'agent-ops-react-ui-'));
  const env: Record<string, string> = Object.fromEntries(
    Object.entries({
      ...process.env,
      AGENT_OPS_DATA_DIR: temp,
      AGENT_OPS_UI_FIXTURES: '1',
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  let app: ElectronApplication;
  try {
    app = await electron.launch({ args: [resolve('.')], env });
  } catch (error) {
    await rm(temp, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
    throw error;
  }
  try {
    const page = await app.firstWindow(),
      errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('.app').waitFor();
    // Finish the real startup/activation handshake before navigating to a sample URL.
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const result = await window.agentOps.state.get({});
          return result.ok ? result.value.generation : 0;
        }),
      )
      .toBeGreaterThan(0);
    const url = page.url().split('#')[0] + `#/?fixture=${mode}&theme=${theme}`;
    await app.evaluate(
      ({ BrowserWindow }, url) =>
        BrowserWindow.getAllWindows()[0]!.loadURL(url),
      url,
    );
    await app.evaluate(
      ({ BrowserWindow }) =>
        new Promise<void>((resolve) => {
          const contents = BrowserWindow.getAllWindows()[0]!.webContents;
          contents.once('did-finish-load', () => resolve());
          contents.reload();
        }),
    );
    await expect(
      page.getByText('Sample workspace', { exact: true }),
    ).toBeVisible();
    if (mode !== 'loading')
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    return {
      app,
      page,
      temp,
      errors,
      close: async () => {
        await app.close();
        await rm(temp, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      },
    };
  } catch (error) {
    await app.close();
    await rm(temp, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
    throw error;
  }
}
export async function navigate(page: Page, path: string) {
  await page.evaluate((route) => {
    location.hash = route;
  }, path);
}
