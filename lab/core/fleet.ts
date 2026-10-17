/*
 * 자체 오토스케일러 + VM 수명 관리 (lab 모델, bs 원본 수정 없음).
 *
 * 구조: LB 뒤에 VM 노드를 최대 대수만큼 미리 그려 둔다(VM 1대 = bs 노드 1개, instances=1).
 * 쓰지 않는 VM은 LB 연결을 끊고(partition) 꺼 둔다(crash). 이 컨트롤러가 VM마다 상태를 들고
 * 증설·축소·헬스체크·재시작·교체를 bs의 기존 장애 기능(crash/slow/partition)으로 실행한다.
 *
 * VM 지표는 기존 lab 모델과 같은 식을 쓴다(meter.ts):
 *   CPU 수요 = 처리 중 요청(엔진 실측, 평활) × cpuPerReq,  사용률 = 수요 / vCPU
 *   CPU 수요 > vCPU면 처리 시간 × cpuSlowFactor(수요/vCPU)
 *   메모리 = memoryMiB(기본 + 누수 + 처리 중 × 요청당 + 대기 × 대기당), 한도 초과 = OOM kill
 *
 * VM 상태:
 *   standby    꺼져 있음(대기 노드). LB 연결 끊김. 원하는 대수에 안 들어감.
 *   booting    새 VM 부팅 중(증설 또는 교체). LB 연결 끊김.
 *   checking   프로세스는 떴고 헬스체크 통과를 기다림(healthyThreshold회 연속 통과 → LB 합류).
 *   warm       LB 합류 직후. 메모리 캐시가 비어 처리 시간이 warmupFactor에서 1로 서서히 줄어듦.
 *   up         정상.
 *   out        헬스체크 실패로 LB에서 빠졌지만 프로세스는 살아 있음(process 모드의 CPU 포화).
 *              헬스체크는 계속하고, 다시 통과하면 LB에 돌아옴(캐시 그대로라 워밍업 없음).
 *   restarting 프로세스/컨테이너 재시작 대기(죽어 있음).
 *   draining   축소 대상. LB에서 먼저 빼고(새 요청 안 받음, 처리 중 요청은 끝까지) drainMs 뒤 종료.
 *
 * 헬스체크(intervalMs마다): 죽어 있으면 실패. 살아 있으면 응답 시간을 추정해 timeoutMs와 비교.
 *   추정 응답 시간(엔진 값이 아니라 lab 추정)은 헬스체크 경로(health.path)에 따라:
 *     queued    = serviceMs × 지금 처리 시간 배율 × (1 + 대기 요청 / 슬롯)   (일반 요청 뒤에 줄 섬, 기본)
 *     dedicated = healthMs × 지금 처리 시간 배율                            (전용 경로, 대기열 건너뜀)
 *   LB 안의 VM이 unhealthyThreshold회 연속 실패 → LB에서 뺌 → 복구 방식(recovery.mode)대로 처리:
 *     process   (VM + systemd + ALB) 죽었으면 restartMs 뒤 같은 VM에서 재시작. 살아 있으면(out) 그대로 두고 회복 대기.
 *     container (쿠버네티스) 재시작. 연속 재시작이면 대기가 backoffBaseMs × 2^(n-1)로 늘어남(최대 backoffMaxMs).
 *     replace   (ASG + ELB 헬스체크) 종료하고 새 VM 부팅(replaceBootMs). 디스크·캐시 모두 새로.
 *
 * 오토스케일(scaling이 있을 때, HPA식):
 *   지표 = 정상(up) VM의 평균 CPU 사용률(0~100%, 상한 100) 또는 슬롯 가동률. metricWindowMs로 평활.
 *   권장 대수(HPA식) = 올림(정상 VM 지표 합 / 목표). 증설 판단에선 아직 준비 안 된 VM을 0%, 축소 판단에선 100%로 친다.
 *   |평균/목표 - 1| ≤ tolerance면 유지.
 *   증설: 권장 > 현재면 scaleOutCooldownMs 간격으로 바로 부팅.
 *   축소: 지난 scaleInStabilizationMs 동안의 권장값 중 최댓값 < 현재일 때만. 부팅 중인 것부터, 그다음 정책(scaleInPick)대로 드레이닝.
 *   원하는 대수에는 재시작·교체 중인 VM도 들어간다(실제 ASG·Deployment처럼).
 *
 * LB fail-open(failOpen): 정상 VM이 0대면 헬스 상태를 무시하고 등록된 VM 전부에 보낸다(ALB 동작).
 *   꺼짐·부팅 중·드레이닝 VM은 등록돼 있지 않다고 본다. 재시작 대기(죽은) VM에도 보내므로 그쪽 요청은 실패한다.
 */
import type { Engine } from '../../vendor/breakscale/src/sim/engine';
import type { SimSnapshot, Topology } from '../../vendor/breakscale/src/sim/types';
import type { Controller, LabEvent } from './run';
import { cpuSlowFactor, memoryMiB, type NodeSpec, type SpecSheet } from './meter';

export type FleetPhase = 'standby' | 'booting' | 'checking' | 'warm' | 'up' | 'out' | 'restarting' | 'draining';

export interface HealthCheck {
  intervalMs: number;
  timeoutMs: number;
  unhealthyThreshold: number;
  healthyThreshold: number;
  /**
   * 헬스체크 요청이 서비스 안에서 어떤 경로를 타는가(구현 방식 변수).
   *   queued    (기본) 일반 요청과 같은 대기열 뒤에 선다. 스레드 풀 하나로 다 받는 서버, 막힌 이벤트 루프,
   *             헬스체크 안에서 DB를 조회하는 구현. 응답 = serviceMs × 배율 × (1 + 대기/슬롯)
   *   dedicated 전용 경로·스레드로 대기열을 건너뛴다. CPU가 모자라면 같이 느려지는 것만 반영.
   *             응답 = healthMs × 배율
   */
  path?: 'queued' | 'dedicated';
  /** dedicated일 때 헬스체크 자체 처리 시간(ms). 기본 5 */
  healthMs?: number;
}

export interface Recovery {
  mode: 'process' | 'container' | 'replace';
  /** process 모드 재시작 시간 */
  restartMs: number;
  /** container 모드 재시작 대기: 첫 재시작 base, 연속이면 2배씩, 최대 max. 정상으로 resetMs 지나면 초기화 */
  backoffBaseMs: number;
  backoffMaxMs: number;
  backoffResetMs: number;
  /** replace 모드 새 VM 부팅 시간 */
  replaceBootMs: number;
}

export interface Scaling {
  metric: 'cpu' | 'slots';
  /** 목표 사용률 0~1 */
  target: number;
  tolerance: number;
  min: number;
  max: number;
  metricWindowMs: number;
  scaleOutCooldownMs: number;
  scaleInStabilizationMs: number;
  scaleInPick: 'newest' | 'oldest';
}

export interface FleetConfig {
  lb: string;
  /** 미리 그려 둔 VM 노드 id(최대 대수). 앞에서부터 initial대가 처음에 켜져 있다. */
  vms: string[];
  initial: number;
  /** 증설 때 새 VM 부팅 시간 */
  bootMs: number;
  warmupMs: number;
  warmupFactor: number;
  drainMs: number;
  /**
   * LB fail-open(ALB 동작): LB가 정상으로 보는 VM이 하나도 없으면, 헬스 상태를 무시하고
   * 등록된 VM 전부(LB에서 빠진 VM·재시작 대기 VM 포함, 부팅 중·꺼짐·드레이닝 제외)에 보낸다.
   * false면 정상 VM이 없을 때 요청이 전부 실패한다(쿠버네티스 Service처럼 엔드포인트가 비는 경우).
   */
  failOpen?: boolean;
  health: HealthCheck;
  recovery: Recovery;
  scaling?: Scaling;
}

export interface FleetVm {
  id: string;
  phase: FleetPhase;
  since: number;
  crashed: boolean;
  /** 이번 상태로 들어온 이유(화면 레이블) */
  reason: string;
  memMiB: number;
  limitMiB: number;
  leakedMiB: number;
  /** CPU 수요/vCPU × 100 (100 초과 가능) */
  cpuPct: number;
  cpuCores: number;
  vcpu: number;
  /** 지금 건 처리 시간 배율(CPU 경합 × 워밍업) */
  factor: number;
  /** 오토스케일 지표(0~1, 평활) */
  metric: number;
  fails: number;
  passes: number;
  ooms: number;
  restarts: number;
  attachedAt: number;
  /** 재시작·부팅이 끝나는 시각 */
  readyAt: number;
}

interface Internal extends FleetVm {
  spec: NodeSpec;
  edgeId: string;
  serviceMs: number;
  capacity: number;
  slowOk: boolean;
  busy: number;
  nextCheck: number;
  consecutive: number;
  lastRestartAt: number;
  lastCompleted: number;
  applied: { kind: 'none' | 'crash' | 'slow'; factor: number };
}

const ATTACHED: ReadonlySet<FleetPhase> = new Set(['warm', 'up']);
const MEMBER: ReadonlySet<FleetPhase> = new Set(['booting', 'checking', 'warm', 'up', 'out', 'restarting']);
/** LB 대상 그룹에 등록돼 있는 상태(fail-open 때 보내는 대상) */
const REGISTERED: ReadonlySet<FleetPhase> = new Set(['checking', 'warm', 'up', 'out', 'restarting']);
const RUNNING: ReadonlySet<FleetPhase> = new Set(['checking', 'warm', 'up', 'out', 'draining']);

export interface FleetSummary {
  members: number;
  ready: number;
  /** 지표 평균(0~1) */
  avg: number;
  recommended: number;
  lastDecision: string;
}

export class Fleet implements Controller {
  readonly vms = new Map<string, Internal>();
  readonly summary: FleetSummary = { members: 0, ready: 0, avg: 0, recommended: 0, lastDecision: '' };
  private order: Internal[] = [];
  private lastMs = 0;
  private lastOut = -Infinity;
  private recs: { t: number; n: number }[] = [];
  private cutApplied = '';

  constructor(private cfg: FleetConfig, private specs: SpecSheet) {}

  init(engine: Engine, topology: Topology): void {
    this.cfg.vms.forEach((id, i) => {
      const node = topology.nodes.find((n) => n.id === id);
      const edge = topology.edges.find((e) => e.from === this.cfg.lb && e.to === id && !e.control);
      if (!node || !edge) throw new Error(`fleet: ${id} 노드 또는 ${this.cfg.lb}→${id} 연결이 없음`);
      if ((node.config.instances ?? 1) > 1) throw new Error(`fleet: ${id}는 instances=1이어야 함(VM 1대 = 노드 1개)`);
      const spec = this.specs[id] ?? {};
      const on = i < this.cfg.initial;
      const vm: Internal = {
        id, spec, edgeId: edge.id,
        serviceMs: node.config.serviceMs ?? 0,
        capacity: Math.max(1, node.config.capacity ?? 1),
        slowOk: node.kind === 'service',
        phase: on ? 'up' : 'standby',
        since: 0,
        crashed: !on,
        reason: on ? '초기 배치' : '대기(꺼짐)',
        memMiB: 0,
        limitMiB: spec.memMiB ?? Infinity,
        leakedMiB: on ? spec.memInitialLeakMiB ?? 0 : 0,
        cpuPct: 0, cpuCores: 0, vcpu: spec.vcpu ?? 0,
        factor: 1, metric: 0, fails: 0, passes: 0, ooms: 0, restarts: 0,
        attachedAt: on ? 0 : -1, readyAt: 0,
        busy: 0, nextCheck: this.cfg.health.intervalMs, consecutive: 0, lastRestartAt: -Infinity, lastCompleted: 0,
        applied: { kind: 'none', factor: 1 },
      };
      this.vms.set(id, vm);
      this.order.push(vm);
    });
    this.summary.members = this.summary.ready = this.summary.recommended = Math.min(this.cfg.initial, this.order.length);
    this.applyFaults(engine);
    this.applyCuts(engine);
  }

  tick(engine: Engine, snapshot: SimSnapshot, now: number): LabEvent[] {
    const dt = now - this.lastMs;
    this.lastMs = now;
    const ev: LabEvent[] = [];
    const say = (node: string, what: string) => ev.push({ t: now, node, what });
    const h = this.cfg.health;
    const rc = this.cfg.recovery;
    const aBusy = 1 - Math.exp(-dt / 100);
    const aMetric = 1 - Math.exp(-dt / (this.cfg.scaling?.metricWindowMs ?? 1000));

    for (const vm of this.order) {
      const s = snapshot.nodes[vm.id];
      if (!s) continue;
      const running = RUNNING.has(vm.phase) && !vm.crashed;

      // --- 지표: CPU·메모리 (기존 lab 식) ---
      vm.busy += aBusy * (s.inFlight - vm.busy);
      const p = vm.spec.cpuPerReq ?? 0;
      vm.cpuCores = running ? vm.busy * p : 0;
      const r = vm.vcpu > 0 ? vm.cpuCores / vm.vcpu : 0;
      vm.cpuPct = r * 100;
      const m = this.cfg.scaling?.metric === 'slots' || !(vm.vcpu > 0) ? s.utilization : Math.min(r, 1);
      vm.metric += aMetric * ((running ? m : 0) - vm.metric);

      if (running) {
        const done = s.totalCompleted - vm.lastCompleted;
        vm.leakedMiB += Math.max(0, done) * (vm.spec.leakPerReqMiB ?? 0) + (dt / 1000) * (vm.spec.leakPerSecMiB ?? 0);
        vm.memMiB = memoryMiB(vm.spec, vm.leakedMiB, s.inFlight, s.queued);
      } else if (!(vm.crashed && ATTACHED.has(vm.phase))) {
        vm.memMiB = 0; // 프로세스가 없으면 메모리도 없다(LB가 아직 모르는 OOM 직후만 마지막 값을 남겨 둔다)
      }
      vm.lastCompleted = s.totalCompleted;

      // 처리 시간 배율: CPU 경합 × 워밍업(선형 감소)
      const warm = vm.phase === 'warm'
        ? 1 + (this.cfg.warmupFactor - 1) * Math.max(0, 1 - (now - vm.since) / this.cfg.warmupMs)
        : 1;
      vm.factor = running ? cpuSlowFactor(r, vm.spec.cpuAlpha ?? 0) * warm : 1;

      // --- OOM ---
      if (running && vm.memMiB > vm.limitMiB) {
        vm.crashed = true;
        vm.ooms++;
        say(vm.id, `OOM kill (${(vm.memMiB / 1024).toFixed(2)}/${(vm.limitMiB / 1024).toFixed(1)} GiB) · 처리 중 요청 실패`);
        vm.reason = 'OOM으로 프로세스 죽음';
        // LB 안이면 헬스체크가 잡을 때까지 그대로 둔다(그동안 LB가 계속 보낸다). 드레이닝 중이면 종료로 끝.
        if (!ATTACHED.has(vm.phase) && vm.phase !== 'draining') this.startRecovery(vm, now, 'oom', say);
      }

      // --- 상태별 진행 ---
      const age = now - vm.since;
      switch (vm.phase) {
        case 'booting':
          if (now >= vm.readyAt) {
            vm.crashed = false;
            vm.leakedMiB = 0;
            this.enter(vm, 'checking', now, '부팅 완료 · 헬스체크 대기');
            vm.passes = 0;
            vm.nextCheck = now + h.intervalMs;
            say(vm.id, '부팅 완료 → 헬스체크 시작');
          }
          break;
        case 'restarting':
          if (now >= vm.readyAt) {
            vm.crashed = false;
            vm.leakedMiB = 0; // 프로세스가 새로 떴으니 누수·메모리 캐시는 사라졌다
            vm.restarts++;
            vm.consecutive++;
            vm.lastRestartAt = now;
            this.enter(vm, 'checking', now, rc.mode === 'container' ? '컨테이너 재시작 · 헬스체크 대기' : '프로세스 재시작 · 헬스체크 대기');
            vm.passes = 0;
            vm.nextCheck = now + h.intervalMs;
            say(vm.id, rc.mode === 'container' ? '컨테이너 재시작' : '프로세스 재시작');
          }
          break;
        case 'warm':
          if (age >= this.cfg.warmupMs && !vm.crashed) this.enter(vm, 'up', now, '정상');
          break;
        case 'draining':
          if (age >= this.cfg.drainMs) {
            vm.crashed = true; // 종료: 남은 요청은 끊긴다
            vm.leakedMiB = 0;
            this.enter(vm, 'standby', now, '축소로 종료됨');
            vm.attachedAt = -1;
            say(vm.id, '드레이닝 끝 → 종료');
          }
          break;
      }
      if (vm.phase === 'up' && vm.consecutive > 0 && now - vm.lastRestartAt >= rc.backoffResetMs) vm.consecutive = 0;

      // --- 헬스체크 ---
      if ((ATTACHED.has(vm.phase) || vm.phase === 'checking' || vm.phase === 'out') && now >= vm.nextCheck) {
        vm.nextCheck += h.intervalMs;
        const resp = vm.crashed
          ? Infinity
          : h.path === 'dedicated'
            ? (h.healthMs ?? 5) * vm.factor
            : vm.serviceMs * vm.factor * (1 + s.queued / vm.capacity);
        const pass = resp <= h.timeoutMs;
        if (ATTACHED.has(vm.phase)) {
          vm.fails = pass ? 0 : vm.fails + 1;
          if (vm.fails >= h.unhealthyThreshold) {
            const why = vm.crashed
              ? `응답 없음 ${vm.fails}회`
              : `응답 ${resp.toFixed(0)}ms > ${h.timeoutMs}ms ${vm.fails}회 (CPU 수요 ${vm.cpuPct.toFixed(0)}%, 대기 ${s.queued})`;
            say(vm.id, `헬스체크 실패: ${why} → LB에서 제외`);
            vm.fails = 0;
            this.startRecovery(vm, now, vm.crashed ? 'oom' : 'cpu', say, why);
          }
        } else {
          vm.passes = pass ? vm.passes + 1 : 0;
          if (vm.passes >= h.healthyThreshold) {
            const fresh = vm.phase === 'checking';
            this.enter(vm, fresh ? 'warm' : 'up', now, fresh ? 'LB 합류 · 워밍업(캐시 비어 있음)' : 'LB 복귀(캐시 그대로)');
            vm.attachedAt = now;
            vm.fails = 0;
            say(vm.id, fresh ? '헬스체크 통과 → LB 합류(워밍업)' : '헬스체크 회복 → LB 복귀');
          }
        }
      }
    }

    if (this.cfg.scaling) this.autoscale(now, say);
    this.applyFaults(engine);
    this.applyCuts(engine, say);
    return ev;
  }

  private enter(vm: Internal, phase: FleetPhase, now: number, reason: string) {
    vm.phase = phase;
    vm.since = now;
    vm.reason = reason;
  }

  private startRecovery(vm: Internal, now: number, cause: 'oom' | 'cpu', say: (n: string, w: string) => void, why = '') {
    const rc = this.cfg.recovery;
    vm.attachedAt = -1;
    if (rc.mode === 'replace') {
      vm.crashed = true;
      vm.leakedMiB = 0;
      vm.restarts++;
      vm.readyAt = now + rc.replaceBootMs;
      this.enter(vm, 'booting', now, `교체: 새 VM 부팅 (원인 ${cause === 'oom' ? 'OOM' : 'CPU 포화'})`);
      say(vm.id, `종료 후 교체 VM 부팅 (${(rc.replaceBootMs / 1000).toFixed(1)}s, 디스크·캐시 새로)`);
      return;
    }
    if (rc.mode === 'container') {
      vm.crashed = true; // 활성 검사 실패도 컨테이너를 죽인다
      const delay = Math.min(rc.backoffBaseMs * 2 ** vm.consecutive, rc.backoffMaxMs);
      vm.readyAt = now + delay;
      this.enter(vm, 'restarting', now, `컨테이너 재시작 대기 ${(delay / 1000).toFixed(1)}s (원인 ${cause === 'oom' ? 'OOM' : 'CPU 포화'})`);
      say(vm.id, `컨테이너 재시작 대기 ${(delay / 1000).toFixed(1)}s (연속 ${vm.consecutive + 1}번째)`);
      return;
    }
    // process
    if (vm.crashed) {
      vm.readyAt = now + rc.restartMs;
      this.enter(vm, 'restarting', now, `프로세스 재시작 대기 (원인 ${cause === 'oom' ? 'OOM' : '죽음'})`);
    } else {
      vm.passes = 0;
      this.enter(vm, 'out', now, `LB 제외 · 살아 있음 (${why})`);
    }
  }

  private autoscale(now: number, say: (n: string, w: string) => void) {
    const sc = this.cfg.scaling!;
    const members = this.order.filter((v) => MEMBER.has(v.phase));
    // 지표 기준: 정상(up)과, LB에선 빠졌지만 프로세스는 살아 CPU 값이 있는 VM(out).
    // 부팅·헬스체크 대기·워밍업 중인 VM은 뺀다(HPA의 준비 안 된 Pod, ASG의 워밍업 인스턴스처럼).
    const ready = members.filter((v) => (v.phase === 'up' || v.phase === 'out') && !v.crashed);
    const basis = ready.length ? ready : members.filter((v) => ATTACHED.has(v.phase) && !v.crashed);
    const sum = basis.reduce((a, v) => a + v.metric, 0);
    const avg = basis.length ? sum / basis.length : 0;
    const notReady = members.length - basis.length;
    const ratio = sc.target > 0 ? avg / sc.target : 1;
    // HPA처럼: 증설 판단에선 아직 준비 안 된 VM을 0%로, 축소 판단에선 100%로 본다(둘 다 보수적으로).
    let rec = members.length;
    if (basis.length && ratio > 1 + sc.tolerance) rec = Math.max(members.length, Math.ceil(sum / sc.target - 1e-9));
    else if (basis.length && ratio < 1 - sc.tolerance) rec = Math.min(members.length, Math.ceil((sum + notReady) / sc.target - 1e-9));
    rec = Math.max(sc.min, Math.min(sc.max, rec));
    this.summary.members = members.length;
    this.summary.ready = basis.length;
    this.summary.avg = avg;
    this.summary.recommended = rec;

    this.recs.push({ t: now, n: rec });
    while (this.recs.length && this.recs[0].t < now - sc.scaleInStabilizationMs) this.recs.shift();
    const label = sc.metric === 'cpu' ? 'CPU' : '슬롯';

    if (rec > members.length && now - this.lastOut >= sc.scaleOutCooldownMs) {
      const add = this.order.filter((v) => v.phase === 'standby').slice(0, rec - members.length);
      if (add.length) {
        this.lastOut = now;
        this.summary.lastDecision = `${(now / 1000).toFixed(1)}s 증설 ${members.length}→${members.length + add.length}대 (평균 ${label} ${(avg * 100).toFixed(0)}% > 목표 ${(sc.target * 100).toFixed(0)}%)`;
        for (const v of add) {
          v.readyAt = now + this.cfg.bootMs;
          v.leakedMiB = 0;
          this.enter(v, 'booting', now, `증설로 부팅 (${(this.cfg.bootMs / 1000).toFixed(1)}s)`);
          say(v.id, `증설: 부팅 시작 (평균 ${label} ${(avg * 100).toFixed(0)}% > 목표 ${(sc.target * 100).toFixed(0)}%)`);
        }
      }
      return;
    }

    const stable = Math.max(...this.recs.map((x) => x.n));
    if (stable < members.length && now >= sc.scaleInStabilizationMs) {
      let remove = members.length - stable;
      const pending = members.filter((v) => v.phase === 'booting' || v.phase === 'checking');
      const attached = members
        .filter((v) => ATTACHED.has(v.phase))
        .sort((a, b) => (sc.scaleInPick === 'newest' ? b.attachedAt - a.attachedAt : a.attachedAt - b.attachedAt));
      this.summary.lastDecision = `${(now / 1000).toFixed(1)}s 축소 ${members.length}→${stable}대 (${(sc.scaleInStabilizationMs / 1000).toFixed(0)}s간 권장 최대 ${stable})`;
      for (const v of [...pending, ...attached]) {
        if (remove <= 0) break;
        remove--;
        if (v.phase === 'booting' || v.phase === 'checking') {
          v.crashed = true;
          this.enter(v, 'standby', now, '축소로 부팅 취소');
          say(v.id, '축소: 부팅 취소');
        } else {
          this.enter(v, 'draining', now, `축소: 드레이닝 ${(this.cfg.drainMs / 1000).toFixed(1)}s`);
          v.attachedAt = -1;
          say(v.id, `축소: LB에서 빼고 드레이닝 (${sc.scaleInPick === 'newest' ? '최신' : '가장 오래된'} VM)`);
        }
      }
      // 권장값 기록은 지우지 않는다. 지우면 다음 tick에 창이 비어 연속으로 줄여 버린다(HPA도 기록을 유지).
    }
  }

  /** VM마다 원하는 장애(죽음 > 느려짐 > 없음)를 엔진에 반영. */
  private applyFaults(engine: Engine) {
    for (const vm of this.order) {
      const want: Internal['applied'] = vm.crashed
        ? { kind: 'crash', factor: 1 }
        : vm.slowOk && vm.factor > 1.01
          ? { kind: 'slow', factor: vm.factor }
          : { kind: 'none', factor: 1 };
      const cur = vm.applied;
      if (want.kind === cur.kind && (want.kind !== 'slow' || Math.abs(want.factor - cur.factor) / cur.factor < 0.02)) continue;
      if (want.kind === 'none') engine.clearFailure(vm.id);
      else if (want.kind === 'crash') engine.injectFailure(vm.id, 'crash');
      else engine.injectFailure(vm.id, 'slow', { factor: want.factor });
      vm.applied = want;
    }
  }

  /** 지금 LB가 fail-open 상태인가(정상 VM 0대라 등록된 VM 전부에 보내는 중) */
  failOpenActive = false;

  /** LB가 보내지 않는 VM의 연결을 끊는다(LB에 partition 하나로). */
  private applyCuts(engine: Engine, say?: (n: string, w: string) => void) {
    const healthy = this.order.some((v) => ATTACHED.has(v.phase));
    const open = !!this.cfg.failOpen && !healthy && this.order.some((v) => REGISTERED.has(v.phase));
    if (open !== this.failOpenActive) {
      this.failOpenActive = open;
      say?.(this.cfg.lb, open ? 'fail-open: 정상 VM 0대 → 헬스 상태 무시하고 등록된 VM 전부에 보냄' : 'fail-open 해제: 정상 VM 생김');
    }
    const routed = open ? REGISTERED : ATTACHED;
    const cut = this.order.filter((v) => !routed.has(v.phase)).map((v) => v.edgeId);
    const key = cut.join(',');
    if (key === this.cutApplied) return;
    this.cutApplied = key;
    if (cut.length) engine.injectFailure(this.cfg.lb, 'partition', { edgeIds: cut });
    else engine.clearFailure(this.cfg.lb);
  }

  /** 캔버스에 넘길 때: 꺼진 VM을 숨긴 토폴로지 */
  visibleTopology(topology: Topology): Topology {
    const hidden = new Set(this.order.filter((v) => v.phase === 'standby').map((v) => v.id));
    if (!hidden.size) return topology;
    return {
      ...topology,
      nodes: topology.nodes.filter((n) => !hidden.has(n.id)),
      edges: topology.edges.filter((e) => !hidden.has(e.from) && !hidden.has(e.to)),
    };
  }

  /** 캔버스용: 우리가 건 LB partition, CPU·워밍업 slow, 꺼짐·부팅 중 crash는 장애 표시에서 뺀다. */
  hideOwnFaults(snapshot: SimSnapshot): SimSnapshot {
    const activeFailures = snapshot.activeFailures.filter((f) => {
      if (f.nodeId === this.cfg.lb && f.kind === 'partition') return false;
      const vm = this.vms.get(f.nodeId);
      if (!vm) return true;
      if (f.kind === 'slow') return false;
      if (f.kind === 'crash' && (vm.phase === 'standby' || vm.phase === 'booting')) return false;
      return true;
    });
    return activeFailures.length === snapshot.activeFailures.length ? snapshot : { ...snapshot, activeFailures };
  }
}
