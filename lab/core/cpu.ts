/*
 * CPU 경합 컨트롤러 (lab 모델).
 *
 * 엔진에는 CPU가 없다. 노드의 슬롯(capacity)만큼 동시에 처리하고, 처리 시간은 부하와 무관하다.
 * 이 컨트롤러는 "슬롯 수보다 vCPU가 적으면, 슬롯이 다 차도 CPU가 모자라 각 요청이 느려진다"를 덧입힌다.
 *
 * 모델 (프로세서 공유 근사):
 *   p  = 요청 하나가 자기 처리 시간 중 CPU를 쓰는 비율(cpuPerReq). 나머지(1-p)는 I/O 대기 등.
 *   D  = 지금 처리 중인 요청 수(엔진 실측, 평활) × p   … CPU 수요(코어)
 *   V  = 쓸 수 있는 vCPU (같은 호스트를 나눠 쓰는 노드들은 V를 공유)
 *   D ≤ V 이면 아무것도 하지 않는다(엔진 원래 결과 그대로).
 *   D > V 이면 처리 시간 배율 = D/V. 문맥 전환 등 손실 α를 더해
 *     배율 = (D/V) · (1 + α·(D/V - 1))
 *   이 배율을 엔진의 'slow' 장애 factor로 넣는다(새로 시작하는 요청부터 적용).
 *   (유도: 요청 c개가 CPU 구간(원래 p·s)과 I/O 구간((1-p)·s)을 오간다. CPU 구간에 있는 요청 수를 n이라 하면
 *    n>V일 때 각자 V/n코어를 받아 CPU 구간이 k=n/V배로 늘어난다. n = c·pk/((1-p)+pk)를 풀면
 *    (1-p)+pk = c·p/V = D/V. 즉 전체 처리 시간이 정확히 D/V배가 된다.)
 * 이론 검증점: 슬롯이 다 찬 채로 D>V면 처리량 = c / (s · c·p/V) = V / (p · s). 슬롯 수와 무관하다.
 *
 * 한계:
 *  - tick 간격(기본 50ms)만큼 늦게 반응하고, 이미 처리 중인 요청의 시간은 바꾸지 못한다.
 *  - 노드당 장애는 하나뿐이라, 다른 장애(crash 등)가 걸린 노드는 건드리지 않는다.
 *  - instances>1이면 인스턴스 사이 부하가 고르다고 보고 V = vcpu × instances.
 */
import type { Engine } from '../../vendor/breakscale/src/sim/engine';
import type { SimSnapshot, Topology } from '../../vendor/breakscale/src/sim/types';
import type { Controller, LabEvent } from './run';
import { cpuSlowFactor, type SpecSheet } from './meter';

/** slow 배율이 처리 시간에 반영되는 것을 확인한 노드 종류 */
const SLOW_WORKS = new Set(['service']);

export interface CpuState {
  /** 평활한 처리 중 요청 수 */
  busy: number;
  /** CPU 수요(코어) */
  demand: number;
  /** 이 노드(또는 호스트 그룹)가 쓸 수 있는 vCPU */
  vcpu: number;
  /** 지금 걸어 둔 배율, 1이면 경합 없음 */
  factor: number;
  host?: string;
}

export interface CpuOptions {
  /** 처리 중 요청 수 평활 시간 상수(ms) */
  tauMs?: number;
  /** 배율이 이만큼 이상 바뀔 때만 엔진에 다시 건다(잦은 재설정 방지) */
  minChange?: number;
}

export class CpuContention implements Controller {
  readonly state = new Map<string, CpuState>();
  private nodes: { id: string; p: number; alpha: number; vcpu: number; host?: string }[] = [];
  private hostVcpu = new Map<string, number>();
  private lastMs = 0;
  private readonly tauMs: number;
  private readonly minChange: number;

  constructor(private specs: SpecSheet, hosts: Record<string, { vcpu: number }> = {}, opts: CpuOptions = {}) {
    for (const [h, v] of Object.entries(hosts)) this.hostVcpu.set(h, v.vcpu);
    this.tauMs = opts.tauMs ?? 100;
    this.minChange = opts.minChange ?? 0.02;
  }

  init(_engine: Engine, topology: Topology): void {
    for (const node of topology.nodes) {
      const s = this.specs[node.id];
      if (!s || s.managed || !s.cpuPerReq) continue;
      // 엔진의 'slow'가 실제로 먹히는 종류만. db 등 자체 슬롯을 쓰는 종류는 serveWithin()을 거쳐
      // slow 배율이 적용되지 않는다(lab/probe_db.ts로 확인). 거기에 배율을 걸면 표시만 되고 효과가 없다.
      if (!SLOW_WORKS.has(node.kind)) continue;
      if (!s.host && !s.vcpu) continue;
      const instances = node.config.instances ?? 1;
      this.nodes.push({
        id: node.id,
        p: s.cpuPerReq,
        alpha: s.cpuAlpha ?? 0,
        vcpu: (s.vcpu ?? 0) * instances,
        host: s.host,
      });
      const v = s.host ? this.hostVcpu.get(s.host) ?? (s.vcpu ?? 0) * instances : (s.vcpu ?? 0) * instances;
      this.state.set(node.id, { busy: 0, demand: 0, vcpu: v, factor: 1, host: s.host });
    }
  }

  tick(engine: Engine, snapshot: SimSnapshot, simMs: number): LabEvent[] {
    const dt = simMs - this.lastMs;
    this.lastMs = simMs;
    const a = 1 - Math.exp(-dt / this.tauMs);

    // 1) 노드별 수요
    const hostDemand = new Map<string, number>();
    for (const n of this.nodes) {
      const st = this.state.get(n.id)!;
      const inFlight = snapshot.nodes[n.id]?.inFlight ?? 0;
      st.busy += a * (inFlight - st.busy);
      st.demand = st.busy * n.p;
      if (n.host) hostDemand.set(n.host, (hostDemand.get(n.host) ?? 0) + st.demand);
    }

    // 2) 배율 계산·적용
    const faults = new Map(snapshot.activeFailures.map((f) => [f.nodeId, f]));
    const events: LabEvent[] = [];
    for (const n of this.nodes) {
      const st = this.state.get(n.id)!;
      // 같은 호스트면 호스트 전체 수요와 호스트 vCPU로 압박 비율을 본다.
      const D = n.host ? hostDemand.get(n.host)! : st.demand;
      const V = n.host ? this.hostVcpu.get(n.host) ?? n.vcpu : n.vcpu;
      st.vcpu = V;
      const r = V > 0 ? D / V : 0;
      const want = cpuSlowFactor(r, n.alpha);

      const f = faults.get(n.id);
      const ours = !f || (f.kind === 'slow' && st.factor > 1);
      if (!ours) {
        st.factor = 1; // 다른 장애가 우선
        continue;
      }
      if (Math.abs(want - st.factor) < this.minChange && !(want === 1 && st.factor > 1)) continue;
      if (want <= 1) {
        if (st.factor > 1) {
          engine.clearFailure(n.id);
          events.push({ t: simMs, node: n.id, what: 'cpu ok' });
        }
        st.factor = 1;
      } else {
        if (st.factor === 1) events.push({ t: simMs, node: n.id, what: `cpu contention x${want.toFixed(2)}` });
        engine.injectFailure(n.id, 'slow', { factor: want });
        st.factor = want;
      }
    }
    return events;
  }

  /** 캔버스에 넘길 스냅숏: 우리가 건 CPU 'slow'는 장애 표시에서 뺀다(오버레이가 따로 보여준다). */
  hideOwnFaults(snapshot: SimSnapshot): SimSnapshot {
    const own = (id: string) => (this.state.get(id)?.factor ?? 1) > 1;
    const activeFailures = snapshot.activeFailures.filter((f) => !(f.kind === 'slow' && own(f.nodeId)));
    return activeFailures.length === snapshot.activeFailures.length ? snapshot : { ...snapshot, activeFailures };
  }
}
