/*
 * breakscale_lab 실험 실행기.
 *
 * 원본 Breakscale(vendor/breakscale, 고정 커밋)은 한 줄도 고치지 않고 import만 한다.
 * 컨트롤러가 없으면 공식 MCP create_view와 같은 경로로 돈다
 * (buildTopology -> Engine -> 1/60초 단위 advance -> describeRun -> 공유 링크).
 * 컨트롤러가 있으면 시뮬레이션 시간 tickMs마다 엔진 상태를 보고 장애를 넣거나 푼다.
 */
import './compat';
import { Engine } from '../../vendor/breakscale/src/sim/engine';
import type { SimSnapshot, Topology } from '../../vendor/breakscale/src/sim/types';
import { buildShareUrl, ShareLinkTooLargeError } from '../../vendor/breakscale/src/share';
import { buildTopology } from '../../vendor/breakscale/mcp/src/design';
import { DEFAULT_RUN, describeRun, type RunOptions } from '../../vendor/breakscale/mcp/src/run';

export const APP_URL = 'https://breakscale.tech/';
const STEP_MS = 1000 / 60; // mcp/src/run.ts 와 같은 값

/** 컨트롤러가 엔진에 하는 일을 기록한 사건 하나. */
export interface LabEvent {
  t: number; // 시뮬레이션 시각(ms)
  node: string;
  what: string;
}

export interface Controller {
  /** 실행 전에 한 번. 토폴로지를 확정한 뒤 호출된다. */
  init?(engine: Engine, topology: Topology): void;
  /** tickMs마다 호출. 사건이 있으면 돌려준다. */
  tick(engine: Engine, snapshot: SimSnapshot, simMs: number): LabEvent[];
}

export interface LabOptions extends RunOptions {
  controller?: Controller;
  tickMs?: number;
  /** 프레임마다(1/60초) 호출. 녹화·시계열용. */
  onFrame?: (engine: Engine, simMs: number) => void;
}

export interface LabResult {
  topology: Topology;
  snapshot: SimSnapshot;
  simulatedMs: number;
  events: LabEvent[];
  /** 공식 create_view 응답과 같은 형식의 본문. */
  text: string;
}

export async function runLab(
  args: unknown,
  opts: LabOptions = { ...DEFAULT_RUN },
): Promise<LabResult> {
  const built = buildTopology(args as Parameters<typeof buildTopology>[0]);
  if (!built.ok) throw new Error('design rejected:\n' + built.errors.join('\n'));
  const { topology } = built;

  const engine = new Engine(topology, opts.seed);
  const events: LabEvent[] = [];
  const tickMs = opts.tickMs ?? 100;
  opts.controller?.init?.(engine, topology);

  const target = opts.seconds * 1000;
  const start = performance.now();
  let simulatedMs = 0;
  let nextTick = tickMs;
  while (simulatedMs < target && performance.now() - start < opts.budgetMs) {
    engine.advance(STEP_MS);
    simulatedMs += STEP_MS;
    if (opts.controller && simulatedMs >= nextTick) {
      nextTick += tickMs;
      events.push(...opts.controller.tick(engine, engine.snapshot(), simulatedMs));
    }
    opts.onFrame?.(engine, simulatedMs);
  }
  const snapshot = engine.snapshot();
  const run = { snapshot, simulatedMs };

  // 아래 문구는 mcp/src/server.ts create_view와 글자 단위로 같아야 한다(회귀 기준).
  const lines = [describeRun(topology, run, opts)];
  try {
    lines.push(
      '',
      `Link to the design, which opens it on breakscale.tech: ${await buildShareUrl(topology, APP_URL)}`,
    );
  } catch (err) {
    if (!(err instanceof ShareLinkTooLargeError)) throw err;
    lines.push('', 'The design is too large for a link; use export_design to save it as a file.');
  }
  lines.push(
    '',
    'A changed design can be shown by passing the whole updated design to create_view; keeping the node ids keeps the layout stable. ' +
      'Edits the user makes on the canvas are reported back as context.',
  );

  return { topology, snapshot, simulatedMs, events, text: lines.join('\n') };
}
