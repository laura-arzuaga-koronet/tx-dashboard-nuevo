/**
 * Adapter store — loads every data file once and builds the id-keyed lookup
 * maps the builders read from. Kept as a plain module-level singleton (same
 * semantics as the legacy IIFE) so the evidence for ~4k accounts is computed
 * from in-memory indexes rather than re-scanning arrays per account.
 */
import { DATA_FILES, EXCLUDED_COMPANY_IDS, fetchJson, isBadCubeRow } from './files';
import { sid } from './helpers';
import type {
  Benchmark,
  BenchmarksFile,
  BuyCubeRow,
  BuyersFile,
  CubeFile,
  CubeMeta,
  ExternalEstimateRecord,
  ExternalEstimatesFile,
  FeesCubeRow,
  HardgoodsFile,
  KeyedCompaniesFile,
  LooseRecord,
  PacingFile,
  PacingRecord,
  RawAccount,
  RawAccountsFile,
  SellCubeRow,
  TemporalFile,
  TemporalRow,
  VendorsFile,
  IndirectCubeRow,
  WholesalerUniverseFile,
} from './types';

export interface MonthBounds { from: string; to: string }

export interface AdapterStore {
  loaded: boolean;

  // Raw lists
  accountsV3: RawAccount[];
  sellCube: SellCubeRow[];
  buyCube: BuyCubeRow[];
  feesCube: FeesCubeRow[];
  indirectCube: IndirectCubeRow[];
  /** Portfolio universe and the 618-only set, as explicit sfdc_id sets. */
  whPortfolio: Set<string> | null;
  wh618: Set<string> | null;
  gmvPacing: PacingRecord[];
  gmvExternal: ExternalEstimateRecord[];
  buyers: Record<string, LooseRecord>;
  vendors: LooseRecord[];
  temporal: TemporalFile;
  inventory: Record<string, LooseRecord>;
  benchmarks: Record<string, Benchmark>;
  config: Record<string, LooseRecord>;
  hardgoods: LooseRecord[];
  skusOnlineOffline: Record<string, LooseRecord>;
  /** Fecha de corrida de inventory_current_v1: es una FOTO, no sigue el selector. */
  inventoryAsOf: string | null;
  /** catalog_reach_v1: alcance online del catálogo por company_id, ventana fija. */
  catalogReach: Record<string, LooseRecord>;
  /** Percentiles de cobertura de toda la red, para comparar cada cuenta. */
  catalogNetwork: LooseRecord | null;

  // Cube metadata (used by the UI to derive the data period instead of hardcoding it)
  cubeMeta: { sell: CubeMeta | null; buy: CubeMeta | null; fees: CubeMeta | null };
  /** First/last month actually present in each cube — bounds for "is this range fully covered?" */
  coverage: { sell: MonthBounds | null; buy: MonthBounds | null; fees: MonthBounds | null; indirect: MonthBounds | null };

  // Derived lookups
  accountById: Record<string, RawAccount>;
  idToName: Record<string, string>;
  nameToId: Record<string, string>;
  sellCubeById: Record<string, SellCubeRow[]>;
  buyCubeById: Record<string, BuyCubeRow[]>;
  feesCubeById: Record<string, FeesCubeRow[]>;
  /** Keyed by the BUYER's company_id. */
  indirectCubeById: Record<string, IndirectCubeRow[]>;
  pacingById: Record<string, PacingRecord>;
  externalById: Record<string, ExternalEstimateRecord>;
  vendorsByName: Record<string, LooseRecord>;
  vendorsById: Record<string, LooseRecord>;
  hardgoodsByName: Record<string, LooseRecord>;
  skusById: Record<string, LooseRecord>;
  buyersById: Record<string, LooseRecord>;
  temporalSAByName: Record<string, TemporalRow[]>;
  temporalVFByName: Record<string, TemporalRow[]>;
  temporalFIByName: Record<string, TemporalRow[]>;
  temporalSAById: Record<string, TemporalRow[]>;
  temporalVFById: Record<string, TemporalRow[]>;
  temporalFIById: Record<string, TemporalRow[]>;
}

function emptyStore(): AdapterStore {
  return {
    loaded: false,
    accountsV3: [], sellCube: [], buyCube: [], feesCube: [], gmvPacing: [], gmvExternal: [],
    buyers: {}, vendors: [], temporal: {}, inventory: {}, benchmarks: {}, config: {}, hardgoods: [], skusOnlineOffline: {}, catalogReach: {}, catalogNetwork: null, inventoryAsOf: null,
    cubeMeta: { sell: null, buy: null, fees: null },
    coverage: { sell: null, buy: null, fees: null, indirect: null },
    accountById: {}, idToName: {}, nameToId: {},
    indirectCube: [], whPortfolio: null, wh618: null,
    sellCubeById: {}, buyCubeById: {}, feesCubeById: {}, indirectCubeById: {}, pacingById: {}, externalById: {},
    vendorsByName: {}, vendorsById: {}, hardgoodsByName: {}, skusById: {}, buyersById: {},
    temporalSAByName: {}, temporalVFByName: {}, temporalFIByName: {},
    temporalSAById: {}, temporalVFById: {}, temporalFIById: {},
  };
}

export const store: AdapterStore = emptyStore();

let loadPromise: Promise<void> | null = null;

/** Fetcher signature — injectable so tests can load from disk instead of HTTP. */
export type JsonFetcher = <T>(url: string) => Promise<T | null>;

/** Load every file (in parallel), then build lookups. Idempotent. */
export function loadAll(fetcher: JsonFetcher = fetchJson): Promise<void> {
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const [
      accounts, sell, buy, fees, indirect, whUni, pacing, external,
      buyers, vendors, temporal, inventory, benchmarks, config, hardgoods, skus, catalog,
    ] = await Promise.all([
      fetcher<RawAccountsFile>(DATA_FILES.accountsV3),
      fetcher<CubeFile<SellCubeRow>>(DATA_FILES.sellCube),
      fetcher<CubeFile<BuyCubeRow>>(DATA_FILES.buyCube),
      fetcher<CubeFile<FeesCubeRow>>(DATA_FILES.feesCube),
      fetcher<CubeFile<IndirectCubeRow>>(DATA_FILES.indirectCube),
      fetcher<WholesalerUniverseFile>(DATA_FILES.whUniverse),
      fetcher<PacingFile>(DATA_FILES.gmvPacing),
      fetcher<ExternalEstimatesFile>(DATA_FILES.gmvExternal),
      fetcher<BuyersFile>(DATA_FILES.buyers),
      fetcher<VendorsFile>(DATA_FILES.vendors),
      fetcher<TemporalFile>(DATA_FILES.temporal),
      fetcher<KeyedCompaniesFile>(DATA_FILES.inventory),
      fetcher<BenchmarksFile>(DATA_FILES.benchmarks),
      fetcher<KeyedCompaniesFile>(DATA_FILES.config),
      fetcher<HardgoodsFile>(DATA_FILES.hardgoods),
      fetcher<KeyedCompaniesFile>(DATA_FILES.skusOnlineOffline),
      fetcher<CatalogReachFile>(DATA_FILES.catalogReach),
    ]);

    store.accountsV3 = Array.isArray(accounts?.accounts) ? accounts.accounts : [];
    store.sellCube = Array.isArray(sell?.data) ? sell.data : [];
    store.buyCube = Array.isArray(buy?.data) ? buy.data : [];
    store.feesCube = Array.isArray(fees?.data) ? fees.data : [];
    store.indirectCube = Array.isArray(indirect?.data) ? indirect.data : [];
    /* The wholesaler universe is an explicit set of sfdc_ids, not a rule:
       membership involves human judgement no combination of fields encodes.
       When the file is missing both sets stay null and isClientWholesaler
       falls back to the old Client + Wholesaler + product_tier rule. */
    store.whPortfolio = Array.isArray(whUni?.portfolio_sfdc_ids)
      ? new Set(whUni.portfolio_sfdc_ids.map(String)) : null;
    store.wh618 = Array.isArray(whUni?.only_618_sfdc_ids)
      ? new Set(whUni.only_618_sfdc_ids.map(String)) : null;
    store.gmvPacing = Array.isArray(pacing?.pacing) ? pacing.pacing : [];
    store.gmvExternal = Array.isArray(external?.estimates) ? external.estimates : [];
    store.buyers = buyers?.companies ?? {};
    store.vendors = Array.isArray(vendors?.companies) ? vendors.companies : [];
    store.temporal = temporal ?? {};
    store.inventory = inventory?.companies ?? {};
    store.inventoryAsOf = typeof (inventory as { _metadata?: { generated_at?: unknown } } | undefined)
      ?._metadata?.generated_at === 'string'
      ? ((inventory as { _metadata: { generated_at: string } })._metadata.generated_at).slice(0, 10)
      : null;
    store.benchmarks = benchmarks?.benchmarks ?? {};
    store.config = config?.companies ?? {};
    store.hardgoods = Array.isArray(hardgoods?.companies) ? hardgoods.companies : [];
    store.skusOnlineOffline = skus?.companies ?? {};
    store.catalogReach = catalog?.companies ?? {};
    store.catalogNetwork = catalog?.network ?? null;
    store.cubeMeta = { sell: sell?._meta ?? null, buy: buy?._meta ?? null, fees: fees?._meta ?? null };

    buildLookups();
    store.coverage = {
      sell: monthBounds(store.sellCube),
      buy: monthBounds(store.buyCube),
      fees: monthBounds(store.feesCube),
      indirect: monthBounds(store.indirectCube),
    };
    store.loaded = true;
  })();

  return loadPromise;
}

/** Reset — test-only. */
export function resetStore(): void {
  Object.assign(store, emptyStore());
  loadPromise = null;
}

function monthBounds(rows: { month?: string }[]): MonthBounds | null {
  let from: string | null = null;
  let to: string | null = null;
  for (const r of rows) {
    if (!r.month) continue;
    if (from == null || r.month < from) from = r.month;
    if (to == null || r.month > to) to = r.month;
  }
  return from && to ? { from, to } : null;
}

function pushTo<T>(map: Record<string, T[]>, key: string, row: T) {
  (map[key] ??= []).push(row);
}

function buildLookups(): void {
  // accounts_v3 → accountById / idToName / nameToId
  for (const rec of store.accountsV3) {
    let id = sid(rec.company_id);
    if (id && EXCLUDED_COMPANY_IDS.has(id)) continue;
    if (!id) {
      // Prospects without a Koronet company_id are keyed by sfdc_id so they stay browsable.
      if (!rec.sfdc_id) continue;
      id = `sfdc:${rec.sfdc_id}`;
    }
    store.accountById[id] = rec;
    store.idToName[id] = rec.company_name;
    if (rec.company_name) {
      // Real company_ids win the name→id mapping; synthetic ids only fill gaps.
      if (id.startsWith('sfdc:')) store.nameToId[rec.company_name] ??= id;
      else store.nameToId[rec.company_name] = id;
    }
  }

  // Known-bad company-months are dropped here so nothing downstream sees them.
  store.sellCube = store.sellCube.filter((r) => !isBadCubeRow('sell', String(r.company_id), r.month));
  store.buyCube = store.buyCube.filter((r) => !isBadCubeRow('buy', String(r.company_id), r.month));
  for (const row of store.sellCube) { const id = sid(row.company_id); if (id) pushTo(store.sellCubeById, id, row); }
  for (const row of store.buyCube) { const id = sid(row.company_id); if (id) pushTo(store.buyCubeById, id, row); }
  for (const row of store.indirectCube) { const id = sid(row.buyer_company_id); if (id) pushTo(store.indirectCubeById, id, row); }
  for (const row of store.feesCube) { const id = sid(row.company_id); if (id) pushTo(store.feesCubeById, id, row); }
  for (const rec of store.gmvPacing) { const id = sid(rec.company_id); if (id) store.pacingById[id] = rec; }
  for (const rec of store.gmvExternal) { const id = sid(rec.company_id); if (id) store.externalById[id] = rec; }

  for (const rec of store.vendors) {
    if (rec.company_name) store.vendorsByName[rec.company_name] = rec;
    const vid = sid(rec.company_id);
    if (vid) store.vendorsById[vid] = rec;
  }
  for (const rec of Object.values(store.skusOnlineOffline)) {
    const id = sid(rec?.company_id);
    if (id) store.skusById[id] = rec;
  }
  for (const rec of Object.values(store.buyers)) {
    const id = sid(rec?.company_id);
    if (id) store.buyersById[id] = rec;
  }
  for (const rec of store.hardgoods) {
    if (rec.company_name) store.hardgoodsByName[rec.company_name] = rec;
  }

  const indexTemporal = (
    rows: TemporalRow[] | undefined,
    byName: Record<string, TemporalRow[]>,
    byId: Record<string, TemporalRow[]>,
  ) => {
    for (const row of rows ?? []) {
      if (row.company_name) pushTo(byName, row.company_name, row);
      const rid = sid(row.company_id);
      if (rid) pushTo(byId, rid, row);
    }
  };
  indexTemporal(store.temporal.sell_anticipation?.data, store.temporalSAByName, store.temporalSAById);
  indexTemporal(store.temporal.variety_freshness?.data, store.temporalVFByName, store.temporalVFById);
  indexTemporal(store.temporal.forward_inventory_depth?.data, store.temporalFIByName, store.temporalFIById);
}
