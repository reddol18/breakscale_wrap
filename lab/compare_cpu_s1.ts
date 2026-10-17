/*
 * S1 v0 (300rps) 화면 시나리오를 CPU 경합 모델 끔/켬으로 돌려 숫자를 비교한다.
 * 시나리오: 10초 api2 crash, 15초 해제 (lab/viz/main.tsx와 같음).
 * 실행: bun lab/compare_cpu_s1.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLab, type Controller } from './core/run';
import { CpuContention } from './core/cpu';
import type { SpecSheet } from './core/meter';

const root = join(import.meta.dir, '..');
const args = JSON.parse(readFileSync(join(root, 'lab/fixtures/official/S1/C02.args.json'), 'utf8'));
const specs = JSON.parse(readFileSync(join(root, 'lab/specs/S1_v0.json'), 'utf8')).nodes as SpecSheet;

function scenario(cpu: CpuContention | null): Controller {
  let crashed = false;
  return {
    init: (e, t) => cpu?.init(e, t),
    tick(e, s, t) {
      const ev = cpu ? cpu.tick(e, s, t) : [];
      if (!crashed && t >= 10_000 && t < 15_000) { e.injectFailure('api2', 'crash'); crashed = true; ev.push({ t, node: 'api2', what: 'crash' }); }
      if (crashed && t >= 15_000) { e.clearFailure('api2'); crashed = false; ev.push({ t, node: 'api2', what: 'clear' }); }
      return ev;
    },
  };
}

for (const on of [false, true]) {
  const cpu = on ? new CpuContention(specs) : null;
  const rows: string[] = [];
  const marks = [5_000, 12_000, 20_000];
  const r = await runLab(args, {
    seconds: 22, seed: 1, budgetMs: 60_000, tickMs: 50, controller: scenario(cpu),
    onFrame: (e, t) => {
      if (marks.length && t >= marks[0]) {
        marks.shift();
        const s = e.snapshot();
        const f = (id: string) => (cpu?.state.get(id)?.factor ?? 1).toFixed(2);
        rows.push(`  t=${(t / 1000).toFixed(0)}s served ${s.system.goodputRps.toFixed(0)}/s failed ${(s.system.errorRate * 100).toFixed(1)}% ` +
          `p99 ${s.system.p99.toFixed(0)}ms | api1 ${s.nodes.api1.throughput.toFixed(0)}/s x${f('api1')} · api2 ${s.nodes.api2.throughput.toFixed(0)}/s x${f('api2')} · db busy ${(s.nodes.db.utilization * 100).toFixed(0)}% x${f('db')}`);
      }
    },
  });
  console.log(`CPU 경합 ${on ? 'ON' : 'OFF'}  (CPU 개입 ${r.events.filter((e) => e.what.startsWith('cpu')).length}회)`);
  console.log(rows.join('\n'));
}
