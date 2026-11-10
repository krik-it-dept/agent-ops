import { expect, test } from '@playwright/test';
import { launchFixture, navigate } from './helpers';

test('Escape in a Settings field keeps the draft and the Settings page', async () => {
  const fixture = await launchFixture();
  const { page } = fixture;
  try {
    await navigate(page, '/settings/projects');
    await page.getByRole('button', { name: 'Rename' }).first().click();
    const name = page.getByLabel('Workspace name');
    await name.fill('Draft name');
    await name.press('Escape');
    await expect(page).toHaveURL(/#\/settings\/projects$/);
    await expect(name).toHaveValue('Draft name');
    // Escape outside a field still leaves Settings.
    await page.getByRole('heading', { name: 'Workspace', level: 2 }).click();
    await page.keyboard.press('Escape');
    await expect(page).not.toHaveURL(/#\/settings/);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test('a failed plan action is reported as that action, not as a plan read failure', async () => {
  const fixture = await launchFixture();
  const { page } = fixture;
  try {
    await navigate(
      page,
      `/plan/${encodeURIComponent('studio/Ledger/Cải thiện tìm kiếm')}/summary`,
    );
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error('denied')) },
      });
    });
    await page.getByRole('button', { name: 'Copy link' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'That didn’t work — Copying is not available here.',
    );
    await expect(page.getByText(/Couldn’t read plans/)).toHaveCount(0);
    await expect(
      page.getByRole('contentinfo').getByRole('status').first(),
    ).toHaveText('Live');
    await navigate(page, '/settings/about');
    await expect(page.getByRole('alert')).toContainText('Copying');
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(page.getByText(/That didn’t work/)).toHaveCount(0);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test('the command palette scrolls the keyboard selection into view', async () => {
  const fixture = await launchFixture();
  const { page } = fixture;
  try {
    await page.setViewportSize({ width: 1200, height: 520 });
    await page.keyboard.press('Control+k');
    const input = page.getByRole('combobox', {
      name: 'Search plans or commands',
    });
    await input.fill('plan');
    await input.press('End');
    const last = page.locator('#command-results [aria-selected="true"]');
    await expect(last).toBeInViewport();
    expect(
      await last.evaluate((el) => {
        const list = el.parentElement!.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        return box.top >= list.top - 1 && box.bottom <= list.bottom + 1;
      }),
    ).toBe(true);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test('setup does not replace a chosen but unconfirmed Tasks folder', async () => {
  const fixture = await launchFixture('setup');
  const { page } = fixture;
  try {
    for (let i = 0; i < 2; i++)
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await page
      .getByLabel('Tasks folder', { exact: true })
      .fill('D:/Mine/Tasks');
    await page.getByRole('button', { name: 'Use folder', exact: true }).click();
    const open = page.getByRole('button', { name: 'Open ledger', exact: true });
    await expect(open).toBeDisabled();
    await expect(
      page.getByText('Confirm or cancel the new Tasks folder first.'),
    ).toBeVisible();
    await page.keyboard.press('Control+Enter');
    await expect(
      page.getByRole('heading', { name: 'Tasks', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Change Tasks folder', exact: true })
      .click();
    await expect(open).toBeEnabled();
    await open.click();
    await navigate(page, '/settings/tasks');
    await expect(page.getByLabel('Tasks folder', { exact: true })).toHaveValue(
      'D:/Mine/Tasks',
    );
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test('the palette shows plan stages without the recorded reason', async () => {
  const fixture = await launchFixture();
  const { page } = fixture;
  try {
    await page.keyboard.press('Control+k');
    await page
      .getByRole('combobox', { name: 'Search plans or commands' })
      .fill('Chờ duyệt');
    const option = page.getByRole('option').first();
    await expect(option).toContainText('Waiting for owner');
    await expect(option).not.toContainText('Please confirm');
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test('setup keeps the app bar out of reach and draws no focus box on its heading', async () => {
  const fixture = await launchFixture('setup');
  const { page } = fixture;
  try {
    const heading = page.getByRole('heading', {
      name: 'Your plans, together in one place',
    });
    await expect(heading).toBeFocused();
    expect(
      await heading.evaluate((el) => getComputedStyle(el).outlineStyle),
    ).toBe('none');
    await expect(page.locator('header.appbar')).toHaveAttribute('inert', '');
    await expect(page.locator('footer.statusbar')).toHaveAttribute('inert', '');
    // Inert controls do not receive the click.
    await page
      .locator('header.appbar a.icon-button')
      .click({ timeout: 1000, force: true })
      .catch(() => undefined);
    await expect(heading).toBeVisible();
    await expect(page).not.toHaveURL(/#\/settings/);
    await page.getByRole('button', { name: 'Set up later' }).click();
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(page.locator('header.appbar')).not.toHaveAttribute('inert');
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test('Escape closes an open plan actions menu before leaving the plan', async () => {
  const fixture = await launchFixture();
  const { page } = fixture;
  try {
    await navigate(
      page,
      `/plan/${encodeURIComponent('studio/Ledger/Cải thiện tìm kiếm')}/summary`,
    );
    const menu = page.locator('.plan-header details.plan-actions');
    await menu.locator('summary').click();
    await expect(menu).toHaveAttribute('open', '');
    await page.keyboard.press('Escape');
    await expect(menu).not.toHaveAttribute('open');
    await expect(menu.locator('summary')).toBeFocused();
    await expect(page).toHaveURL(/#\/plan\//);
    await page.keyboard.press('Escape');
    await expect(page).not.toHaveURL(/#\/plan\//);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});
