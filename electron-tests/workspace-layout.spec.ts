import { expect, test, type Locator, type Page } from '@playwright/test';
import { launchFixture, navigate } from './helpers';

async function drop(page: Page, source: Locator, target: Locator) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent('dragstart', { dataTransfer });
  await target.dispatchEvent('dragover', { dataTransfer });
  await target.dispatchEvent('drop', { dataTransfer });
}

for (const theme of ['dark', 'light'] as const) {
  test(`${theme}: resized sidebar, reordered/pinned tabs, compact Summary and Plan-state controls`, async () => {
    const fixture = await launchFixture('demo', theme);
    const { page, app } = fixture;
    try {
      await page.getByRole('button', { name: 'Dismiss update' }).click();
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000),
      );
      const resizer = page.getByRole('separator', {
        name: 'Resize plans sidebar',
      });
      await resizer.focus();
      await page.keyboard.press('ArrowRight');
      await expect(resizer).toHaveAttribute('aria-valuenow', '254');
      const before = await page.locator('.plan-sidebar').boundingBox();
      const handle = await resizer.boundingBox();
      await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + 100);
      await page.mouse.down();
      await page.mouse.move(
        handle!.x + handle!.width / 2 + 70,
        handle!.y + 100,
      );
      await page.mouse.up();
      expect(
        (await page.locator('.plan-sidebar').boundingBox())!.width,
      ).toBeGreaterThan(before!.width + 50);

      // Sidebar Plan cards reorder by drag (including starting on the card link) and Alt+Arrow, without changing Recent.
      const ledgerFolder = page.locator(
        '#folder-studio\\%2FLedger .sidebar-plan',
      );
      await expect(ledgerFolder).toHaveCount(3);
      await expect(ledgerFolder.nth(0)).toContainText('Cải thiện tìm kiếm');
      await expect(ledgerFolder.nth(1)).toContainText('Chờ duyệt nội dung');
      await drop(
        page,
        ledgerFolder.nth(1).locator('.sidebar-plan-link'),
        ledgerFolder.nth(0),
      );
      await expect(ledgerFolder.nth(0)).toContainText('Chờ duyệt nội dung');
      await expect(ledgerFolder.nth(1)).toContainText('Cải thiện tìm kiếm');
      await ledgerFolder.nth(1).locator('.sidebar-plan-link').focus();
      await page.keyboard.press('Alt+ArrowDown');
      await expect(ledgerFolder.nth(2)).toContainText('Cải thiện tìm kiếm');

      const panels = page.locator('.summary-grid > section');
      await expect(
        panels.nth(0).getByRole('heading', { name: 'Task progress' }),
      ).toBeVisible();
      await expect(
        panels.nth(1).getByRole('heading', { name: 'Agent workload' }),
      ).toBeVisible();
      const current = page.locator('.summary-focus');
      const recent = page.locator('.summary-recent');
      expect(
        Math.abs(
          (await current.boundingBox())!.height -
            (await recent.boundingBox())!.height,
        ),
      ).toBeLessThan(2);
      const height = (await current.boundingBox())!.height;
      await current.getByRole('button', { name: /Show more plans/ }).click();
      expect((await current.boundingBox())!.height).toBe(height);
      await recent.getByRole('button', { name: 'Show more activity' }).click();
      expect((await recent.boundingBox())!.height).toBe(height);
      await current.locator('.card-tasks-link').first().click();
      await expect(
        page.getByRole('heading', { name: 'List', exact: true }),
      ).toBeVisible();
      await expect(page.locator('.filter-notice')).toContainText('Plans:');
      await expect(page.locator('.task-group')).toHaveCount(1);
      await navigate(page, '/');
      await page
        .getByRole('region', { name: 'Task overview' })
        .getByRole('button', { name: /Tasks$/ })
        .click();
      await expect(page.locator('.task-group').nth(1)).toBeVisible();
      await page
        .getByRole('button', { name: 'Clear filters', exact: true })
        .click();
      await expect(page.locator('.task-group').nth(1)).toBeVisible();

      const keys = [
        'studio/Ledger/Cải thiện tìm kiếm',
        'studio/Ledger/Chờ duyệt nội dung',
        'personal/Ledger/Kế hoạch cũ',
      ];
      for (const key of keys) {
        await navigate(page, `/plan/${encodeURIComponent(key)}/summary`);
        await expect(page.locator('.plan-page')).toBeVisible();
      }
      // Opening a Plan keeps Milestones compact; Waiting for owner and Open questions live in Questions.
      await navigate(
        page,
        `/plan/${encodeURIComponent('studio/Ledger/Chờ duyệt nội dung')}/summary`,
      );
      await expect(page.locator('.plan-summary')).not.toContainText(
        'Please confirm the release wording',
      );
      await expect(page.locator('.plan-summary')).not.toContainText(
        'Open questions',
      );
      await page.screenshot({
        path: test.info().outputPath(`compact-plan-${theme}.png`),
      });
      await page.getByRole('tab', { name: 'Questions 1' }).click();
      await expect(page.getByRole('tabpanel')).toContainText(
        'Please confirm the release wording',
      );
      await expect(page.getByRole('tabpanel')).toContainText(
        'Chốt bộ dữ liệu mẫu?',
      );
      await navigate(page, `/plan/${encodeURIComponent(keys[2]!)}/summary`);
      const tabs = page.locator('.document-tab');
      await expect(tabs).toHaveCount(3);
      await tabs.nth(2).getByLabel('Tab menu: Kế hoạch cũ').click();
      await page.getByRole('menuitem', { name: 'Move left' }).click();
      await expect(tabs.nth(1)).toContainText('Kế hoạch cũ');
      await drop(page, tabs.nth(1), tabs.nth(0));
      await expect(tabs.nth(0)).toContainText('Kế hoạch cũ');
      await tabs.nth(0).getByLabel('Tab menu: Kế hoạch cũ').click();
      await page
        .getByRole('menuitem', { name: 'Pin tab', exact: true })
        .click();
      await expect(tabs.nth(0)).toHaveClass(/pinned/);
      await page.keyboard.press('Control+w');
      await expect(tabs.nth(0)).toHaveClass(/pinned/);
      await expect(
        tabs.nth(0).getByRole('button', { name: /^Close/ }),
      ).toHaveCount(0);
      await navigate(page, '/board');
      const key = keys[0]!;
      const card = page.locator(`.work-card[data-plan-key="${key}"]`);
      await card
        .getByRole('button', { name: 'Pin Cải thiện tìm kiếm on Board' })
        .click();
      const pinned = page.getByRole('region', { name: 'Pinned plans' });
      await expect(pinned.locator(card)).toHaveCount(1);
      await expect(
        card.getByLabel('Plan state for Cải thiện tìm kiếm'),
      ).toHaveValue('Implementing');
      await card
        .getByLabel('Plan state for Cải thiện tìm kiếm')
        .selectOption('Blocked');
      await expect(
        card.getByLabel('Plan state for Cải thiện tìm kiếm'),
      ).toHaveValue('Blocked');
      await expect(card.locator('.plan-state-picker')).toContainText('Blocked');
      await page
        .locator('.toast')
        .getByRole('button', { name: 'Undo' })
        .click();
      await expect(
        card.getByLabel('Plan state for Cải thiện tìm kiếm'),
      ).toHaveValue('Implementing');
      await card
        .getByRole('button', { name: 'Unpin Cải thiện tìm kiếm on Board' })
        .click();
      await expect(pinned.locator(card)).toHaveCount(0);
      await drop(page, card, pinned);
      await expect(pinned.locator(card)).toHaveCount(1);
      await page.reload();
      await expect(page.locator('.document-tab').first()).toHaveClass(/pinned/);
      await expect(pinned.locator(card)).toHaveCount(1);
      await expect(ledgerFolder.nth(0)).toContainText('Chờ duyệt nội dung');
      await expect(ledgerFolder.nth(2)).toContainText('Cải thiện tìm kiếm');
      expect(
        Number(await resizer.getAttribute('aria-valuenow')),
      ).toBeGreaterThan(300);
      await navigate(page, '/');
      await page.locator('.view').evaluate((view) => view.scrollTo(0, 0));
      await page.screenshot({
        path: test.info().outputPath(`compact-summary-${theme}.png`),
      });
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
}
