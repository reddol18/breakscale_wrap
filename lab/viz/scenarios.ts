/*
 * 시나리오. 주소의 ?scn=<이름>, bun lab/sim.ts <이름>으로 고른다(기본 s1crash).
 * 각 시나리오: 설계(MCP create_view와 같은 입력 형식), 노드 사양, 공유 호스트, 시간표.
 * 아래 코드로 적은 시나리오 말고도, lab/scenarios/<이름>.json 파일을 같은 이름으로 쓸 수 있다
 * (형식은 lab/core/scenario-file.ts). 새 시나리오는 JSON 파일로 만드는 것을 권장.
 */
import type { Engine } from '../../vendor/breakscale/src/sim/engine';
import type { SimSnapshot } from '../../vendor/breakscale/src/sim/types';
import type { SpecSheet } from '../core/meter';
import type { OomOptions } from '../core/oom';
import type { FleetConfig } from '../core/fleet';
import { fromScenarioFile, type ScenarioFile } from '../core/scenario-file';
export type { ScenarioFile };
import s1design from '../fixtures/official/S1/C02.args.json';
import s1spec from '../specs/S1_v0.json';

export interface Scenario {
  design: unknown;
  specs: SpecSheet;
  hosts?: Record<string, { vcpu: number }>;
  /** 있으면 부분 OOM 컨트롤러를 켠다 */
  oom?: OomOptions;
  /** 있으면 자체 오토스케일러가 VM 전체(CPU·메모리·헬스체크·증설/축소)를 맡는다 */
  fleet?: FleetConfig;
  seconds: number;
  /** 매 시뮬레이션 스텝 호출. 장애·트래픽 변경을 여기서 한다. */
  step(engine: Engine, t: number): void;
  /** HUD에 덧붙일 시나리오 전용 한 줄 */
  hud(s: SimSnapshot, t: number): string;
}

function s1crash(): Scenario {
  let crashed = false;
  return {
    design: s1design,
    specs: s1spec.nodes as SpecSheet,
    seconds: 22,
    step(e, t) {
      if (!crashed && t >= 10_000 && t < 15_000) { e.injectFailure('api2', 'crash'); crashed = true; }
      if (crashed && t >= 15_000) { e.clearFailure('api2'); crashed = false; }
    },
    hud: () => '10초 api2 crash · 15초 해제',
  };
}

/*
 * 이웃 소음(noisy neighbor): 서비스 A와 B가 같은 VM(2 vCPU)에서 돈다.
 * B의 트래픽은 50rps로 고정. A만 8초에 60 → 300rps로 올렸다가 18초에 60으로 내린다.
 * 엔진만으로는 A가 바빠도 B는 그대로다. CPU 경합 모델을 켜면 B도 느려진다.
 */
function noisy(): Scenario {
  const svc = (id: string, label: string) => ({
    id, kind: 'service', label,
    config: { capacity: 16, serviceMs: 20, serviceCv: 0.5, queueLimit: 200, errorRate: 0, timeoutMs: 0, retries: 0 },
  });
  const design = {
    name: 'noisy neighbor',
    nodes: [
      { id: 'srcA', kind: 'client', label: 'Traffic A', x: 80, y: 80, config: { rps: 60, timeoutMs: 2000, retries: 0 } },
      { id: 'srcB', kind: 'client', label: 'Traffic B', x: 80, y: 360, config: { rps: 50, timeoutMs: 2000, retries: 0 } },
      { ...svc('a', 'Service A'), x: 520, y: 80 },
      { ...svc('b', 'Service B'), x: 520, y: 360 },
    ],
    edges: [{ from: 'srcA', to: 'a' }, { from: 'srcB', to: 'b' }],
  };
  const spec = { product: '같은 VM · c6i.large', cpuPerReq: 0.5, host: 'vm1' };
  let phase = 0;
  return {
    design,
    specs: { a: { ...spec }, b: { ...spec } },
    hosts: { vm1: { vcpu: 2 } },
    seconds: 24,
    step(e, t) {
      if (phase === 0 && t >= 8_000) { e.updateNodeConfig('srcA', { rps: 300 }); phase = 1; }
      if (phase === 1 && t >= 18_000) { e.updateNodeConfig('srcA', { rps: 60 }); phase = 2; }
    },
    hud: (s) =>
      `A ${phase === 1 ? '300' : '60'}rps · B 50rps 고정 | B 지연 p99 ${s.nodes.b?.p99.toFixed(0) ?? '-'}ms · ` +
      `A p99 ${s.nodes.a?.p99.toFixed(0) ?? '-'}ms | 8초 A 급증 · 18초 복귀`,
  };
}

/*
 * LB 뒤 VM 3대(노드를 VM마다 따로 둠). api1·api2는 c6i.xlarge(4 vCPU), api3만 c6i.large(2 vCPU).
 * 슬롯(16)·처리 시간(20ms)·요청당 CPU(0.5)는 같다. 하류(DB)는 두지 않는다.
 * 트래픽: 0~6초 300 → 6~14초 700 → 14~22초 1100 → 22초~ 300 rps.
 * CPU 상한(이론): 4 vCPU VM = 4/(0.5·0.02) = 400/s, 2 vCPU VM = 200/s, 합계 1000/s.
 */
function lbsplit(): Scenario {
  const api = (id: string, label: string) => ({
    id, kind: 'service', label,
    config: { capacity: 16, serviceMs: 20, serviceCv: 0.5, queueLimit: 100, errorRate: 0, timeoutMs: 0, retries: 0 },
  });
  const design = {
    name: 'lb split across VMs',
    nodes: [
      // 사양 패널(노드 아래)이 들어갈 자리를 남기려고 VM 사이 세로 간격을 넓게 둔다.
      { id: 'users', kind: 'client', label: 'Users', x: 0, y: 270, config: { rps: 300, timeoutMs: 2000, retries: 0 } },
      { id: 'lb', kind: 'lb', label: 'LB', x: 360, y: 270, config: { capacity: 1024, serviceMs: 0.5, serviceCv: 0.2, queueLimit: 4096 } },
      { ...api('api1', 'API VM #1'), x: 760, y: 0 },
      { ...api('api2', 'API VM #2'), x: 760, y: 270 },
      { ...api('api3', 'API VM #3 (small)'), x: 760, y: 540 },
    ],
    // DB는 뺐다: 이 시나리오는 VM별 CPU만 보려는 것이라 하류 병목을 두지 않는다.
    edges: [
      { from: 'users', to: 'lb' },
      { from: 'lb', to: 'api1' }, { from: 'lb', to: 'api2' }, { from: 'lb', to: 'api3' },
    ],
  };
  const big = { product: 'c6i.xlarge', vcpu: 4, memMiB: 8192, cpuPerReq: 0.5, memBaseMiB: 1200, memPerInflightMiB: 24, memPerQueuedMiB: 2 };
  const small = { product: 'c6i.large', vcpu: 2, memMiB: 4096, cpuPerReq: 0.5, memBaseMiB: 1200, memPerInflightMiB: 24, memPerQueuedMiB: 2 };
  const plan = [[0, 300], [6_000, 700], [14_000, 1100], [22_000, 300]] as const;
  let idx = 0;
  let rps = 300;
  return {
    design,
    specs: {
      lb: { product: 'ALB (관리형)', managed: true },
      api1: { ...big }, api2: { ...big }, api3: { ...small },
    },
    seconds: 26,
    step(e, t) {
      while (idx + 1 < plan.length && t >= plan[idx + 1][0]) {
        idx++;
        rps = plan[idx][1];
        e.updateNodeConfig('users', { rps });
      }
    },
    hud: (s) =>
      `유입 ${rps}rps (6초 700 · 14초 1100 · 22초 300) | 처리 api1 ${s.nodes.api1?.throughput.toFixed(0)} · ` +
      `api2 ${s.nodes.api2?.throughput.toFixed(0)} · api3 ${s.nodes.api3?.throughput.toFixed(0)} /s | 이론 CPU 상한 400·400·200`,
  };
}

/*
 * 부분 OOM: LB 뒤 같은 사양 VM 3대(c6i.large, 4 GiB). 요청마다 메모리가 조금씩 새는 버그가 있다.
 * 배포 시점이 달라 이미 쌓인 누수량이 다르다(VM #1이 가장 오래 떠 있었음).
 * 트래픽은 450rps로 일정. 시간은 압축했다(실제로는 수 시간에 걸친 누수를 수십 초로).
 * 헬스체크 제외 3초, 재시작 4초, 재합류 6초, 워밍업 3초(×2.5 느림) — 이것도 압축값.
 */
function oom(): Scenario {
  const api = (id: string, label: string, x: number, y: number) => ({
    id, kind: 'service', label, x, y,
    config: { capacity: 16, serviceMs: 20, serviceCv: 0.5, queueLimit: 100, errorRate: 0, timeoutMs: 0, retries: 0 },
  });
  const design = {
    name: 'partial oom',
    nodes: [
      { id: 'users', kind: 'client', label: 'Users', x: 0, y: 270, config: { rps: 450, timeoutMs: 2000, retries: 0 } },
      { id: 'lb', kind: 'lb', label: 'LB', x: 360, y: 270, config: { capacity: 1024, serviceMs: 0.5, serviceCv: 0.2, queueLimit: 4096 } },
      api('api1', 'API VM #1', 760, 0),
      api('api2', 'API VM #2', 760, 270),
      api('api3', 'API VM #3', 760, 540),
    ],
    edges: [
      { from: 'users', to: 'lb' },
      { from: 'lb', to: 'api1' }, { from: 'lb', to: 'api2' }, { from: 'lb', to: 'api3' },
    ],
  };
  const vm = { product: 'c6i.large', vcpu: 2, memMiB: 4096, cpuPerReq: 0.1, memBaseMiB: 1200, memPerInflightMiB: 24, memPerQueuedMiB: 2, leakPerReqMiB: 0.35 };
  return {
    design,
    specs: {
      lb: { product: 'ALB (관리형)', managed: true },
      api1: { ...vm, memInitialLeakMiB: 2300 },
      api2: { ...vm, memInitialLeakMiB: 1300 },
      api3: { ...vm, memInitialLeakMiB: 300 },
    },
    oom: { detectMs: 3000, restartMs: 4000, healthyMs: 2000, warmupMs: 3000, warmupFactor: 2.5 },
    seconds: 36,
    step() {},
    hud: (s) =>
      `유입 450rps 일정 · 요청당 0.35 MiB 누수 · 시간 압축 | 처리 api1 ${s.nodes.api1?.throughput.toFixed(0)} · ` +
      `api2 ${s.nodes.api2?.throughput.toFixed(0)} · api3 ${s.nodes.api3?.throughput.toFixed(0)} /s`,
  };
}

/*
 * 자체 오토스케일러: LB 뒤 VM 최대 6대(같은 사양 c6i.large). 처음 2대.
 * VM: 슬롯 16, 처리 20ms, 요청당 CPU 0.5 → VM당 CPU 상한 200/s. 목표 CPU 60%(VM당 120/s).
 * 트래픽: 240 → (8s) 360 → (30s) 560 → (55s) 240. VM #2에는 메모리 누수 버그(요청당 0.3 MiB).
 * 시간은 압축: 부팅 5s, 헬스체크 1s 간격, 축소 안정화 10s, 드레이닝 2s, 재시작 3s.
 */
function asg(): Scenario {
  const ids = ['vm1', 'vm2', 'vm3', 'vm4', 'vm5', 'vm6'];
  // 3열 × 2행. 패널(노드 아래)이 들어갈 세로 간격을 넉넉히 둔다.
  const pos: Record<string, [number, number]> = {
    vm1: [700, 0], vm2: [1050, 0], vm3: [1400, 0], vm4: [700, 440], vm5: [1050, 440], vm6: [1400, 440],
  };
  const design = {
    name: 'lab autoscaler',
    nodes: [
      { id: 'users', kind: 'client', label: 'Users', x: 0, y: 220, config: { rps: 240, timeoutMs: 2000, retries: 0 } },
      { id: 'lb', kind: 'lb', label: 'LB', x: 330, y: 220, config: { capacity: 4096, serviceMs: 0.5, serviceCv: 0.2, queueLimit: 8192 } },
      ...ids.map((id, i) => ({
        id, kind: 'service', label: `API VM #${i + 1}`, x: pos[id][0], y: pos[id][1],
        config: { capacity: 16, serviceMs: 20, serviceCv: 0.5, queueLimit: 100, errorRate: 0, timeoutMs: 0, retries: 0 },
      })),
    ],
    edges: [{ from: 'users', to: 'lb' }, ...ids.map((id) => ({ from: 'lb', to: id }))],
  };
  const vm = { product: 'c6i.large', vcpu: 2, memMiB: 4096, cpuPerReq: 0.5, memBaseMiB: 1000, memPerInflightMiB: 24, memPerQueuedMiB: 2 };
  const plan = [[0, 240], [8_000, 360], [30_000, 560], [55_000, 240]] as const;
  let idx = 0;
  let rps = 240;
  return {
    design,
    specs: {
      lb: { product: 'ALB (관리형)', managed: true },
      ...Object.fromEntries(ids.map((id) => [id, { ...vm }])),
      vm2: { ...vm, leakPerReqMiB: 0.3, memInitialLeakMiB: 1200 },
    },
    fleet: {
      lb: 'lb', vms: ids, initial: 2, bootMs: 5000, warmupMs: 3000, warmupFactor: 2, drainMs: 2000,
      health: { intervalMs: 1000, timeoutMs: 500, unhealthyThreshold: 3, healthyThreshold: 2 },
      recovery: { mode: 'process', restartMs: 3000, backoffBaseMs: 2000, backoffMaxMs: 30000, backoffResetMs: 20000, replaceBootMs: 6000 },
      scaling: { metric: 'cpu', target: 0.6, tolerance: 0.1, min: 2, max: 6, metricWindowMs: 5000, scaleOutCooldownMs: 3000, scaleInStabilizationMs: 10000, scaleInPick: 'oldest' },
    },
    seconds: 80,
    step(e, t) {
      while (idx + 1 < plan.length && t >= plan[idx + 1][0]) {
        idx++;
        rps = plan[idx][1];
        e.updateNodeConfig('users', { rps });
      }
    },
    hud: () => `유입 ${rps}rps (8s 360 · 30s 560 · 55s 240) · VM #2 메모리 누수 · 시간 압축`,
  };
}

/*
 * 급증(스파이크): asg와 같은 구성인데, 누수 없이 8초에 트래픽이 240 → 700으로 한 번에 뛴다.
 * 2대의 CPU 상한은 400/s라 새 VM이 붙기 전(부팅 5s + 헬스체크 2s)에 과부하가 온다.
 * 과부하로 헬스체크 응답이 늦어 1대가 LB에서 빠지면 나머지가 더 받는 연쇄가 생기는지 본다.
 */
function asgSpike(): Scenario {
  const s = asg();
  const specs = { ...s.specs, vm2: { ...s.specs.vm1 } }; // 누수 없음
  let rps = 240;
  let done = false;
  return {
    ...s,
    specs,
    seconds: 60,
    step(e, t) {
      if (!done && t >= 8_000) { rps = 700; e.updateNodeConfig('users', { rps }); done = true; }
    },
    hud: () => `유입 ${rps}rps (8s에 240 → 700 급증) · 시간 압축`,
  };
}

/* asg_spike와 모든 것이 같고 LB만 fail-open(ALB 동작)인 비교용. */
function asgSpikeFailOpen(): Scenario {
  const s = asgSpike();
  return { ...s, fleet: { ...s.fleet!, failOpen: true }, hud: (snap, t) => s.hud(snap, t) + ' · LB fail-open' };
}

/* asg_spike와 모든 것이 같고 헬스체크만 전용 경로(대기열을 건너뜀)인 비교용. */
function asgSpikeDedicated(): Scenario {
  const s = asgSpike();
  return {
    ...s,
    fleet: { ...s.fleet!, health: { ...s.fleet!.health, path: 'dedicated', healthMs: 5 } },
    hud: (snap, t) => s.hud(snap, t) + ' · 헬스체크 전용 경로',
  };
}

export const SCENARIOS: Record<string, () => Scenario> = {
  s1crash, noisy, lbsplit, oom, asg, asg_spike: asgSpike, asg_spike_fo: asgSpikeFailOpen, asg_spike_ded: asgSpikeDedicated,
};

/*
 * lab/scenarios/*.json. 파일 목록은 부르는 쪽이 넘긴다:
 * 브라우저는 main.tsx의 import.meta.glob(vite가 빌드 때 펼친다), bun은 lab/sim.ts가 파일을 직접 읽는다.
 */

/** 이름으로 시나리오를 만든다. 코드 시나리오가 먼저, 없으면 JSON 파일(<이름>.json). */
export function getScenario(name: string, jsonFiles: Record<string, ScenarioFile> = {}): (() => Scenario) | undefined {
  if (SCENARIOS[name]) return SCENARIOS[name];
  const f = jsonFiles[name];
  return f ? () => fromScenarioFile(f) : undefined;
}
