/*
 * DB 노드 확인.
 *  1) buildTopology가 DB 설정을 어떻게 받아들였나(serviceMs·capacity 등).
 *  2) 손님 → DB 직결에서 처리량 상한이 capacity / serviceMs와 맞나.
 *  3) 엔진의 'slow' 장애(factor 4)가 DB에 먹히나 — service와 비교.
 * 실행: bun lab/probe_db.ts
 */
import { buildTopology } from '../vendor/breakscale/mcp/src/design';
import { runLab } from './core/run';

const mk = (kind: string, rps: number) => ({
  name: 'db probe',
  nodes: [
    { id: 'src', kind: 'client', label: 'Load', config: { rps, timeoutMs: 600000, retries: 0 } },
    { id: 'n', kind, label: kind, config: { capacity: 64, serviceMs: 5, serviceCv: 0.5, queueLimit: 100000 } },
  ],
  edges: [{ from: 'src', to: 'n' }],
});

const b = buildTopology(mk('db', 100));
if (b.ok) {
  const c = b.topology.nodes.find((n) => n.id === 'n')!.config;
  console.log('db config after buildTopology:', JSON.stringify(c));
}

async function rate(kind: string, rps: number, slowAt?: number) {
  let base = -1;
  const r = await runLab(mk(kind, rps), {
    seconds: 20, seed: 1, budgetMs: 120_000, tickMs: 100,
    controller: slowAt
      ? { tick: (e, _s, t) => { if (t >= slowAt && !e.activeFailures().length) e.injectFailure('n', 'slow', { factor: 4 }); return []; } }
      : undefined,
    onFrame: (e, t) => { if (base < 0 && t >= 10_000) base = e.snapshot().nodes.n.totalCompleted; },
  });
  const n = r.snapshot.nodes.n;
  return `${kind.padEnd(7)} 유입 ${rps}/s → 처리 ${((n.totalCompleted - base) / 10).toFixed(0)}/s, 슬롯 ${n.inFlight}/64, 대기 ${n.queued}, p50 ${n.p50.toFixed(1)}ms` +
    (slowAt ? ' (slow x4 주입)' : '');
}

console.log('이론: capacity 64 / 5ms = 12800/s');
for (const kind of ['service', 'db']) {
  console.log(await rate(kind, 700));
  console.log(await rate(kind, 3000));
  console.log(await rate(kind, 3000, 1));
}
