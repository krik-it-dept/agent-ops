import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchFixture } from './helpers';

test('sandbox, typed bridge, strict CSP, safe external targets and single instance', async () => {
  const fixture = await launchFixture();
  const { app, page, temp } = fixture;
  try {
    await expect(
      page.getByRole('heading', { name: 'Summary', exact: true }),
    ).toBeVisible();
    expect(new URL(page.url()).protocol).toBe('app:');
    expect(new URL(page.url()).host).toBe('agent-ops');
    const responseCsp = await app.evaluate(async ({ net }) =>
      (await net.fetch('app://agent-ops/index.html')).headers.get(
        'Content-Security-Policy',
      ),
    );
    expect(responseCsp).toContain("script-src 'self'");
    expect(responseCsp).toContain("frame-ancestors 'none'");
    const version = await app.evaluate(({ app }) => app.getVersion());
    expect(await page.evaluate(() => window.agentOps.app.getInfo({}))).toEqual({
      ok: true,
      value: {
        version,
        dataDir: temp,
        platform: 'win32',
        sampleModeAllowed: true,
      },
    });
    expect(
      await page.evaluate(() => ({
        require: typeof (window as unknown as { require?: unknown }).require,
        process: typeof (window as unknown as { process?: unknown }).process,
        keys: Object.keys(window.agentOps).sort(),
        settings: Object.keys(window.agentOps.settings).sort(),
      })),
    ).toEqual({
      require: 'undefined',
      process: 'undefined',
      keys: [
        'app',
        'diagnostics',
        'plans',
        'sessions',
        'settings',
        'shell',
        'skills',
        'state',
        'tasks',
        'updates',
        'workspaces',
      ],
      settings: ['get', 'onChanged', 'set'],
    });
    const csp = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute('content');
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = 'document.body.dataset.inlineExecuted="yes"';
      document.body.append(script);
      window.open('https://example.com');
    });
    expect(
      await page.locator('body').getAttribute('data-inline-executed'),
    ).toBeNull();
    expect(app.windows()).toHaveLength(1);
    await app.evaluate(({ shell }) => {
      const targets: string[] = [];
      Object.assign(globalThis, { smokeTargets: targets });
      shell.openExternal = async (url) => {
        targets.push(url);
      };
    });
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = '#';
      link.textContent = 'Trusted release target';
      link.dataset.agentOpsRelease = 'v0.5.0';
      link.addEventListener('click', (e) => {
        if (!e.isTrusted) e.preventDefault();
      });
      document.body.append(link);
      link.click();
    });
    const targets = () =>
      app.evaluate(
        () =>
          (globalThis as unknown as { smokeTargets: unknown[] }).smokeTargets,
      );
    expect(await targets()).toEqual([]);
    await page.getByRole('link', { name: 'Trusted release target' }).click();
    await expect
      .poll(targets)
      .toEqual([
        'https://github.com/krik-it-dept/agent-ops/releases/tag/v0.5.0',
      ]);
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      const event = {
        prevented: false,
        preventDefault() {
          this.prevented = true;
        },
      };
      contents.emit('will-navigate', event, 'https://example.com');
      if (!event.prevented) throw Error('Navigation was not denied');
      BrowserWindow.getAllWindows()[0]!.close();
    });
    expect(
      await app.evaluate(({ BrowserWindow }) => ({
        count: BrowserWindow.getAllWindows().length,
        visible: BrowserWindow.getAllWindows()[0]?.isVisible(),
      })),
    ).toEqual({ count: 1, visible: false });
    const reply = await page.evaluate(() =>
      window.agentOps.settings.set({ theme: 'dark' }),
    );
    expect(reply.ok).toBe(true);
    expect(
      JSON.parse(await readFile(join(temp, 'config.json'), 'utf8')),
    ).toMatchObject({ version: 1, theme: 'dark' });
    const executable = await app.evaluate(() => process.execPath);
    const env: NodeJS.ProcessEnv = { ...process.env, AGENT_OPS_DATA_DIR: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    const second = spawn(executable, [resolve('.')], {
      env,
      windowsHide: true,
      stdio: 'ignore',
    });
    const code = await new Promise<number | null>((done, reject) => {
      const timer = setTimeout(() => {
        second.kill();
        reject(Error('Second instance did not exit'));
      }, 10_000);
      second.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      second.once('exit', (code) => {
        clearTimeout(timer);
        done(code);
      });
    });
    expect(code).toBe(0);
    // A busy CI machine can take longer than the default 10 s to deliver the
    // second-instance message to the first instance.
    await expect
      .poll(
        () =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]!.isVisible(),
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    expect(app.windows()).toHaveLength(1);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});
