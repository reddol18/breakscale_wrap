/*
 * 부분 OOM 컨트롤러 (lab 모델).
 *
 * 엔진에는 메모리가 없다. 이 컨트롤러는 VM(노드)마다 메모리를 따로 계산해서,
 * 한도를 넘은 VM만 죽이고(crash), 헬스체크·재시작·재합류·워밍업을 엔진의 기존 장애 기능으로 흉내 낸다.
 * VM 한 대 = 노드 하나여야 한다(원본의 instances>1 노드는 기계별 상태가 없어서 부분 OOM을 표현할 수 없다).
 *
 * 메모리(MiB) = 기본 + 누수 + 처리 중 요청 × 요청당 + 대기 요청 × 대기당
 *   누수: 완료한 요청 수 × leakPerReqMiB  +  경과 시간 × leakPerSecMiB  (+ 시작 시 이미 쌓인 memInitialLeakMiB)
 *   처리 중·대기 수는 엔진 실측(순간값). OOM은 순간값이 한도를 넘는 순간 일어난다.
 *
 * 한 VM의 수명:
 *   up ──(메모리>한도)──▶ dead: crash. 아직 LB 목록에 있어서 LB가 계속 보낸다(요청은 즉시 실패).
 *   dead ──(detectMs 후, 헬스체크 실패 확정)──▶ out: 이 VM으로 들어오는 연결을 partition으로 끊는다(LB 목록에서 빠짐).
 *   out ──(OOM 후 restartMs, 프로세스 재시작)──▶ booting: crash 해제, 메모리 초기화. 연결은 아직 끊김.
 *   booting ──(healthyMs 후, 헬스체크 통과)──▶ warm: 연결 복구, warmupMs 동안 처리 시간 ×warmupFactor.
 *   warm ──(warmupMs 후)──▶ up
 *
 * 엔진 장애는 노드당 하나뿐이라, 연결 끊기(partition)는 그 연결의 출발 노드(LB)에 건다.
 * 출발 노드에 이미 다른 장애가 있으면 끊지 못하고 사건으로 남긴다.
 */
import type { Engine } from '../../vendor/breakscale/src/sim/engine';
import type { SimSnapshot, Topology } from '../../vendor/breakscale/src/sim/types';
import type { Controller, LabEvent } from './run';
import { memoryMiB, type NodeSpec, type SpecSheet } from './meter';

export type VmPhase = 'up' | 'dead' | 'out' | 'booting' | 'warm';

export interface OomOptions {
  /** OOM 후 LB가 헬스체크 실패를 확정해 목록에서 빼기까지(ms) */
  detectMs?: number;
  /** OOM 후 프로세스가 다시 뜨기까지(ms) */
  restartMs?: number;
  /** 재시작 후 헬스체크 통과로 LB에 다시 들어가기까지(ms) */
  healthyMs?: number;
  /** 재합류 직후 느린 구간(ms)과 배율 */
  warmupMs?: number;
  warmupFactor?: number;
}

export interface VmState {
  phase: VmPhase;
  /** 지금 메모리(MiB) */
  memMiB: number;
  limitMiB: number;
  leakedMiB: number;
  /** 지금 단계에 들어온 시각(ms) */
  since: number;
  ooms: number;
  lastCompleted: number;
}

interface Tracked {
  id: string;
  spec: NodeSpec;
  /** 이 VM으로 들어오는 연결: [출발 노드, 연결 id] */
  inbound: { from: string; edgeId: string }[];
}

export class PartialOom implements Controller {
  readonly vms = new Map<string, VmState>();
  private tracked: Tracked[] = [];
  /** 출발 노드별로 우리가 끊어 둔 연결 */
  private cut = new Map<string, Set<string>>();
  private lastMs = 0;
  private readonly o: Required<OomOptions>;

  constructor(private specs: SpecSheet, opts: OomOptions = {}) {
    this.o = {
      detectMs: opts.detectMs ?? 3000,
      // 재시작은 LB 제외 뒤에 일어난다고 본다(그 전에 살아나면 제외 자체가 없던 일이 된다).
      restartMs: Math.max(opts.restartMs ?? 4000, opts.detectMs ?? 3000),
      healthyMs: opts.healthyMs ?? 2000,
      warmupMs: opts.warmupMs ?? 3000,
      warmupFactor: opts.warmupFactor ?? 2.5,
    };
  }

  init(_engine: Engine, topology: Topology): void {
    for (const node of topology.nodes) {
      const spec = this.specs[node.id];
      if (!spec?.memMiB || spec.managed) continue;
      if ((node.config.instances ?? 1) > 1) {
        throw new Error(`${node.id}: instances>1 노드는 부분 OOM을 표현할 수 없다. VM마다 노드를 나눌 것.`);
      }
      const inbound = topology.edges
        .filter((e) => e.to === node.id && !e.control)
        .map((e) => ({ from: e.from, edgeId: e.id }));
      this.tracked.push({ id: node.id, spec, inbound });
      const leaked = spec.memInitialLeakMiB ?? 0;
      this.vms.set(node.id, {
        phase: 'up',
        memMiB: (spec.memBaseMiB ?? 0) + leaked,
        limitMiB: spec.memMiB,
        leakedMiB: leaked,
        since: 0,
        ooms: 0,
        lastCompleted: 0,
      });
    }
  }

  tick(engine: Engine, snapshot: SimSnapshot, simMs: number): LabEvent[] {
    const dt = (simMs - this.lastMs) / 1000;
    this.lastMs = simMs;
    const ev: LabEvent[] = [];
    const say = (node: string, what: string) => ev.push({ t: simMs, node, what });

    for (const t of this.tracked) {
      const vm = this.vms.get(t.id)!;
      const s = snapshot.nodes[t.id];
      const age = simMs - vm.since;
      const spec = t.spec;

      switch (vm.phase) {
        case 'up':
        case 'warm': {
          const done = s.totalCompleted - vm.lastCompleted;
          vm.lastCompleted = s.totalCompleted;
          vm.leakedMiB += done * (spec.leakPerReqMiB ?? 0) + dt * (spec.leakPerSecMiB ?? 0);
          vm.memMiB = memoryMiB(spec, vm.leakedMiB, s.inFlight, s.queued);
          if (vm.memMiB > vm.limitMiB) {
            if (vm.phase === 'warm') engine.clearFailure(t.id); // 워밍업 slow를 걷고 crash로 교체
            engine.injectFailure(t.id, 'crash');
            say(t.id, `OOM kill (${(vm.memMiB / 1024).toFixed(2)}/${(vm.limitMiB / 1024).toFixed(0)} GiB)`);
            vm.phase = 'dead';
            vm.since = simMs;
            vm.ooms++;
            break;
          }
          if (vm.phase === 'warm' && age >= this.o.warmupMs) {
            engine.clearFailure(t.id);
            vm.phase = 'up';
            vm.since += this.o.warmupMs;
            say(t.id, '워밍업 끝');
          }
          break;
        }
        case 'dead':
          if (age >= this.o.detectMs) {
            for (const e of t.inbound) this.cutEdge(engine, e.from, e.edgeId, say);
            vm.phase = 'out';
            say(t.id, '헬스체크 실패 → LB에서 제외');
          }
          break;
        case 'out':
          // since는 OOM 시각 그대로 둔다(재시작은 OOM 기준)
          if (age >= this.o.restartMs) {
            engine.clearFailure(t.id);
            vm.leakedMiB = 0;
            vm.memMiB = spec.memBaseMiB ?? 0;
            vm.lastCompleted = s.totalCompleted;
            vm.phase = 'booting';
            vm.since += this.o.restartMs; // 예정 시각 기준(tick 지연이 단계마다 쌓이지 않게)
            say(t.id, '프로세스 재시작');
          }
          break;
        case 'booting':
          vm.memMiB = spec.memBaseMiB ?? 0;
          if (age >= this.o.healthyMs) {
            for (const e of t.inbound) this.uncutEdge(engine, e.from, e.edgeId);
            if (this.o.warmupFactor > 1 && this.o.warmupMs > 0) {
              engine.injectFailure(t.id, 'slow', { factor: this.o.warmupFactor });
            }
            vm.lastCompleted = s.totalCompleted;
            vm.phase = 'warm';
            vm.since += this.o.healthyMs;
            say(t.id, '헬스체크 통과 → LB 재합류(워밍업)');
          }
          break;
      }
    }
    return ev;
  }

  private cutEdge(engine: Engine, from: string, edgeId: string, say: (n: string, w: string) => void) {
    const set = this.cut.get(from) ?? new Set<string>();
    const other = engine.activeFailures().find((f) => f.nodeId === from);
    if (other && !(other.kind === 'partition' && this.cut.has(from))) {
      say(from, `연결 ${edgeId}를 끊지 못함: ${from}에 다른 장애(${other.kind})가 있음`);
      return;
    }
    set.add(edgeId);
    this.cut.set(from, set);
    engine.injectFailure(from, 'partition', { edgeIds: [...set] });
  }

  private uncutEdge(engine: Engine, from: string, edgeId: string) {
    const set = this.cut.get(from);
    if (!set || !set.delete(edgeId)) return;
    if (set.size === 0) {
      this.cut.delete(from);
      engine.clearFailure(from);
    } else {
      engine.injectFailure(from, 'partition', { edgeIds: [...set] });
    }
  }

  /** 캔버스용: 우리가 LB에 건 partition은 장애 표시에서 뺀다(끊긴 연결은 연결선 상태로 보인다). */
  hideOwnFaults(snapshot: SimSnapshot): SimSnapshot {
    const own = (f: SimSnapshot['activeFailures'][number]) =>
      (f.kind === 'partition' && this.cut.has(f.nodeId)) ||
      (f.kind === 'slow' && this.vms.get(f.nodeId)?.phase === 'warm');
    const activeFailures = snapshot.activeFailures.filter((f) => !own(f));
    return activeFailures.length === snapshot.activeFailures.length ? snapshot : { ...snapshot, activeFailures };
  }
}
