/*
 * 시나리오를 화면 없이 돌려 결과를 텍스트로 낸다.
 * 실행: bun lab/sim.ts <시나리오 이름 | 파일.json> [--every 초] [--cpu=0]
 *   이름: lab/viz/scenarios.ts의 코드 시나리오 또는 lab/scenarios/<이름>.json
 *   --every N  N초마다 한 줄(기본 1)
 *   --cpu=0    CPU 경합 모델 끔(fleet가 없는 시나리오만, 원본 동작과 비교용)
 * 출력: 시각별 처리·실패·노드 상태, 사건 기록(증설·OOM·헬스체크 등), 마지막에 요약.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runLab } from './core/run';
import { CpuContention } from './core/cpu';
import { PartialOom } from './core/oom';
import { combine } from './core/combine';
import { Fleet } from './core/fleet';
import { fromScenarioFile } from './core/scenario-file';
import { SCENARIOS } from './viz/scenarios';

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith('--'));
const every = Number(argv[argv.indexOf('--every') + 1]) || 1;
const cpuOn = !argv.includes('--cpu=0');
if (!target) {
  console.error('사용법: bun lab/sim.ts <시나리오 이름 | 파일.json> [--every 초] [--cpu=0]');
  process.exit(1);
}

function load(name: string) {
  if (SCENARIOS[name]) return SCENARIOS[name]();
  const candidates = [resolve(name), join(import.meta.dir, 'scenarios', `${name}.json`)];
  const file = candidates.find((p) => existsSync(p) && p.endsWith('.json'));
  if (!file) {
    console.error(`시나리오 "${name}"을(를) 찾지 못했습니다. 코드 시나리오: ${Object.keys(SCENARIOS).join(', ')} / 또는 lab/scenarios/*.json`);
    process.exit(1);
  }
  return fromScenarioFile(JSON.parse(readFileSync(file, 'utf8')));
}

const scn = load(target);
const fleet = scn.fleet ? new Fleet(scn.fleet, scn.specs) : null;
const cpu = cpuOn && !fleet ? new CpuContention(scn.specs, scn.hosts) : null;
const oom = scn.oom && !fleet ? new PartialOom(scn.specs, scn.oom) : null;
const ids = Object.keys(scn.specs).filter((id) => !scn.specs[id].managed);
const prev: Record<string, { ok: number; fail: number }> = {};
let next = every * 1000;
let vmMs = 0;
let lastT = 0;
let maxVms = 0;
const counts: string[] = [];

const r = await runLab(scn.design, {
  seconds: scn.seconds, seed: 1, budgetMs: 600_000, tickMs: 50,
  controller: combine(cpu, oom, fleet),
  onFrame(e, t) {
    scn.step(e, t);
    if (fleet) {
      // 과금 대상 VM-초: 꺼진(standby) VM을 뺀 나머지(부팅·재시작·드레이닝 포함)
      const on = [...fleet.vms.values()].filter((v) => v.phase !== 'standby').length;
      vmMs += on * (t - lastT);
      maxVms = Math.max(maxVms, on);
      const label = `${fleet.summary.members}`;
      if (counts[counts.length - 1]?.split('=')[1] !== label) counts.push(`${(t / 1000).toFixed(1)}s=${label}`);
    }
    lastT = t;
    if (t < next) return;
    next += every * 1000;
    const s = e.snapshot();
    const cols = ids.map((id) => {
      const n = s.nodes[id];
      if (!n) return `${id} ?`;
      const p = prev[id] ?? { ok: 0, fail: 0 };
      prev[id] = { ok: n.totalCompleted, fail: n.totalFailed };
      const fv = fleet?.vms.get(id);
      const f = fv?.factor ?? cpu?.state.get(id)?.factor ?? 1;
      const vm = fv ?? oom?.vms.get(id);
      const state = vm ? ` ${vm.phase}${fv?.crashed && fv.phase !== 'standby' && fv.phase !== 'booting' ? '(죽음)' : ''} mem ${(vm.memMiB / 1024).toFixed(2)}G` : '';
      const cpuTxt = fv ? ` cpu ${fv.cpuPct.toFixed(0)}%` : '';
      return `${id} 완료${String(n.totalCompleted - p.ok).padStart(4)} 실패${String(n.totalFailed - p.fail).padStart(4)} 대기${String(n.queued).padStart(4)}${cpuTxt} x${f.toFixed(2)}${state}`;
    });
    console.log(`t=${String(Math.round(t / 1000)).padStart(3)}s 처리 ${s.system.goodputRps.toFixed(0).padStart(5)}/s 실패 ${(s.system.errorRate * 100).toFixed(0).padStart(3)}%${fleet ? ` VM ${fleet.summary.members}대` : ''} | ${cols.join(' | ')}`);
  },
});

console.log('\n사건 기록');
for (const e of r.events.filter((x) => !x.what.startsWith('cpu'))) console.log(`  ${(e.t / 1000).toFixed(1).padStart(6)}s ${e.node}: ${e.what}`);

// 요약: 클라이언트 노드 기준 전체 성공·실패
const clientIds = (scn.design as { nodes: { id: string; kind: string }[] }).nodes.filter((n) => n.kind === 'client').map((n) => n.id);
const ok = clientIds.reduce((a, id) => a + (r.snapshot.nodes[id]?.totalCompleted ?? 0), 0);
const failed = clientIds.reduce((a, id) => a + (r.snapshot.nodes[id]?.totalFailed ?? 0), 0);
console.log('\n요약');
console.log(`  시뮬레이션 ${(r.simulatedMs / 1000).toFixed(1)}s · 요청 ${ok + failed}건 · 성공 ${ok}건 · 실패 ${failed}건 (${((failed / Math.max(1, ok + failed)) * 100).toFixed(1)}%)`);
if (fleet) {
  console.log(`  VM 대수 변화: ${counts.join(' → ')} · 최대 ${maxVms}대 켜짐`);
  console.log(`  VM-초(과금 대상, 꺼진 VM 제외): ${(vmMs / 1000).toFixed(0)} VM·s`);
}
