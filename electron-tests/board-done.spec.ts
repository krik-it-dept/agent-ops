import { expect, test, type Locator, type Page } from '@playwright/test';
import { launchFixture, navigate } from './helpers';

const card = (page: Page, key: string) =>
  page.locator(`.work-card[data-plan-key="${key}"]`);
const column = (page: Page, name: string) =>
  page.getByRole('region', { name, exact: true });
// Drag and drop is driven with DOM drag events and one DataTransfer: a real
// mouse drag starts the Windows drag loop, which is unreliable on CI runners.
async function dragOver(page: Page, from: Locator, to: Locator) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await from.dispatchEvent('dragstart', { dataTransfer });
  await to.dispatchEvent('dragenter', { dataTransfer });
  await to.dispatchEvent('dragover', { dataTransfer });
  return dataTransfer;
}
async function drop(page: Page, from: Locator, to: Locator) {
  const dataTransfer = await dragOver(page, from, to);
  await to.dispatchEvent('drop', { dataTransfer });
  if (await from.count()) await from.dispatchEvent('dragend', { dataTransfer });
}

test('Board: drag a plan to Done, Undo from the toast, refusals keep the card, keyboard menu path', async () => {
  const fixture = await launchFixture('demo');
  const { page } = fixture;
  try {
    const dismiss = page.getByRole('button', { name: 'Dismiss update' });
    if (await dismiss.isVisible()) await dismiss.click();
    await navigate(page, '/board');
    const done = column(page, 'Done');
    const inProgress = column(page, 'In progress');
    const search = card(page, 'studio/Ledger/Cải thiện tìm kiếm');
    await expect(inProgress.locator(search)).toHaveCount(1);
    await expect(search).toHaveAttribute('draggable', 'true');
    // Done plans can be moved back to another state but have no Mark as Done.
    const finished = card(page, 'studio/Ledger/Hoàn tất bản mẫu');
    await expect(done.locator(finished)).toHaveCount(1);
    await expect(finished).toHaveAttribute('draggable', 'true');
    await finished.locator('summary').click();
    await expect(
      finished.getByRole('button', { name: 'Mark as Done' }),
    ).toHaveCount(0);
    await finished.locator('summary').click();

    // All other Plan-state columns are targets.
    const dataTransfer = await dragOver(page, search, done);
    await expect(done).toHaveClass(/drop-target/);
    await expect(
      done.getByText('Drop here to mark the plan Done'),
    ).toBeVisible();
    await expect(page.locator('.board-column.drop-target')).toHaveCount(4);
    await done.dispatchEvent('drop', { dataTransfer });
    await search.dispatchEvent('dragend', { dataTransfer });
    await expect(done.locator(search)).toHaveCount(1);
    await expect(page.locator('.board-column.drop-target')).toHaveCount(0);
    const toast = page.locator('.toast');
    await expect(toast).toContainText('Marked Cải thiện tìm kiếm Done');
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(inProgress.locator(search)).toHaveCount(1);
    await expect(toast).toContainText(
      'Cải thiện tìm kiếm is back to Implementing',
    );

    // Other columns write the matching Plan state, and Undo restores it.
    await drop(page, search, column(page, 'Review & test'));
    await expect(column(page, 'Review & test').locator(search)).toHaveCount(1);
    await expect(
      search.getByLabel('Plan state for Cải thiện tìm kiếm'),
    ).toHaveValue('Reviewing');
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(inProgress.locator(search)).toHaveCount(1);

    // A refusal is shown plainly and the card stays where it was.
    const locked = card(page, 'studio/Services/Khắc phục đồng bộ');
    const waiting = column(page, 'Waiting');
    await expect(waiting.locator(locked)).toHaveCount(1);
    await drop(page, locked, done);
    await expect(page.getByRole('alert')).toContainText(
      'This plan could not be changed. The file may be locked or unavailable.',
    );
    await expect(waiting.locator(locked)).toHaveCount(1);
    await page
      .getByRole('button', { name: 'Dismiss', exact: true })
      .first()
      .click();

    // Keyboard and screen reader path: the card menu.
    const plan1 = card(page, 'studio/Workspace 1/Plan 1');
    await expect(column(page, 'Review & test').locator(plan1)).toHaveCount(1);
    await plan1.locator('summary').focus();
    await page.keyboard.press('Enter');
    const mark = plan1.getByRole('button', { name: 'Mark as Done' });
    await expect(mark).toBeVisible();
    await mark.focus();
    await page.keyboard.press('Enter');
    await expect(done.locator(plan1)).toHaveCount(1);
    await expect(toast).toContainText('Marked Plan 1 Done');
    const undo = toast.getByRole('button', { name: 'Undo' });
    await undo.focus();
    await page.keyboard.press('Enter');
    await expect(column(page, 'Review & test').locator(plan1)).toHaveCount(1);

    // The plan page has the same action, hidden once the plan is Done.
    await navigate(
      page,
      '/plan/' + encodeURIComponent('studio/Workspace 1/Plan 1') + '/summary',
    );
    const actions = page.locator('.plan-header .plan-actions');
    await actions.locator('summary').click();
    await actions.getByRole('button', { name: 'Mark as Done' }).click();
    await expect(toast).toContainText('Marked Plan 1 Done');
    await actions.locator('summary').click();
    await expect(
      actions.getByRole('button', { name: 'Mark as Done' }),
    ).toHaveCount(0);
    await expect(
      actions.getByRole('button', { name: 'Archive', exact: true }),
    ).toBeVisible();

    // Reduced motion: the toast appears without animation.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(
      await toast.evaluate((el) => getComputedStyle(el).animationName),
    ).toBe('none');
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});
