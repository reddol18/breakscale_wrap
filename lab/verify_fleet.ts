/*
 * 자체 오토스케일러(fleet.ts) 검증. 실행: bun lab/verify_fleet.ts
 *
 * 공통 VM: 슬롯 16, 처리 20ms, vCPU 2, 요청당 CPU 0.5 → CPU 상한 200/s, 사용률 = 처리량/200.
 * 목표 CPU 60% → VM당 120/s가 목표.
 *  A. 아무 일도 안 일어나는 설정이면 컨트롤러 없이 돌린 결과와 글자 단위로 같다.
 *  B. 증설: 240 → 840 rps. 최종 대수 = 올림(840/120) = 7. 새 VM은 부팅 + 헬스체크 2회 뒤 합류.
 *  C. 축소: 840 → 240 rps. 안정화 구간 뒤 2대로. 드레이닝 동안 실패 없음.
 *  D. OOM(process): 처리 중 요청 실패, 헬스체크 3회 실패 뒤 LB 제외, 재시작, 헬스체크 2회 통과 뒤 합류.
 *  E. OOM 반복(container): 재시작 대기가 2s → 4s → 8s로 늘어난다.
 *  F. CPU 포화(process, 증설 없음): 응답 지연으로 헬스체크 실패 → 1대 빠지면 나머지도 무너지는 연쇄.
 *  G. 교체(replace): OOM → 종료 → 새 VM 부팅 → 합류(메모리 0부터).
 */
import { runLab, type LabEvent } from './core/run';
import { Fleet, type FleetConfig } from './core/fleet';
import type { SpecSheet } from './core/meter';

let fail = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) fail++;
};
const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function design(n: number, rps: number) {
  const vms = Array.from({ length: n }, (_, i) => `vm${i + 1}`);
  return {
    vms,
    design: {
      name: 'fleet',
      nodes: [
        { id: 'src', kind: 'client', label: 'Users', config: { rps, timeoutMs: 2000, retries: 0 } },
        { id: 'lb', kind: 'lb', label: 'LB', config: { capacity: 4096, serviceMs: 0.5, serviceCv: 0.2, queueLimit: 8192 } },
        ...vms.map((id) => ({ id, kind: 'service', label: id, config: { capacity: 16, serviceMs: 20, serviceCv: 0.5, queueLimit: 100, timeoutMs: 0, retries: 0 } })),
      ],
      edges: [{ from: 'src', to: 'lb' }, ...vms.map((id) => ({ from: 'lb', to: id }))],
    },
  };
}
const VM = { vcpu: 2, cpuPerReq: 0.5, memMiB: 4096, memBaseMiB: 1000, memPerInflightMiB: 20, memPerQueuedMiB: 2 };
const specsFor = (vms: string[], extra: Partial<typeof VM> & Record<string, number> = {}): SpecSheet =>
  Object.fromEntries(vms.map((id) => [id, { ...VM, ...extra }]));
const base = (vms: string[]): FleetConfig => ({
  lb: 'lb', vms, initial: 2, bootMs: 5000, warmupMs: 3000, warmupFactor: 2, drainMs: 2000,
  health: { intervalMs: 1000, timeoutMs: 500, unhealthyThreshold: 3, healthyThreshold: 2 },
  recovery: { mode: 'process', restartMs: 3000, backoffBaseMs: 2000, backoffMaxMs: 30000, backoffResetMs: 20000, replaceBootMs: 6000 },
});
const ev = (r: { events: LabEvent[] }, node: string, prefix: string) => r.events.filter((e) => e.node === node && e.what.startsWith(prefix)).map((e) => e.t);

// ---------- A ----------
{
  const { vms, design: d } = design(3, 300);
  const ref = await runLab(d, { seconds: 20, seed: 1, budgetMs: 60_000 });
  const cfg = { ...base(vms), initial: 3, health: { intervalMs: 1000, timeoutMs: 1e9, unhealthyThreshold: 3, healthyThreshold: 2 } };
  const r = await runLab(d, { seconds: 20, seed: 1, budgetMs: 60_000, tickMs: 50, controller: new Fleet(cfg, specsFor(vms, { vcpu: 1e6, memMiB: 1e9 })) });
  check(r.text === ref.text && r.events.length === 0, `A  전부 켜짐·자원 넉넉: 컨트롤러 없는 결과와 동일=${r.text === ref.text}, 사건 ${r.events.length}건`);
}

// ---------- B, C ----------
{
  const { vms, design: d } = design(8, 240);
  const fleet = new Fleet({
    ...base(vms),
    scaling: { metric: 'cpu', target: 0.6, tolerance: 0.1, min: 2, max: 8, metricWindowMs: 5000, scaleOutCooldownMs: 3000, scaleInStabilizationMs: 10000, scaleInPick: 'oldest' },
  }, specsFor(vms));
  // 과부하 없이 오르는 부하(VM CPU 상한 안쪽): 240(2대) → 360(3대) → 560(5대) → 240(2대)
  const plan: [number, number][] = [[10_000, 360], [35_000, 560], [65_000, 240]];
  let i = 0;
  const counts: { t: number; members: number; failRate: number }[] = [];
  let prevFail = 0, prevOk = 0, next = 1000;
  const r = await runLab(d, {
    seconds: 100, seed: 1, budgetMs: 120_000, tickMs: 50, controller: fleet,
    onFrame(e, t) {
      while (i < plan.length && t >= plan[i][0]) e.updateNodeConfig('src', { rps: plan[i++][1] });
      if (t < next) return;
      next += 1000;
      const src = e.snapshot().nodes.src;
      const f = src.totalFailed - prevFail, o = src.totalCompleted - prevOk;
      prevFail = src.totalFailed; prevOk = src.totalCompleted;
      counts.push({ t, members: fleet.summary.members, failRate: f / Math.max(1, f + o) });
    },
  });
  const at = (t: number) => counts.find((c) => c.t >= t)!;
  const firstOut = r.events.find((e) => e.what.startsWith('증설'));
  check(!!firstOut && firstOut.t > 10_000 && firstOut.t - 10_000 < 4000, `B  첫 증설 결정: 부하 증가 후 ${firstOut ? s(firstOut.t - 10_000) : '없음'} (그 전엔 증설 없음)`);
  const joins = r.events.filter((e) => e.what.startsWith('헬스체크 통과'));
  const boots = r.events.filter((e) => e.what.startsWith('증설'));
  const lag = joins.map((j) => j.t - (boots.find((b) => b.node === j.node && b.t <= j.t)?.t ?? NaN));
  check(lag.length > 0 && lag.every((x) => x >= 5000 + 2000 - 100 && x <= 5000 + 3000 + 100),
    `B  부팅 결정 → LB 합류 간격 ${lag.map(s).join(', ')} (부팅 5s + 헬스체크 2회 = 7~8s)`);
  check(at(34_000).members === 3, `B  360rps 안정 후 대수 ${at(34_000).members} (기대 올림(360/120)=3)`);
  check(at(64_000).members === 5, `B  560rps 안정 후 대수 ${at(64_000).members} (기대 올림(3×93%/60%)=5)`);
  const allFail = Math.max(...counts.map((c) => c.failRate));
  check(allFail < 0.01, `B  전 구간 실패율 최대 ${(allFail * 100).toFixed(2)}% < 1% (과부하 전에 증설됨)`);
  const drainWindow = counts.filter((c) => c.t > 65_000);
  check(at(99_000).members === 2, `C  240rps로 내린 뒤 최종 대수 ${at(99_000).members} (기대 2)`);
  check(drainWindow.every((c) => c.failRate < 0.01), `C  축소·드레이닝 구간 실패율 최대 ${(Math.max(...drainWindow.map((c) => c.failRate)) * 100).toFixed(2)}% < 1%`);
  const scaleIn = r.events.find((e) => e.what.startsWith('축소'));
  check(!!scaleIn && scaleIn.t >= 74_000, `C  첫 축소 ${scaleIn ? s(scaleIn.t) : '없음'} ≥ 부하 감소(65s) + 지표 반영 + 안정화 10s`);
  console.log(`   대수 변화: ${counts.filter((c, k) => k === 0 || c.members !== counts[k - 1].members).map((c) => `${s(c.t)}=${c.members}`).join(' → ')}`);
}

// ---------- D ----------
{
  const { vms, design: d } = design(2, 200);
  const sp = specsFor(vms);
  sp.vm1 = { ...sp.vm1, leakPerReqMiB: 1, memInitialLeakMiB: 2000 }; // 여유 약 1000 MiB → 100/s면 약 10s
  let failAtVm1 = 0;
  const r = await runLab(d, {
    seconds: 30, seed: 1, budgetMs: 60_000, tickMs: 50, controller: new Fleet(base(vms), sp),
  });
  const oom = ev(r, 'vm1', 'OOM')[0];
  const out = ev(r, 'vm1', '헬스체크 실패')[0];
  const restart = ev(r, 'vm1', '프로세스 재시작')[0];
  const join = ev(r, 'vm1', '헬스체크 통과')[0];
  failAtVm1 = r.snapshot.nodes.vm1.totalFailed;
  check(Number.isFinite(oom) && failAtVm1 > 0, `D  OOM ${s(oom)}, vm1에서 실패한 요청 ${failAtVm1}건(처리 중·대기 요청 포함)`);
  check(out - oom >= 2000 && out - oom <= 3100, `D  OOM → LB 제외 ${s(out - oom)} (헬스체크 1초 간격 3회: 2~3s)`);
  check(Math.abs(restart - out - 3000) <= 100, `D  LB 제외 → 재시작 ${s(restart - out)} (설정 3s)`);
  check(join - restart >= 1900 && join - restart <= 2100, `D  재시작 → LB 합류 ${s(join - restart)} (헬스체크 2회)`);
}

// ---------- E ----------
{
  const { vms, design: d } = design(2, 200);
  const sp = specsFor(vms);
  sp.vm1 = { ...sp.vm1, leakPerReqMiB: 6, memInitialLeakMiB: 2500 };
  const cfg = { ...base(vms), recovery: { ...base(vms).recovery, mode: 'container' as const } };
  const r = await runLab(d, { seconds: 60, seed: 1, budgetMs: 60_000, tickMs: 50, controller: new Fleet(cfg, sp) });
  const waits = r.events.filter((e) => e.node === 'vm1' && e.what.startsWith('컨테이너 재시작 대기')).map((e) => e.what.match(/대기 ([\d.]+)s/)![1]);
  check(waits.length >= 3 && waits[0] === '2.0' && waits[1] === '4.0' && waits[2] === '8.0', `E  연속 OOM 재시작 대기: ${waits.join('s → ')}s (기대 2 → 4 → 8)`);
}

// ---------- F ----------
{
  const { vms, design: d } = design(2, 480); // 2대 CPU 상한 400 < 480
  const r = await runLab(d, { seconds: 40, seed: 1, budgetMs: 60_000, tickMs: 50, controller: new Fleet(base(vms), specsFor(vms)) });
  const outs = r.events.filter((e) => e.what.startsWith('헬스체크 실패: 응답'));
  const t1 = outs[0]?.t;
  const other = outs.find((e) => e.node !== outs[0]?.node && e.t > t1);
  check(outs.length > 0, `F  CPU 포화로 헬스체크 실패: ${outs[0] ? `${outs[0].node} ${s(outs[0].t)} "${outs[0].what}"` : '없음'}`);
  check(!!other, `F  연쇄: 1대 빠진 뒤 ${other ? `${other.node}도 ${s(other.t)}에 빠짐` : '나머지는 버팀'}`);
  const back = r.events.filter((e) => e.what.startsWith('헬스체크 회복'));
  console.log(`   LB 복귀(대기열이 빠진 뒤): ${back.map((e) => `${e.node}@${s(e.t)}`).join(', ') || '없음'}`);
}

// ---------- G ----------
{
  const { vms, design: d } = design(2, 200);
  const sp = specsFor(vms);
  sp.vm1 = { ...sp.vm1, leakPerReqMiB: 1, memInitialLeakMiB: 2000 };
  const cfg = { ...base(vms), recovery: { ...base(vms).recovery, mode: 'replace' as const } };
  const fleet = new Fleet(cfg, sp);
  let memAtJoin = -1;
  const r = await runLab(d, {
    seconds: 30, seed: 1, budgetMs: 60_000, tickMs: 50, controller: fleet,
    onFrame: () => { const v = fleet.vms.get('vm1')!; if (memAtJoin < 0 && v.restarts === 1 && v.phase === 'warm') memAtJoin = v.memMiB; },
  });
  const out = ev(r, 'vm1', '헬스체크 실패')[0];
  const boot = ev(r, 'vm1', '부팅 완료')[0];
  const join = ev(r, 'vm1', '헬스체크 통과')[0];
  check(Math.abs(boot - out - 6000) <= 100 && join - boot >= 1900 && join - boot <= 2100,
    `G  교체: LB 제외 → 새 VM 부팅 완료 ${s(boot - out)} (설정 6s) → 합류 ${s(join - boot)}`);
  check(memAtJoin >= 1000 && memAtJoin < 1300, `G  새 VM 합류 시 메모리 ${memAtJoin.toFixed(0)} MiB (기본 1000 + 처리 중 요청분, 누수 없음)`);
}

// ---------- H ----------
// 과부하로 2대가 모두 LB에서 빠지는 상황(F와 같은 조건). fail-open이면 그 구간에도 계속 보내야 한다.
{
  const run = async (failOpen: boolean) => {
    const { vms, design: d } = design(2, 480);
    const fleet = new Fleet({ ...base(vms), failOpen }, specsFor(vms));
    let allOutMs = 0, allOutFail = 0, allOutTotal = 0, prevF = 0, prevO = 0, lastT = 0;
    const r = await runLab(d, {
      seconds: 40, seed: 1, budgetMs: 60_000, tickMs: 50, controller: fleet,
      onFrame(e, t) {
        const src = e.snapshot().nodes.src;
        const df = src.totalFailed - prevF, dO = src.totalCompleted - prevO;
        prevF = src.totalFailed; prevO = src.totalCompleted;
        const out = [...fleet.vms.values()].every((v) => v.phase === 'out');
        if (out) { allOutMs += t - lastT; allOutFail += df; allOutTotal += df + dO; }
        lastT = t;
      },
    });
    return { allOutMs, rate: allOutFail / Math.max(1, allOutTotal), events: r.events.filter((x) => x.what.startsWith('fail-open')).length, served: r.snapshot.nodes.src.totalCompleted };
  };
  const closed = await run(false);
  const open = await run(true);
  // 끔: 새 요청은 전부 실패하지만, 이미 VM 대기열에 들어가 있던 요청은 그 구간에도 끝나므로 100%는 아니다.
  check(closed.allOutMs > 0 && closed.rate > 0.7, `H  fail-open 끔: 2대 모두 제외된 ${s(closed.allOutMs)} 동안 실패율 ${(closed.rate * 100).toFixed(0)}% (대기열에 있던 요청만 성공)`);
  check(open.allOutMs > 0 && open.rate < closed.rate / 2 && open.events > 0,
    `H  fail-open 켬: 2대 모두 '비정상'인 ${s(open.allOutMs)} 동안 실패율 ${(open.rate * 100).toFixed(0)}% (LB가 계속 보냄, 전환 사건 ${open.events}건)`);
  console.log(`   40초간 성공 요청: fail-open 끔 ${closed.served}건, 켬 ${open.served}건`);
}

// ---------- I ----------
// F와 같은 과부하(2대, CPU 상한 400 < 480rps, 증설 없음). 헬스체크 경로만 바꾼다.
{
  const run = async (path: 'queued' | 'dedicated') => {
    const { vms, design: d } = design(2, 480);
    const cfg = base(vms);
    const fleet = new Fleet({ ...cfg, health: { ...cfg.health, path, healthMs: 5 } }, specsFor(vms));
    const r = await runLab(d, { seconds: 40, seed: 1, budgetMs: 60_000, tickMs: 50, controller: fleet });
    const src = r.snapshot.nodes.src;
    return {
      outs: r.events.filter((e) => e.what.startsWith('헬스체크 실패')).length,
      served: src.totalCompleted,
      failRate: src.totalFailed / Math.max(1, src.totalFailed + src.totalCompleted),
    };
  };
  const q = await run('queued');
  const ded = await run('dedicated');
  check(q.outs > 0, `I  queued: 과부하로 헬스체크 실패 ${q.outs}회 → LB 제외 반복, 40초 성공 ${q.served}건, 실패율 ${(q.failRate * 100).toFixed(0)}%`);
  // dedicated: 배율 ×4(CPU 수요 400%)여도 5ms×4 = 20ms < 500ms → 제외되지 않는다. 넘친 요청은 대기열 초과로 거절.
  check(ded.outs === 0 && ded.served > q.served,
    `I  dedicated: 헬스체크 실패 ${ded.outs}회(LB 제외 없음), 40초 성공 ${ded.served}건, 실패율 ${(ded.failRate * 100).toFixed(0)}% (상한 400/s × 40s ≈ 16000)`);
}

console.log(fail ? `\n${fail} FAIL` : '\nall PASS');
process.exit(fail ? 1 : 0);
