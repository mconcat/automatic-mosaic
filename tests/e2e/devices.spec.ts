import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectPageErrors, snapshot, startApp } from './helpers';

// 파일 영상 대신 Chrome 합성 가짜 카메라 2대를 쓴다 (파일 영상은 장치가 1대뿐이다).
test.use({
  permissions: ['camera'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream=device-count=2'] },
});

declare global {
  interface Window {
    __oldTracks?: MediaStreamTrack[];
    __requested?: string[];
  }
}

function cameraSelect(page: Page): Locator {
  return page.getByLabel('Camera', { exact: true });
}

// 카메라 선택 상자(Tweakpane)는 옵션 값에 장치 ID를 두지 않으므로 ID는 테스트 훅에서, 선택은 이름으로 한다.
async function deviceIds(page: Page): Promise<string[]> {
  return (await snapshot(page)).devices.map((d) => d.deviceId);
}

async function selectDevice(page: Page, deviceId: string): Promise<void> {
  const label = (await snapshot(page)).devices.find((d) => d.deviceId === deviceId)!.label;
  await cameraSelect(page).selectOption({ label });
}

// 선택 상자에 보이는 장치 ID
async function selectedDevice(page: Page): Promise<string | undefined> {
  const label = await cameraSelect(page).evaluate((el) => {
    const s = el as HTMLSelectElement;
    return s.options[s.selectedIndex]?.textContent ?? '';
  });
  return (await snapshot(page)).devices.find((d) => d.label === label)?.deviceId;
}

// 실행 중인 장치와 다른 장치 ID
async function otherDevice(page: Page): Promise<{ current: string; other: string }> {
  const values = await deviceIds(page);
  expect(values).toHaveLength(2);
  expect(await cameraSelect(page).locator('option').count()).toBe(2);
  const current = (await snapshot(page)).deviceId!;
  return { current, other: values.find((v) => v !== current)! };
}

async function waitRunning(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = window.__am.snapshot();
    return s.state === 'running' && s.frameCount >= 3;
  });
}

test('카메라를 바꾸면 이전 트랙을 끝내고 새 장치로 계속 렌더한다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  const select = cameraSelect(page);
  const { other: next } = await otherDevice(page);

  await page.evaluate(() => {
    const video = document.getElementById('source') as HTMLVideoElement;
    window.__oldTracks = (video.srcObject as MediaStream).getTracks();
    // 전환이 눈에 보이도록 getUserMedia를 늦춘다.
    const md = navigator.mediaDevices;
    const getUserMedia = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      await new Promise((r) => setTimeout(r, 300));
      return getUserMedia(c);
    };
  });

  await selectDevice(page, next);
  // 전환이 끝날 때까지 선택 상자를 막아 전환이 겹치지 않게 한다.
  await expect(select).toBeDisabled();
  await expect.poll(async () => (await snapshot(page)).deviceId).toBe(next);
  await expect(select).toBeEnabled();
  const switchedAt = (await snapshot(page)).frameCount;
  await expect.poll(async () => (await snapshot(page)).frameCount).toBeGreaterThan(switchedAt + 3);

  const s = await snapshot(page);
  expect(s.state).toBe('running');
  expect(s.error).toBeNull();
  expect(s.tracks.every((t) => t.readyState === 'live')).toBe(true);
  expect(await page.evaluate(() => window.__oldTracks!.map((t) => t.readyState))).toEqual(['ended']);
  expect(await selectedDevice(page)).toBe(next);
  expect(await page.evaluate(() => window.__am.get('deviceId'))).toBe(next);
  expect(errors).toEqual([]);
});

test('비동기 표시: 같은 크기의 다른 카메라로 바꾸면 이전 카메라의 박스를 쓰지 않고 새 카메라의 첫 결과까지 화면 전체를 가린다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  await page.evaluate(() => {
    window.__am.set('displayMode', 'async');
    // 실제 웹캠처럼 새 장치를 여는 동안에도 이전 카메라 프레임이 계속 검출되게 getUserMedia를 늦춘다.
    const md = navigator.mediaDevices;
    const getUserMedia = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      await new Promise((r) => setTimeout(r, 300));
      return getUserMedia(c);
    };
  });
  await page.waitForFunction(() => {
    const r = window.__am.renders().at(-1);
    return r?.mode === 'async' && !r.fullCover && r.detectionFrameId !== null;
  });
  const before = await snapshot(page);
  const seq = await page.evaluate(() => window.__am.renders().at(-1)!.seq);
  const { other } = await otherDevice(page);
  await selectDevice(page, other);
  await expect.poll(async () => (await snapshot(page)).deviceId).toBe(other);
  // 전환 때 전체를 가렸다가, 새 카메라의 검출 결과로 그린 프레임이 나올 때까지
  await expect
    .poll(
      () =>
        page.evaluate((s) => {
          const recs = window.__am.renders(s);
          const i = recs.findIndex((r) => r.fullCover);
          return i >= 0 && recs.slice(i).some((r) => !r.fullCover);
        }, seq),
      { message: '전환 뒤 전체를 가렸다가 새 카메라의 결과로 돌아와야 한다', timeout: 8000 },
    )
    .toBe(true);
  const recs = await page.evaluate((s) => window.__am.renders(s), seq);
  const after = await snapshot(page);
  const first = recs.findIndex((r) => r.fullCover);
  const covered = recs.filter((r) => r.fullCover).length;
  console.log('[async switch]', JSON.stringify({ size: [after.videoWidth, after.videoHeight], renders: recs.length, first, covered }));

  expect([after.videoWidth, after.videoHeight]).toEqual([before.videoWidth, before.videoHeight]); // 같은 크기라 크기 검사로는 걸리지 않는다
  expect(first).toBeGreaterThan(0); // 전환 직전까지는 이전 카메라의 결과(새것)로 그렸다
  expect(recs[first - 1]!.detectionFrameId).not.toBeNull();
  // 전체를 가린 첫 프레임이 새 카메라의 첫 프레임이다. 그 뒤 박스로 그린 프레임은 모두 새 카메라 프레임의 결과를 쓴다.
  const boundary = recs[first]!.frameId;
  for (const r of recs.slice(first)) {
    expect(r.mode).toBe('async');
    if (r.fullCover) expect(r.detectionFrameId).toBeNull();
    else expect(r.detectionFrameId!).toBeGreaterThanOrEqual(boundary);
  }
  expect(errors).toEqual([]);
});

test('고른 카메라가 빠지면 선택 상자와 다음 시작이 남은 카메라로 맞춰진다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  const select = cameraSelect(page);
  const { current: remaining, other: gone } = await otherDevice(page);
  await selectDevice(page, gone);
  await expect.poll(async () => (await snapshot(page)).deviceId).toBe(gone);
  await expect(select).toBeEnabled(); // 전환 끝

  // 장치 분리 흉내: 목록에서 빼고, 그 장치를 열면 실제 Chrome처럼 OverconstrainedError(deviceId),
  // 트랙 ended, devicechange 순서로 알린다.
  await page.evaluate((goneId) => {
    const md = navigator.mediaDevices;
    const enumerate = md.enumerateDevices.bind(md);
    const getUserMedia = md.getUserMedia.bind(md);
    window.__requested = [];
    md.enumerateDevices = async () => (await enumerate()).filter((d) => d.deviceId !== goneId);
    md.getUserMedia = async (c) => {
      const video = c?.video as MediaTrackConstraints | undefined;
      const id = (video?.deviceId as ConstrainDOMStringParameters | undefined)?.exact;
      window.__requested!.push(String(id ?? ''));
      if (id === goneId) throw new OverconstrainedError('deviceId', 'Requested device not found');
      return getUserMedia(c);
    };
    const source = document.getElementById('source') as HTMLVideoElement;
    (source.srcObject as MediaStream).getVideoTracks()[0]!.dispatchEvent(new Event('ended'));
    md.dispatchEvent(new Event('devicechange'));
  }, gone);

  await expect.poll(async () => (await snapshot(page)).errorCode).toBe('disconnected');
  await expect.poll(() => deviceIds(page)).toEqual([remaining]);
  await expect(select.locator('option')).toHaveCount(1);
  expect(await selectedDevice(page)).toBe(remaining);
  expect((await snapshot(page)).deviceId).toBe(remaining);

  await page.getByRole('button', { name: 'Start' }).click();
  await waitRunning(page);
  const s = await snapshot(page);
  expect(s.deviceId).toBe(remaining);
  expect(s.error).toBeNull();
  expect(await page.evaluate(() => window.__requested)).toEqual([remaining]);
  expect(errors).toEqual([]);
});

test('전환 중 재생이 실패해 카메라를 모두 잃으면 error 상태가 되고 다시 시작할 수 있다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  const { other: next } = await otherDevice(page);

  await page.evaluate(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      HTMLMediaElement.prototype.play = play; // 한 번만 실패
      return Promise.reject(new DOMException('test', 'AbortError'));
    };
  });
  await selectDevice(page, next);

  await expect.poll(async () => (await snapshot(page)).state).toBe('error');
  expect((await snapshot(page)).errorCode).toBe('not-readable');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled();
  expect(await page.evaluate(() => (document.getElementById('source') as HTMLVideoElement).srcObject)).toBeNull();

  // 선택 상자에 남은 장치로 다시 연다.
  await page.getByRole('button', { name: 'Start' }).click();
  await waitRunning(page);
  expect((await snapshot(page)).deviceId).toBe(next);
  expect(errors).toEqual([]);
});

test('연결 중 재생을 기다리는 사이 트랙이 끝나면 error 상태로 남는다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.goto('/');
  await page.evaluate(() => {
    const md = navigator.mediaDevices;
    const getUserMedia = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      const stream = await getUserMedia(c);
      setTimeout(() => stream.getVideoTracks()[0]!.dispatchEvent(new Event('ended')), 0);
      return stream;
    };
    // play()가 끝나기 전에 ended가 오도록 재생 완료를 늦춘다.
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      const playing = play.call(this);
      playing.catch(() => {}); // 나중에 이어 붙이므로 그 전에 거부돼도 '처리 안 된 거부'로 잡히지 않게
      return new Promise((r) => setTimeout(r, 200)).then(() => playing);
    };
  });

  // __am.start()는 시작 절차가 끝나야 resolve 된다.
  await page.evaluate(() => window.__am.start());
  const s = await snapshot(page);
  expect(s.state).toBe('error');
  expect(s.errorCode).toBe('disconnected');
  await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled();
  expect(errors).toEqual([]);
});
