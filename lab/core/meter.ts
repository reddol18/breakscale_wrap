/*
 * 노드별 하드웨어 계기값.
 *
 * 엔진이 직접 재는 값(실측): 처리 중 요청 수, 대기 수, 슬롯 가동률.
 * lab 모델이 그 값으로 계산하는 값(추정): CPU 사용률, 메모리 사용량.
 *   CPU 수요(코어) = 처리 중 요청 × 요청당 CPU 비율(cpuPerReq)
 *   메모리(MiB)    = 기본 + 처리 중 × 요청당 + 대기 × 대기 요청당
 * 엔진은 CPU·메모리를 모델링하지 않으므로, 이 값은 아직 결과(지연·실패)에 영향을 주지 않는다.
 * CPU 사용률이 100%를 넘으면 "실제라면 경합으로 느려졌을 구간"이라는 뜻이다(2단계에서 반영).
 */
import type { NodeStats, Topology } from '../../vendor/breakscale/src/sim/types';

export interface NodeSpec {
  product?: string;
  managed?: boolean;
  vcpu?: number;
  memMiB?: number;
  cpuPerReq?: number;
  memBaseMiB?: number;
  memPerInflightMiB?: number;
  memPerQueuedMiB?: number;
  /** 메모리 누수: 완료 요청당(MiB), 초당(MiB), 시작 시 이미 쌓인 양(MiB, 배포 시점 차이 표현) */
  leakPerReqMiB?: number;
  leakPerSecMiB?: number;
  memInitialLeakMiB?: number;
  /** CPU 경합 손실 계수(문맥 전환 등). 기본 0 */
  cpuAlpha?: number;
  /** 같은 호스트(vCPU 풀)를 나눠 쓰는 노드끼리 같은 이름 */
  host?: string;
}
export type SpecSheet = Record<string, NodeSpec>;

/*
 * 공용 계산식. CPU 경합(cpu.ts)·부분 OOM(oom.ts)·자체 오토스케일러(fleet.ts)가 같은 식을 쓴다.
 */

/** CPU 경합 처리 시간 배율. r = 수요/vCPU. r ≤ 1이면 1. 유도는 cpu.ts 머리말. */
export function cpuSlowFactor(r: number, alpha = 0): number {
  return r > 1 ? r * (1 + alpha * (r - 1)) : 1;
}

/** VM 한 대의 메모리(MiB) = 기본 + 누수 + 처리 중 × 요청당 + 대기 × 대기당 */
export function memoryMiB(spec: NodeSpec, leakedMiB: number, inFlight: number, queued: number): number {
  return (
    (spec.memBaseMiB ?? 0) +
    leakedMiB +
    inFlight * (spec.memPerInflightMiB ?? 0) +
    queued * (spec.memPerQueuedMiB ?? 0)
  );
}

export interface Meter {
  nodeId: string;
  product?: string;
  managed: boolean;
  // 실측
  inFlight: number;
  capacity: number;
  queued: number;
  queueLimit: number;
  // 추정 (사양이 있을 때만)
  vcpu?: number;
  cpuCores?: number;
  cpuPct?: number;
  /** 공유 호스트일 때: cpuCores·cpuPct는 호스트 전체, ownCores는 이 노드 몫 */
  host?: string;
  ownCores?: number;
  memMiB?: number;
  memLimitMiB?: number;
  memPct?: number;
  /** OOM 컨트롤러가 있을 때: VM 상태, 그 상태로 들어온 뒤 경과(ms), 누적 OOM 횟수 */
  phase?: string;
  phaseAge?: number;
  ooms?: number;
  /** 자체 오토스케일러: 재시작 횟수, 지금 상태의 이유(레이블) */
  restarts?: number;
  reason?: string;
}

export function readMeters(topology: Topology, nodes: Record<string, NodeStats>, specs: SpecSheet): Meter[] {
  const out: Meter[] = [];
  for (const node of topology.nodes) {
    const spec = specs[node.id];
    const s = nodes[node.id];
    if (!spec || !s) continue;
    const instances = node.config.instances ?? 1;
    const m: Meter = {
      nodeId: node.id,
      product: spec.product,
      managed: !!spec.managed,
      inFlight: s.inFlight,
      capacity: (node.config.capacity ?? 0) * instances,
      queued: s.queued,
      queueLimit: (node.config.queueLimit ?? 0) * instances,
    };
    if (spec.vcpu && spec.cpuPerReq != null) {
      m.vcpu = spec.vcpu * instances;
      m.cpuCores = s.inFlight * spec.cpuPerReq;
      m.cpuPct = (m.cpuCores / m.vcpu) * 100;
    }
    if (spec.memMiB) {
      m.memLimitMiB = spec.memMiB * instances;
      m.memMiB =
        (spec.memBaseMiB ?? 0) * instances +
        s.inFlight * (spec.memPerInflightMiB ?? 0) +
        s.queued * (spec.memPerQueuedMiB ?? 0);
      m.memPct = (m.memMiB / m.memLimitMiB) * 100;
    }
    out.push(m);
  }
  return out;
}
