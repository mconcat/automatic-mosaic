import type { Frame, FrameSource } from '../core/types';

export type CameraErrorCode =
  | 'not-allowed'
  | 'not-found'
  | 'not-readable'
  | 'overconstrained'
  | 'unsupported'
  | 'disconnected'
  | 'unknown';

const MESSAGES: Record<CameraErrorCode, string> = {
  'not-allowed':
    'Camera permission was denied. Allow camera access from the icon in the address bar, then start again. If it is already allowed, turn on Chrome in macOS System Settings > Privacy & Security > Camera.',
  'not-found': 'No camera found. Check the webcam connection and the camera selection, then start again.',
  'not-readable': 'Cannot open the camera. Check whether another app is using it.',
  overconstrained: 'The selected camera does not support the requested settings. Choose another camera.',
  unsupported: 'The camera is not available here. Open the app from localhost or over HTTPS.',
  disconnected: 'The camera was disconnected. Check the device, then start again.',
  unknown: 'Failed to start the camera.',
};

export class CameraError extends Error {
  readonly code: CameraErrorCode;
  constructor(code: CameraErrorCode, cause?: unknown) {
    super(MESSAGES[code], { cause });
    this.name = 'CameraError';
    this.code = code;
  }
}

// getUserMedia 등이 던지는 DOMException을 사용자용 오류로 바꾼다.
export function toCameraError(err: unknown): CameraError {
  if (err instanceof CameraError) return err;
  switch (field(err, 'name')) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CameraError('not-allowed', err);
    case 'NotFoundError':
      return new CameraError('not-found', err);
    case 'NotReadableError':
    case 'AbortError':
      return new CameraError('not-readable', err);
    case 'OverconstrainedError':
      // 해상도는 ideal로만 거므로 deviceId(exact)가 걸리면 고른 장치가 없는 것이다.
      return new CameraError(field(err, 'constraint') === 'deviceId' ? 'not-found' : 'overconstrained', err);
    default:
      return new CameraError('unknown', err);
  }
}

function field(err: unknown, key: string): string {
  return typeof err === 'object' && err !== null && key in err ? String((err as Record<string, unknown>)[key]) : '';
}

export function cameraConstraints(deviceId?: string): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  };
}

export interface CameraDevice {
  deviceId: string;
  label: string;
}

// 웹캠 FrameSource. 비디오 프레임마다(requestVideoFrameCallback) ImageBitmap을 만들어 하나의 소비자에게 넘긴다.
export class CameraSource implements FrameSource {
  readonly kind = 'camera';
  /** 트랙이 예기치 않게 끝났을 때 (장치 분리, 권한 회수) */
  onEnded: ((err: CameraError) => void) | null = null;

  private readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private listener: ((frame: Frame) => void) | null = null;
  private generation = 0;
  private frameId = 0;
  private lastTimestamp = 0;
  private rvfcHandle = 0;
  private capturing = false;

  constructor(video: HTMLVideoElement) {
    this.video = video;
    video.muted = true;
    video.playsInline = true;
  }

  get active(): boolean {
    return this.stream !== null;
  }

  get tracks(): MediaStreamTrack[] {
    return this.stream?.getTracks() ?? [];
  }

  /** 열려 있는 장치 ID. 스트림이 없으면 undefined (고른 장치는 호출부가 들고 있다). */
  get deviceId(): string | undefined {
    return this.stream?.getVideoTracks()[0]?.getSettings().deviceId;
  }

  /** 소비자는 하나다. 넘겨받은 frame.bitmap은 소비자가 close() 한다. */
  onFrame(listener: (frame: Frame) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  /**
   * deviceId 카메라를 연다 (없으면 기본 장치). 실행 중에 부르면 장치 전환이다: 새 스트림을 얻은 뒤에
   * 이전 스트림을 놓으므로 getUserMedia가 실패하면 이전 스트림이 남는다. 재생(play)이 실패하면 둘 다 놓는다.
   * 기다리는 사이 stop()이나 다른 start()가 불리면 던지지 않고 끝난다. 결과는 `active`로 확인한다.
   */
  async start(deviceId?: string): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new CameraError('unsupported');
    const gen = ++this.generation;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(cameraConstraints(deviceId));
    } catch (err) {
      if (gen !== this.generation) return;
      throw toCameraError(err);
    }
    if (gen !== this.generation) {
      stopTracks(stream);
      return;
    }
    this.release();
    this.stream = stream;
    for (const track of stream.getTracks()) track.addEventListener('ended', this.handleEnded);
    this.video.srcObject = stream;
    // 스트림을 붙이자마자 프레임 루프를 건다. 스트림이 있는 동안에는 루프도 항상 있다.
    this.rvfcHandle = this.video.requestVideoFrameCallback(this.handleVideoFrame);
    try {
      await this.video.play();
    } catch (err) {
      if (gen !== this.generation) return;
      this.stop();
      throw toCameraError(err);
    }
  }

  stop(): void {
    this.generation++;
    this.release();
  }

  async listDevices(): Promise<CameraDevice[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'videoinput' && d.deviceId)
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  }

  onDeviceChange(listener: () => void): () => void {
    const md = navigator.mediaDevices;
    if (!md) return () => {};
    md.addEventListener('devicechange', listener);
    return () => md.removeEventListener('devicechange', listener);
  }

  private release(): void {
    if (this.rvfcHandle) this.video.cancelVideoFrameCallback(this.rvfcHandle);
    this.rvfcHandle = 0;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.removeEventListener('ended', this.handleEnded);
      stopTracks(this.stream);
    }
    this.stream = null;
    this.video.srcObject = null;
  }

  private handleEnded = (): void => {
    this.stop();
    this.onEnded?.(new CameraError('disconnected'));
  };

  private handleVideoFrame = (now: number): void => {
    if (!this.stream) return;
    this.rvfcHandle = this.video.requestVideoFrameCallback(this.handleVideoFrame);
    // 이전 프레임 변환이 끝나지 않았으면 이번 프레임은 버린다.
    if (this.capturing || !this.listener) return;
    this.capturing = true;
    const gen = this.generation;
    const streamId = this.stream.id; // 전환 직전에 시작한 캡처는 이전 스트림의 프레임이다
    createImageBitmap(this.video)
      .then((bitmap) => {
        const listener = this.listener;
        if (gen !== this.generation || !listener) {
          bitmap.close();
          return;
        }
        this.lastTimestamp = Math.max(now, this.lastTimestamp + 0.001);
        const frame: Frame = {
          id: ++this.frameId,
          timestampMs: this.lastTimestamp,
          streamId,
          bitmap,
          width: bitmap.width,
          height: bitmap.height,
        };
        try {
          listener(frame);
        } catch (err) {
          bitmap.close();
          console.error('[camera] Frame handling error', err);
        }
      })
      .catch((err: unknown) => console.warn('[camera] Frame capture failed', err))
      .finally(() => {
        this.capturing = false;
      });
  };
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}
