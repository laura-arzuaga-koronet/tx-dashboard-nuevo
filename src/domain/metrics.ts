/**
 * Row-level derived metrics: $ at stake, diagnosis text, opportunity flags,
 * intervention count, GMV band, sparkline series. Pure functions over AccountEvidence.
 */
import type { AccountEvidence, LooseRecord } from '../data/adapter/types';
import type { SfdcOppTotals } from '../data/sfdc/openOpportunities';
import { evValue, fmtMoney, fmtPct } from './format';

/* ── GMV bands (shared by the filter and the tier matrix) ────────────── */
export const GMV_BANDS = [
  { label: '>=10M', test: (g: number) => g >= 10_000_000 },
  { label: '$2-10M', test: (g: number) => g >= 2_000_000 && g < 10_000_000 },
  { label: '$500K-2M', test: (g: number) => g >= 500_000 && g < 2_000_000 },
  { label: '<$500K', test: (g: number) => g > 0 && g < 500_000 },
] as const;

export type GmvBandLabel = (typeof GMV_BANDS)[number]['label'];

export function getGmvBand(ev: AccountEvidence | null): GmvBandLabel | null {
  const gmv = ev?.potential?.gmv_reference?.value ?? 0;
  for (const band of GMV_BANDS) if (band.test(gmv)) return band.label;
  return null;
}

/* ── $ at stake ──────────────────────────────────────────────────────── */
export interface AtStake {
  amount: number;
  source: 'sfdc' | 'scenario';
}

/** Fallback take rate when the account has none (0.2%). */
const DEFAULT_TAKE_RATE = 0.002;
/** Directional scenario: 10% of offline GMV shifts online. */
const SCENARIO_SHIFT = 0.1;

/**
 * Primary: sum of open SFDC opportunity amounts for the account.
 * Fallback: directional scenario (offline × 10% shift × take rate × 12 months).
 */
export function calcAtStake(ev: AccountEvidence | null, sfdcTotals: SfdcOppTotals): AtStake | null {
  if (!ev) return null;
  const sfdcId = ev.identity?.sfdc_id ?? null;
  if (sfdcId && sfdcTotals[sfdcId] != null && sfdcTotals[sfdcId] > 0) {
    return { amount: sfdcTotals[sfdcId], source: 'sfdc' };
  }
  const p = ev.potential;
  if (!p) return null;
  const offlineSell = evValue(p.sell_offline_ytd);
  if (offlineSell == null) return null;
  const takeRate = evValue(p.take_rate);
  const rate = takeRate != null && takeRate > 0 ? takeRate / 100 : DEFAULT_TAKE_RATE;
  const scenario = offlineSell * SCENARIO_SHIFT * rate * 12;
  return scenario > 0 ? { amount: scenario, source: 'scenario' } : null;
}

/* ── Config helpers ──────────────────────────────────────────────────── */
function configRaw(ev: AccountEvidence): LooseRecord | null {
  return ev.list?.config?.value?.raw ?? null;
}

function bunchesReality(ev: AccountEvidence): boolean | null {
  const br = ev.list?.config?.value?.bunches_reality;
  const v = br?.actually_sells_bunches_ecom;
  return typeof v === 'boolean' ? v : null;
}

/** Bunches flag from config, following the legacy precedence order. */
function configBunchFlag(raw: LooseRecord | null): unknown {
  if (!raw) return null;
  if (raw.is_on_hand_inventory_units != null) return raw.is_on_hand_inventory_units;
  if (raw.sell_in_bunches != null) return raw.sell_in_bunches;
  if (raw.bunches != null) return raw.bunches;
  return null;
}

function configMaxAge(raw: LooseRecord | null): number | null {
  if (!raw) return null;
  const v = raw.ecommerce_max_age ?? raw.max_age_sell ?? raw.MaxAge ?? null;
  if (v == null) return null;
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? null : n;
}

/* ── Diagnosis one-liner ─────────────────────────────────────────────── */
export interface DiagnosisPart {
  text: string;
  strong?: boolean;
  /** A complete fallback sentence — rendered as-is, without joining punctuation. */
  fallback?: boolean;
}

export function buildDiagnosis(ev: AccountEvidence | null): DiagnosisPart[] {
  if (!ev) return [{ text: 'No data available.', fallback: true }];
  const p = ev.potential;
  if (!p) return [{ text: 'Data loading…', fallback: true }];

  const parts: DiagnosisPart[] = [];
  const onlinePct = evValue(p.sell_online_pct);
  const offlineAmt = evValue(p.sell_offline_ytd);
  const fees = evValue(p.fees_ytd_2026);

  if (offlineAmt != null && offlineAmt > 0) {
    parts.push({ text: `${fmtMoney(offlineAmt, true)} offline at $0 fees`, strong: true });
  }
  if (onlinePct != null) {
    if (onlinePct < 10) parts.push({ text: `${fmtPct(onlinePct)} online — nearly all offline` });
    else if (onlinePct < 30) parts.push({ text: `${fmtPct(onlinePct)} online — majority offline` });
    else if (onlinePct > 60) parts.push({ text: `${fmtPct(onlinePct)} online — digital-first` });
    else parts.push({ text: `${fmtPct(onlinePct)} online` });
  }

  const offBuyers = ev.sell?.buyers_table?.value?.offline_buyers ?? null;
  if (offBuyers != null && offBuyers > 0) {
    parts.push({ text: `${offBuyers.toLocaleString()} offline buyers not yet invited` });
  }

  const cfg = ev.list?.config?.value;
  if (cfg) {
    const reality = bunchesReality(ev);
    const raw = cfg.raw;
    const flag = raw ? (raw.is_on_hand_inventory_units ?? raw.sell_in_bunches) : null;
    if (reality !== true && !flag) parts.push({ text: 'Bunches OFF — retail TAM blocked' });
  }

  if (!parts.length) {
    if (fees != null && fees > 0) return [{ text: `Fees: ${fmtMoney(fees, true)} YTD`, fallback: true }];
    return [{ text: 'Account data loaded.', fallback: true }];
  }
  return parts;
}

/* ── Intervention count (shown next to $ at stake) ───────────────────── */
export function countInterventions(ev: AccountEvidence): number {
  let count = 0;
  const p = ev.potential;
  if (p && (evValue(p.buy_offline_ytd) ?? 0) > 0) count++;
  const raw = configRaw(ev);
  if (raw) {
    const bunches = raw.sell_in_bunches ?? raw.bunches;
    if (bunches === false || bunches === 'false' || bunches === 0) count++;
    const maxAge = raw.max_age_sell ?? raw.MaxAge;
    if (maxAge != null && Number(maxAge) < 30) count++;
  }
  const bt = ev.sell?.buyers_table?.value;
  if (bt && (bt.offline_buyers ?? 0) > 0) count++;
  return count;
}

/* ── Opportunity flags (drive the BUY / LIST / SELL / CONFIG / Declining tabs) ── */
export interface OpportunityFlags {
  hasBuy: boolean;
  hasList: boolean;
  hasSell: boolean;
  hasConfig: boolean;
  isDeclining: boolean;
}

export const NO_FLAGS: OpportunityFlags = { hasBuy: false, hasList: false, hasSell: false, hasConfig: false, isDeclining: false };

export function detectOpportunityFlags(ev: AccountEvidence | null): OpportunityFlags {
  if (!ev) return NO_FLAGS;
  const p = ev.potential;

  // BUY: offline buy GMV > 0 OR K2K leakage cost > $10K OR dormant K2K > 0
  const buyOffline = p ? evValue(p.buy_offline_ytd) : null;
  const leakageCost = (ev.buy?.leakage?.value?.leakage_cost as number | undefined) ?? null;
  const dormantK2k = (ev.buy?.k2k_lifecycle?.value?.dormant as number | undefined) ?? null;
  const hasBuy = (buyOffline != null && buyOffline > 0)
    || (leakageCost != null && leakageCost > 10_000)
    || (dormantK2k != null && dormantK2k > 0);

  // LIST: MaxAge < 30 OR bunches OFF OR variety gap > 100
  const raw = configRaw(ev);
  const maxAge = configMaxAge(raw);
  const maxAgeBad = maxAge != null && maxAge < 30;
  const maxAgeBlocking = maxAge != null && maxAge < 10;

  const reality = bunchesReality(ev);
  const flag = configBunchFlag(raw);
  const bunchesOff = reality === false || (reality == null && (flag === false || flag === 0));

  const vf = ev.list?.variety_freshness?.value;
  const onlineVar = vf?.online ? vf.online.total_varieties || 0 : null;
  const offlineVar = vf?.offline ? vf.offline.total_varieties || 0 : null;
  const varietyGap = onlineVar != null && offlineVar != null ? Math.max(0, offlineVar - onlineVar) : null;
  const hasList = maxAgeBad || bunchesOff || (varietyGap != null && varietyGap > 100);

  // SELL: offline buyers > 0 OR declining sell YoY < -5%
  const offlineBuyers = ev.sell?.buyers_table?.value?.offline_buyers ?? null;
  const yoy = p?.sell_yoy_delta ?? null;
  const yoyPct = yoy ? yoy.pct : null;
  const hasSell = (offlineBuyers != null && offlineBuyers > 0) || (yoyPct != null && yoyPct < -5);

  // CONFIG (blocking): MaxAge < 10 OR 0TX post-go-live
  const implStage = ev.identity?.impl_stage ?? null;
  const koronetSell = p ? evValue(p.koronet_sell_ytd) : null;
  const hasPostGoLiveZeroTx = implStage != null && (koronetSell == null || koronetSell < 500);
  const hasConfig = maxAgeBlocking || hasPostGoLiveZeroTx;

  // Declining: sell YoY < 0
  const isDeclining = yoy ? (typeof yoy.pct === 'number' ? yoy.pct < 0 : yoy.direction === 'down') : false;

  return { hasBuy, hasList, hasSell, hasConfig, isDeclining };
}

/* ── Sparkline (last 4 months of sell GMV) ───────────────────────────── */
export interface SparkBar {
  heightPct: number;
  trend: 'up' | 'down' | 'flat';
}

/**
 * NOTE: the legacy dashboard read `m.sell_total`, a field that does not exist on
 * the monthly series (it is `sell_gmv`), so every sparkline rendered flat. Fixed here.
 */
export function buildSparkline(ev: AccountEvidence | null): SparkBar[] {
  const series = ev?.sell?.monthly_series?.value;
  const placeholder: SparkBar[] = Array.from({ length: 4 }, () => ({ heightPct: 40, trend: 'flat' }));
  if (!series || !series.length) return placeholder;

  const last4 = [...series].sort((a, b) => (a.month < b.month ? -1 : 1)).slice(-4);
  if (last4.length < 2) return placeholder;

  const vals = last4.map((m) => m.sell_gmv || 0);
  const max = Math.max(...vals);
  return vals.map((v, i) => {
    let trend: SparkBar['trend'] = 'flat';
    if (i > 0) {
      const prev = vals[i - 1];
      if (v > prev * 1.02) trend = 'up';
      else if (v < prev * 0.98) trend = 'down';
    }
    return { heightPct: max > 0 ? Math.max(15, Math.round((v / max) * 100)) : 40, trend };
  });
}

/** Month-over-month % for the trend label; falls back to the monthly series. */
export function sellMomPct(ev: AccountEvidence | null): number | null {
  const mom = ev?.potential?.sell_mom_delta;
  if (mom && mom.pct != null) return mom.pct;
  const series = ev?.sell?.monthly_series?.value;
  if (!series || series.length < 2) return null;
  const sorted = [...series].sort((a, b) => (a.month < b.month ? -1 : 1));
  const prev = sorted[sorted.length - 2].sell_gmv || 0;
  const curr = sorted[sorted.length - 1].sell_gmv || 0;
  return prev === 0 ? null : ((curr - prev) / prev) * 100;
}
