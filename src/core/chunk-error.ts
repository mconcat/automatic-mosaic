// 앱을 다시 배포한 뒤 예전에 연 페이지가 이제 없는 코드 조각(chunk)을 동적 import 하면 브라우저마다 다른 오류가 난다.
// 그런 오류면 새로고침하라고 알린다.
const CHUNK_LOAD_ERRORS = [/Importing a module script failed/i, /Failed to fetch dynamically imported module/i, /error loading dynamically imported module/i];

export function withReloadHint(err: unknown): unknown {
  const msg = err instanceof Error ? err.message : String(err);
  if (!CHUNK_LOAD_ERRORS.some((re) => re.test(msg))) return err;
  return new Error(`Could not load part of the app (${msg}). The app may have been updated — reload the page.`);
}
