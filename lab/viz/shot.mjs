// 녹화용 페이지를 열어 콘솔 오류를 모으고, 지정한 시뮬레이션 시각에 화면을 찍는다.
// 실행: node lab/viz/shot.mjs <출력폴더> [초,초,...]
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(join(here, '..', '..', 'package.json'));
const { chromium } = req('playwright-core');

const outDir = resolve(process.argv[2] ?? join(here, 'out'));
const marks = (process.argv[3] ?? '5,12,20').split(',').map(Number);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
// 네 번째 인자: 주소 옵션(예: scn=noisy&cpu=0)
await page.goto(`http://127.0.0.1:4180/?${process.argv[4] ?? ''}`, { waitUntil: 'domcontentloaded' });

const simSeconds = () => page.evaluate(() => {
  const m = /t=([\d.]+)s/.exec(document.getElementById('hud')?.textContent ?? '');
  return m ? Number(m[1]) : -1;
});
for (const s of marks) {
  const deadline = Date.now() + 120_000;
  while ((await simSeconds()) < s && Date.now() < deadline) await page.waitForTimeout(100);
  const hud = await page.evaluate(() => document.getElementById('hud')?.textContent);
  const file = join(outDir, `t${s}.png`);
  // page.screenshot은 폰트 로딩 완료를 기다리다 멈춘다. CDP로 바로 찍는다.
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(data, 'base64'));
  await cdp.detach();
  console.log(`${file}\n  ${hud}`);
}
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console errors');
await browser.close();
