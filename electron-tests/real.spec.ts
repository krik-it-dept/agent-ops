import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from '@playwright/test';
import { build } from 'vite';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BackendControls } from './backend';
import { navigate } from './helpers';

let harnessRoot: string;
test.beforeAll(async () => {
  harnessRoot = await mkdtemp(join(tmpdir(), 'agent-ops-e2e-entry-'));
  await build({
    configFile: false,
    logLevel: 'error',
    build: {
      ssr: resolve('electron-tests/backend.ts'),
      outDir: harnessRoot,
      emptyOutDir: false,
      rollupOptions: {
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: 'backend.cjs' },
      },
    },
  });
});
test.afterAll(async () => {
  if (harnessRoot)
    await rm(harnessRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
});
async function start(
  prepare?: (root: string) => Promise<void>,
  args: string[] = [],
) {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-real-e2e-'));
  try {
    await mkdir(join(root, 'data'));
    await prepare?.(root);
    const env: Record<string, string> = Object.fromEntries(
      Object.entries({
        ...process.env,
        AGENT_OPS_DATA_DIR: join(root, 'data'),
        AGENT_OPS_TEST_ROOT: root,
        AGENT_OPS_E2E: '1',
        AGENT_OPS_TEST_ENTRY: resolve('out/main/index.cjs'),
        AGENT_OPS_UI_FIXTURES: '0',
      }).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RENDERER_URL;
    const app = await electron.launch({
      args: [join(harnessRoot, 'backend.cjs'), ...args],
      env,
    });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('.app').waitFor();
    return {
      root,
      app,
      page,
      errors,
      close: async () => {
        await app.close();
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      },
    };
  } catch (error) {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
    throw error;
  }
}
async function controls(
  app: ElectronApplication,
  change: {
    pick?: string;
    complete?: boolean;
    failCheck?: boolean;
    failInstall?: boolean;
  } = {},
) {
  return app.evaluate((_electron, change) => {
    const control = (globalThis as unknown as { agentOpsE2E: BackendControls })
      .agentOpsE2E;
    if (change.pick) control.picks.push(change.pick);
    if (change.complete) control.completeDownload?.();
    if (change.failCheck) control.failCheck = true;
    if (change.failInstall) control.failInstall = true;
    return {
      opened: control.opened,
      trashed: control.trashed,
      installs: control.installs,
    };
  }, change);
}
const planText =
  'Status: Implementing\nGoal: Ship a real feature\nNext: Verify the reader\n- [doing] Build from real files\n';
test('initial protocol activation waits for the real reader and the renderer listener', async () => {
  const f = await start(
    async (root) => {
      const tasks = join(root, 'Tasks');
      await mkdir(join(tasks, 'workspace'), { recursive: true });
      await writeFile(join(tasks, 'workspace', 'launch-plan.md'), planText);
      await writeFile(
        join(root, 'data', 'config.json'),
        JSON.stringify({
          version: 1,
          setupComplete: true,
          projects: [],
          tasksDir: tasks,
          notifications: true,
          shortcuts: true,
          autoArchiveDone: false,
        }),
      );
    },
    ['agent-ops:open?plan=tasks%2Fworkspace%2Flaunch-plan'],
  );
  try {
    await expect(
      f.page.getByRole('heading', { name: 'launch-plan', exact: true }),
    ).toBeVisible();
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});
test('Board refuses a revision refreshed during a drag and preserves the agent save', async () => {
  const source = 'Status: Testing\nNext: Owner saw this\nGoal: Ship\n';
  const f = await start(async (root) => {
    const tasks = join(root, 'Tasks');
    await mkdir(join(tasks, 'web'), { recursive: true });
    await writeFile(join(tasks, 'web', 'ship.md'), source);
    await writeFile(
      join(root, 'data', 'config.json'),
      JSON.stringify({
        version: 1,
        setupComplete: true,
        projects: [],
        tasksDir: tasks,
        autoArchiveDone: true,
      }),
    );
  });
  try {
    const { page, root } = f;
    await navigate(page, '/board');
    const card = page.locator('.work-card[data-plan-key="tasks/web/ship"]');
    await expect(card).toContainText('Owner saw this');
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await card.dispatchEvent('dragstart', { dataTransfer: transfer });
    await expect(page.locator('.board-column.drop-target')).toHaveCount(4);
    const changed = source.replace(
      'Owner saw this',
      'Agent changed this while dragging',
    );
    const file = join(root, 'Tasks', 'web', 'ship.md');
    await writeFile(file, changed);
    await page.evaluate(() => window.agentOps.state.refresh({}));
    await expect(card).toContainText('Agent changed this while dragging');
    await page
      .getByRole('region', { name: 'Done', exact: true })
      .dispatchEvent('drop', { dataTransfer: transfer });
    await expect(page.getByRole('alert')).toContainText(
      'This plan changed. Look again before marking it Done.',
    );
    expect(await readFile(file, 'utf8')).toBe(changed);
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await card.locator('summary').focus();
    await page.keyboard.press('Enter');
    await card.getByRole('button', { name: 'Mark as Done' }).focus();
    await page.keyboard.press('Enter');
    const undo = page.locator('.toast').getByRole('button', { name: 'Undo' });
    await expect(card).toHaveCount(0);
    await expect(undo).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(card).toContainText('Agent changed this while dragging');
    await expect(card.locator('summary')).toBeFocused();
    expect(await readFile(file, 'utf8')).toBe(changed);
    // A same-column drop is ignored; a double drop consumes one drag only.
    const sameColumn = page.getByRole('region', {
      name: 'Review & test',
      exact: true,
    });
    const sameTransfer = await page.evaluateHandle(() => new DataTransfer());
    await card.dispatchEvent('dragstart', { dataTransfer: sameTransfer });
    await sameColumn.dispatchEvent('drop', { dataTransfer: sameTransfer });
    await card.dispatchEvent('dragend', { dataTransfer: sameTransfer });
    expect(await readFile(file, 'utf8')).toBe(changed);
    const doubleTransfer = await page.evaluateHandle(() => new DataTransfer());
    await card.dispatchEvent('dragstart', { dataTransfer: doubleTransfer });
    await page
      .getByRole('region', { name: 'Done', exact: true })
      .evaluate((target, transfer) => {
        target.dispatchEvent(
          new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          }),
        );
        target.dispatchEvent(
          new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          }),
        );
      }, doubleTransfer);
    await expect(page.locator('.toast')).toContainText('Marked ship Done');
    const backups = await readdir(join(root, 'data', 'backups', 'plan-edits'));
    expect(backups).toHaveLength(2);
    const result = await page.evaluate(() => window.agentOps.state.get({}));
    expect(
      result.ok &&
        result.value.activity.filter(
          (e) => e.text === 'Marked Done in Agent Ops',
        ),
    ).toHaveLength(2);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test('real first-run setup, native picker port, Skills install, Tasks move, live ledger, archive and recoverable delete', async () => {
  const f = await start(async (root) => {
    await mkdir(join(root, 'workspace', '.tasks'), { recursive: true });
    await writeFile(
      join(root, 'workspace', '.tasks', 'real-plan.md'),
      planText,
    );
    await mkdir(join(root, 'data', 'profile', '.agents', 'skills'), {
      recursive: true,
    });
  });
  const { page, app, root } = f;
  try {
    await expect(
      page.getByRole('dialog', { name: 'Agent Ops setup' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await controls(app, { pick: join(root, 'workspace') });
    await page.getByRole('button', { name: /^Choose folder/ }).click();
    await expect(
      page.getByRole('heading', { name: 'workspace', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Connect your AI tools' }),
    ).toBeVisible();
    await page.getByRole('checkbox', { name: /Codex/ }).check();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const skillFile = join(
      root,
      'data',
      'profile',
      '.agents',
      'skills',
      'task-plan',
      'SKILL.md',
    );
    await expect(
      page.getByRole('heading', { name: 'Tasks', exact: true }),
    ).toBeVisible();
    expect(await readFile(skillFile, 'utf8')).toBe(
      await readFile('skills/task-plan/SKILL.md', 'utf8'),
    );
    await page
      .getByLabel('Tasks folder', { exact: true })
      .fill(join(root, 'Tasks'));
    await page.getByRole('button', { name: 'Use folder', exact: true }).click();
    const confirmation = page.getByRole('group', {
      name: 'Confirm Tasks folder',
    });
    await expect(confirmation.getByRole('checkbox')).toBeChecked();
    await confirmation
      .getByRole('button', { name: 'Change Tasks folder' })
      .click();
    await expect(confirmation).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Move them here', exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: 'Plan move results' }),
    ).toContainText('1 moved');
    await page.getByLabel('Theme', { exact: true }).selectOption('dark');
    await page
      .getByRole('button', { name: 'Open ledger', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Summary', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Sample workspace', { exact: true }),
    ).toHaveCount(0);
    const moved = join(root, 'Tasks', 'workspace', 'real-plan.md');
    expect(await readFile(moved, 'utf8')).toBe(planText);
    const config = JSON.parse(
      await readFile(join(root, 'data', 'config.json'), 'utf8'),
    );
    expect(config).toMatchObject({
      version: 1,
      setupComplete: true,
      theme: 'dark',
      tasksDir: join(root, 'Tasks'),
    });
    expect(config.integrations[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    await navigate(
      page,
      '/plan/' + encodeURIComponent('tasks/workspace/real-plan') + '/summary',
    );
    await expect(
      page.getByRole('heading', { name: 'real-plan', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Ship a real feature', { exact: true }),
    ).toBeVisible();
    await page.locator('.plan-header .plan-actions summary').click();
    await page.getByRole('button', { name: 'Open plan folder' }).click();
    await page.locator('.plan-header .plan-actions summary').click();
    await expect
      .poll(async () => (await controls(app)).opened)
      .toContain(realpathSync.native(join(root, 'Tasks', 'workspace')));
    const changed = planText
      .replace('Implementing', 'Testing')
      .replace('Ship a real feature', 'Live file refresh works');
    await writeFile(moved, changed);
    await expect(
      page.getByText('Live file refresh works', { exact: true }),
    ).toBeVisible();
    const actions = page.locator('.plan-header .plan-actions');
    await actions.locator('summary').click();
    await actions.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(
      actions.getByRole('button', { name: 'Unarchive', exact: true }),
    ).toBeVisible();
    expect(await readFile(moved, 'utf8')).toBe(changed);
    await actions
      .getByRole('button', { name: 'Unarchive', exact: true })
      .click();
    await expect(
      actions.getByRole('button', { name: 'Archive', exact: true }),
    ).toBeVisible();
    // Mark as Done changes only the Status value, byte for byte, and Undo
    // puts the original bytes back.
    const crlf = (text: string) =>
      String.fromCharCode(0xfeff) + text.replace(/\n/g, '\r\n');
    const original = Buffer.from(crlf(changed));
    await writeFile(moved, original);
    const revision = createHash('sha256').update(original).digest('hex');
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const result = await window.agentOps.state.get({});
          return result.ok
            ? result.value.state.plans.find((p) => p.name === 'real-plan')
                ?.revision
            : '';
        }),
      )
      .toBe(revision);
    await actions
      .getByRole('button', { name: 'Mark as Done', exact: true })
      .click();
    const toast = page.locator('.toast');
    await expect(toast).toContainText('Marked real-plan Done');
    expect(await readFile(moved)).toEqual(
      Buffer.from(crlf(changed.replace('Status: Testing', 'Status: Done'))),
    );
    const edits = join(root, 'data', 'backups', 'plan-edits');
    const [backup] = await readdir(edits);
    expect(
      await readFile(join(edits, backup!, 'workspace', 'real-plan.md')),
    ).toEqual(original);
    await expect(
      page
        .locator('.plan-header')
        .getByLabel('Plan state for real-plan', { exact: true }),
    ).toHaveValue('Done');
    await toast.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(toast).toContainText('real-plan is back to Testing');
    expect(await readFile(moved)).toEqual(original);
    await actions.locator('summary').click();
    await actions.getByRole('button', { name: /Delete/ }).click();
    const dialog = page.getByRole('dialog', {
      name: 'Move this plan to the Recycle Bin?',
    });
    await expect(
      dialog.getByRole('button', { name: 'Cancel', exact: true }),
    ).toBeFocused();
    await dialog
      .getByRole('button', { name: 'Move to Recycle Bin', exact: true })
      .click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Moved to the Recycle Bin.' }),
    ).toBeVisible();
    const result = await controls(app);
    expect(result.trashed).toHaveLength(1);
    expect(await readFile(result.trashed[0]!)).toEqual(original);
    await expect(readFile(moved)).rejects.toMatchObject({ code: 'ENOENT' });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test('real Skills update and explicit replace keep backups in a temporary profile', async () => {
  const canonical = await readFile('skills/task-plan/SKILL.md', 'utf8');
  const old = canonical.replace(/agent-ops-skill: \d+/, 'agent-ops-skill: 2');
  const f = await start(async (root) => {
    const skillDir = join(root, 'profile', 'test-skills');
    await mkdir(join(skillDir, 'task-plan'), { recursive: true });
    await writeFile(join(skillDir, 'task-plan', 'SKILL.md'), old);
    await writeFile(
      join(root, 'data', 'config.json'),
      JSON.stringify({
        version: 1,
        setupComplete: true,
        projects: [],
        notifications: true,
        shortcuts: true,
        autoArchiveDone: false,
        integrationsSeeded: true,
        integrations: [
          {
            id: 'test-tool',
            label: 'Test tool',
            skillDir,
            instructionBlock: false,
            enabled: true,
            source: 'custom',
            version: 2,
            sha256: createHash('sha256')
              .update(old.replaceAll('\r\n', '\n'))
              .digest('hex'),
          },
        ],
      }),
    );
  });
  try {
    await navigate(f.page, '/settings/integrations');
    const card = f.page.locator('li[aria-label="Test tool"]');
    const file = join(
      f.root,
      'profile',
      'test-skills',
      'task-plan',
      'SKILL.md',
    );
    await expect(card).toContainText('Update available');
    await card.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(card).toContainText('Installed v5');
    expect(await readFile(file, 'utf8')).toBe(canonical);
    const changed = canonical + '\nOwner changes to preserve\n';
    await writeFile(file, changed);
    await navigate(f.page, '/settings/general');
    await navigate(f.page, '/settings/integrations');
    await expect(card).toContainText('Modified locally');
    await card.getByRole('button', { name: 'Replace', exact: true }).click();
    expect(await readFile(file, 'utf8')).toBe(changed);
    await card.getByRole('button', { name: 'Click again to replace' }).click();
    await expect(card).toContainText('Installed v5');
    expect(await readFile(file, 'utf8')).toBe(canonical);
    const backupFiles = await readdir(join(f.root, 'data', 'backups'), {
      recursive: true,
    });
    const saved = [];
    for (const relative of backupFiles) {
      try {
        saved.push(
          await readFile(join(f.root, 'data', 'backups', relative), 'utf8'),
        );
      } catch {
        /* Directories. */
      }
    }
    expect(saved).toContain(old);
    expect(saved).toContain(changed);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test('real update handlers and events follow a fake provider through failure, offer, progress and restart', async () => {
  const f = await start(async (root) => {
    await writeFile(
      join(root, 'data', 'config.json'),
      JSON.stringify({
        version: 1,
        setupComplete: true,
        projects: [],
        notifications: true,
        shortcuts: true,
        autoArchiveDone: false,
      }),
    );
  });
  try {
    await navigate(f.page, '/settings/about');
    await controls(f.app, { failCheck: true });
    await f.page
      .getByRole('button', { name: 'Check for updates', exact: true })
      .click();
    await expect(
      f.page.getByRole('button', { name: 'Try again', exact: true }),
    ).toBeVisible();
    await f.page
      .getByRole('button', { name: 'Try again', exact: true })
      .click();
    await expect(
      f.page.getByRole('button', { name: 'Update and restart', exact: true }),
    ).toBeVisible();
    await controls(f.app, { failInstall: true });
    await f.page
      .getByRole('button', { name: 'Update and restart', exact: true })
      .click();
    await expect(
      f.page
        .getByRole('region', { name: 'Software update' })
        .getByRole('status'),
    ).toContainText('Downloading');
    expect(
      await f.page.evaluate(() => window.agentOps.updates.get({})),
    ).toMatchObject({
      ok: true,
      value: { phase: 'downloading', message: expect.stringContaining('50%') },
    });
    await controls(f.app, { complete: true });
    await expect(
      f.page.getByRole('button', { name: 'Try again', exact: true }),
    ).toBeVisible();
    await navigate(f.page, '/settings/general');
    await f.page.getByLabel('Theme', { exact: true }).selectOption('dark');
    await expect(f.page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(
      JSON.parse(await readFile(join(f.root, 'data', 'config.json'), 'utf8'))
        .theme,
    ).toBe('dark');
    await navigate(f.page, '/settings/about');
    await f.page
      .getByRole('button', { name: 'Try again', exact: true })
      .click();
    await expect(
      f.page
        .getByRole('region', { name: 'Software update' })
        .getByRole('status'),
    ).toContainText('Downloading');
    await controls(f.app, { complete: true });
    await expect.poll(async () => (await controls(f.app)).installs).toBe(1);
    await expect(
      f.page.getByText(/Agent Ops will restart automatically/).first(),
    ).toBeVisible();
    expect(
      JSON.parse(
        await readFile(join(f.root, 'data', 'update-result.json'), 'utf8'),
      ),
    ).toMatchObject({ phase: 'restarting', version: 'v1.1.0' });
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test('sample hash and stored fixture preference cannot replace real data without the dev flag', async () => {
  const f = await start();
  try {
    await f.page.evaluate(() =>
      sessionStorage.setItem('agent-ops-ui-fixture', 'demo'),
    );
    await f.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      return window.loadURL(
        window.webContents.getURL().split('#')[0] + '#/?fixture=demo',
      );
    });
    await expect(
      f.page.getByRole('heading', { name: 'Summary', exact: true }),
    ).toBeVisible();
    await expect(
      f.page.getByText('Sample workspace', { exact: true }),
    ).toHaveCount(0);
    expect(
      await f.page.evaluate(() => window.agentOps.app.getInfo({})),
    ).toMatchObject({ ok: true, value: { sampleModeAllowed: false } });
  } finally {
    await f.close();
  }
});

test('headless health CLI prints one receipt, exits promptly and leaves default-format data unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-health-cli-'));
  const source = '{"version":1,"projects":[],"theme":"dark","private":"keep"}';
  try {
    await writeFile(join(root, 'config.json'), source);
    await writeFile(join(root, 'private-runtime.txt'), 'leave alone');
    const env: NodeJS.ProcessEnv = { ...process.env, AGENT_OPS_DATA_DIR: root };
    delete env.ELECTRON_RUN_AS_NODE;
    const executable = createRequire(resolve('package.json'))(
      'electron',
    ) as string;
    for (const [config, code] of [
      [source, 0],
      ['{bad config', 1],
    ] as const) {
      await writeFile(join(root, 'config.json'), config);
      const child = spawn(executable, [resolve('.'), '--health-check'], {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let stderr = '';
      child.stdout.on('data', (data: Buffer) => {
        output += data.toString();
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      const exit = await new Promise<number | null>((resolveExit, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('Health CLI did not exit'));
        }, 8000);
        child.once('error', reject);
        child.once('exit', (code) => {
          clearTimeout(timer);
          resolveExit(code);
        });
      });
      expect(exit, stderr).toBe(code);
      const lines = output.trim().split(/\r?\n/);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({
        kind: 'agent-ops-health',
        ok: code === 0,
      });
      expect((await readdir(root)).sort()).toEqual([
        'config.json',
        'private-runtime.txt',
      ]);
      expect(await readFile(join(root, 'config.json'), 'utf8')).toBe(config);
    }
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});
