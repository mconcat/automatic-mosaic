import { defineConfig } from '@playwright/test';

// 가짜 카메라 영상(y4m)은 테스트 파일마다 tests/e2e/helpers.ts의 useFakeCamera()로 고른다.
export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5318',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:5318',
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
  },
});
