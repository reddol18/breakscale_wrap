/*
 * 회귀 확인: 컨트롤러 없이 runLab을 돌린 결과가
 * 공식 MCP create_view 응답(lab/fixtures/official/S1·S2의 .txt, 고정 커밋으로 받은 23건)과 글자 단위로 같은지 본다.
 * 실행: bun lab/regress.ts
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_RUN } from '../vendor/breakscale/mcp/src/run';
import { runLab } from './core/run';

const root = join(import.meta.dir, 'fixtures', 'official');
let same = 0;
let total = 0;
for (const scenario of ['S1', 'S2']) {
  const dir = join(root, scenario);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.args.json')).sort()) {
    const id = f.replace('.args.json', '');
    const args = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const want = readFileSync(join(dir, `${id}.txt`), 'utf8').replace(/\r\n/g, '\n').trimEnd();
    const got = (await runLab(args, { ...DEFAULT_RUN })).text.trimEnd();
    total++;
    if (got === want) {
      same++;
      console.log(`${scenario}/${id} same`);
    } else {
      console.log(`${scenario}/${id} DIFF`);
      const a = got.split('\n');
      const b = want.split('\n');
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
          console.log(`  line ${i + 1}\n  lab : ${a[i]}\n  mcp : ${b[i]}`);
          break;
        }
      }
    }
  }
}
console.log(`\n${same}/${total} same`);
if (same !== total) process.exit(1);
