/**
 * Period model — every metric is computed over an explicit month range.
 *
 * Four periods are offered, all anchored on the last closed month of the
 * sell cube (`_meta.period_to`, e.g. 2026-08) so sell, buy and fees line up:
 *
 *   ytd        Jan of anchor year → anchor            (annualized: 12 / months)
 *   h1         Jan → Jun of the anchor year           (6 months)
 *   prev_year  Jan → Dec of the year before the anchor (12 months, factor 1)
 *   l12m       anchor-11 → anchor                     (12 months, factor 1)
 *
 * Each period carries its comparison range (the same range shifted one year)
 * so YoY deltas are always like-for-like.
 */

export type PeriodId = 'ytd' | 'h1' | 'prev_year' | 'l12m';

export interface MonthRange {
  /** inclusive, 'YYYY-MM' */
  from: string;
  /** inclusive, 'YYYY-MM' */
  to: string;
}

export interface Period extends MonthRange {
  id: PeriodId;
  label: string;
  /** Calendar months in the range (not months with data). */
  months: number;
  /** Same range one year earlier — the YoY baseline. */
  prior: MonthRange;
}

export const PERIOD_IDS: readonly PeriodId[] = ['ytd', 'h1', 'prev_year', 'l12m'];

export const DEFAULT_ANCHOR = '2026-08';

export function monthKey(year: number, month1to12: number): string {
  return `${year}-${String(month1to12).padStart(2, '0')}`;
}

export function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return monthKey(d.getUTCFullYear(), d.getUTCMonth() + 1);
}

export function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
}

export function shiftRange(r: MonthRange, deltaMonths: number): MonthRange {
  return { from: shiftMonth(r.from, deltaMonths), to: shiftMonth(r.to, deltaMonths) };
}

export function inRange(month: string | undefined, r: MonthRange): boolean {
  return !!month && month >= r.from && month <= r.to;
}

/** True when `bounds` (months present in a cube) fully contain the range. */
export function covers(bounds: MonthRange | null, r: MonthRange): boolean {
  return !!bounds && bounds.from <= r.from && bounds.to >= r.to;
}

/** Build the four periods for a given anchor month ('YYYY-MM'). */
export function buildPeriods(anchor: string = DEFAULT_ANCHOR): Record<PeriodId, Period> {
  const year = Number(anchor.slice(0, 4));

  const ytd: MonthRange = { from: monthKey(year, 1), to: anchor };
  const h1: MonthRange = { from: monthKey(year, 1), to: monthKey(year, 6) };
  const prevYear: MonthRange = { from: monthKey(year - 1, 1), to: monthKey(year - 1, 12) };
  const l12m: MonthRange = { from: shiftMonth(anchor, -11), to: anchor };

  const make = (id: PeriodId, label: string, r: MonthRange): Period => ({
    id,
    label,
    ...r,
    months: monthsBetween(r.from, r.to),
    prior: shiftRange(r, -12),
  });

  return {
    ytd: make('ytd', `YTD ${year}`, ytd),
    h1: make('h1', `1er semestre ${year}`, h1),
    prev_year: make('prev_year', `Todo ${year - 1}`, prevYear),
    l12m: make('l12m', 'Last 12 months', l12m),
  };
}

/** Resolve a period id (or an already-built Period) against an anchor. */
export function resolvePeriod(p: PeriodId | Period, anchor: string = DEFAULT_ANCHOR): Period {
  return typeof p === 'string' ? buildPeriods(anchor)[p] : p;
}
