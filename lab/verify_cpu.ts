/*
 * CPU 경합 컨트롤러 검증.
 *  A. 수요 ≤ vCPU면 결과가 공식 MCP와 글자 단위로 같아야 한다(컨트롤러가 아무것도 안 함).
 *  B. 슬롯이 다 찬 과부하에서 처리량이 이론값과 맞아야 한다.
 *       D=c·p ≤ V : 처리량 = c / s          (슬롯 상한, 엔진 원래 동작)
 *       D=c·p > V : 처리량 = V / (p · s)    (CPU 상한)
 *  C. 같은 호스트를 나눠 쓰는 두 노드: 한쪽 부하가 다른 쪽을 느리게 만든다.
 * 실행: bun lab/verify_cpu.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLab } from './core/run';
import { CpuContention } from './core/cpu';
import type { SpecSheet } from './core/meter';

const root = join(import.meta.dir, '..');
const RUN = { seconds: 30, seed: 1, budgetMs: 120_000 };
let fail = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) fail++;
};

// ---------- A ----------
{
  const args = JSON.parse(readFileSync(join(root, 'lab/fixtures/official/S1/C02.args.json'), 'utf8'));
  const official = readFileSync(join(root, 'lab/fixtures/official/S1/C02.txt'), 'utf8').replace(/\r\n/g, '\n').trimEnd();
  const big: SpecSheet = {};
  for (const id of ['api1', 'api2', 'db']) big[id] = { vcpu: 64, cpuPerReq: 0.4 };
  const ctl = new CpuContention(big);
  const r = await runLab(args, { seconds: 30, seed: 1, budgetMs: 3000, controller: ctl, tickMs: 50 });
  check(r.text.trimEnd() === official && r.events.length === 0,
    `A  S1 v0, vCPU 64 (수요<공급): 공식 응답과 동일=${r.text.trimEnd() === official}, 개입 ${r.events.length}회`);
}

// ---------- B ----------
function oneService(c: number, s: number, rps: number) {
  return {
    name: 'cpu probe',
    nodes: [
      { id: 'src', kind: 'client', label: 'Load', config: { rps, timeoutMs: 600000, retries: 0 } },
      { id: 'svc', kind: 'service', label: 'Svc', config: { capacity: c, serviceMs: s, serviceCv: 0.5, queueLimit: 100000, errorRate: 0, timeoutMs: 0, retries: 0 } },
    ],
    edges: [{ from: 'src', to: 'svc' }],
  };
}
async function measure(args: unknown, ctl?: CpuContention, node = 'svc') {
  let atWarm = -1;
  const r = await runLab(args, {
    ...RUN,
    controller: ctl,
    tickMs: 50,
    onFrame: (e, t) => {
      if (atWarm < 0 && t >= 10_000) atWarm = e.snapshot().nodes[node].totalCompleted;
    },
  });
  const done = r.snapshot.nodes[node].totalCompleted - atWarm;
  return { x: done / ((r.simulatedMs - 10_000) / 1000), r };
}

const cases = [
  { c: 4, p: 0.4, V: 2, s: 25 }, // D=1.6 ≤ 2 : 슬롯 상한 160
  { c: 8, p: 0.4, V: 2, s: 25 }, // D=3.2 > 2 : CPU 상한 200 (슬롯 상한 320)
  { c: 64, p: 0.5, V: 2, s: 25 }, // D=32 > 2 : CPU 상한 160 (슬롯 상한 2560)
  { c: 16, p: 0.25, V: 4, s: 10 }, // D=4 = 4 : 경계, 슬롯 상한 1600
  { c: 32, p: 0.25, V: 4, s: 10 }, // D=8 > 4 : CPU 상한 1600 (슬롯 상한 3200)
];
for (const k of cases) {
  const D = k.c * k.p;
  const theory = D > k.V ? k.V / (k.p * k.s / 1000) : k.c / (k.s / 1000);
  const slotOnly = k.c / (k.s / 1000);
  const rps = Math.ceil(theory * 2); // 확실히 과부하
  const base = await measure(oneService(k.c, k.s, rps));
  const ctl = new CpuContention({ svc: { vcpu: k.V, cpuPerReq: k.p } });
  const lab = await measure(oneService(k.c, k.s, rps), ctl);
  const err = (lab.x - theory) / theory;
  check(Math.abs(err) < 0.05,
    `B  c=${k.c} p=${k.p} V=${k.V} s=${k.s}ms D=${D}: 이론 ${theory.toFixed(0)}/s, lab ${lab.x.toFixed(1)}/s (${(err * 100).toFixed(1)}%), ` +
    `컨트롤러 없음 ${base.x.toFixed(1)}/s(슬롯 상한 ${slotOnly.toFixed(0)}), 최종 배율 x${ctl.state.get('svc')!.factor.toFixed(2)}`);
}

// ---------- C ----------
{
  const design = {
    name: 'shared host',
    nodes: [
      { id: 'srcA', kind: 'client', label: 'Load A', config: { rps: 300, timeoutMs: 600000, retries: 0 } },
      { id: 'srcB', kind: 'client', label: 'Load B', config: { rps: 50, timeoutMs: 600000, retries: 0 } },
      { id: 'a', kind: 'service', label: 'A', config: { capacity: 16, serviceMs: 20, serviceCv: 0.5, queueLimit: 100000, timeoutMs: 0, retries: 0 } },
      { id: 'b', kind: 'service', label: 'B', config: { capacity: 16, serviceMs: 20, serviceCv: 0.5, queueLimit: 100000, timeoutMs: 0, retries: 0 } },
    ],
    edges: [{ from: 'srcA', to: 'a' }, { from: 'srcB', to: 'b' }],
  };
  const spec: SpecSheet = { a: { cpuPerReq: 0.5, host: 'h' }, b: { cpuPerReq: 0.5, host: 'h' } };
  const alone = await runLab(design, { ...RUN, controller: new CpuContention({ a: { vcpu: 2, cpuPerReq: 0.5 }, b: { vcpu: 2, cpuPerReq: 0.5 } }), tickMs: 50 });
  const ctl = new CpuContention(spec, { h: { vcpu: 2 } });
  const shared = await runLab(design, { ...RUN, controller: ctl, tickMs: 50 });
  const pb = (x: typeof alone) => x.snapshot.nodes.b.p99;
  check(pb(shared) > pb(alone) * 1.5,
    `C  B는 50rps로 한가함. 전용 2vCPU일 때 B p99 ${pb(alone).toFixed(0)}ms → A와 2vCPU 공유 시 ${pb(shared).toFixed(0)}ms ` +
    `(A 처리 ${shared.snapshot.nodes.a.throughput.toFixed(0)}/s, 이론 CPU 상한 합계 ${(2 / (0.5 * 0.02)).toFixed(0)}/s)`);
}

console.log(fail ? `\n${fail} FAIL` : '\nall PASS');
process.exit(fail ? 1 : 0);
