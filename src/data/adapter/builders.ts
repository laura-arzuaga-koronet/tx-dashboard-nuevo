/**
 * Section builders — turn the store's raw indexes into the normalized
 * `AccountEvidence` sections. Business rules (Piso de red, penetration,
 * 45% buy estimate, take rate threshold…) live here and ONLY here.
 */
import {
  aggregateBuyCube,
  aggregateFeesCube,
  aggregateSellCube,
  buyMonthlyTotals,
  computeMomDelta,
  delta,
  ev,
  num,
  selectPeriod,
  sellMonthlyTotals,
  sid,
  sumPriorYtd,
} from './helpers';
import { store } from './store';
import type {
  Benchmarks,
  BucketSummary,
  BuyDomain,
  BuyersTable,
  ConfigEvidence,
  EvidenceState,
  Freshness,
  FreshnessGroup,
  GmvReference,
  Identity,
  ListDomain,
  LooseRecord,
  MonthlyBuyTotal,
  Potential,
  SellDomain,
  SourcingTable,
  TemporalRow,
  Timeframe,
  VarietyFreshness,
} from './types';

/** Ratio of buy GMV to sell GMV for wholesalers (Christine measured). */
export const BUY_TO_SELL_RATIO = 0.45;
/** Minimum YTD sell for a take rate to be meaningful. */
export const TAKE_RATE_MIN_SELL = 10_000;

const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

/* ── IDENTITY ─────────────────────────────────────────────────────────── */
export function buildIdentity(companyId: string): Identity | null {
  const rec = store.accountById[companyId];
  if (!rec) return null;
  return {
    company_id: rec.company_id != null ? sid(rec.company_id) : null,
    company_name: rec.company_name || null,
    account_class: rec.account_class || null,
    business_type: rec.business_type || null,
    segment: rec.segment || null,
    product_tier: rec.product_tier || null,
    sell_channel: rec.sell_channel || null,
    potential_tier: rec.potential_tier || null,
    impl_stage_display: rec.impl_stage_display || null,
    digital_pct_caveat: rec.digital_pct_caveat || null,
    has_active_pmt: rec.has_active_pmt || false,
    pmt_lead: rec.pmt_lead || null,
    pmt_status: rec.pmt_status || null,
    pmt_health: rec.pmt_health || null,
    priority_level: rec.priority_level || null,
    engagement_status: rec.engagement_status || null,
    komet_status: rec.komet_status || null,
    industry: rec.industry || null,
    sfdc_id: rec.sfdc_id || null,
    impl_stage: str(rec.impl_stage),
    impl_type: str(rec.impl_type),
    ct_id: str(rec.ct_id),
    sfdc_type: str(rec.sfdc_type),
    digital_pct: num(rec.digital_pct),
    has_eshop: rec.has_eshop || false,
    has_procurement: rec.has_procurement || false,
    in_christine_sheet: rec.in_christine_sheet || false,
    city: null,
    location: null,
    am_name: null,
    account_manager: null,
    status: null,
  };
}

/* ── POTENTIAL ────────────────────────────────────────────────────────── */
export function buildPotential(companyId: string, timeframe: Timeframe): Potential {
  const acct = store.accountById[companyId] ?? ({} as Partial<Identity> & Record<string, unknown>);

  // GMV reference (Christine cascade, from accounts_v3)
  let gmvRef = num(acct.gmv_reference);
  let gmvSource = (acct.gmv_source as string | null) || null;
  let gmvIsFloor = Boolean(acct.gmv_is_floor);
  let buyGmvEst = num(acct.buy_gmv_estimated);

  let gmvConfidence: GmvReference['confidence'] = null;
  if (gmvSource === 'Medido' || gmvSource === 'Piso de red') gmvConfidence = 'Alta';
  else if (gmvSource === 'ORA' || gmvSource === 'FCS') gmvConfidence = 'Baja';

  // Pacing
  const paceRec = store.pacingById[companyId] ?? null;
  const gmvPace = paceRec
    ? { value: num(paceRec.annual_pace), daily_rate: num(paceRec.daily_rate), confidence: paceRec.confidence ?? null }
    : null;

  // External estimate
  const extRec = store.externalById[companyId] ?? null;
  const gmvExternal = extRec
    ? { value: num(extRec.estimated_gmv_mid), methods: extRec.methods_used ?? [], confidence: extRec.confidence ?? null }
    : null;

  const gmvOra = gmvSource === 'ORA' && gmvRef ? { value: gmvRef } : null;

  // Cubes
  const sellRows = store.sellCubeById[companyId] ?? [];
  const sellAggYtd = aggregateSellCube(sellRows, 'ytd');
  const sellYtd2025 = sumPriorYtd(sellRows, 'sell_gmv');

  const buyRows = store.buyCubeById[companyId] ?? [];
  const buyAggYtd = aggregateBuyCube(buyRows, 'ytd');
  const buyYtd2025 = sumPriorYtd(buyRows, 'buy_gmv');

  // NOTE: the legacy adapter also aggregated by `timeframe` but never used the result;
  // every displayed figure is YTD. Kept as-is for parity. `timeframe` drives sell/buy sections.
  void timeframe;

  const feesAgg = aggregateFeesCube(store.feesCubeById[companyId] ?? []);
  const feesYtd2026 = feesAgg ? feesAgg.total : null;
  const feesByChannel = feesAgg ? feesAgg.byChannel : null;
  const feesYtd2025: number | null = null; // not in fees cube

  const sellOfflineYtd = sellAggYtd && sellAggYtd.offline > 0 ? sellAggYtd.offline : null;
  const buyOfflineYtd = buyAggYtd && buyAggYtd.offline > 0 ? buyAggYtd.offline : null;
  const koronetSellYtd = sellAggYtd ? sellAggYtd.total : null;
  const koronetBuyYtd = buyAggYtd ? buyAggYtd.total : null;
  const onlineSellYtd = sellAggYtd ? sellAggYtd.online : 0;
  const onlineBuyYtd = buyAggYtd ? buyAggYtd.online : 0;

  // Penetration + "Piso de red" rule: Est GMV can never be below what we already measure.
  let sellPenetration: number | null = null;
  let sellPenEv: EvidenceState = 'gap';
  let sellPenNote: string | null = null;
  let buyPenetration: number | null = null;
  let buyPenEv: EvidenceState = 'gap';
  let buyPenNote: string | null = null;

  const noReference = !gmvRef || gmvRef <= 0 || gmvSource === 'not in Christine cascade' || gmvSource === 'Sin dato';
  const ytdMonthsSell = sellAggYtd ? sellAggYtd.months.length : 0;

  // Rule D: no GMV reference but Koronet activity → auto Piso de red
  if (noReference && koronetSellYtd && koronetSellYtd > 0 && ytdMonthsSell > 0) {
    gmvRef = koronetSellYtd * (12 / ytdMonthsSell);
    gmvSource = 'Piso de red';
    gmvConfidence = 'Alta';
    gmvIsFloor = true;
    buyGmvEst = gmvRef * BUY_TO_SELL_RATIO;
  }

  if (gmvRef && gmvRef > 0 && gmvSource !== 'not in Christine cascade' && gmvSource !== 'Sin dato') {
    const isTautological = /^(Medido|Piso)/.test(gmvSource ?? '');

    if (koronetSellYtd && koronetSellYtd > 0 && ytdMonthsSell > 0) {
      const annualizedSell = koronetSellYtd * (12 / ytdMonthsSell);
      if (isTautological) {
        sellPenetration = 100;
        sellPenEv = 'tautological';
      } else if (annualizedSell > gmvRef) {
        // Estimate was wrong — Koronet already exceeds it. Upgrade to Piso.
        gmvRef = annualizedSell;
        gmvSource = 'Piso de red';
        gmvConfidence = 'Alta';
        gmvIsFloor = true;
        buyGmvEst = gmvRef * BUY_TO_SELL_RATIO;
        sellPenetration = 100;
        sellPenEv = 'tautological';
      } else {
        sellPenetration = (annualizedSell / gmvRef) * 100;
        sellPenEv = gmvConfidence === 'Alta' ? 'model' : 'proxy';
      }
      sellPenNote = gmvSource;
    }

    if (buyGmvEst && buyGmvEst > 0 && koronetBuyYtd && koronetBuyYtd > 0) {
      const buyYtdMonths = buyAggYtd ? buyAggYtd.months.length : 0;
      if (buyYtdMonths > 0) {
        const annualizedBuy = koronetBuyYtd * (12 / buyYtdMonths);
        if (isTautological || sellPenEv === 'tautological') {
          buyPenetration = 100;
          buyPenEv = 'tautological';
        } else if (annualizedBuy > buyGmvEst) {
          buyGmvEst = annualizedBuy;
          buyPenetration = 100;
          buyPenEv = 'tautological';
        } else {
          buyPenetration = (annualizedBuy / buyGmvEst) * 100;
          buyPenEv = gmvConfidence === 'Alta' ? 'model' : 'proxy';
        }
        buyPenNote = gmvSource;
      }
    }
  }

  // Online % = annualized online / Est GMV (same denominator as penetration)
  const sellMonthCount = sellAggYtd ? sellAggYtd.months.length : 0;
  const buyMonthCount = buyAggYtd ? buyAggYtd.months.length : 0;

  let sellOnlinePct: number | null = null;
  if (koronetSellYtd && koronetSellYtd > 0 && gmvRef && gmvRef > 0) {
    sellOnlinePct = onlineSellYtd > 0 && sellMonthCount > 0
      ? ((onlineSellYtd * (12 / sellMonthCount)) / gmvRef) * 100
      : 0;
  }
  let buyOnlinePct: number | null = null;
  if (koronetBuyYtd && koronetBuyYtd > 0 && buyGmvEst && buyGmvEst > 0) {
    buyOnlinePct = onlineBuyYtd > 0 && buyMonthCount > 0
      ? ((onlineBuyYtd * (12 / buyMonthCount)) / buyGmvEst) * 100
      : 0;
  }
  // online ⊂ total → online% ≤ penetration%
  if (sellOnlinePct != null && sellPenetration != null && sellOnlinePct > sellPenetration) sellOnlinePct = sellPenetration;
  if (buyOnlinePct != null && buyPenetration != null && buyOnlinePct > buyPenetration) buyOnlinePct = buyPenetration;

  // Take rate
  let takeRate: number | null = null;
  if (feesYtd2026 && koronetSellYtd && koronetSellYtd > TAKE_RATE_MIN_SELL) {
    takeRate = (feesYtd2026 / koronetSellYtd) * 100;
  }

  const sellYoyDelta = koronetSellYtd && sellYtd2025 ? delta(koronetSellYtd, sellYtd2025) : null;
  const daysObserved = paceRec ? num(paceRec.days_observed) : null;

  return {
    gmv_reference: { value: gmvRef, source: gmvSource, is_floor: gmvIsFloor, confidence: gmvConfidence, days_observed: daysObserved },
    gmv_pace: gmvPace,
    gmv_external: gmvExternal,
    gmv_ora: gmvOra,
    buy_gmv_estimated: { value: buyGmvEst },

    koronet_sell_ytd: ev(koronetSellYtd, koronetSellYtd ? 'observed' : 'gap', 'sell cube'),
    koronet_buy_ytd: ev(koronetBuyYtd, koronetBuyYtd ? 'observed' : 'gap', 'buy cube'),
    sell_ytd_2025: ev(sellYtd2025, sellYtd2025 ? 'observed' : 'gap'),
    buy_ytd_2025: ev(buyYtd2025, buyYtd2025 ? 'observed' : 'gap'),

    sell_online_pct: ev(sellOnlinePct, sellOnlinePct != null ? 'observed' : 'gap'),
    buy_online_pct: ev(buyOnlinePct, buyOnlinePct != null ? 'observed' : 'gap'),
    sell_offline_ytd: ev(sellOfflineYtd, sellOfflineYtd ? 'observed' : 'gap'),
    buy_offline_ytd: ev(buyOfflineYtd, buyOfflineYtd ? 'observed' : 'gap'),

    sell_penetration: ev(sellPenetration, sellPenEv, sellPenNote),
    buy_penetration: ev(buyPenetration, buyPenEv, buyPenNote),

    fees_ytd_2026: ev(feesYtd2026, feesYtd2026 ? 'observed' : 'gap', 'fees cube'),
    fees_ytd_2025: ev<number>(feesYtd2025, 'gap'),
    fees_by_channel: { value: feesByChannel },
    fees_yoy_pct: ev<number>(null, 'gap'),
    take_rate: ev(takeRate, feesYtd2026 && koronetSellYtd ? 'model' : 'gap'),

    sell_yoy_delta: sellYoyDelta,
    sell_mom_delta: computeMomDelta(sellMonthlyTotals(sellRows), 'sell_gmv'),
    buy_mom_delta: computeMomDelta(buyMonthlyTotals(buyRows), 'buy_gmv'),
    fees_mom_delta: null,
  };
}

/* ── BUY DOMAIN ───────────────────────────────────────────────────────── */
function summarizeBuckets(rows: TemporalRow[]): BucketSummary {
  const buckets: BucketSummary['buckets'] = {};
  let totalOrders = 0;
  let weightedDays = 0;
  for (const r of rows) {
    buckets[r.bucket ?? ''] = { orders: r.total_orders, gmv: r.total_gmv, avg_days: r.avg_days };
    totalOrders += r.total_orders ?? 0;
    weightedDays += (r.avg_days ?? 0) * (r.total_orders ?? 0);
  }
  return { buckets, total_orders: totalOrders, avg_days: totalOrders > 0 ? weightedDays / totalOrders : null };
}

export function buildBuy(companyId: string, timeframe: Timeframe): BuyDomain {
  const name = store.idToName[companyId];
  const vendRec = store.vendorsById[companyId] ?? (name ? store.vendorsByName[name] ?? null : null);
  const saRows = store.temporalSAById[companyId] ?? (name ? store.temporalSAByName[name] ?? null : null);
  const skusRec = store.skusById[companyId] ?? (name ? store.skusOnlineOffline[name] ?? null : null);

  const buyRows = store.buyCubeById[companyId] ?? [];
  const monthly = buyMonthlyTotals(buyRows);
  const buyAggYtd = aggregateBuyCube(buyRows, 'ytd');
  const buyYtd2025 = sumPriorYtd(buyRows, 'buy_gmv');

  let sourcingTable: SourcingTable | null = null;
  if (monthly.length) {
    const byMonth: Record<string, MonthlyBuyTotal> = {};
    for (const m of monthly) byMonth[m.month] = m;
    const sp = selectPeriod(byMonth, timeframe);
    sourcingTable = {
      ytd_2026: buyAggYtd ? buyAggYtd.total : null,
      ytd_2025: buyYtd2025,
      yoy_delta: buyAggYtd && buyYtd2025 ? delta(buyAggYtd.total, buyYtd2025) : null,
      monthly: byMonth,
      current_month: sp.current,
      current_month_key: sp.current ? sp.current.month : null,
      prior_month: sp.prior,
      prior_month_key: sp.prior ? sp.prior.month : null,
      ev: 'observed',
    };
  }

  const k2kLifecycle = (vendRec?.k2k_connections as LooseRecord | undefined) || null;
  const vendorLifecycle = (vendRec?.vendor_lifecycle as LooseRecord | undefined) || null;
  const categoriesTop20 = vendRec?.categories_top20 || null;
  const leakage = (vendRec?.vendor_leakage as LooseRecord | undefined) || null;

  let anticipationOnline: BucketSummary | null = null;
  let anticipationOffline: BucketSummary | null = null;
  if (saRows && saRows.length) {
    const online = saRows.filter((r) => r.channel_type === 'online');
    const offline = saRows.filter((r) => r.channel_type === 'offline');
    anticipationOnline = online.length ? summarizeBuckets(online) : null;
    anticipationOffline = offline.length ? summarizeBuckets(offline) : null;
  }

  return {
    sourcing_table: sourcingTable ? ev(sourcingTable, 'observed', 'buy cube + vendors_evidence_v2') : null,
    k2k_lifecycle: k2kLifecycle ? ev(k2kLifecycle, 'observed', 'vendors_evidence_v2') : null,
    vendor_lifecycle: vendorLifecycle ? ev(vendorLifecycle, 'observed', 'vendors_evidence_v2') : null,
    anticipation_online: anticipationOnline ? ev(anticipationOnline, 'observed', 'temporal sell_anticipation') : null,
    anticipation_offline: anticipationOffline ? ev(anticipationOffline, 'observed', 'temporal sell_anticipation') : null,
    categories_top20: categoriesTop20 ? ev(categoriesTop20, 'observed', 'vendors_evidence_v2') : null,
    leakage: leakage ? ev(leakage, 'observed', 'vendors_evidence_v2') : null,
    skus_online_offline: skusRec ? ev(skusRec, 'observed', 'skus_online_offline') : null,
  };
}

/* ── LIST DOMAIN ──────────────────────────────────────────────────────── */
function groupFreshness(rows: TemporalRow[]): FreshnessGroup {
  const buckets: FreshnessGroup['buckets'] = {};
  let total = 0;
  for (const r of rows) {
    buckets[r.freshness_bucket ?? ''] = { variety_count: r.variety_count, avg_days: r.avg_days_since };
    total += r.variety_count ?? 0;
  }
  return { buckets, total_varieties: total };
}

export function buildList(companyId: string): ListDomain {
  const name = store.idToName[companyId];
  const invRec = store.inventory[companyId] ?? null;
  const cfgRec = store.config[companyId] ?? null;
  const vfRows = store.temporalVFById[companyId] ?? (name ? store.temporalVFByName[name] ?? null : null);
  const fiRows = store.temporalFIById[companyId] ?? (name ? store.temporalFIByName[name] ?? null : null);

  const inventoryCurrent = invRec
    ? { by_type: invRec.by_inventory_type || null, by_division: invRec.by_inventory_division || null, totals: invRec.totals || null, ev: 'observed' as const }
    : null;

  let varietyFreshness: VarietyFreshness | null = null;
  if (vfRows && vfRows.length) {
    const online = vfRows.filter((r) => r.channel_type === 'online');
    const offline = vfRows.filter((r) => r.channel_type === 'offline');
    varietyFreshness = {
      online: online.length ? groupFreshness(online) : null,
      offline: offline.length ? groupFreshness(offline) : null,
      ev: 'observed',
    };
  }

  let forwardInventory: { by_bucket: Record<string, LooseRecord>; ev: EvidenceState } | null = null;
  if (fiRows && fiRows.length) {
    const byBucket: Record<string, LooseRecord> = {};
    for (const r of fiRows) {
      byBucket[r.horizon_bucket ?? ''] = {
        prebook_lines: r.prebook_lines,
        total_value: r.total_value,
        distinct_vendors: r.distinct_vendors,
        distinct_products: r.distinct_products,
      };
    }
    forwardInventory = { by_bucket: byBucket, ev: 'observed' };
  }

  const config: ConfigEvidence | null = cfgRec
    ? {
        raw: (cfgRec.config as LooseRecord | undefined) || null,
        bunches_reality: (cfgRec.bunches_reality as LooseRecord | undefined) || null,
        sfdc: (cfgRec.sfdc as LooseRecord | undefined) || null,
        company_name: (cfgRec.company_name as string | undefined) || null,
        company_industry: (cfgRec.company_industry as string | undefined) || null,
        ev: 'observed',
      }
    : null;

  return {
    inventory_current: inventoryCurrent ? ev(inventoryCurrent, 'observed', 'inventory_current_v1') : null,
    variety_freshness: varietyFreshness ? ev(varietyFreshness, 'observed', 'temporal variety_freshness') : null,
    forward_inventory: forwardInventory ? ev(forwardInventory, 'observed', 'temporal forward_inventory_depth') : null,
    tam_lost: null,
    config: config ? ev(config, 'observed', 'config_evidence_v2') : null,
  };
}

/* ── SELL DOMAIN ──────────────────────────────────────────────────────── */
export function buildSell(companyId: string, timeframe: Timeframe): SellDomain {
  const name = store.idToName[companyId];
  const buyRec = store.buyersById[companyId] ?? (name ? store.buyers[name] ?? null : null);
  const hgRec = name ? store.hardgoodsByName[name] ?? null : null;

  const sellRows = store.sellCubeById[companyId] ?? [];
  const monthly = sellMonthlyTotals(sellRows);
  const n = monthly.length;

  let currentMonth = n ? monthly[n - 1] : null;
  let priorMonth = n >= 2 ? monthly[n - 2] : null;
  if (timeframe === 'prior_month') {
    currentMonth = n >= 2 ? monthly[n - 2] : null;
    priorMonth = n >= 3 ? monthly[n - 3] : null;
  }

  let buyersTable: BuyersTable | null = null;
  const bd = buyRec?.buyers as LooseRecord | undefined;
  if (bd) {
    buyersTable = {
      online_buyers: num(bd.online_buyers),
      offline_buyers: num(bd.offline_buyers),
      total_buyers: num(bd.total_buyers),
      l30d_online: num(bd.l30d_online),
      l30d_offline: num(bd.l30d_offline),
      aov_online: num(bd.aov_online) || null,
      aov_offline: num(bd.aov_offline) || null,
      new_month: num(bd.new_month) || null,
      churned: num(bd.churned) || null,
      ev: 'observed',
    };
  }

  const hardgoods: LooseRecord | null = hgRec
    ? {
        hardgoods_total: num(hgRec.hardgoods_total),
        hardgoods_online: num(hgRec.hardgoods_online),
        hardgoods_offline: num(hgRec.hardgoods_offline),
        hardgoods_online_pct: num(hgRec.hardgoods_online_pct),
        plants_total: num(hgRec.plants_total),
        plants_online: num(hgRec.plants_online),
        plants_offline: num(hgRec.plants_offline),
        plants_online_pct: num(hgRec.plants_online_pct),
        ct_id: hgRec.ct_id || null,
        ev: 'observed',
      }
    : null;

  const agg = aggregateSellCube(sellRows, 'ytd');
  const sellOnlineYtd = agg && agg.online > 0 ? agg.online : null;
  const sellOfflineYtd = agg && agg.offline > 0 ? agg.offline : null;
  const sellTotalYtd = agg && agg.total > 0 ? agg.total : null;

  const cvr = buyRec?.login_cvr ?? null;
  const newUserCvr = buyRec?.new_user_cvr ?? null;
  const repeatRate = buyRec?.repeat_rate ?? null;
  const concentration = buyRec?.concentration ?? null;

  return {
    buyers_table: buyersTable ? ev(buyersTable, 'observed', 'buyers_evidence_v2') : null,
    cvr: cvr ? ev(cvr, 'observed', 'buyers_evidence_v2') : null,
    new_user_cvr: newUserCvr ? ev(newUserCvr, 'observed', 'buyers_evidence_v2') : null,
    repeat_rate: repeatRate ? ev(repeatRate, 'observed', 'buyers_evidence_v2') : null,
    concentration: concentration ? ev(concentration, 'observed', 'buyers_evidence_v2') : null,
    hardgoods: hardgoods ? ev(hardgoods, 'observed', 'hardgoods_v2') : null,
    sell_online_ytd: ev(sellOnlineYtd, sellOnlineYtd ? 'observed' : 'gap'),
    sell_offline_ytd: ev(sellOfflineYtd, sellOfflineYtd ? 'observed' : 'gap'),
    sell_total_ytd: ev(sellTotalYtd, sellTotalYtd ? 'observed' : 'gap'),
    monthly_series: monthly.length ? ev(monthly, 'observed', 'sell cube') : null,
    current_month: currentMonth,
    prior_month: priorMonth,
  };
}

/* ── BENCHMARKS ───────────────────────────────────────────────────────── */
export function buildBenchmarks(companyId: string): Benchmarks | null {
  const acct = store.accountById[companyId];
  const ctId = (acct?.ct_id as string | undefined) ?? '';
  const bmarks = store.benchmarks;
  if (!bmarks || !Object.keys(bmarks).length) return null;

  const result: Benchmarks = { segment: ctId, per_metric: {} };
  for (const [key, bm] of Object.entries(bmarks)) {
    const network = bm.network ?? null;
    const seg = bm.by_segment && ctId ? bm.by_segment[ctId] ?? null : null;
    result.per_metric[key] = {
      description: bm.description ?? null,
      network,
      segment: seg,
      median: network?.median ?? null,
      p75: network?.p75 ?? null,
      p90: network?.p90 ?? null,
      best_account: network?.best_account ?? null,
      best_value: network?.best_value ?? null,
      seg_median: seg?.median ?? null,
      seg_p75: seg?.p75 ?? null,
      seg_p90: seg?.p90 ?? null,
    };
  }
  return result;
}

/* ── FRESHNESS / SOURCE COVERAGE ─────────────────────────────────────── */
export function buildFreshness(companyId: string): Freshness {
  const id = companyId;
  const name = store.idToName[id];
  const has = (arr: unknown[] | undefined) => !!(arr && arr.length);

  const checks: [string, boolean][] = [
    ['accounts_v3', !!store.accountById[id]],
    ['sell_cube', has(store.sellCubeById[id])],
    ['buy_cube', has(store.buyCubeById[id])],
    ['fees_cube', has(store.feesCubeById[id])],
    ['gmv_pacing', !!store.pacingById[id]],
    ['gmv_external', !!store.externalById[id]],
    ['buyers_evidence', !!(store.buyersById[id] || (name && store.buyers[name]))],
    ['vendors_evidence', !!(store.vendorsById[id] || (name && store.vendorsByName[name]))],
    ['temporal', has(store.temporalSAById[id]) || (!!name && has(store.temporalSAByName[name]))],
    ['inventory_current', !!store.inventory[id]],
    ['benchmarks', Object.keys(store.benchmarks).length > 0],
    ['config_evidence', !!store.config[id]],
    ['hardgoods', name ? !!store.hardgoodsByName[name] : false],
  ];

  const sources = checks.map(([source, found]) => ({ source, found, as_of: null }));
  const foundCount = sources.filter((s) => s.found).length;
  return {
    as_of: new Date().toISOString().slice(0, 10),
    sources_used: foundCount,
    sources_total: sources.length,
    coverage_pct: Math.round((foundCount / sources.length) * 100),
    sources,
  };
}
