/*
 * 3안 확인: bs 노드(instances=N) 안에서 인스턴스 1대만 멈출 수 있나.
 *  1) engine.setScale(id, N-1)로 1대를 빼면 처리 상한이 (N-1)/N로 줄고, 되돌리면 회복하나.
 *  2) 원본 오토스케일러가 붙어 있을 때 우리가 뺀 1대를 오토스케일러가 어떻게 다루나.
 * 실행: bun lab/probe_instances.ts
 */
import { runLab } from './core/run';

const svc = { id: 'svc', kind: 'service', label: 'API fleet', config: { instances: 3, capacity: 8, serviceMs: 20, serviceCv: 0.5, queueLimit: 200, timeoutMs: 0, retries: 0 } };
const src = (rps: number) => ({ id: 'src', kind: 'client', label: 'Load', config: { rps, timeoutMs: 2000, retries: 0 } });

async function run(title: string, design: unknown, plan: [number, (e: any) => void][], seconds = 20) {
  console.log(`\n== ${title}`);
  let next = 1000, prev = 0, i = 0;
  await runLab(design, {
    seconds, seed: 1, budgetMs: 60_000, tickMs: 50,
    controller: { tick: (e, _s, t) => { while (i < plan.length && t >= plan[i][0]) plan[i++][1](e); return []; } },
    onFrame(e, t) {
      if (t < next) return;
      next += 1000;
      const s = e.snapshot();
      const n = s.nodes.svc;
      const done = n.totalCompleted - prev;
      prev = n.totalCompleted;
      const as = s.nodes.as as any;
      console.log(`t=${String(Math.round(t / 1000)).padStart(2)}s instances=${n.instances} pending=${n.instancesPending ?? 0} 처리 ${String(done).padStart(4)}/s 대기 ${String(n.queued).padStart(3)} 가동률 ${(n.utilization * 100).toFixed(0)}%` +
        (as ? ` | autoscaler ${JSON.stringify(Object.fromEntries(Object.entries(as).filter(([k]) => /target|pending|instances|decision|util/i.test(k))))}` : ''));
    },
  });
}

// 1) 오토스케일러 없음. 3대 상한 = 3×8/20ms = 1200/s, 2대 = 800/s.
await run('setScale만: 5초에 3→2, 10초에 2→3 (유입 1500/s)', { name: 'p1', nodes: [src(1500), svc], edges: [{ from: 'src', to: 'svc' }] }, [
  [5000, (e) => e.setScale('svc', 2)],
  [10000, (e) => e.setScale('svc', 3)],
], 14);

// 2) 오토스케일러 붙임(목표 가동률 0.6, 쿨다운 2초, 워밍업 3초). 유입 600/s면 3대 가동률 약 50%.
const as = { id: 'as', kind: 'autoscaler', label: 'ASG', config: { targetUtil: 0.6, cooldownMs: 2000, warmupMs: 3000, minCapacity: 1, maxCapacity: 6, scaleStepPct: 0.5 } };
await run('오토스케일러 + 6초에 우리가 3→2 (유입 600/s)', {
  name: 'p2', nodes: [src(600), svc, as],
  edges: [{ from: 'src', to: 'svc' }, { from: 'as', to: 'svc', control: true }],
}, [[6000, (e) => e.setScale('svc', 2)]], 20);
