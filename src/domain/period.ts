/**
 * UI-facing period helpers. The Period model itself lives in the adapter
 * (src/data/adapter/period.ts) because the adapter computes with it.
 */
import type { Period, PeriodId } from '../data/adapter/period';
import { PERIOD_IDS } from '../data/adapter/period';
import { fmtMonthKey } from './format';

export type { Period, PeriodId };
export { PERIOD_IDS };

export const DEFAULT_PERIOD_ID: PeriodId = 'ytd';

/** "Jan 2026 – Jul 2026 · 7 months" */
export function describeRange(p: Period): string {
  return `${fmtMonthKey(p.from)} – ${fmtMonthKey(p.to)} · ${p.months} months`;
}

/** Short label for the YoY baseline, e.g. "vs Jan–Jul 2025". */
export function describePrior(p: Period): string {
  const from = fmtMonthKey(p.prior.from);
  const to = fmtMonthKey(p.prior.to);
  return p.prior.from === p.prior.to ? `vs ${from}` : `vs ${from} – ${to}`;
}
