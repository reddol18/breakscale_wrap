// 녹화용 페이지를 프레임 단위로 캡처해 실시간 속도의 영상(webm, mp4)을 만든다.
// 페이지를 ?manual 모드로 열고, 1/fps초씩 시뮬레이션을 넘긴 뒤 화면을 찍는다.
// 브라우저 화면 녹화(recordVideo)는 부하가 걸리면 프레임을 버려 영상 시간이 짧아지므로 쓰지 않는다.
// 실행: node lab/viz/record.mjs <출력폴더> [초] [fps] [이름] [주소 옵션(예: scn=noisy&cpu=0)]
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(join(here, '..', '..', 'package.json'));
const { chromium } = req('playwright-core');

const outDir = resolve(process.argv[2] ?? join(here, 'out'));
const seconds = Number(process.argv[3] ?? 22);
const fps = Number(process.argv[4] ?? 30);
const name = process.argv[5] ?? 'crash_api2';
const frameDir = join(outDir, `_frames_${name}`);
rmSync(frameDir, { recursive: true, force: true });
mkdirSync(frameDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const extra = process.argv[6] ? `&${process.argv[6]}` : '';
await page.goto(`http://127.0.0.1:4180/?manual${extra}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.__labStep === 'function', null, { timeout: 60_000 });
const cdp = await page.context().newCDPSession(page);

const total = Math.round(seconds * fps);
for (let i = 0; i <= total; i++) {
  if (i > 0) await page.evaluate((ms) => window.__labStep(ms), 1000 / fps);
  else await page.evaluate(() => window.__labStep(0));
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(frameDir, `f${String(i).padStart(5, '0')}.png`), Buffer.from(data, 'base64'));
  if (i % (fps * 2) === 0) process.stdout.write(`${(i / fps).toFixed(0)}s `);
}
const hud = await page.evaluate(() => document.getElementById('hud')?.textContent);
await browser.close();
console.log('\nlast HUD:', hud);

const input = ['-v', 'error', '-y', '-framerate', String(fps), '-i', join(frameDir, 'f%05d.png')];
const webm = join(outDir, `${name}.webm`);
const mp4 = join(outDir, `${name}.mp4`);
execFileSync('ffmpeg', [...input, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-row-mt', '1', webm]);
execFileSync('ffmpeg', [...input, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', mp4]);
rmSync(frameDir, { recursive: true, force: true });
console.log(webm + '\n' + mp4);
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console errors');
