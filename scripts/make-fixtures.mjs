// E2E용 가짜 카메라 영상(y4m)을 만든다. 이미 있고 검증을 통과한 파일은 건너뛴다 (--force 로 재생성).
// 원본: MediaPipe 테스트 이미지 portrait.jpg (820x1024, 퍼블릭 도메인 초상).
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'tests/fixtures');
const portraitUrl = 'https://storage.googleapis.com/mediapipe-assets/portrait.jpg';
const portrait = join(outDir, 'portrait.jpg');
const force = process.argv.includes('--force');

const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE ?? 'ffprobe';
const W = 640;
const H = 480;
const FPS = 15;
const SECONDS = 4;
const FRAMES = FPS * SECONDS;

// 얼굴은 원본 기준 대략 x 275–530, y 30–360.
const CLIPS = {
  // 원본 해상도 그대로 얼굴 주변을 640x480으로 자른다.
  'still-1face.y4m': {
    inputs: ['-loop', '1', '-i', portrait],
    filter: `[0:v]crop=${W}:${H}:80:0[v]`,
  },
  // 회색 배경 위에서 머리 부분(240x240)이 사인 곡선으로 좌우 왕복한다 (주기 = 클립 길이라 반복 재생이 끊기지 않음).
  'moving-1face.y4m': {
    inputs: ['-f', 'lavfi', '-i', `color=c=0x707070:s=${W}x${H}:r=${FPS}`, '-loop', '1', '-i', portrait],
    filter:
      `[1:v]crop=500:500:150:0,scale=240:240[head];` +
      `[0:v][head]overlay=x='200+240*sin(2*PI*t/${SECONDS})':y=120:eval=frame[v]`,
  },
  // 같은 인물 두 장을 나란히 붙인다.
  'two-faces.y4m': {
    inputs: ['-loop', '1', '-i', portrait],
    filter: `[0:v]crop=560:840:120:0,scale=320:480,split[a][b];[a][b]hstack[v]`,
  },
  // 커튼과 깃발만 보이는 오른쪽 위 부분.
  'no-face.y4m': {
    inputs: ['-loop', '1', '-i', portrait],
    filter: `[0:v]crop=280:210:540:0,scale=${W}:${H}[v]`,
  },
};

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.error) throw new Error(`${cmd} 실행 실패: ${r.error.message} (ffmpeg/ffprobe 가 PATH에 있어야 합니다)`);
  if (r.status !== 0) throw new Error(`${cmd} 실패 (${r.status}):\n${r.stderr.slice(-2000)}`);
  return r.stdout;
}

async function exists(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

async function fetchPortrait() {
  if (await exists(portrait)) return;
  const tmp = `${portrait}.part`;
  const res = await fetch(portraitUrl);
  if (!res.ok || !res.body) throw new Error(`portrait.jpg 다운로드 실패: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  await rename(tmp, portrait);
  console.log(`[fixtures] 다운로드 ${relative(root, portrait)}`);
}

function probe(path) {
  const out = run(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=width,height,pix_fmt,r_frame_rate,nb_read_frames',
    '-of', 'json', path,
  ]);
  const s = JSON.parse(out).streams?.[0] ?? {};
  const problems = [];
  if (s.width !== W || s.height !== H) problems.push(`크기 ${s.width}x${s.height}`);
  if (s.pix_fmt !== 'yuv420p') problems.push(`pix_fmt ${s.pix_fmt}`);
  if (s.r_frame_rate !== `${FPS}/1`) problems.push(`fps ${s.r_frame_rate}`);
  if (Number(s.nb_read_frames) !== FRAMES) problems.push(`프레임 ${s.nb_read_frames}`);
  return { info: s, problems };
}

async function build(name, { inputs, filter }) {
  const dest = join(outDir, name);
  if (!force && (await exists(dest)) && probe(dest).problems.length === 0) {
    console.log(`[fixtures] 건너뜀 ${relative(root, dest)}`);
    return;
  }
  const tmp = join(outDir, `.${name}.part.y4m`);
  await rm(tmp, { force: true });
  run(FFMPEG, [
    '-y', '-v', 'error', ...inputs,
    '-filter_complex', filter, '-map', '[v]',
    '-r', String(FPS), '-frames:v', String(FRAMES),
    '-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe', tmp,
  ]);
  const { info, problems } = probe(tmp);
  if (problems.length) {
    await rm(tmp, { force: true });
    throw new Error(`${name} 검증 실패: ${problems.join(', ')}`);
  }
  await rename(tmp, dest);
  console.log(`[fixtures] 생성 ${relative(root, dest)} ${info.width}x${info.height} ${info.r_frame_rate}fps ${info.nb_read_frames}프레임`);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  await fetchPortrait();
  for (const [name, spec] of Object.entries(CLIPS)) await build(name, spec);
}

main().catch((err) => {
  console.error(`[fixtures] ${err.message}`);
  process.exit(1);
});
