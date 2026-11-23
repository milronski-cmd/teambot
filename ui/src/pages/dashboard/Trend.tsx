import { useId, useMemo, useState } from 'react';
import { t } from '../../lib/i18n';

/**
 * The course of a number on the dashboard (4.17.0). Seen with a real team: most tiles had one to four points, and a
 * line through two points was drawn as a slope over the whole width, spread by their order, not by their time: "lijkt
 * nergens op". Now a line is drawn only for a real course (at least MIN_POINTS measurements over at least MIN_DAYS
 * days), placed by time, in a quiet colour with the last point marked; pointing at it (mouse or arrow keys) shows the
 * value and the date. Without such a course the same space says plainly when it was measured.
 */

export type Point = { v: number; at: string };

export const MIN_POINTS = 4;
export const MIN_DAYS = 2;
const DAY = 86_400_000;

/** The points of a number in time order, one per moment; with `course` whether they make a real course. */
export function courseOf(points: Point[] | undefined): { points: Point[]; course: boolean } {
  const ps = (points || [])
    .map((p) => ({ v: Number(p.v), at: p.at, t: new Date(p.at).getTime() }))
    .filter((p) => Number.isFinite(p.v) && Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  const span = ps.length ? ps[ps.length - 1].t - ps[0].t : 0;
  return { points: ps.map(({ v, at }) => ({ v, at })), course: ps.length >= MIN_POINTS && span >= MIN_DAYS * DAY };
}

const num = (v: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(v);
const dayOf = (at: string) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const momentOf = (at: string) => new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** The line itself: by time, last point marked, a readout when pointed at. Height includes nothing else. */
export function TrendLine({ points, height = 44 }: { points: Point[]; height?: number }) {
  const [at, setAt] = useState<number | null>(null);
  const id = useId();
  const W = 300;
  const H = height;
  const geo = useMemo(() => {
    const ts = points.map((p) => new Date(p.at).getTime());
    const t0 = ts[0];
    const t1 = ts[ts.length - 1];
    const vs = points.map((p) => p.v);
    const lo = Math.min(...vs);
    const hi = Math.max(...vs);
    const pad = 5;
    const x = (t: number) => (t1 === t0 ? W / 2 : pad + ((t - t0) / (t1 - t0)) * (W - 2 * pad));
    const y = (v: number) => (hi === lo ? H / 2 : H - pad - ((v - lo) / (hi - lo)) * (H - 2 * pad));
    const xy = points.map((p, i) => [x(ts[i]), y(p.v)] as const);
    const r1 = (n: number) => Math.round(n * 10) / 10;
    return { xy, d: xy.map(([px, py], i) => `${i ? 'L' : 'M'}${r1(px)},${r1(py)}`).join(' ') };
  }, [points, H]);
  const last = geo.xy[geo.xy.length - 1];
  const nearest = (clientX: number, box: DOMRect) => {
    const px = ((clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < geo.xy.length; i++) if (Math.abs(geo.xy[i][0] - px) <= Math.abs(geo.xy[best][0] - px)) best = i;
    return best;
  };
  const shown = at === null ? null : points[at];
  return (
    <div className="relative" style={{ height: H }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block h-full w-full cursor-crosshair overflow-visible outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-accent"
        role="img"
        aria-label={t('Verloop: {0} metingen van {1} tot {2}', points.length, dayOf(points[0].at), dayOf(points[points.length - 1].at))}
        aria-describedby={shown ? id : undefined}
        tabIndex={0}
        onPointerMove={(e) => setAt(nearest(e.clientX, e.currentTarget.getBoundingClientRect()))}
        onPointerLeave={() => setAt(null)}
        onFocus={() => setAt(points.length - 1)}
        onBlur={() => setAt(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') (e.preventDefault(), setAt((i) => Math.max(0, (i ?? points.length - 1) - 1)));
          if (e.key === 'ArrowRight') (e.preventDefault(), setAt((i) => Math.min(points.length - 1, (i ?? 0) + 1)));
        }}
        data-testid="dashboard-trend-line"
      >
        <path d={geo.d} fill="none" stroke="currentColor" className="text-muted/70" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {at !== null && <line x1={geo.xy[at][0]} x2={geo.xy[at][0]} y1={0} y2={H} stroke="currentColor" className="text-fg/30" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
      </svg>
      {/* The points as round marks (an SVG stretched to the width would make them ovals). */}
      <span className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-surface" style={{ left: `${(last[0] / W) * 100}%`, top: last[1] }} aria-hidden />
      {at !== null && at !== points.length - 1 && <span className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg ring-2 ring-surface" style={{ left: `${(geo.xy[at][0] / W) * 100}%`, top: geo.xy[at][1] }} aria-hidden />}
      {shown && (
        <div id={id} role="status" className="pointer-events-none absolute bottom-full z-10 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-lg bg-fg px-2 py-1 text-[12px] text-canvas shadow-lg" style={{ left: `${Math.min(88, Math.max(12, (geo.xy[at!][0] / W) * 100))}%` }}>
          <span className="font-semibold">{num(shown.v)}</span>
          <span className="opacity-75"> · {momentOf(shown.at)}</span>
        </div>
      )}
    </div>
  );
}

/** One line under the number: the change since the first measurement of the course, or when it was measured. */
export function trendNote(points: Point[], course: boolean): string {
  if (!points.length) return '';
  const first = points[0];
  const last = points[points.length - 1];
  if (course) {
    const diff = last.v - first.v;
    return diff === 0 ? t('Gelijk gebleven sinds {0}', dayOf(first.at)) : t('{0} sinds {1}', `${diff > 0 ? '+' : ''}${num(diff)}`, dayOf(first.at));
  }
  if (points.length === 1) return t('Eerste meting op {0}', dayOf(first.at));
  const prev = points[points.length - 2];
  return t('Vorige meting: {0} op {1}', num(prev.v), dayOf(prev.at));
}

/** "6 van 9", "6 van 8 (2 afgekeurd)": the part and the whole, or null. */
export function ratioOf(value: unknown): { part: number; whole: number } | null {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s+(?:van|of|uit)\s+(\d+(?:[.,]\d+)?)/i.exec(String(value ?? ''));
  if (!m) return null;
  const part = Number(m[1].replace(',', '.'));
  const whole = Number(m[2].replace(',', '.'));
  return whole > 0 && part >= 0 && part <= whole ? { part, whole } : null;
}

/** A part of a whole as a thin bar: what is there in the accent, the rest in a lighter step. */
export function RatioBar({ part, whole }: { part: number; whole: number }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-accent/15" role="meter" aria-valuemin={0} aria-valuemax={whole} aria-valuenow={part} aria-label={t('{0} van {1}', num(part), num(whole))} data-testid="dashboard-ratio">
      <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, (part / whole) * 100)}%` }} />
    </div>
  );
}
