/*
 * S1 v0 crash 시나리오에서 LB가 api1/api2에 나눠 보내는 양을 0.5초 간격으로 찍는다.
 * edgeFlow(화면의 선 위 숫자)와, 같은 0.5초 동안 실제로 각 API에 도착한 수(arrival 누계 차)를 같이 본다.
 * 실행: bun lab/probe_lb.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLab } from './core/run';

const root = join(import.meta.dir, '..');
const args = JSON.parse(readFileSync(join(root, 'lab/fixtures/official/S1/C02.args.json'), 'utf8'));
let crashed = false;
let next = 8_000;
let prev = { a1: 0, a2: 0 };
const counts = { a1: 0, a2: 0 };

await runLab(args, {
  seconds: 20, seed: 1, budgetMs: 60_000, tickMs: 1000 / 60,
  controller: {
    tick(e, s, t) {
      if (!crashed && t >= 10_000 && t < 15_000) { e.injectFailure('api2', 'crash'); crashed = true; }
      if (crashed && t >= 15_000) { e.clearFailure('api2'); crashed = false; }
      return [];
    },
  },
  onFrame(e, t) {
    const s = e.snapshot();
    // 누계 도착: 완료 + 실패 + 처리 중 + 대기
    const arrived = (id: string) => {
      const n = s.nodes[id];
      return n.totalCompleted + n.totalFailed + n.inFlight + n.queued;
    };
    counts.a1 = arrived('api1');
    counts.a2 = arrived('api2');
    if (t >= next) {
      next += 500;
      const ids = Object.keys(s.edgeFlow);
      const flow = (to: string) => ids.filter((k) => k.includes(to)).map((k) => s.edgeFlow[k]);
      const d1 = (counts.a1 - prev.a1) * 2, d2 = (counts.a2 - prev.a2) * 2;
      prev = { ...counts };
      console.log(
        `t=${(t / 1000).toFixed(1)}s ${crashed ? 'CRASH' : '     '} ` +
          `실도착/s api1 ${d1.toFixed(0).padStart(4)} api2 ${d2.toFixed(0).padStart(4)} | ` +
          `slot+대기 api1 ${(s.nodes.api1.inFlight + s.nodes.api1.queued).toFixed(0).padStart(3)} api2 ${(s.nodes.api2.inFlight + s.nodes.api2.queued).toFixed(0).padStart(3)} | ` +
          `edgeFlow(화면) ${JSON.stringify(Object.fromEntries(ids.filter((k) => /api/.test(k)).map((k) => [k, Math.round(s.edgeFlow[k])])))}`,
      );
    }
  },
});
