/*
 * 부분 OOM 컨트롤러 검증.
 *  A. 메모리가 넉넉하면 결과가 공식 MCP와 글자 단위로 같다(개입 0회).
 *  B. VM 1대: OOM 시각이 "완료 요청 수 × 요청당 누수 = 여유 메모리"가 되는 순간과 맞고,
 *     헬스체크 제외 → 재시작 → 재합류 → 워밍업 끝 시각이 설정대로 간다. 재시작하면 메모리가 초기화된다.
 *  C. LB 뒤 VM 3대: 누수가 가장 많이 쌓인 1대만 죽는다(부분 장애).
 *     죽은 뒤 헬스체크 전까지는 LB가 죽은 VM으로 계속 보내 실패가 치솟고,
 *     LB에서 빠진 뒤에는 나머지 2대가 받아 실패가 거의 없어지며, 재합류하면 다시 3대로 나뉜다.
 * 실행: bun lab/verify_oom.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLab } from './core/run';
import { PartialOom } from './core/oom';
import type { SpecSheet } from './core/meter';

const root = join(import.meta.dir, '..');
let fail = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) fail++;
};
const OPT = { detectMs: 3000, restartMs: 4000, healthyMs: 2000, warmupMs: 3000, warmupFactor: 2.5 };

// ---------- A ----------
{
  const args = JSON.parse(readFileSync(join(root, 'lab/fixtures/official/S1/C02.args.json'), 'utf8'));
  const official = readFileSync(join(root, 'lab/fixtures/official/S1/C02.txt'), 'utf8').replace(/\r\n/g, '\n').trimEnd();
  const specs: SpecSheet = {};
  for (const id of ['api1', 'api2', 'db']) specs[id] = { memMiB: 1e9, memBaseMiB: 500, memPerInflightMiB: 10, leakPerReqMiB: 0.1 };
  const r = await runLab(args, { seconds: 30, seed: 1, budgetMs: 3000, controller: new PartialOom(specs, OPT), tickMs: 100 });
  check(r.text.trimEnd() === official && r.events.length === 0,
    `A  S1 v0, 메모리 한도 무한: 공식 응답과 동일=${r.text.trimEnd() === official}, 개입 ${r.events.length}회`);
}

// ---------- B ----------
{
  const design = {
    name: 'oom single',
    nodes: [
      { id: 'src', kind: 'client', label: 'Load', config: { rps: 100, timeoutMs: 2000, retries: 0 } },
      { id: 'vm', kind: 'service', label: 'VM', config: { capacity: 16, serviceMs: 20, serviceCv: 0.5, queueLimit: 100, timeoutMs: 0, retries: 0 } },
    ],
    edges: [{ from: 'src', to: 'vm' }],
  };
  // 기준: 컨트롤러 없이 돌려 완료 수가 1000을 넘는 시각(여유 1000 MiB / 요청당 1 MiB)
  let ref = -1;
  await runLab(design, {
    seconds: 20, seed: 1, budgetMs: 60_000,
    onFrame: (e, t) => { if (ref < 0 && e.snapshot().nodes.vm.totalCompleted > 1000) ref = t; },
  });
  const oom = new PartialOom({ vm: { memMiB: 2000, memBaseMiB: 1000, leakPerReqMiB: 1 } }, OPT);
  const r = await runLab(design, { seconds: 40, seed: 1, budgetMs: 60_000, controller: oom, tickMs: 100 });
  const at = (what: string, n = 0) => r.events.filter((e) => e.what.startsWith(what))[n]?.t ?? NaN;
  const t0 = at('OOM kill');
  check(Math.abs(t0 - ref) <= 150, `B  첫 OOM ${(t0 / 1000).toFixed(2)}s, 기준(완료 1000건 도달) ${(ref / 1000).toFixed(2)}s`);
  const steps: [string, number][] = [['헬스체크 실패', OPT.detectMs], ['프로세스 재시작', OPT.restartMs], ['헬스체크 통과', OPT.restartMs + OPT.healthyMs], ['워밍업 끝', OPT.restartMs + OPT.healthyMs + OPT.warmupMs]];
  for (const [w, d] of steps) {
    const got = at(w) - t0;
    check(Math.abs(got - d) <= 150, `B  ${w}: OOM 후 ${(got / 1000).toFixed(2)}s (설정 ${(d / 1000).toFixed(1)}s)`);
  }
  const t1 = at('OOM kill', 1);
  const rejoin = at('헬스체크 통과');
  // 재합류 뒤 다시 1000건(워밍업 중엔 느리지만 100rps는 감당) → 약 10초 뒤 두 번째 OOM
  check(Number.isFinite(t1) && t1 - rejoin > 8000 && t1 - rejoin < 12000,
    `B  재시작 후 메모리 초기화: 재합류 ${(rejoin / 1000).toFixed(2)}s → 두 번째 OOM ${(t1 / 1000).toFixed(2)}s (간격 ${((t1 - rejoin) / 1000).toFixed(1)}s, 예상 약 10s)`);
}

// ---------- C ----------
{
  const vm = (id: string) => ({ id, kind: 'service', label: id, config: { capacity: 16, serviceMs: 20, serviceCv: 0.5, queueLimit: 100, timeoutMs: 0, retries: 0 } });
  const design = {
    name: 'oom partial',
    nodes: [
      { id: 'src', kind: 'client', label: 'Load', config: { rps: 300, timeoutMs: 2000, retries: 0 } },
      { id: 'lb', kind: 'lb', label: 'LB', config: { capacity: 1024, serviceMs: 0.5, serviceCv: 0.2, queueLimit: 4096 } },
      vm('v1'), vm('v2'), vm('v3'),
    ],
    edges: [{ from: 'src', to: 'lb' }, { from: 'lb', to: 'v1' }, { from: 'lb', to: 'v2' }, { from: 'lb', to: 'v3' }],
  };
  const base = { memMiB: 2000, memBaseMiB: 1000, leakPerReqMiB: 0.1 };
  const oom = new PartialOom({ v1: { ...base, memInitialLeakMiB: 900 }, v2: { ...base, memInitialLeakMiB: 400 }, v3: { ...base } }, OPT);
  const samples: { t: number; fail: number; ok: number; per: Record<string, number> }[] = [];
  let prev = { ok: 0, fail: 0, v1: 0, v2: 0, v3: 0 };
  let next = 500;
  const r = await runLab(design, {
    seconds: 25, seed: 1, budgetMs: 60_000, controller: oom, tickMs: 100,
    onFrame: (e, t) => {
      if (t < next) return;
      next += 500;
      const s = e.snapshot();
      const src = s.nodes.src;
      const cur = { ok: src.totalCompleted, fail: src.totalFailed, v1: s.nodes.v1.totalCompleted, v2: s.nodes.v2.totalCompleted, v3: s.nodes.v3.totalCompleted };
      samples.push({ t, ok: (cur.ok - prev.ok) * 2, fail: (cur.fail - prev.fail) * 2, per: { v1: (cur.v1 - prev.v1) * 2, v2: (cur.v2 - prev.v2) * 2, v3: (cur.v3 - prev.v3) * 2 } });
      prev = cur;
    },
  });
  const ooms = r.events.filter((e) => e.what.startsWith('OOM'));
  check(ooms.length === 1 && ooms[0].node === 'v1', `C  OOM은 v1만: ${ooms.map((e) => `${e.node}@${(e.t / 1000).toFixed(1)}s`).join(', ') || '없음'}`);
  const t0 = ooms[0]?.t ?? 0;
  const win = (a: number, b: number) => samples.filter((x) => x.t > t0 + a && x.t <= t0 + b);
  const avg = (xs: typeof samples, f: (x: (typeof samples)[number]) => number) => xs.reduce((s, x) => s + f(x), 0) / Math.max(1, xs.length);
  const failShare = (xs: typeof samples) => avg(xs, (x) => x.fail) / Math.max(1, avg(xs, (x) => x.ok + x.fail));
  const before = samples.filter((x) => x.t > t0 - 3000 && x.t <= t0);
  const dead = win(500, 3000);
  const out = win(3500, 6000);
  const back = win(9500, 13000);
  console.log(`   OOM 전 3초: 실패 ${(failShare(before) * 100).toFixed(1)}%, VM별 처리 ${['v1', 'v2', 'v3'].map((v) => avg(before, (x) => x.per[v]).toFixed(0)).join('/')}`);
  console.log(`   죽었지만 LB 목록에 있음: 실패 ${(failShare(dead) * 100).toFixed(1)}%, VM별 처리 ${['v1', 'v2', 'v3'].map((v) => avg(dead, (x) => x.per[v]).toFixed(0)).join('/')}`);
  console.log(`   LB에서 제외됨: 실패 ${(failShare(out) * 100).toFixed(1)}%, VM별 처리 ${['v1', 'v2', 'v3'].map((v) => avg(out, (x) => x.per[v]).toFixed(0)).join('/')}`);
  console.log(`   재합류 후: 실패 ${(failShare(back) * 100).toFixed(1)}%, VM별 처리 ${['v1', 'v2', 'v3'].map((v) => avg(back, (x) => x.per[v]).toFixed(0)).join('/')}`);
  check(failShare(dead) > 0.5, `C  헬스체크 전(죽은 VM이 LB 목록에 남음) 실패율 ${(failShare(dead) * 100).toFixed(0)}% > 50%`);
  check(failShare(out) < 0.02 && avg(out, (x) => x.per.v1) === 0, `C  LB 제외 후 실패율 ${(failShare(out) * 100).toFixed(1)}% < 2%, v1 처리 0`);
  check(avg(back, (x) => x.per.v1) > 50, `C  재합류 후 v1 처리 ${avg(back, (x) => x.per.v1).toFixed(0)}/s > 50`);
}

console.log(fail ? `\n${fail} FAIL` : '\nall PASS');
process.exit(fail ? 1 : 0);
