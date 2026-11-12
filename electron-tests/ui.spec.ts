import { expect, test } from '@playwright/test';
import { launchFixture, navigate } from './helpers';

const key = 'studio/Ledger/Cải thiện tìm kiếm';
for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: plan navigation, source milestones, search, refresh preservation, task filters and plan actions`, async () => {
    const fixture = await launchFixture('demo', theme);
    const { page } = fixture;
    try {
      await expect(
        page.getByRole('heading', { name: 'Summary', exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => getComputedStyle(document.body).backgroundColor,
        ),
      ).toBe(theme === 'dark' ? 'rgb(25, 25, 25)' : 'rgb(250, 250, 250)');
      expect(await page.locator('body').innerText()).not.toMatch(
        /repository|\bGit\b|GitHub|worktree|Detached HEAD|main checkout/i,
      );
      await page.getByRole('button', { name: 'Dismiss update' }).click();
      await page.screenshot({
        path: test.info().outputPath(`overview-${theme}.png`),
      });
      await page.keyboard.press('Control+k');
      const command = page.getByRole('combobox', {
        name: 'Search plans or commands',
      });
      await command.fill('cai thien');
      await command.press('Enter');
      await expect(
        page.getByRole('heading', { name: 'Cải thiện tìm kiếm', exact: true }),
      ).toBeVisible();
      const milestones = page.locator('details.milestone');
      await expect(milestones.nth(0)).not.toHaveAttribute('open');
      await expect(milestones.nth(1)).toHaveAttribute('open');
      await expect(
        page.getByRole('progressbar', { name: 'Plan progress', exact: true }),
      ).toHaveAttribute('aria-valuetext', '2 of 5 steps');
      await milestones.nth(1).locator('summary').click();
      await expect(milestones.nth(1)).not.toHaveAttribute('open');
      const search = page.getByRole('searchbox', { name: 'Search this plan' });
      await search.focus();
      await page.evaluate(() => {
        const view = document.querySelector<HTMLElement>('.view');
        if (view) view.scrollTop = 100;
        Object.assign(window, {
          keptPlanNode: document.querySelector('.plan-page'),
          keptMilestoneNode: document.querySelectorAll('.milestone')[1],
          keptScrollTop: view?.scrollTop || 0,
        });
      });
      await page.keyboard.press('F5');
      await expect(
        page.getByText('Progress updated', { exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(() => {
          const saved = window as unknown as {
            keptPlanNode: Element;
            keptMilestoneNode: Element;
          };
          return (
            saved.keptPlanNode === document.querySelector('.plan-page') &&
            saved.keptMilestoneNode ===
              document.querySelectorAll('.milestone')[1]
          );
        }),
      ).toBe(true);
      await expect(search).toBeFocused();
      expect(
        await page.evaluate(() => document.querySelector('.view')?.scrollTop),
      ).toBe(
        await page.evaluate(
          () => (window as unknown as { keptScrollTop: number }).keptScrollTop,
        ),
      );
      await expect(milestones.nth(1)).not.toHaveAttribute('open');
      await page.getByRole('tab', { name: 'Decisions 1' }).click();
      await expect(page.getByRole('tabpanel')).toContainText(
        'Giữ tiếng Việt và thứ tự nguồn',
      );
      await expect(page.getByRole('tabpanel')).not.toContainText(
        'Đối chiếu nội dung hiện có',
      );
      await page.getByRole('tab', { name: 'Questions 1' }).click();
      await expect(page.getByRole('tabpanel')).toContainText(
        'Chốt bộ dữ liệu mẫu?',
      );
      await page.getByRole('tab', { name: 'Activity' }).click();
      await expect(page.getByRole('tabpanel')).toContainText('Minh');
      await page.keyboard.press('Control+2');
      await expect(
        page.getByRole('heading', { name: 'List', exact: true }),
      ).toBeVisible();
      await expect(page.locator('.filter-notice')).toContainText('tasks');
      await page.locator('thead .column-trigger').nth(2).click();
      await page
        .getByLabel('Filter Status', { exact: true })
        .selectOption('todo');
      await page.getByRole('button', { name: 'Apply', exact: true }).click();
      await page
        .getByRole('searchbox', { name: 'Search tasks' })
        .fill('Xác minh');
      await expect(page.locator('.filter-notice')).toContainText(
        'Status: To do',
      );
      await page
        .getByRole('button', { name: 'Collapse all', exact: true })
        .click();
      await expect(page.locator('.task-group').first()).toContainText(
        '3 / 5 · 60%',
      );
      await expect(
        page.locator('.task-table tbody:not(.task-group) tr').first(),
      ).not.toBeVisible();
      await page
        .getByRole('button', { name: 'Expand all', exact: true })
        .click();
      await page.locator('thead .column-trigger').nth(1).click();
      await page
        .getByRole('button', { name: 'Clear selection', exact: true })
        .click();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(
        page.locator('.task-table tbody:not(.task-group) tr').first(),
      ).toBeVisible();
      await page.locator('thead .column-trigger').nth(0).click();
      await page
        .getByRole('button', { name: 'Sort Z → A', exact: true })
        .click();
      await expect(page.getByRole('columnheader').first()).toHaveAttribute(
        'aria-sort',
        'descending',
      );
      await page
        .getByRole('button', { name: 'Clear filters', exact: true })
        .click();
      await expect(page.locator('.filter-notice')).not.toContainText('Status:');
      await navigate(page, '/');
      const row = page.locator('article.work-card').filter({
        has: page.getByRole('link', {
          name: 'Cải thiện tìm kiếm',
          exact: true,
        }),
      });
      await row.getByLabel('Actions for Cải thiện tìm kiếm').click();
      await row.getByRole('button', { name: 'Archive', exact: true }).click();
      await navigate(page, '/archive');
      await expect(
        page.getByRole('heading', { name: 'Archive', exact: true }),
      ).toBeVisible();
      await expect(page.locator('article.work-card')).toHaveCount(1);
      await page
        .locator('article.work-card')
        .getByLabel('Actions for Cải thiện tìm kiếm')
        .click();
      await page
        .getByRole('button', { name: 'Unarchive', exact: true })
        .click();
      await expect(
        page.getByRole('heading', { name: 'No archived plans' }),
      ).toBeVisible();
      await navigate(page, `/plan/${encodeURIComponent(key)}/summary`);
      await page.getByLabel('Actions for Cải thiện tìm kiếm').click();
      await page.getByRole('button', { name: 'Delete…', exact: true }).click();
      const dialog = page.getByRole('dialog', {
        name: 'Move this plan to the Recycle Bin?',
      });
      await expect(dialog).toContainText('Cải thiện tìm kiếm.md');
      await expect(
        dialog.getByRole('button', { name: 'Cancel', exact: true }),
      ).toBeFocused();
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByLabel('Actions for Cải thiện tìm kiếm').click();
      await page.getByRole('button', { name: 'Delete…', exact: true }).click();
      await dialog
        .getByRole('button', { name: 'Move to Recycle Bin', exact: true })
        .click();
      await expect(
        page.getByText(
          'Moved to the Recycle Bin. You can restore it from there.',
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        page.locator('article.work-card').filter({
          has: page.getByRole('link', {
            name: 'Cải thiện tìm kiếm',
            exact: true,
          }),
        }),
      ).toHaveCount(0);
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
}

test('Settings: preferences, Workspace picker/paste, Tasks confirmation and per-file report, Skills guards and About', async () => {
  const fixture = await launchFixture();
  const { page } = fixture;
  try {
    await page.keyboard.press('Control+,');
    await expect(
      page.getByRole('heading', { name: 'Settings', exact: true }),
    ).toBeVisible();
    await page.getByLabel('Theme', { exact: true }).selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    // "Saved" confirms a change, then goes away on its own.
    await expect(
      page.getByRole('status').filter({ hasText: 'Saved' }),
    ).toBeVisible();
    await expect(
      page.getByRole('status').filter({ hasText: 'Saved' }),
    ).toHaveCount(0, { timeout: 6000 });
    // Text size scales the interface and the window still fits without scrolling.
    await page.getByLabel('Text size', { exact: true }).selectOption('larger');
    await expect(page.locator('html')).toHaveAttribute(
      'data-text-size',
      'larger',
    );
    expect(
      await page.evaluate(() => ({
        zoom: getComputedStyle(document.body).zoom,
        fits:
          document.querySelector('.app')!.getBoundingClientRect().bottom <=
          innerHeight + 1,
      })),
    ).toEqual({ zoom: '1.25', fits: true });
    await page.getByLabel('Text size', { exact: true }).selectOption('default');
    await page.getByRole('switch', { name: /Single-key shortcuts/ }).uncheck();
    await page.getByRole('link', { name: '← Back', exact: true }).click();
    await page.locator('.view').click();
    await page.keyboard.press(',');
    await expect(
      page.getByRole('heading', { name: 'Summary', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Control+,');
    await expect(
      page.getByRole('heading', { name: 'Settings', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Control+f');
    await expect(
      page.getByRole('searchbox', { name: 'Search settings' }),
    ).toBeFocused();
    await page
      .getByRole('searchbox', { name: 'Search settings' })
      .fill('no matching setting');
    await expect(
      page.getByRole('heading', { name: 'No matching settings' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('searchbox', { name: 'Search settings' }),
    ).toHaveValue('');
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('link', { name: 'Workspace', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Add workspace', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Paste a path instead', exact: true })
      .click();
    await page.getByLabel('Folder path', { exact: true }).fill('relative');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('full workspace');
    await page
      .getByLabel('Folder path', { exact: true })
      .fill('C:\\Sample\\NewWorkspace');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'NewWorkspace', exact: true }),
    ).toBeVisible();
    const workspace = page.locator('li.settings-card').filter({
      has: page.getByRole('heading', { name: 'NewWorkspace', exact: true }),
    });
    await workspace
      .getByRole('switch', { name: 'Include in ledger' })
      .uncheck();
    await expect(workspace).toContainText('Hidden');
    await workspace
      .getByRole('button', { name: 'Remove', exact: true })
      .click();
    await expect(workspace).toContainText('Plan files are not changed');
    await workspace
      .getByRole('button', { name: 'Click again to remove' })
      .click();
    await expect(
      page.getByRole('heading', { name: 'NewWorkspace', exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('link', { name: 'Tasks', exact: true })
      .click();
    await page
      .getByLabel('Tasks folder', { exact: true })
      .fill('C:\\InsideWorkspace\\Tasks');
    await page.getByRole('button', { name: 'Use folder', exact: true }).click();
    const confirm = page.getByRole('group', { name: 'Confirm Tasks folder' });
    await expect(confirm.getByRole('checkbox')).toBeChecked();
    await confirm.getByRole('checkbox').uncheck();
    await confirm.getByRole('button', { name: 'Change Tasks folder' }).click();
    await expect(
      page.getByRole('button', { name: 'Use it anyway' }),
    ).toBeVisible();
    await expect(confirm.getByRole('checkbox')).not.toBeChecked();
    await confirm.getByRole('button', { name: 'Use it anyway' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByLabel('Tasks folder', { exact: true })).toHaveValue(
      'C:\\InsideWorkspace\\Tasks',
    );
    await page
      .getByRole('button', { name: 'Move them here', exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: 'Plan move results' }),
    ).toContainText('1 moved · 1 not moved');
    await expect(
      page.getByRole('region', { name: 'Plan move results' }),
    ).toContainText('left in place');
    // A folder that holds a workspace is refused with a ready subfolder,
    // and the earlier move results are cleared for the new choice.
    await page.getByLabel('Tasks folder', { exact: true }).fill('D:\\Projects');
    await page.getByRole('button', { name: 'Use folder', exact: true }).click();
    await expect(
      page.getByRole('region', { name: 'Plan move results' }),
    ).toHaveCount(0);
    await confirm.getByRole('button', { name: 'Change Tasks folder' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'contains the workspace',
    );
    await confirm
      .getByRole('button', { name: 'Use D:\\Projects\\Tasks', exact: true })
      .click();
    await expect(confirm.locator('code')).toHaveText('D:\\Projects\\Tasks');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('link', { name: 'Skills', exact: true })
      .click();
    const codex = page.locator('li[aria-label="Codex"]');
    await codex.getByRole('button', { name: 'Show changes' }).click();
    await expect(
      codex.getByRole('region', { name: 'Differences for Codex' }),
    ).toContainText('<owner-written instruction>');
    await expect(codex.locator('script')).toHaveCount(0);
    await codex.getByRole('button', { name: 'Keep mine' }).click();
    await expect(codex).toContainText('your version is kept');
    await codex.getByRole('button', { name: 'Replace', exact: true }).click();
    await codex.getByRole('button', { name: 'Click again to replace' }).click();
    await expect(codex).toContainText('Installed v2');
    const claude = page.locator('li[aria-label="Claude Code"]');
    await claude
      .getByRole('switch', { name: /Add a one-line reminder/ })
      .check();
    await claude.getByRole('switch', { name: 'Use this folder' }).uncheck();
    await expect(
      claude.getByRole('button', { name: 'Remove skill', exact: true }),
    ).toBeEnabled();
    await expect(
      claude.getByRole('button', { name: 'Remove from list' }),
    ).toBeDisabled();
    await claude
      .getByRole('switch', { name: /Add a one-line reminder/ })
      .uncheck();
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('link', { name: 'About', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Copy diagnostics', exact: true })
      .click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Diagnostics copied' }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Check for updates', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Update and restart', exact: true }),
    ).toBeVisible();
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test('first-run setup: Workspace, unchecked Skills choices, suggested Tasks and preferences', async () => {
  const fixture = await launchFixture('setup');
  const { page } = fixture;
  try {
    await expect(
      page.getByRole('heading', { name: 'Your plans, together in one place' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Add your workspace' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Connect your AI tools' }),
    ).toBeVisible();
    for (const box of await page.getByRole('checkbox').all())
      await expect(box).not.toBeChecked();
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Tasks', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Open ledger', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Summary', exact: true }),
    ).toBeVisible();
    await navigate(page, '/settings/tasks');
    await expect(page.getByLabel('Tasks folder', { exact: true })).toHaveValue(
      'C:\\Sample\\Tasks',
    );
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});
test('setup skip asks first and keeps an actionable empty ledger', async () => {
  const fixture = await launchFixture('setup');
  try {
    const { page } = fixture;
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('alertdialog', { name: 'Skip setup?' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Keep going' }).click();
    await page.getByRole('button', { name: 'Set up later' }).click();
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Add a workspace to start' }),
    ).toBeVisible();
  } finally {
    await fixture.close();
  }
});

test('read failures retain plans and timestamp, update errors are actionable and dismissible', async () => {
  const fixture = await launchFixture('error');
  const { page } = fixture;
  try {
    await expect(
      page.getByRole('alert').filter({ hasText: 'sample folder' }),
    ).toBeVisible();
    const checked = await page
      .locator('.statusbar > span')
      .nth(1)
      .getAttribute('title');
    await page.keyboard.press('F5');
    await expect(
      page.getByText('Progress check failed', { exact: true }),
    ).toBeVisible();
    expect(
      await page.locator('.statusbar > span').nth(1).getAttribute('title'),
    ).toBe(checked);
    await expect(page.locator('article.work-card').first()).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Open logs', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss update' }).click();
    await expect(page.locator('.update-dock')).toHaveCount(0);
    await page.locator('.update-segment').click();
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(
      page.getByRole('progressbar', { name: 'Update progress' }),
    ).toBeVisible();
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test('automatic archive, explicit restore, stars/tabs and refresh preserve navigation independently of plan files', async () => {
  const fixture = await launchFixture();
  const { page, app } = fixture;
  try {
    await page.getByRole('button', { name: 'Dismiss update' }).click();
    await navigate(page, '/settings/general');
    await page
      .getByRole('switch', { name: /Automatically archive Done plans/ })
      .check();
    await navigate(page, '/archive');
    await expect(page.locator('article.work-card')).toHaveCount(1);
    await page.getByLabel('Actions for Hoàn tất bản mẫu').click();
    await page.getByRole('button', { name: 'Unarchive', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'No archived plans' }),
    ).toBeVisible();
    await navigate(page, `/plan/${encodeURIComponent(key)}/summary`);
    await page
      .locator('.plan-header')
      .getByRole('button', { name: 'Star Cải thiện tìm kiếm', exact: true })
      .click();
    await page
      .locator('.collections')
      .getByRole('button', { name: 'Starred', exact: true })
      .click();
    await expect(page.locator('.sidebar-plan')).toHaveCount(1);
    const url = page.url();
    await app.evaluate(({ BrowserWindow }, url) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      return new Promise<void>((resolve) => {
        contents.once('did-finish-load', () => resolve());
        void contents.loadURL(url).then(() => contents.reload());
      });
    }, url);
    await expect(page.locator('.sidebar-plan')).toHaveCount(1);
    await expect(page.locator('.document-tab')).toHaveCount(1);
    await expect(
      page.locator('.plan-header').getByRole('button', {
        name: 'Unstar Cải thiện tìm kiếm',
        exact: true,
      }),
    ).toBeVisible();
    // The plan's title row sits in the top bar, level with search and Refresh.
    const titleBox = await page.locator('.top .plan-header').boundingBox();
    const searchBox = await page.locator('#work-search').boundingBox();
    expect(titleBox && searchBox).toBeTruthy();
    expect(searchBox!.y).toBeGreaterThanOrEqual(titleBox!.y);
    expect(searchBox!.y + searchBox!.height).toBeLessThanOrEqual(
      titleBox!.y + titleBox!.height + 1,
    );
    // The plan's name and actions stay in view when its content is scrolled.
    await page.setViewportSize({ width: 1000, height: 420 });
    const scrolled = await page.locator('.view').evaluate((el) => {
      el.scrollTo(0, el.scrollHeight);
      return el.scrollTop;
    });
    expect(scrolled).toBeGreaterThan(0);
    await expect(page.locator('.plan-header h1')).toBeInViewport();
    await expect(
      page.getByRole('tablist', { name: 'Plan sections' }),
    ).toBeInViewport();
    // Goal and Next stay compact at ordinary heights and stay within a third of a short window until expanded.
    await page.locator('.view').evaluate((el) => el.scrollTo(0, 0));
    await expect(
      page.getByRole('button', { name: 'Show full summary' }),
    ).toHaveCount(0);
    await page.setViewportSize({ width: 520, height: 240 });
    const tallest = () =>
      page.evaluate(() =>
        Math.max(
          ...[
            ...document.querySelectorAll<HTMLElement>(
              '.plan-summary > .plan-summary-main, .plan-summary > .plan-summary-side',
            ),
          ].map((el) => el.getBoundingClientRect().height / innerHeight),
        ),
      );
    expect(await tallest()).toBeLessThanOrEqual(0.34);
    await page.getByRole('button', { name: 'Show full summary' }).click();
    expect(await tallest()).toBeGreaterThan(0.34);
    await page.getByRole('button', { name: 'Show less' }).click();
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test('a failed manual update check keeps Try again on the check operation', async () => {
  const fixture = await launchFixture('error');
  const { page } = fixture;
  try {
    await navigate(page, '/settings/about');
    await page
      .getByRole('button', { name: 'Check for updates', exact: true })
      .click();
    await expect(
      page.getByText('Couldn’t check for updates', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(
      page.getByText('The sample update check could not finish.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('progressbar', { name: 'Update progress' }),
    ).toHaveCount(0);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

for (const [mode, title] of [
  ['empty', 'Add a workspace to start'],
  ['hidden', 'All workspace folders are hidden'],
  ['loading', 'Loading plans…'],
] as const)
  test(`${mode}: clear initial state`, async () => {
    const fixture = await launchFixture(mode);
    try {
      await expect(
        fixture.page.getByRole('heading', { name: title, exact: true }),
      ).toBeVisible();
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

test('update progress stays bounded, minimizes, restarts calmly and preserves the current plan', async () => {
  const fixture = await launchFixture('demo', 'dark');
  const { page } = fixture;
  try {
    await navigate(page, `/plan/${encodeURIComponent(key)}/summary`);
    await page
      .getByRole('button', { name: 'Update and restart', exact: true })
      .click();
    await expect(
      page.getByRole('progressbar', { name: 'Update progress' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Minimize to status bar' }).click();
    await expect(page.locator('.update-dock')).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'Cải thiện tìm kiếm', exact: true }),
    ).toBeVisible();
    await page.locator('.update-segment').click();
    await expect(
      page.getByText('Agent Ops will restart automatically.', { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText('Updated to v0.5.1', { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole('heading', { name: 'Cải thiện tìm kiếm', exact: true }),
    ).toBeVisible();
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test('history, deep links, unavailable plans, shortcut sheet and narrow reduced-motion layouts', async () => {
  const fixture = await launchFixture();
  const { page, app } = fixture;
  try {
    await page.getByRole('button', { name: 'Dismiss update' }).click();
    await page
      .getByRole('navigation', { name: 'Views' })
      .getByRole('link', { name: 'List', exact: true })
      .click();
    // Each view must be shown before the next step, or Back can run before the
    // history entry exists on a slow machine.
    await expect(
      page.getByRole('heading', { name: 'List', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Views' })
      .getByRole('link', { name: 'Summary', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Summary', exact: true }),
    ).toBeVisible();
    await page.goBack();
    await expect(
      page.getByRole('heading', { name: 'List', exact: true }),
    ).toBeVisible();
    await page.goForward();
    await expect(
      page.getByRole('heading', { name: 'Summary', exact: true }),
    ).toBeVisible();
    await navigate(page, `/plan/${encodeURIComponent(key)}/summary?step=L19`);
    await expect(page.locator('[aria-current="step"]')).toContainText(
      'Xác minh',
    );
    await navigate(page, '/plan/missing%2Fplan/summary');
    await expect(
      page.getByRole('heading', { name: 'Plan unavailable' }),
    ).toBeVisible();
    await page.keyboard.press('?');
    await expect(
      page.getByRole('dialog', { name: 'Keyboard shortcuts' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setMinimumSize(500, 400);
      window.setSize(600, 600);
    });
    await navigate(page, '/settings/general');
    await expect(page.getByLabel('Theme', { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});
