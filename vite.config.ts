import { defineConfig } from 'vitest/config';

// 포트는 package.json 스크립트에서 고정한다 (dev 5317, preview 5318, demo 5320).
// 아이패드 등 다른 기기에서는 `tailscale serve`(HTTPS, *.ts.net)로 연다. 카메라는 보안 컨텍스트(HTTPS)에서만 열린다.
const allowedHosts = ['.ts.net'];

export default defineConfig({
  server: { allowedHosts },
  preview: { allowedHosts },
  // 검출 Worker는 module Worker다 (MediaPipe를 동적 import 하므로 코드 분할이 되는 ES 형식이어야 한다).
  worker: { format: 'es' },
  // Transformers.js(onnxruntime-web)는 사전 번들링하면 WASM 경로가 깨진다
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
