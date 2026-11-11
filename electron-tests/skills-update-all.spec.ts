import { expect, test } from '@playwright/test';
import { launchFixture, navigate } from './helpers';

test('Skills: Update all updates every outdated Skill and leaves changed files alone', async () => {
  const fixture = await launchFixture('demo');
  const { page } = fixture;
  try {
    await navigate(page, '/settings/integrations');
    const gemini = page.locator('li[aria-label="Gemini"]');
    const codex = page.locator('li[aria-label="Codex"]');
    await expect(gemini).toContainText('Update available');
    await expect(codex).toContainText('Modified locally');
    const all = page.getByRole('button', { name: 'Update all (1)' });
    await all.click();
    await expect(
      page.getByRole('status').filter({ hasText: 'updated to v' }),
    ).toContainText('1 Skill updated');
    await expect(gemini).not.toContainText('Update available');
    // A locally changed Skill is never part of Update all.
    await expect(codex).toContainText('Modified locally');
    await expect(page.getByRole('button', { name: /^Update all/ })).toHaveCount(
      0,
    );
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test('Ctrl + wheel and Ctrl = / - / 0 change the text size and keep it as the setting', async () => {
  const fixture = await launchFixture('demo');
  const { page } = fixture;
  const size = () => page.locator('html').getAttribute('data-text-size');
  try {
    await expect(page.locator('html')).toHaveAttribute(
      'data-text-size',
      'default',
    );
    await page.mouse.move(600, 400);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await expect.poll(size).toBe('large');
    await page.keyboard.press('Control+Equal');
    await expect.poll(size).toBe('larger');
    await page.keyboard.press('Control+Equal');
    await expect.poll(size).toBe('larger');
    await page.keyboard.press('Control+Minus');
    await expect.poll(size).toBe('large');
    await page.keyboard.press('Control+0');
    await expect.poll(size).toBe('default');
    await navigate(page, '/settings/general');
    await page.keyboard.press('Control+Minus');
    await expect(page.getByLabel('Text size', { exact: true })).toHaveValue(
      'small',
    );
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});
