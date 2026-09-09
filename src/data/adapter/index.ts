/**
 * Evidence Adapter — public API.
 *
 *   await evidenceAdapter.init();
 *   const ids = evidenceAdapter.getAllAccountIds();
 *   const ev  = evidenceAdapter.getAccountEvidence(ids[0], 'ytd');
 *
 * Same surface as the legacy `EvidenceAdapter` global, now typed.
 * Graceful fallback: a missing file or field yields null, never a crash.
 */
import { buildBenchmarks, buildBuy, buildFreshness, buildIdentity, buildList, buildPotential, buildSell } from './builders';
import { sid } from './helpers';
import { DEFAULT_ANCHOR, buildPeriods, resolvePeriod, type Period, type PeriodId } from './period';
import { loadAll, resetStore, store, type JsonFetcher } from './store';
import type { AccountEvidence, CubeMeta, LoadedState } from './types';

function warnNotLoaded(): void {
  console.warn('[EvidenceAdapter] Data not loaded yet. Call init() first.');
}

/** Load every data file and build lookups. Safe to call more than once. */
export function init(fetcher?: JsonFetcher): Promise<void> {
  return loadAll(fetcher);
}

export function isLoaded(): boolean {
  return store.loaded;
}

/**
 * Anchor month for period math: the sell cube's last closed month
 * (`_meta.period_to`), falling back to DEFAULT_ANCHOR.
 */
export function getAnchorMonth(): string {
  const to = store.cubeMeta.sell?.period_to;
  return typeof to === 'string' && /^\d{4}-\d{2}$/.test(to) ? to : DEFAULT_ANCHOR;
}

/** The three selectable periods, resolved against the data's anchor month. */
export function getPeriods(): Record<PeriodId, Period> {
  return buildPeriods(getAnchorMonth());
}

export function getAccountEvidence(companyId: string | number, periodOrId: PeriodId | Period = 'ytd'): AccountEvidence | null {
  if (!store.loaded) { warnNotLoaded(); return null; }
  const id = sid(companyId);
  if (!id) return null;
  const period = resolvePeriod(periodOrId, getAnchorMonth());

  const identity = buildIdentity(id);
  if (!identity) return null;

  const safe = <T>(label: string, fn: () => T): T | null => {
    try { return fn(); } catch (e) { console.error(`[EvidenceAdapter] ${label} error`, id, e); return null; }
  };

  return {
    _company_id: id,
    _company_name: identity.company_name,
    _period: period,
    identity,
    potential: safe('potential', () => buildPotential(id, period)),
    buy: safe('buy', () => buildBuy(id, period)),
    list: safe('list', () => buildList(id)),
    sell: safe('sell', () => buildSell(id, period)),
    benchmarks: safe('benchmarks', () => buildBenchmarks(id)),
    freshness: safe('freshness', () => buildFreshness(id)),
  };
}

export function getAccountByName(companyName: string, period: PeriodId | Period = 'ytd'): AccountEvidence | null {
  if (!store.loaded) { warnNotLoaded(); return null; }
  const id = store.nameToId[companyName];
  if (!id) { console.warn('[EvidenceAdapter] No company_id found for name:', companyName); return null; }
  return getAccountEvidence(id, period);
}

/** Sorted company ids from accounts_v3 (excluded demo ids removed). */
export function getAllAccountIds(): string[] {
  return Object.keys(store.accountById).sort();
}

/** Cube metadata — lets the UI derive the data period (e.g. `period_to: '2026-07'`) instead of hardcoding. */
export function getCubeMeta(): { sell: CubeMeta | null; buy: CubeMeta | null; fees: CubeMeta | null } {
  return store.cubeMeta;
}

export function getLoadedState(): LoadedState {
  return {
    loaded: store.loaded,
    accounts_v3_count: Object.keys(store.accountById).length,
    sell_cube_companies: Object.keys(store.sellCubeById).length,
    sell_cube_rows: store.sellCube.length,
    buy_cube_companies: Object.keys(store.buyCubeById).length,
    buy_cube_rows: store.buyCube.length,
    fees_cube_companies: Object.keys(store.feesCubeById).length,
    fees_cube_rows: store.feesCube.length,
    gmv_pacing_count: Object.keys(store.pacingById).length,
    gmv_external_count: Object.keys(store.externalById).length,
    buyers_count: Object.keys(store.buyers).length,
    vendors_count: store.vendors.length,
    inventory_count: Object.keys(store.inventory).length,
    benchmarks_count: Object.keys(store.benchmarks).length,
    config_count: Object.keys(store.config).length,
    hardgoods_count: store.hardgoods.length,
    name_to_id_count: Object.keys(store.nameToId).length,
    id_to_name_count: Object.keys(store.idToName).length,
  };
}

/**
 * Canonical filter for the prioritization universe:
 * Client + Wholesaler + known product tier. Every view that prioritizes
 * wholesalers MUST use this (matrix, drill-downs…).
 */
export function isClientWholesaler(ev: AccountEvidence | null): boolean {
  if (!ev?.identity) return false;
  const id = ev.identity;

  /* The portfolio universe is an explicit set of sfdc_ids, not a rule: the old
     Client + Wholesaler + product_tier filter gave 127 accounts and dropped 19
     hand-curated in Christine/Facundo's sheet, 18 of them only for being
     Pre-live or Prospect — $77.1M of Est GMV. Membership involves human
     judgement no combination of fields encodes. Falls back to the old rule when
     the file is missing, so the app degrades instead of blanking. */
  if (store.whPortfolio) {
    const sfdc = id.sfdc_id ?? store.accountById[String(id.company_id)]?.sfdc_id;
    if (sfdc) return store.whPortfolio.has(String(sfdc));
  }

  return id.account_class === 'Client'
    && id.business_type === 'Wholesaler'
    && !!id.product_tier
    && id.product_tier !== 'Unknown';
}

/**
 * Identified as a wholesaler ONLY by the external 618-profile research:
 * registered and reviewable, but deliberately OUTSIDE the portfolio and its
 * KPIs until the team validates the classification. The 618 defines
 * "wholesaler" as selling wholesale to the trade, which in floral legitimately
 * includes importers — 69 of these are Clients booked in Salesforce as
 * Importer, Grower or Retailer. No business_type is changed in Salesforce.
 */
export function isOnly618(ev: AccountEvidence | null): boolean {
  if (!ev?.identity || !store.wh618) return false;
  const sfdc = ev.identity.sfdc_id;
  return !!sfdc && store.wh618.has(String(sfdc));
}

/** Test-only: forget everything so the next init() reloads. */
export const __resetForTests = resetStore;

export const evidenceAdapter = {
  init,
  isLoaded,
  getAccountEvidence,
  getAccountByName,
  getAllAccountIds,
  getCubeMeta,
  getAnchorMonth,
  getPeriods,
  getLoadedState,
  isClientWholesaler,
  isOnly618,
};

export type { AccountEvidence } from './types';
export type { Period, PeriodId } from './period';
