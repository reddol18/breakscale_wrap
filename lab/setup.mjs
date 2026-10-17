// 한 번에 준비: 원본 Breakscale을 검증한 커밋으로 받아 빌드하고, 녹화용 의존성·브라우저를 설치한다.
// 원본은 수정하지 않는다. 이미 받아 둔 것은 건너뛴다.
// 실행: node lab/setup.mjs [--web] [--no-browser]
//   --web         원본 웹 앱도 빌드한다(로컬에서 breakscale.tech와 같은 화면을 띄울 때만 필요)
//   --no-browser  Playwright용 Chromium 설치를 건너뛴다(녹화·스크린샷을 안 쓸 때)
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/xevrion/breakscale.git';
const COMMIT = 'd2c876e0e17e79447bb81de071ef3b820d88f1a4'; // vendor/VERSION.md와 같아야 한다

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'vendor', 'breakscale');
const args = new Set(process.argv.slice(2));

function run(cmd, cwd = root) {
  console.log(`\n> ${cmd}${cwd !== root ? `   (in ${cwd.replace(root, '.')})` : ''}`);
  const r = spawnSync(cmd, { cwd, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error(`\n실패: ${cmd}`);
    process.exit(r.status ?? 1);
  }
}
function has(cmd) {
  return spawnSync(`${cmd} --version`, { shell: true, stdio: 'ignore' }).status === 0;
}

for (const tool of ['git', 'bun', 'node', 'npm']) {
  if (!has(tool)) {
    console.error(`${tool}이(가) 필요합니다. 설치 후 다시 실행하세요.`);
    process.exit(1);
  }
}
if (!has('ffmpeg')) console.warn('주의: ffmpeg가 없습니다. 영상 녹화(lab/viz/record.mjs)만 안 되고 나머지는 됩니다.');

// 1) 원본 받기 + 커밋 고정
if (!existsSync(join(vendor, '.git'))) run(`git clone ${REPO} "${vendor}"`);
run(`git -C "${vendor}" fetch --quiet origin`);
run(`git -C "${vendor}" checkout --quiet ${COMMIT}`);
const dirty = spawnSync(`git -C "${vendor}" status --porcelain`, { shell: true, encoding: 'utf8' }).stdout.trim();
if (dirty) {
  console.error('vendor/breakscale에 수정된 파일이 있습니다. 원본은 고치지 않는 것이 이 프로젝트의 원칙입니다.');
  process.exit(1);
}

// 2) 원본 의존성(엔진·캔버스·vite·react) + MCP 빌드
run('bun install --frozen-lockfile', vendor);
if (args.has('--web')) run('bun run build', vendor);
run('bun install --frozen-lockfile', join(vendor, 'mcp'));
run('bun run build', join(vendor, 'mcp'));

// 3) 우리 쪽 의존성(playwright-core) + 브라우저
run('npm install --no-audit --no-fund');
if (!args.has('--no-browser')) run('npx playwright-core install chromium');

console.log(`
준비 완료.
  검증:       bun lab/regress.ts   (공식 MCP 응답 23건과 글자 단위로 같아야 함)
  화면:       node lab/viz/serve.mjs  →  http://127.0.0.1:4180/?scn=example_spike
  수치:       bun lab/sim.ts example_spike
  Claude Code: 이 폴더에서 claude 실행 → .mcp.json의 로컬 breakscale MCP 사용 승인`);
