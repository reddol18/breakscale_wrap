/*
 * JSON 시나리오 파일(lab/scenarios/*.json) 형식과 해석.
 * 코드를 고치지 않고 파일 하나로 시뮬레이션을 정의하려고 둔다(Claude Code가 자연어 요청을 이 파일로 옮긴다).
 *
 * {
 *   "name": "급증 예제",                        화면·출력에 쓰는 이름
 *   "description": "...",                       (선택) 한 줄 설명
 *   "seconds": 70,                              시뮬레이션 길이(초)
 *   "design": { "name", "nodes", "edges" },     공식 MCP create_view와 같은 입력
 *   "specs": { "<노드 id>": NodeSpec },          VM 사양·앱 동작 값(lab/core/meter.ts NodeSpec)
 *   "fleet": FleetConfig,                       (선택) 자체 오토스케일러(lab/core/fleet.ts). 시간은 ms
 *   "oom": OomOptions,                          (선택) fleet 없이 부분 OOM만(lab/core/oom.ts)
 *   "hosts": { "<호스트>": { "vcpu": 2 } },      (선택) 같은 VM을 나눠 쓰는 노드의 vCPU 풀
 *   "timeline": [                               (선택) 시각(초)별 변화, 순서대로 적용
 *     { "at": 8,  "set":   { "users": { "rps": 700 } } },        노드 설정 바꾸기(트래픽 등)
 *     { "at": 10, "fault": { "node": "api2", "kind": "crash" } },  장애 주입: crash | slow(factor) | errors(rate)
 *     { "at": 15, "clear": "api2" }                                 장애 해제
 *   ]
 * }
 */
import type { Engine } from '../../vendor/breakscale/src/sim/engine';
import type { SimSnapshot } from '../../vendor/breakscale/src/sim/types';
import type { SpecSheet } from './meter';
import type { OomOptions } from './oom';
import type { FleetConfig } from './fleet';

export interface TimelineItem {
  at: number;
  set?: Record<string, Record<string, unknown>>;
  fault?: { node: string; kind: 'crash' | 'slow' | 'errors'; factor?: number; rate?: number };
  clear?: string;
}

export interface ScenarioFile {
  name?: string;
  description?: string;
  seconds: number;
  design: { nodes: { id: string; kind: string; config?: Record<string, unknown> }[]; [k: string]: unknown };
  specs?: SpecSheet;
  fleet?: FleetConfig;
  oom?: OomOptions;
  hosts?: Record<string, { vcpu: number }>;
  timeline?: TimelineItem[];
}

/** viz/scenarios.ts의 Scenario와 같은 모양(순환 import를 피하려고 여기서 다시 적는다) */
export interface RunnableScenario {
  design: unknown;
  specs: SpecSheet;
  hosts?: Record<string, { vcpu: number }>;
  oom?: OomOptions;
  fleet?: FleetConfig;
  seconds: number;
  step(engine: Engine, t: number): void;
  hud(s: SimSnapshot, t: number): string;
}

export function fromScenarioFile(f: ScenarioFile): RunnableScenario {
  if (!f || !f.design || !Array.isArray(f.design.nodes)) throw new Error('시나리오 파일에 design.nodes가 없습니다');
  if (!(f.seconds > 0)) throw new Error('시나리오 파일에 seconds(초)가 없습니다');
  const timeline = [...(f.timeline ?? [])].sort((a, b) => a.at - b.at);
  const clients = f.design.nodes.filter((n) => n.kind === 'client').map((n) => n.id);
  const rps: Record<string, number> = Object.fromEntries(
    f.design.nodes.filter((n) => n.kind === 'client').map((n) => [n.id, Number(n.config?.rps ?? 0)]),
  );
  let i = 0;
  return {
    design: f.design,
    specs: f.specs ?? {},
    hosts: f.hosts,
    oom: f.oom,
    fleet: f.fleet,
    seconds: f.seconds,
    step(e, t) {
      while (i < timeline.length && t >= timeline[i].at * 1000) {
        const it = timeline[i++];
        for (const [node, patch] of Object.entries(it.set ?? {})) {
          e.updateNodeConfig(node, patch);
          if (typeof patch.rps === 'number') rps[node] = patch.rps;
        }
        if (it.fault) e.injectFailure(it.fault.node, it.fault.kind, { factor: it.fault.factor, rate: it.fault.rate });
        if (it.clear) e.clearFailure(it.clear);
      }
    },
    hud: () =>
      [f.name, clients.map((c) => `${c} ${rps[c]}rps`).join(' · '), f.description].filter(Boolean).join(' | '),
  };
}
