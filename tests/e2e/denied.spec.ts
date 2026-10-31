import { expect, test } from '@playwright/test';
import { collectPageErrors, snapshot, useFakeCamera } from './helpers';

useFakeCamera('still-1face.y4m', { deny: true });

test('카메라 권한을 거부하면 한국어 안내가 나오고 error 상태가 된다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => window.__am.snapshot().state === 'error');

  const s = await snapshot(page);
  expect(s.errorCode).toBe('not-allowed');
  expect(s.error).toMatch(/permission/);
  expect(s.frameCount).toBe(0);
  expect(s.tracks).toEqual([]);

  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('Camera permission was denied');
  await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled();
  expect(errors).toEqual([]);
});
