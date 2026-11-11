import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { launchFixture, navigate } from './helpers';

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: restored work views, agent filters, reports and responsive layouts`, async () => {
    const fixture = await launchFixture('demo', theme);
    const { page, app } = fixture;
    try {
      await page.getByRole('button', { name: 'Dismiss update' }).click();
      expect(
        await page.evaluate(async () => {
          await document.fonts.ready;
          return document.fonts.check('13px Geist', 'Cải thiện tìm kiếm');
        }),
      ).toBe(true);
      const tabs = page.getByRole('navigation', { name: 'Views' });
      await expect(
        tabs.getByRole('link', { name: 'Summary', exact: true }),
      ).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('.summary-stat')).toHaveCount(4);
      await expect(
        page.getByRole('heading', { name: 'Agent workload', exact: true }),
      ).toBeVisible();
      await expect(
        page.locator('.summary-focus .agent-chain').first(),
      ).toContainText('Claude');
      await expect(
        page.locator('.summary-focus .agent-chain').first(),
      ).toContainText('Codex');
      await expect(page.locator('.summary-focus')).toContainText(
        'Not reported',
      );
      await expect(
        page.getByRole('img', { name: /To do:.*In progress:/ }),
      ).toBeVisible();
      await page
        .locator('.agent-workload button')
        .filter({ has: page.getByText('Codex', { exact: true }) })
        .click();
      const filter = page.getByRole('combobox', { name: 'Filter by agent' });
      await expect(filter).toHaveValue('Codex');
      await page.keyboard.press('F5');
      await expect(filter).toHaveValue('Codex');
      await tabs.getByRole('link', { name: 'List', exact: true }).click();
      await expect(filter).toHaveValue('Codex');
      const rows = page.locator('.task-table tbody:not(.task-group) tr');
      await expect(rows.first()).toBeVisible();
      for (const row of await rows.all())
        await expect(row.locator('td').nth(2)).toContainText('Codex');
      await filter.selectOption('unreported');
      await expect(rows.first()).toBeVisible();
      for (const row of await rows.all())
        await expect(row.locator('td').nth(2)).toContainText('Not reported');
      await filter.selectOption('');
      // Deep links keep their agent even in another case or with no plans left.
      await navigate(page, '/list?agent=codex');
      await expect(filter).toHaveValue('Codex');
      await expect(rows.first()).toContainText('Codex');
      await navigate(page, '/?agent=Nobody');
      await expect(filter).toHaveValue('Nobody');
      await expect(filter.locator('option:checked')).toHaveText('Nobody (0)');
      await expect(
        page.getByRole('heading', { name: 'No matching work' }),
      ).toBeVisible();
      await navigate(page, '/list');
      await expect(filter).toHaveValue('');
      await expect(
        page.getByRole('columnheader', { name: 'Latest result', exact: true }),
      ).toBeVisible();
      await expect(page.locator('.working-now').first()).toHaveText(
        'Working now',
      );
      await expect(page.locator('.blocked-result').first()).toContainText(
        'Blocked',
      );
      await page
        .getByRole('searchbox', { name: 'Search tasks' })
        .fill('chu so huu cung cap');
      await expect(rows.first()).toContainText(
        'Chờ chủ sở hữu cung cấp dữ liệu mẫu',
      );
      await page
        .getByRole('button', { name: 'Clear filters', exact: true })
        .click();
      const key = encodeURIComponent('studio/Ledger/Chờ duyệt nội dung');
      await navigate(page, `/plan/${key}/summary`);
      await expect(page.locator('.plan-header .agent-chain')).toHaveAttribute(
        'aria-label',
        /Coordinator: Claude; Executed by:/,
      );
      await expect(
        page.locator('.step-agents .working-now').first(),
      ).toBeVisible();
      await expect(
        page.locator('[data-source-line="18"] .step-result'),
      ).toContainText('Đang kiểm tra');
      await navigate(
        page,
        `/plan/${encodeURIComponent('personal/Ledger/Kế hoạch cũ')}/summary`,
      );
      await expect(page.locator('.plan-header .agent-chain')).toHaveAttribute(
        'aria-label',
        'Coordinator: Not reported; Executed by: Not reported',
      );

      // Capture the actual Electron surface at full HD, with all native effects isolated.
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(1920, 1080),
      );
      const screenDir = process.env.AGENT_OPS_SCREEN_DIR;
      if (screenDir) await mkdir(screenDir, { recursive: true });
      for (const [route, title] of [
        ['/', 'Summary'],
        ['/list', 'List'],
        ['/board', 'Board'],
        ['/timeline', 'Timeline'],
      ] as const) {
        await navigate(page, route);
        await expect(
          page.getByRole('heading', { name: title, exact: true }),
        ).toBeVisible();
        // One plan count under the title; List counts tasks in its notice instead.
        await expect(page.getByText(/ of \d+ plans$/)).toHaveCount(
          route === '/list' ? 0 : 1,
        );
        if (route === '/board') {
          await expect(page.locator('.board-column')).toHaveCount(5);
          await expect(
            page
              .getByRole('region', { name: 'Done', exact: true })
              .locator('.work-card'),
          ).toHaveCount(1);
        }
        if (route === '/timeline') {
          await expect(
            page.locator('.timeline-table .agent-chain').first(),
          ).toBeVisible();
          await page.getByRole('button', { name: 'Previous month' }).click();
          await expect(page.locator('.timeline-toolbar')).toContainText(
            'October 2026',
          );
          await page
            .getByRole('button', { name: 'Today', exact: true })
            .click();
          await expect(page.locator('.timeline-toolbar')).toContainText(
            'November 2026',
          );
        }
        await page.locator('.view').evaluate((el) => el.scrollTo(0, 0));
        if (route === '/')
          await expect(page.locator('.summary-stats')).toBeInViewport();
        if (route === '/board')
          await expect(
            page.locator('.board-column h2').first(),
          ).toBeInViewport();
        await page.screenshot({
          scale: 'css',
          path: screenDir
            ? join(screenDir, `a2-${title.toLowerCase()}-${theme}.png`)
            : test.info().outputPath(`a2-${title.toLowerCase()}-${theme}.png`),
        });
        if (route === '/') {
          await page
            .getByRole('heading', { name: 'Agent workload', exact: true })
            .scrollIntoViewIfNeeded();
          await page.screenshot({
            scale: 'css',
            path: screenDir
              ? join(screenDir, `a2-summary-workload-${theme}.png`)
              : test.info().outputPath(`a2-summary-workload-${theme}.png`),
          });
          await page.locator('.view').evaluate((el) => el.scrollTo(0, 0));
        }
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.setContentSize(1000, 800),
        );
        await expect(
          page.getByRole('heading', { name: title, exact: true }),
        ).toBeInViewport();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await expect(
          page.getByRole('button', { name: 'Refresh F5' }),
        ).toBeInViewport();
        // The board and six-column list retain readable columns in their own scroll area.
        expect(
          await page
            .locator('.view')
            .evaluate(
              (el) => el.clientWidth > 0 && el.scrollWidth >= el.clientWidth,
            ),
        ).toBe(true);
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.setContentSize(1920, 1080),
        );
      }
      await page.locator('.timeline-event').first().click();
      await expect(page.getByRole('tabpanel')).toContainText('Codex');
      await expect(page.getByRole('tabpanel')).toContainText('Đang kiểm tra');
      await navigate(page, '/attention');
      await expect(page.locator('.work-card').first()).toBeVisible();
      await navigate(page, '/archive');
      await expect(
        page.getByRole('heading', { name: 'No archived plans' }),
      ).toBeVisible();
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
}
