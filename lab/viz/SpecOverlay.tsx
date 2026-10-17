/*
 * 원본 캔버스 위에 노드별 사양·계기판을 덧그린다.
 * 원본 Canvas는 건드리지 않고, 노드 DOM(data-hit="node", data-id)의 위치만 읽어
 * 그 바로 아래에 패널을 띄운다. 값은 화면 깜빡임을 줄이려고 지수평활(약 0.5초)한다.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Meter } from '../core/meter';

const TAU_MS = 500;
const PANEL_H = 76;
/** 상태 배지 줄이 붙는 패널(OOM 모델)의 자리 잡기용 높이 */
const PANEL_H_PHASE = 110;
const PANEL_W = 290;
type Smooth = Record<string, Record<string, number>>;

function color(pct: number) {
  if (pct >= 90) return '#d63a3a';
  if (pct >= 70) return '#e0a020';
  return '#2f9e6a';
}

function Bar({ label, pct, text }: { label: string; pct: number; text: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 34, fontWeight: 700 }}>{label}</span>
      <div style={{ flex: 1, height: 8, background: '#e6e1d8', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: color(pct) }} />
      </div>
      <span style={{ width: 168, textAlign: 'right', color: pct >= 100 ? '#d63a3a' : undefined }}>{text}</span>
    </div>
  );
}

const PHASE: Record<string, { text: string; bg: string }> = {
  up: { text: '정상', bg: '#2f9e6a' },
  dead: { text: '죽음 · LB는 아직 보냄', bg: '#d63a3a' },
  out: { text: 'LB에서 제외됨', bg: '#8a5a00' },
  booting: { text: '기동 중', bg: '#6b6b6b' },
  warm: { text: '합류 · 워밍업', bg: '#2a6fb0' },
  checking: { text: '헬스체크 대기', bg: '#6b6b6b' },
  restarting: { text: '재시작 대기', bg: '#a33' },
  draining: { text: '드레이닝(축소)', bg: '#7a5aa8' },
  standby: { text: '꺼짐', bg: '#999' },
};

function PhaseBadge({ phase, ageMs, ooms, restarts }: { phase: string; ageMs: number; ooms: number; restarts: number }) {
  const p = PHASE[phase] ?? { text: phase, bg: '#666' };
  return (
    <span style={{ padding: '0 5px', borderRadius: 3, background: p.bg, color: '#fff', fontWeight: 700 }}>
      {p.text}
      {phase !== 'up' && ` ${(ageMs / 1000).toFixed(1)}s`}
      {ooms > 0 && ` · OOM ${ooms}회`}
      {restarts > 0 && ` · 재시작 ${restarts}회`}
    </span>
  );
}

export function SpecOverlay({
  meters,
  simMs,
  hostRef,
  factors = {},
}: {
  meters: Meter[];
  simMs: number;
  hostRef: RefObject<HTMLDivElement | null>;
  /** CPU 경합 컨트롤러가 건 처리 시간 배율(1이면 경합 없음) */
  factors?: Record<string, number>;
}) {
  const smooth = useRef<Smooth>({});
  const lastMs = useRef(0);
  const [boxes, setBoxes] = useState<Record<string, { x: number; y: number; w: number }>>({});

  // 평활
  const dt = Math.max(0, simMs - lastMs.current);
  lastMs.current = simMs;
  const a = 1 - Math.exp(-dt / TAU_MS);
  const ema = (id: string, key: string, v: number | undefined) => {
    if (v == null) return undefined;
    const bag = (smooth.current[id] ??= {});
    bag[key] = bag[key] == null ? v : bag[key] + a * (v - bag[key]);
    return bag[key];
  };

  // 노드 위치 읽기
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const base = host.getBoundingClientRect();
    const rectOf = (id: string) =>
      (host.querySelector(`[data-hit="node"][data-id="${CSS.escape(id)}"] .cv-node-body`) ??
        host.querySelector(`[data-hit="node"][data-id="${CSS.escape(id)}"]`))?.getBoundingClientRect();
    const all = [...host.querySelectorAll('[data-hit="node"] .cv-node-body')].map((e) => e.getBoundingClientRect());
    const next: Record<string, { x: number; y: number; w: number }> = {};
    for (const m of meters) {
      const r = rectOf(m.nodeId);
      if (!r) continue;
      // 노드 아래 → 위 → 오른쪽 순으로, 다른 노드와 겹치지 않는 자리를 고른다.
      const W = Math.max(r.width, PANEL_W);
      const H = m.phase ? PANEL_H_PHASE : PANEL_H;
      const hits = (x: number, y: number) =>
        y + H > base.bottom ||
        all.some((o) => o.left < x + W && o.right > x && o.top < y + H && o.bottom > y);
      let x = r.left;
      let y = r.bottom + 6;
      if (hits(x, y)) {
        y = r.top - 6 - H;
        if (hits(x, y) || y < base.top) {
          x = r.right + 10;
          y = r.top;
        }
      }
      x = Math.min(x, base.right - W - 4); // 화면 오른쪽 밖으로 나가지 않게
      next[m.nodeId] = { x: x - base.left, y: y - base.top, w: r.width };
    }
    setBoxes((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  });

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {meters.map((m) => {
        const box = boxes[m.nodeId];
        if (!box) return null;
        const cpu = ema(m.nodeId, 'cpu', m.cpuPct);
        const cores = ema(m.nodeId, 'cores', m.cpuCores);
        // OOM 모델 값은 평활하지 않는다(죽는 순간·재시작 순간의 급변이 그대로 보여야 한다).
        const mem = m.phase ? m.memMiB : ema(m.nodeId, 'mem', m.memMiB);
        const memPct = m.phase ? m.memPct : ema(m.nodeId, 'memPct', m.memPct);
        const inF = ema(m.nodeId, 'inF', m.inFlight) ?? 0;
        const q = ema(m.nodeId, 'q', m.queued) ?? 0;
        return (
          <div
            key={m.nodeId}
            style={{
              position: 'absolute',
              left: box.x,
              top: box.y,
              width: Math.max(box.w, PANEL_W),
              height: m.managed || m.host || m.phase ? undefined : PANEL_H,
              boxSizing: 'border-box',
              padding: '5px 8px',
              background: 'rgba(255,255,255,0.92)',
              border: '1px solid #d8d2c6',
              borderRadius: 6,
              font: '12px/1.45 ui-monospace, Consolas, monospace',
              color: '#333',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
              <b>{m.product}</b>
              <span style={{ color: '#888' }}>
                {m.vcpu != null ? `${m.vcpu} vCPU` : ''}
                {m.memLimitMiB != null ? ` · ${(m.memLimitMiB / 1024).toFixed(0)} GiB` : ''}
              </span>
            </div>
            {m.phase && (
              <div style={{ marginBottom: 2 }}>
                <PhaseBadge phase={m.phase} ageMs={m.phaseAge ?? 0} ooms={m.ooms ?? 0} restarts={m.restarts ?? 0} />
                {m.reason && m.phase !== 'up' && (
                  <div style={{ color: '#555', fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {m.reason}
                  </div>
                )}
              </div>
            )}
            {cpu != null && cores != null && (
              <Bar
                label="CPU"
                pct={cpu}
                text={
                  cpu > 100
                    ? `100% 수요 ${cores.toFixed(1)}/${m.vcpu} core`
                    : `${cpu.toFixed(0)}% (${cores.toFixed(1)}/${m.vcpu} core)`
                }
              />
            )}
            {mem != null && memPct != null && (
              <Bar
                label="MEM"
                pct={memPct}
                text={`${(mem / 1024).toFixed(2)}/${(m.memLimitMiB! / 1024).toFixed(0)} GiB`}
              />
            )}
            {m.host && (
              <div style={{ color: '#555' }}>
                VM {m.host} 공유 · 이 서비스 몫 {(ema(m.nodeId, 'own', m.ownCores) ?? 0).toFixed(1)} core
              </div>
            )}
            <div style={{ color: '#555' }}>
              {m.managed ? '연결' : '슬롯'} {inF.toFixed(1)}/{m.capacity} · 대기 {q.toFixed(1)}/{m.queueLimit}
              {(factors[m.nodeId] ?? 1) > 1 && (
                <b style={{ color: '#d63a3a' }}> · 처리 ×{factors[m.nodeId].toFixed(1)} 느려짐</b>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
