/**
 * Pure helpers shared by the adapter builders.
 * Aggregation math is ported from evidence_adapter_v3.js; the one deliberate
 * change is that EVERY cube (sell, buy and fees) is filtered by an explicit
 * MonthRange — the legacy adapter summed fees without a month filter.
 * See tests/adapter.parity.test.ts for what is expected to match the legacy.
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
} from './types';
import { inRange, type MonthRange } from './period';

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

/**
 * Latest month inside the range (and the one before it, which may fall outside
 * the range — it is a month-over-month reference, not a period metric).
 */
export function selectPeriod<T>(
  monthlyDict: Record<string, T> | null,
  range: MonthRange,
): { current: T | null; prior: T | null } {
  if (!monthlyDict) return { current: null, prior: null };
  const keys = Object.keys(monthlyDict).sort();
  const inside = keys.filter((k) => inRange(k, range));
  const ck = inside.length ? inside[inside.length - 1] : null;
  const pk = ck ? keys[keys.indexOf(ck) - 1] ?? null : null;
  return {
    current: ck ? monthlyDict[ck] : null,
    prior: pk ? monthlyDict[pk] : null,
  };
}

/* ── Cube aggregation ─────────────────────────────────────────────────── */

interface MonthRow { month?: string }

/**
 * Rule 6: online = eCommerce + K2K + API. The sell cube mixes two label
 * generations ('eCommerce'/'K2K'/'API' up to 2025-07, 'Online' afterwards);
 * both are online. The legacy adapter only recognized 'Online'.
 */
const ONLINE_CHANNELS: ReadonlySet<string> = new Set(['Online', 'eCommerce', 'K2K', 'API']);
export function isOnlineChannel(channel: string | undefined): boolean {
  return !!channel && ONLINE_CHANNELS.has(channel);
}

export function uniqueMonths(rows: MonthRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) if (r.month) set.add(r.month);
  return [...set].sort();
}

/** Rows whose month falls inside the range (inclusive). */
export function filterByRange<R extends MonthRow>(rows: R[], range: MonthRange): R[] {
  if (!rows || !rows.length) return [];
  return rows.filter((r) => inRange(r.month, range));
}

export interface CubeAggregate {
  total: number;
  online: number;
  offline: number;
  months: string[];
}

export function aggregateSellCube(rows: SellCubeRow[], range: MonthRange): CubeAggregate | null {
  if (!rows || !rows.length) return null;
  const filtered = filterByRange(rows, range);
  if (!filtered.length) return null;

  let total = 0, online = 0, offline = 0;
  for (const r of filtered) {
    const v = num(r.sell_gmv) ?? 0;
    total += v;
    if (isOnlineChannel(r.channel)) online += v;
    else offline += v;
  }
  return { total, online, offline, months: uniqueMonths(filtered) };
}

export function aggregateBuyCube(rows: BuyCubeRow[], range: MonthRange): CubeAggregate | null {
  if (!rows || !rows.length) return null;
  const filtered = filterByRange(rows, range);
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
  rows: { month?: string; fee_channel?: string; fee_amount?: number | string }[],
  range: MonthRange,
): { total: number; byChannel: FeesByChannel; months: string[] } | null {
  if (!rows || !rows.length) return null;
  const filtered = filterByRange(rows, range);
  if (!filtered.length) return null;
  let total = 0;
  const byChannel: FeesByChannel = { ecom: 0, k2k: 0, api: 0, indirect: 0 };
  for (const r of filtered) {
    const v = num(r.fee_amount) ?? 0;
    total += v;
    const ch = (r.fee_channel ?? '').toLowerCase();
    if (ch === 'ecom') byChannel.ecom += v;
    else if (ch === 'k2k') byChannel.k2k += v;
    else if (ch === 'api') byChannel.api += v;
    else byChannel.indirect += v;
  }
  return { total, byChannel, months: uniqueMonths(filtered) };
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
    if (isOnlineChannel(r.channel)) byMonth[m].sell_online += v;
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

/** Sum one numeric field over the rows inside a range; null when no rows. */
export function sumRange<R extends MonthRow>(rows: R[], key: keyof R, range: MonthRange): number | null {
  const window = filterByRange(rows, range);
  if (!window.length) return null;
  let total = 0;
  for (const r of window) total += num(r[key]) ?? 0;
  return total;
}
