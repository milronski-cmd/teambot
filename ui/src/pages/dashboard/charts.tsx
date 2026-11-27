import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cx } from '../../components/ui';

/**
 * The dashboard's charts (24 Nov 2026). Plain SVG, one axis each, thin marks, a recessive grid, and a hover layer:
 * a crosshair with a tooltip on lines, a tooltip per bar. Colours are roles (--viz-1 …, styles.css), each part of the
 * business its own fixed hue, validated for colour blindness in light and dark (dataviz palette slots 1, 2, 3, 7).
 */

export type Unit = 'eur' | 'count' | 'pct';
export interface Pt {
  d: string;
  v: number;
}

/** A coordinate in an SVG path, to a tenth of a pixel (not a number for people to read). */
const c1 = (n: number) => Math.round(n * 10) / 10;
const nf = (unit: Unit, compact = false) =>
  unit === 'eur'
    ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR', maximumFractionDigits: compact ? 0 : 2, notation: compact ? 'compact' : 'standard' })
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: compact ? 1 : 0, notation: compact ? 'compact' : 'standard' });
export const fmt = (v: number, unit: Unit, compact = false) => {
  if (unit === 'pct') return `${Math.round(v)}%`;
  // Small amounts on an axis keep their cents (otherwise 0.5 and 1 both read "€ 1").
  if (compact && Math.abs(v) < 10 && v % 1 !== 0) return new Intl.NumberFormat(undefined, unit === 'eur' ? { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 } : { maximumFractionDigits: 1 }).format(v);
  return nf(unit, compact).format(v);
};
export const dayLabel = (d: string, long = false) =>
  new Date(d + 'T12:00:00').toLocaleDateString(undefined, long ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short' });

/** A nice top for the axis: 1, 2, 2.5 or 5 times a power of ten, at least the largest value. */
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export interface ChartSeries {
  key: string;
  label: string;
  /** CSS colour (a role: var(--viz-1)). */
  color: string;
  points: Pt[];
  /** The period before, drawn as a quiet dashed line behind (lines only). */
  ghost?: Pt[];
}

const PAD = { top: 12, right: 12, bottom: 26, left: 52 };

function Axis({ w, h, max, unit, days }: { w: number; h: number; max: number; unit: Unit; days: string[] }) {
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const iw = w - PAD.left - PAD.right;
  const ih = h - PAD.top - PAD.bottom;
  const every = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(iw / 70))));
  return (
    <g className="text-muted" aria-hidden>
      {ticks.map((v) => {
        const y = PAD.top + ih - (v / max) * ih;
        return (
          <g key={v}>
            <line x1={PAD.left} x2={w - PAD.right} y1={y} y2={y} stroke="currentColor" strokeOpacity={v === 0 ? 0.35 : 0.12} />
            <text x={PAD.left - 8} y={y} dy="0.32em" textAnchor="end" className="fill-current text-[11px] tabular-nums">
              {fmt(v, unit, true)}
            </text>
          </g>
        );
      })}
      {days.map((d, i) =>
        i % every === 0 || i === days.length - 1 ? (
          i === days.length - 1 && i % every !== 0 && (days.length - 1) % every < every / 2 ? null : (
            <text key={d} x={PAD.left + (days.length === 1 ? iw / 2 : (i / (days.length - 1)) * iw)} y={h - 6} textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'} className="fill-current text-[11px]">
              {dayLabel(d)}
            </text>
          )
        ) : null,
      )}
    </g>
  );
}

function Tooltip({ x, y, w, children }: { x: number; y: number; w: number; children: React.ReactNode }) {
  const left = Math.min(Math.max(x + 12, 4), w - 196);
  return (
    <div className="pointer-events-none absolute z-10 w-[188px] rounded-xl border border-line bg-surface px-3 py-2 text-[12.5px] shadow-xl" style={{ left, top: Math.max(0, y - 10) }} role="status">
      {children}
    </div>
  );
}

/** A line chart, one or more series on one axis, with the earlier period as a dashed line behind it. */
export function LineChart({ series, unit, height = 200, label }: { series: ChartSeries[]; unit: Unit; height?: number; label: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const days = series[0]?.points.map((p) => p.d) || [];
  const max = niceMax(Math.max(0, ...series.flatMap((s) => [...s.points, ...(s.ghost || [])].map((p) => p.v))));
  const iw = Math.max(0, w - PAD.left - PAD.right);
  const ih = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (days.length <= 1 ? iw / 2 : (i / (days.length - 1)) * iw);
  const y = (v: number) => PAD.top + ih - (v / max) * ih;
  const path = (pts: Pt[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${c1(x(i))},${c1(y(p.v))}`).join('');
  const area = (pts: Pt[]) => (pts.length ? `${path(pts)}L${c1(x(pts.length - 1))},${c1(y(0))}L${c1(x(0))},${c1(y(0))}Z` : '');
  const onMove = (e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - PAD.left) / Math.max(1, iw)) * (days.length - 1));
    setHover(i >= 0 && i < days.length ? i : null);
  };
  return (
    <div ref={ref} className="relative" style={{ height }}>
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label={label} onPointerMove={onMove} onPointerLeave={() => setHover(null)} className="block touch-none">
          <Axis w={w} h={height} max={max} unit={unit} days={days} />
          {series.map((s) => s.ghost && <path key={s.key + 'g'} d={path(s.ghost.slice(-days.length))} fill="none" stroke="currentColor" className="text-muted" strokeOpacity={0.55} strokeWidth={1.5} strokeDasharray="3 4" />)}
          {series.length === 1 && <path d={area(series[0].points)} fill={series[0].color} fillOpacity={0.1} />}
          {series.map((s) => (
            <path key={s.key} d={path(s.points)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + ih} stroke="currentColor" className="text-muted" strokeOpacity={0.5} />
              {series.map((s) => (
                <circle key={s.key} cx={x(hover)} cy={y(s.points[hover]?.v || 0)} r={4.5} fill={s.color} stroke="var(--color-surface)" strokeWidth={2} />
              ))}
            </g>
          )}
        </svg>
      )}
      {hover !== null && (
        <Tooltip x={x(hover)} y={PAD.top} w={w}>
          <div className="mb-1 font-semibold">{dayLabel(days[hover], true)}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-muted">{s.label}</span>
              <span className="font-semibold tabular-nums">{fmt(s.points[hover]?.v || 0, unit)}</span>
            </div>
          ))}
          {series.length === 1 && series[0].ghost && (
            <div className="mt-1 flex items-center gap-2 text-muted">
              <span className="w-2.5 shrink-0 border-t-2 border-dashed border-current" aria-hidden />
              <span className="flex-1">Periode ervoor</span>
              <span className="tabular-nums">{fmt(series[0].ghost.slice(-days.length)[hover]?.v || 0, unit)}</span>
            </div>
          )}
        </Tooltip>
      )}
    </div>
  );
}

/** Bars per day; with two series they stand side by side (never stacked when they mean opposite things). */
export function BarChart({ series, unit, height = 200, label }: { series: ChartSeries[]; unit: Unit; height?: number; label: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const days = series[0]?.points.map((p) => p.d) || [];
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.v))));
  const iw = Math.max(0, w - PAD.left - PAD.right);
  const ih = height - PAD.top - PAD.bottom;
  const slot = days.length ? iw / days.length : 0;
  const gap = 2;
  const bw = Math.max(1, Math.min(18, (slot - 4) / series.length - gap));
  const y = (v: number) => PAD.top + ih - (v / max) * ih;
  const cx0 = (i: number) => PAD.left + slot * i + slot / 2;
  // Axis labels sit at the centre of the first and last bar, like the line chart's points.
  const axisW = w;
  return (
    <div ref={ref} className="relative" style={{ height }}>
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label={label} onPointerLeave={() => setHover(null)} className="block touch-none">
          <Axis w={axisW} h={height} max={max} unit={unit} days={[]} />
          {days.map((d, i) => {
            const every = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(iw / 70))));
            return i % every === 0 ? (
              <text key={d} x={cx0(i)} y={height - 6} textAnchor="middle" className="fill-current text-[11px] text-muted" aria-hidden>
                {dayLabel(d)}
              </text>
            ) : null;
          })}
          {days.map((d, i) => (
            <g key={d} onPointerEnter={() => setHover(i)}>
              {/* The hit target is the whole day, taller and wider than the bars. */}
              <rect x={PAD.left + slot * i} y={PAD.top} width={slot} height={ih} fill="transparent" />
              {hover === i && <rect x={PAD.left + slot * i} y={PAD.top} width={slot} height={ih} fill="currentColor" className="text-fg" fillOpacity={0.05} />}
              {series.map((s, k) => {
                const v = s.points[i]?.v || 0;
                if (v <= 0) return null;
                const top = y(v);
                const hh = Math.max(1.5, PAD.top + ih - top);
                const x = cx0(i) - (series.length * (bw + gap) - gap) / 2 + k * (bw + gap);
                const r = Math.min(4, bw / 2, hh);
                return <path key={s.key} d={`M${x},${PAD.top + ih}V${PAD.top + ih - hh + r}Q${x},${PAD.top + ih - hh} ${x + r},${PAD.top + ih - hh}H${x + bw - r}Q${x + bw},${PAD.top + ih - hh} ${x + bw},${PAD.top + ih - hh + r}V${PAD.top + ih}Z`} fill={s.color} />;
              })}
            </g>
          ))}
        </svg>
      )}
      {hover !== null && (
        <Tooltip x={cx0(hover)} y={PAD.top} w={w}>
          <div className="mb-1 font-semibold">{dayLabel(days[hover], true)}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-sm" style={{ background: s.color }} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-muted">{s.label}</span>
              <span className="font-semibold tabular-nums">{fmt(s.points[hover]?.v || 0, unit)}</span>
            </div>
          ))}
        </Tooltip>
      )}
    </div>
  );
}

/** A small line for a number tile: no axis, no hover; the tile says the number. */
export function Spark({ points, color, className }: { points: Pt[]; color: string; className?: string }) {
  const w = 120;
  const h = 32;
  const max = Math.max(1e-9, ...points.map((p) => p.v));
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${c1((i / Math.max(1, points.length - 1)) * w)},${c1(h - 2 - (p.v / max) * (h - 4))}`).join('');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={cx('h-8 w-full', className)} aria-hidden>
      <path d={d} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/** Legend for two or more series: always there, never colour alone. */
export function Legend({ items }: { items: { label: string; color?: string; dashed?: boolean }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          {i.dashed ? <span className="w-3 border-t-2 border-dashed border-current" aria-hidden /> : <span className="size-2.5 rounded-sm" style={{ background: i.color }} aria-hidden />}
          {i.label}
        </span>
      ))}
    </div>
  );
}

export function useTicker(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}
