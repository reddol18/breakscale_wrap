/*
 * 녹화용 페이지. 원본 Canvas 컴포넌트를 수정 없이 import해서
 * 우리가 돌리는 Engine의 snapshot으로 그리고, 그 위에 노드별 사양 패널을 덧그린다.
 * 주소 옵션: ?scn=<시나리오>(lab/viz/scenarios.ts) · ?cpu=0(CPU 경합 모델 끔) · ?manual(녹화 스크립트가 시각을 넘김)
 */
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../vendor/breakscale/src/index.css';
import Canvas from '../../vendor/breakscale/src/components/Canvas';
import { Engine } from '../../vendor/breakscale/src/sim/engine';
import type { SimSnapshot } from '../../vendor/breakscale/src/sim/types';
import { buildTopology } from '../../vendor/breakscale/mcp/src/design';
import { readMeters } from '../core/meter';
import { CpuContention } from '../core/cpu';
import { PartialOom } from '../core/oom';
import { combine } from '../core/combine';
import { Fleet } from '../core/fleet';
import { SpecOverlay } from './SpecOverlay';
import { getScenario, SCENARIOS } from './scenarios';
import type { ScenarioFile } from '../core/scenario-file';

// lab/scenarios/*.json을 이름(파일명)으로 묶는다. vite가 빌드 때 펼치므로 직접 호출 형태여야 한다.
const jsonFiles: Record<string, ScenarioFile> = Object.fromEntries(
  Object.entries(import.meta.glob('../scenarios/*.json', { eager: true, import: 'default' })).map(([p, v]) => [
    p.replace(/^.*\/(.+)\.json$/, '$1'),
    v as ScenarioFile,
  ]),
);

const query = new URLSearchParams(location.search);
const scnName = query.get('scn') ?? 's1crash';
const found = getScenario(scnName, jsonFiles);
if (!found) {
  document.body.textContent = `시나리오 "${scnName}"이(가) 없습니다. 있는 것: ${[...Object.keys(SCENARIOS), ...Object.keys(jsonFiles)].join(', ')}`;
  throw new Error(`unknown scenario ${scnName}`);
}
const makeScenario = found;
const cpuOn = query.get('cpu') !== '0';
const CPU_TICK_MS = 50;
const STEP_MS = 1000 / 60;

const first = makeScenario();
const built = buildTopology(first.design as Parameters<typeof buildTopology>[0]);
if (!built.ok) throw new Error(built.errors.join('\n'));
const topology = built.topology;

function App() {
  const [snapshot, setSnapshot] = useState<SimSnapshot | null>(null);
  const [simMs, setSimMs] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const hostRef = useRef<HTMLDivElement | null>(null);
  const cpuRef = useRef<CpuContention | null>(null);
  const oomRef = useRef<PartialOom | null>(null);
  const fleetRef = useRef<Fleet | null>(null);
  const eventsRef = useRef<{ t: number; node: string; what: string }[]>([]);
  const scnRef = useRef(first);

  useEffect(() => {
    // StrictMode에서 두 번 실행될 수 있으므로 시나리오 상태를 매번 새로 만든다.
    const scn = makeScenario();
    scnRef.current = scn;
    const topo = structuredClone(topology);
    const engine = new Engine(topo, 1);
    // 자체 오토스케일러(fleet)가 있으면 그것이 VM의 CPU·메모리·장애를 모두 맡는다.
    const fleet = scn.fleet ? new Fleet(scn.fleet, scn.specs) : null;
    const cpu = cpuOn && !fleet ? new CpuContention(scn.specs, scn.hosts) : null;
    const oom = scn.oom && !fleet ? new PartialOom(scn.specs, scn.oom) : null;
    const ctl = combine(cpu, oom, fleet);
    ctl.init?.(engine, topo);
    cpuRef.current = cpu;
    oomRef.current = oom;
    fleetRef.current = fleet;
    eventsRef.current = [];
    let nextCpu = CPU_TICK_MS;
    let t = 0;
    let raf = 0;
    const stepTo = (goal: number) => {
      while (t + STEP_MS <= goal + 1e-6) {
        engine.advance(STEP_MS);
        t += STEP_MS;
        if (t >= nextCpu) {
          nextCpu += CPU_TICK_MS;
          const ev = ctl.tick(engine, engine.snapshot(), t);
          for (const e of ev) if (!e.what.startsWith('cpu')) eventsRef.current.push(e);
        }
        scn.step(engine, t);
      }
      let snap = engine.snapshot();
      if (cpu) snap = cpu.hideOwnFaults(snap);
      if (oom) snap = oom.hideOwnFaults(snap);
      if (fleet) snap = fleet.hideOwnFaults(snap);
      setSnapshot(snap);
      setSimMs(t);
    };

    // ?manual: 녹화 스크립트가 시각을 직접 넘긴다(프레임 단위 캡처, 영상 속도 = 실시간 정확).
    if (query.has('manual')) {
      const w = window as unknown as { __labStep?: (ms: number) => Promise<number> };
      w.__labStep = (ms) =>
        new Promise((done) => {
          stepTo(t + ms);
          requestAnimationFrame(() => requestAnimationFrame(() => done(t)));
        });
      stepTo(0);
      return () => { delete w.__labStep; };
    }

    // 평소: 시뮬레이션 시각을 실제 시각에 맞춘다.
    let wallStart = -1;
    const frame = (now: number) => {
      if (wallStart < 0) wallStart = now;
      stepTo(Math.min(now - wallStart, t + 250)); // 한 프레임에 최대 0.25초까지만 따라잡는다
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const cpu = cpuRef.current;
  const meters = snapshot ? readMeters(topology, snapshot.nodes, scnRef.current.specs) : [];
  // 공유 호스트에 묶인 노드는 CPU 막대를 호스트 전체 수요 기준으로 바꾼다.
  if (cpu) {
    for (const m of meters) {
      const st = cpu.state.get(m.nodeId);
      if (!st?.host || !(st.vcpu > 0)) continue;
      let hostDemand = 0;
      for (const o of cpu.state.values()) if (o.host === st.host) hostDemand += o.demand;
      m.vcpu = st.vcpu;
      m.cpuCores = hostDemand;
      m.cpuPct = (hostDemand / st.vcpu) * 100;
      m.ownCores = st.demand;
      m.host = st.host;
    }
  }

  // OOM 컨트롤러가 있으면 메모리 막대를 그 계산값(누수 포함)으로, 상태 배지를 붙인다.
  const oom = oomRef.current;
  if (oom) {
    for (const m of meters) {
      const vm = oom.vms.get(m.nodeId);
      if (!vm) continue;
      m.memMiB = vm.memMiB;
      m.memLimitMiB = vm.limitMiB;
      m.memPct = (vm.memMiB / vm.limitMiB) * 100;
      m.phase = vm.phase;
      m.phaseAge = simMs - vm.since;
      m.ooms = vm.ooms;
    }
  }
  // 자체 오토스케일러: VM별 CPU·메모리·상태·레이블을 fleet 값으로.
  const fleet = fleetRef.current;
  const factors: Record<string, number> = cpu ? Object.fromEntries([...cpu.state].map(([id, s]) => [id, s.factor])) : {};
  if (fleet) {
    for (const m of meters) {
      const vm = fleet.vms.get(m.nodeId);
      if (!vm) continue;
      m.vcpu = vm.vcpu;
      m.cpuCores = vm.cpuCores;
      m.cpuPct = vm.cpuPct;
      m.memMiB = vm.memMiB;
      m.memLimitMiB = vm.limitMiB;
      m.memPct = (vm.memMiB / vm.limitMiB) * 100;
      m.phase = vm.crashed && (vm.phase === 'up' || vm.phase === 'warm') ? 'dead' : vm.phase;
      m.phaseAge = simMs - vm.since;
      m.ooms = vm.ooms;
      m.restarts = vm.restarts;
      m.reason = vm.reason;
      factors[m.nodeId] = vm.factor;
    }
  }
  const recent = eventsRef.current.slice(-(fleet ? 8 : 6));
  // 꺼진 VM은 캔버스에서 숨긴다(켜질 때 나타남). 숨김 목록이 바뀔 때만 새 토폴로지를 만든다.
  const hiddenKey = fleet ? [...fleet.vms.values()].filter((v) => v.phase === 'standby').map((v) => v.id).join(',') : '';
  const viewRef = useRef<{ key: string; topo: typeof topology }>({ key: '', topo: topology });
  if (fleet && viewRef.current.key !== hiddenKey) viewRef.current = { key: hiddenKey, topo: fleet.visibleTopology(topology) };
  // 캔버스는 첫 렌더 때의 노드로 화면 맞춤을 한다. 처음엔 전체를 그려 맞춤을 잡고, 그 뒤부터 꺼진 VM을 숨긴다.
  const viewTopology = fleet && simMs >= 200 ? viewRef.current.topo : topology;
  const fs = fleet?.summary;
  const sc = scnRef.current.fleet?.scaling;

  const noop = () => {};
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <div id="hud" style={{ padding: '6px 12px', fontFamily: 'monospace', fontSize: 14 }}>
        t={(simMs / 1000).toFixed(1)}s · served {snapshot?.system.goodputRps.toFixed(0) ?? '-'}/s ·
        failed {snapshot ? (snapshot.system.errorRate * 100).toFixed(1) : '-'}% · faults{' '}
        {snapshot?.activeFailures?.map((f) => `${f.nodeId}:${f.kind}`).join(', ') || 'none'}
        {snapshot && <b>{'   '}| {scnRef.current.hud(snapshot, simMs)}</b>}
        {fs && (
          <div id="fleet" style={{ fontSize: 13 }}>
            <b>
              자체 오토스케일러: VM {fs.members}대 (지표 기준 {fs.ready}대) · 평균 CPU {(fs.avg * 100).toFixed(0)}%
              {sc && ` · 목표 ${(sc.target * 100).toFixed(0)}% · 권장 ${fs.recommended}대 · 범위 ${sc.min}~${sc.max}대`}
            </b>
            {fs.lastDecision && <span> · 마지막 결정 {fs.lastDecision}</span>}
            <span> · LB fail-open {scnRef.current.fleet?.failOpen ? '켬' : '끔'}</span>
            <span> · 헬스체크 {scnRef.current.fleet?.health.path === 'dedicated' ? '전용 경로' : '일반 요청과 같은 대기열'}</span>
            {fleet?.failOpenActive && (
              <b style={{ marginLeft: 6, padding: '0 5px', background: '#d63a3a', color: '#fff', borderRadius: 3 }}>
                fail-open 작동 중: 정상 VM 0대 → 전부에 보냄
              </b>
            )}
          </div>
        )}
        <div style={{ color: '#888', fontSize: 12 }}>
          {fleet
            ? '슬롯·대기·처리량 = 엔진 실측 · CPU·MEM·헬스체크 응답·증설/축소/재시작 = lab 모델(사양·시간은 가정값, 시간 압축)'
            : <>
                슬롯·대기 = 엔진 실측 · CPU·MEM = lab 추정(사양 가정값) · CPU 경합 모델{' '}
                {cpuOn ? 'ON (CPU 수요>vCPU면 처리 시간 ×수요/vCPU)' : 'OFF (엔진 원래 동작)'} ·{' '}
                {scnRef.current.oom ? 'OOM 모델 ON (MEM>한도면 VM crash → 헬스체크 제외 → 재시작 → 재합류)' : 'MEM은 표시만'}
              </>}
        </div>
      </div>
      <div ref={hostRef} style={{ position: 'relative', flex: 1 }}>
        <Canvas
          topology={viewTopology}
          snapshot={snapshot}
          selectedIds={selected}
          onSelectionChange={setSelected}
          onMoveNode={noop}
          onConnect={noop}
          onDeleteSelection={noop}
          onDropNode={noop}
        />
        {snapshot && (
          <SpecOverlay
            meters={meters}
            simMs={simMs}
            hostRef={hostRef}
            factors={factors}
          />
        )}
        {recent.length > 0 && (
          <div
            id="events"
            style={{
              position: 'absolute', left: 16, bottom: 56, padding: '6px 10px', minWidth: 360,
              background: 'rgba(255,255,255,0.92)', border: '1px solid #d8d2c6', borderRadius: 6,
              font: '12px/1.6 ui-monospace, Consolas, monospace', color: '#333', pointerEvents: 'none',
            }}
          >
            <b>사건 기록</b>
            {recent.map((e, i) => (
              <div key={i} style={{ color: e.what.startsWith('OOM') ? '#d63a3a' : undefined }}>
                {(e.t / 1000).toFixed(1).padStart(5)}s {e.node}: {e.what}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
