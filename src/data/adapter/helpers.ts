/**
 * Pure helpers shared by the adapter builders.
 * Logic ported 1:1 from evidence_adapter_v3.js — do not "improve" the math here
 * without updating the parity tests in tests/adapter.parity.test.ts.
 */
import type {
  BuyCubeRow,
  Delta,
  Ev,
  EvidenceState,
  FeesByChannel,
  MomDelta,
  MonthlyBuyTotal,
  MonthlySellTotal,
  SellCubeRow,
  Timeframe,
} from './types';

/** Stringify an id (company_id comes as number in some files, string in others). */
export function sid(id: string | number | null | undefined): string | null {
  return id == null ? null : String(id);
}

/** Parse a numeric value that may arrive as string; null when missing/NaN. */
export function num(val: unknown): number | null {
  if (val == null) return null;
  const n = parseFloat(val as string);
  return Number.isNaN(n) ? null : n;
}

export function ev<T>(value: T | null, state?: EvidenceState, note?: string | null): Ev<T> {
  return { value, ev: state ?? 'gap', note: note ?? null };
}

export function delta(current: number | null, prior: number | null): Delta | null {
  if (current == null || prior == null || prior === 0) return null;
  const diff = current - prior;
  return {
    value: diff,
    pct: (diff / prior) * 100,
    direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
  };
}

/** Most recent key of a { 'YYYY-MM': ... } dict; offset 0 = latest, 1 = prior… */
export function latestMonthKey(monthlyDict: Record<string, unknown> | null | undefined, offset = 0): string | null {
  if (!monthlyDict || typeof monthlyDict !== 'object') return null;
  const keys = Object.keys(monthlyDict).sort();
  const idx = keys.length - 1 - offset;
  return idx >= 0 ? keys[idx] : null;
}

export function selectPeriod<T>(
  monthlyDict: Record<string, T> | null,
  timeframe: Timeframe,
): { current: T | null; prior: T | null } {
  if (!monthlyDict) return { current: null, prior: null };
  const base = timeframe === 'prior_month' ? 1 : 0;
  const ck = latestMonthKey(monthlyDict, base);
  const pk = latestMonthKey(monthlyDict, base + 1);
  return {
    current: ck ? monthlyDict[ck] : null,
    prior: pk ? monthlyDict[pk] : null,
  };
}

/* ── Cube aggregation ─────────────────────────────────────────────────── */

interface MonthRow { month?: string }

export function uniqueMonths(rows: MonthRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) if (r.month) set.add(r.month);
  return [...set].sort();
}

/** Rows belonging to the requested timeframe. YTD is hard-wired to calendar 2026 (as in V3). */
export function filterByTimeframe<R extends MonthRow>(rows: R[], timeframe: Timeframe | undefined): R[] {
  if (!rows || !rows.length) return [];
  const allMonths = uniqueMonths(rows);

  if (timeframe === 'ytd' || !timeframe) {
    return rows.filter((r) => !!r.month && r.month >= '2026-01' && r.month <= '2026-12');
  }
  if (timeframe === 'current_month') {
    const latest = allMonths[allMonths.length - 1];
    return latest ? rows.filter((r) => r.month === latest) : [];
  }
  if (timeframe === 'prior_month') {
    const prior = allMonths.length >= 2 ? allMonths[allMonths.length - 2] : null;
    return prior ? rows.filter((r) => r.month === prior) : [];
  }
  if (timeframe === 'l12m') return rows;

  // default: ytd
  return rows.filter((r) => !!r.month && r.month >= '2026-01');
}

export interface CubeAggregate {
  total: number;
  online: number;
  offline: number;
  months: string[];
}

export function aggregateSellCube(rows: SellCubeRow[], timeframe: Timeframe): CubeAggregate | null {
  if (!rows || !rows.length) return null;
  const filtered = filterByTimeframe(rows, timeframe);
  if (!filtered.length) return null;

  let total = 0, online = 0, offline = 0;
  for (const r of filtered) {
    const v = num(r.sell_gmv) ?? 0;
    total += v;
    if (r.channel === 'Online') online += v;
    else offline += v;
  }
  return { total, online, offline, months: uniqueMonths(filtered) };
}

export function aggregateBuyCube(rows: BuyCubeRow[], timeframe: Timeframe): CubeAggregate | null {
  if (!rows || !rows.length) return null;
  const filtered = filterByTimeframe(rows, timeframe);
  if (!filtered.length) return null;

  let total = 0, online = 0, offline = 0;
  for (const r of filtered) {
    total += num(r.buy_gmv) ?? 0;
    online += num(r.buy_online) ?? 0;
    offline += num(r.buy_offline) ?? 0;
  }
  return { total, online, offline, months: uniqueMonths(filtered) };
}

export function aggregateFeesCube(
  rows: { fee_channel?: string; fee_amount?: number | string }[],
): { total: number; byChannel: FeesByChannel } | null {
  if (!rows || !rows.length) return null;
  let total = 0;
  const byChannel: FeesByChannel = { ecom: 0, k2k: 0, api: 0, indirect: 0 };
  for (const r of rows) {
    const v = num(r.fee_amount) ?? 0;
    total += v;
    const ch = (r.fee_channel ?? '').toLowerCase();
    if (ch === 'ecom') byChannel.ecom += v;
    else if (ch === 'k2k') byChannel.k2k += v;
    else if (ch === 'api') byChannel.api += v;
    else byChannel.indirect += v;
  }
  return { total, byChannel };
}

export function sellMonthlyTotals(rows: SellCubeRow[]): MonthlySellTotal[] {
  if (!rows || !rows.length) return [];
  const byMonth: Record<string, MonthlySellTotal> = {};
  for (const r of rows) {
    const m = r.month;
    if (!m) continue;
    byMonth[m] ??= { month: m, sell_gmv: 0, sell_online: 0, sell_offline: 0 };
    const v = num(r.sell_gmv) ?? 0;
    byMonth[m].sell_gmv += v;
    if (r.channel === 'Online') byMonth[m].sell_online += v;
    else byMonth[m].sell_offline += v;
  }
  return Object.keys(byMonth).sort().map((k) => byMonth[k]);
}

export function buyMonthlyTotals(rows: BuyCubeRow[]): MonthlyBuyTotal[] {
  if (!rows || !rows.length) return [];
  const byMonth: Record<string, MonthlyBuyTotal> = {};
  for (const r of rows) {
    const m = r.month;
    if (!m) continue;
    byMonth[m] ??= { month: m, buy_gmv: 0, buy_online: 0, buy_offline: 0 };
    byMonth[m].buy_gmv += num(r.buy_gmv) ?? 0;
    byMonth[m].buy_online += num(r.buy_online) ?? 0;
    byMonth[m].buy_offline += num(r.buy_offline) ?? 0;
  }
  return Object.keys(byMonth).sort().map((k) => byMonth[k]);
}

/** Month-over-month delta from a sorted monthly totals array. */
export function computeMomDelta<T extends { month: string }>(
  monthlyTotals: T[],
  valueKey: keyof T,
): MomDelta | null {
  if (!monthlyTotals || monthlyTotals.length < 2) return null;
  const current = monthlyTotals[monthlyTotals.length - 1];
  const prior = monthlyTotals[monthlyTotals.length - 2];
  const currVal = num(current[valueKey]) ?? 0;
  const priorVal = num(prior[valueKey]) ?? 0;
  if (priorVal === 0) return null;
  return {
    pct: ((currVal - priorVal) / priorVal) * 100,
    absolute: currVal - priorVal,
    current_month: current.month,
    prior_month: prior.month,
  };
}

/** Sum a cube's rows for the Jan–Jul 2025 window used as the prior-year YTD baseline. */
export function sumPriorYtd<R extends MonthRow>(rows: R[], key: keyof R): number | null {
  const window = rows.filter((r) => !!r.month && r.month >= '2025-01' && r.month <= '2025-07');
  if (!window.length) return null;
  let total = 0;
  for (const r of window) total += num(r[key]) ?? 0;
  return total;
}
