/**
 * Period selector → adapter timeframe token.
 * Options are derived from the cube metadata (`period_to`) so the labels
 * follow the data instead of being hardcoded to "Jul 2026".
 */
import type { CubeMeta, Timeframe } from '../data/adapter/types';
import { fmtMonthKey } from './format';

export type PeriodId = 'ytd' | 'current_month' | 'prior_month' | 'q2' | 'h1';

export interface PeriodOption {
  id: PeriodId;
  label: string;
  timeframe: Timeframe;
}

/** Period id → adapter timeframe token (static, independent of data). */
export const PERIOD_TIMEFRAME: Record<PeriodId, Timeframe> = {
  ytd: 'ytd',
  current_month: 'current_month',
  prior_month: 'prior_month',
  q2: 'prior_quarter',
  h1: 'ytd',
};

/** Fallback when no cube metadata is available. */
const FALLBACK_PERIOD_TO = '2026-07';

function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function buildPeriodOptions(sellMeta: CubeMeta | null): PeriodOption[] {
  const periodTo = typeof sellMeta?.period_to === 'string' ? sellMeta.period_to : FALLBACK_PERIOD_TO;
  const year = periodTo.slice(0, 4);
  const prior = shiftMonth(periodTo, -1);
  return [
    { id: 'ytd', label: `YTD ${year}`, timeframe: PERIOD_TIMEFRAME.ytd },
    { id: 'current_month', label: fmtMonthKey(periodTo), timeframe: PERIOD_TIMEFRAME.current_month },
    { id: 'prior_month', label: fmtMonthKey(prior), timeframe: PERIOD_TIMEFRAME.prior_month },
    { id: 'q2', label: `Q2 ${year}`, timeframe: PERIOD_TIMEFRAME.q2 },
    { id: 'h1', label: `H1 ${year}`, timeframe: PERIOD_TIMEFRAME.h1 },
  ];
}

/** Number of months covered by the YTD window of the sell cube (replaces the hardcoded `YTD_MONTHS = 7`). */
export function ytdMonthCount(sellMeta: CubeMeta | null): number {
  const periodTo = typeof sellMeta?.period_to === 'string' ? sellMeta.period_to : FALLBACK_PERIOD_TO;
  return Number(periodTo.slice(5, 7)) || 7;
}
