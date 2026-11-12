import { expect, test } from '@playwright/test';
import { launchFixture, navigate } from './helpers';

for (const theme of ['dark', 'light'] as const) {
  test(`${theme}: checklist overview filters, plan breakdowns and segment tooltips`, async () => {
    const fixture = await launchFixture('demo', theme);
    const { page } = fixture;
    try {
      await page.getByRole('button', { name: 'Dismiss update' }).click();
      await navigate(page, '/list');
      const overview = page.getByRole('region', { name: 'Task overview' });
      const rows = page.locator('.task-table tbody:not(.task-group) tr');
      await expect(rows.first()).toBeVisible();
      const total = await rows.count();
      const initial = (await overview.locator('.task-counts').textContent())!;
      const bounds = await overview.boundingBox();
      expect(bounds!.height).toBeGreaterThanOrEqual(55);
      expect(bounds!.height).toBeLessThanOrEqual(70);
      for (const [status, label] of [
        ['done', 'Done'],
        ['doing', 'In progress'],
        ['todo', 'To do'],
        ['blocked', 'Blocked'],
      ]) {
        const button = overview.getByRole('button', {
          name: new RegExp(`^${label}:`),
        });
        await button.click();
        await expect(button).toHaveAttribute('aria-pressed', 'true');
        expect(await rows.count()).toBeGreaterThan(0);
        expect(await rows.count()).toBeLessThan(total);
        await expect(rows.locator(`.pill:not(.step-${status})`)).toHaveCount(0);
        await expect(overview.locator('.task-counts')).toHaveText(initial);
      }
      const group = page.locator('.task-group').first();
      await expect(group).toContainText('3 / 5 · 60%');
      await expect(
        group.getByLabel('Done + In progress: 3 of 5 tasks · 60%', {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        group.getByLabel('Done: 2 tasks', { exact: true }),
      ).toBeVisible();
      await expect(group.locator('.plan-attention')).toContainText('1 blocked');
      await overview.getByRole('button', { name: /^Blocked:/ }).click();
      await expect(rows).toHaveCount(total);
      const segment = overview.locator('.task-tone-done.task-segment');
      await segment.hover();
      await expect(segment.locator('.task-segment-tooltip')).toBeVisible();
      await segment.focus();
      await expect(segment.locator('.task-segment-tooltip')).toBeVisible();
      await page
        .getByRole('searchbox', { name: 'Search tasks' })
        .fill('no-such-task-xyz');
      await expect(rows).toHaveCount(0);
      await expect(overview).toContainText('0 / 0 · 0%');
      await overview.getByRole('button', { name: /^Done:/ }).click();
      await expect(rows).toHaveCount(0);
      await page
        .getByRole('button', { name: 'Clear filters', exact: true })
        .click();
      await page.screenshot({
        path: test.info().outputPath(`task-progress-${theme}.png`),
      });
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
}
