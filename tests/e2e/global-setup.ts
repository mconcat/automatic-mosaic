import { execFileSync } from 'node:child_process';

// 픽스처가 없으면 만든다 (있으면 금방 끝난다).
export default function globalSetup(): void {
  execFileSync(process.execPath, ['scripts/make-fixtures.mjs'], { stdio: 'inherit' });
}
