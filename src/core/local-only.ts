// 추론은 모두 브라우저 안에서 한다. 바깥으로 나가는 요청은 공식 저장소에서 모델·WASM을 받는 것뿐이다.
// MediaPipe Tasks 1.2.0은 사용 지표를 https://odml.pa.googleapis.com/v1/log 로 보낸다 (태스크마다 60초 간격, close() 때).
// fetch를 감싸 이런 텔레메트리 요청만 보내기 전에 거부한다. 그러면 MediaPipe 로거는 오류로 보고 스스로 멈춘다.
// 메인 스레드와 검출 Worker에 각각 건다 (Worker는 막은 URL을 메인으로 알린다).

const BLOCKED_HOSTS = ['odml.pa.googleapis.com'];

export function isAllowedUrl(url: string, origin: string): boolean {
  if (url.startsWith('data:') || url.startsWith('blob:')) return true;
  try {
    return !BLOCKED_HOSTS.includes(new URL(url, origin).hostname);
  } catch {
    return false;
  }
}

/** 막은 요청 URL (메인 + Worker, 테스트 훅으로 보인다) */
export const blockedRequests: string[] = [];

export function noteBlocked(url: string): void {
  blockedRequests.push(url);
  console.info('[local-only] blocked telemetry request:', url);
}

// 모델·WASM 다운로드 진행률 (진행 표시줄용). 응답을 복제해 바이트만 센다 (원래 소비자는 그대로 읽는다).
export interface DownloadProgress {
  url: string;
  loaded: number;
  total: number; // Content-Length (없거나 압축이면 0일 수 있다)
  done: boolean;
}
export type ProgressListener = (p: DownloadProgress) => void;

const MODEL_FILE = /\.(wasm|tflite|task|onnx|onnx_data|bin)(\?|$)/i;

/** 진행 중·끝난 다운로드 (메인 + Worker). 표시줄이 읽고, 한 묶음이 끝나면 비운다. */
export const downloads = new Map<string, DownloadProgress>();

export function noteProgress(p: DownloadProgress): void {
  downloads.set(p.url, p);
}

// 이보다 큰 응답은 복제하지 않는다. 복제본을 한 벌 더 들고 있으면 iOS WebKit에서 메모리가 넘쳐 탭이 죽는다
// (OWL-ViT fp16 약 300MB). 그런 모델은 로더 자체의 진행률 콜백으로 센다 (owlvit.ts).
const MAX_CLONE_BYTES = 64 * 1024 * 1024;

function trackDownload(res: Response, url: string, onProgress: ProgressListener): void {
  if (!res.ok || !res.body || !MODEL_FILE.test(url)) return;
  const total = Number(res.headers.get('content-length')) || 0;
  if (total === 0 || total > MAX_CLONE_BYTES) return;
  const reader = res.clone().body!.getReader();
  let loaded = 0;
  onProgress({ url, loaded, total, done: false });
  const pump = (): void => {
    reader.read().then(
      ({ done, value }) => {
        if (done) return onProgress({ url, loaded, total: Math.max(total, loaded), done: true });
        loaded += value.byteLength;
        onProgress({ url, loaded, total, done: false });
        pump();
      },
      () => onProgress({ url, loaded, total, done: true }),
    );
  };
  pump();
}

interface FetchScope {
  fetch: typeof fetch;
  location: { origin: string };
}

export function installLocalOnlyFetch(
  scope: FetchScope = window,
  onBlocked: (url: string) => void = noteBlocked,
  onProgress: ProgressListener = noteProgress,
): void {
  const nativeFetch = scope.fetch.bind(scope);
  // 진행률은 처음 받을 때만 센다. 검출기를 다시 만들 때 같은 모델을 또 받으면(브라우저 캐시) 복제하지 않는다.
  const tracked = new Set<string>();
  scope.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (!isAllowedUrl(url, scope.location.origin)) {
      onBlocked(url);
      return Promise.reject(new TypeError(`Blocked telemetry request: ${url}`));
    }
    return nativeFetch(input, init).then((res) => {
      try {
        if (!tracked.has(url)) {
          tracked.add(url);
          trackDownload(res, url, onProgress);
        }
      } catch {
        // 진행률은 보조 정보다. 세지 못해도 응답은 그대로 넘긴다.
      }
      return res;
    });
  };
}
