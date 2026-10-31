// QA P1: 카메라 권한 거부.
import { expect, test } from '@playwright/test';
import { canvasThumb, collectPageErrors, isMediaPipeLog, litRatio, snapshot, useFakeCamera } from './helpers';
import { collectConsole, installProbes, probe, saveEvidence, shot } from './qa-helpers';

useFakeCamera('still-1face.y4m', { deny: true });

test('QA-5 권한 거부: 한국어 안내, error 상태, 잡히지 않은 예외 없음, 다시 눌러도 같음', async ({ page }) => {
  const errors = collectPageErrors(page);
  const consoleLog = collectConsole(page);
  await installProbes(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => window.__am.snapshot().state === 'error');
  await page.waitForTimeout(500);

  const s = await snapshot(page);
  const p = await probe(page);
  const alertText = await page.getByRole('alert').textContent();
  const statusText = await page.locator('#status').textContent();
  const toggle = { text: await page.locator('#toggle').textContent(), enabled: await page.locator('#toggle').isEnabled() };
  const lit = litRatio(await canvasThumb(page));
  const placeholderVisible = await page.locator('.placeholder').isVisible();
  await shot(page, 'p1-05-denied-error');

  // 다시 시작을 눌러도 같은 안내와 상태, 예외 없음
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => window.__am.snapshot().state === 'error');
  await page.waitForTimeout(300);
  const s2 = await snapshot(page);
  const p2 = await probe(page);

  const evidence = { snapshot: s, probe: p, alertText, statusText, toggle, canvasLit: lit, placeholderVisible, retry: { snapshot: s2, probe: p2 }, pageErrors: errors.map(String), console: consoleLog };
  saveEvidence('qa5-denied', evidence);
  console.log('[QA-5 denied]', JSON.stringify(evidence));

  expect(s.state).toBe('error');
  expect(s.errorCode).toBe('not-allowed');
  expect(alertText).toMatch(/camera/i);
  expect(alertText).toContain('Camera permission was denied');
  expect(statusText).toMatch(/^Error/);
  await expect(page.getByRole('alert')).toBeVisible();
  expect(toggle).toEqual({ text: 'Start', enabled: true });
  expect(p.streamCount).toBe(0);
  expect(s.frameCount).toBe(0);
  expect(s2.state).toBe('error');
  expect(s2.errorCode).toBe('not-allowed');
  expect(errors).toEqual([]);
  expect(p2.errors).toEqual([]);
  expect(consoleLog.filter((m) => m.type === 'error' && !isMediaPipeLog(m.text))).toEqual([]); // P2: MediaPipe 자체 로그 제외
});
