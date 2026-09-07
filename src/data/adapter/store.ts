/**
 * Adapter store — loads every data file once and builds the id-keyed lookup
 * maps the builders read from. Kept as a plain module-level singleton (same
 * semantics as the legacy IIFE) so the evidence for ~4k accounts is computed
 * from in-memory indexes rather than re-scanning arrays per account.
 */
import { DATA_FILES, EXCLUDED_COMPANY_IDS, fetchJson } from './files';
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
} from './types';

export interface AdapterStore {
  loaded: boolean;

  // Raw lists
  accountsV3: RawAccount[];
  sellCube: SellCubeRow[];
  buyCube: BuyCubeRow[];
  feesCube: FeesCubeRow[];
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

  // Cube metadata (used by the UI to derive the data period instead of hardcoding it)
  cubeMeta: { sell: CubeMeta | null; buy: CubeMeta | null; fees: CubeMeta | null };

  // Derived lookups
  accountById: Record<string, RawAccount>;
  idToName: Record<string, string>;
  nameToId: Record<string, string>;
  sellCubeById: Record<string, SellCubeRow[]>;
  buyCubeById: Record<string, BuyCubeRow[]>;
  feesCubeById: Record<string, FeesCubeRow[]>;
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
    buyers: {}, vendors: [], temporal: {}, inventory: {}, benchmarks: {}, config: {}, hardgoods: [], skusOnlineOffline: {},
    cubeMeta: { sell: null, buy: null, fees: null },
    accountById: {}, idToName: {}, nameToId: {},
    sellCubeById: {}, buyCubeById: {}, feesCubeById: {}, pacingById: {}, externalById: {},
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
      accounts, sell, buy, fees, pacing, external,
      buyers, vendors, temporal, inventory, benchmarks, config, hardgoods, skus,
    ] = await Promise.all([
      fetcher<RawAccountsFile>(DATA_FILES.accountsV3),
      fetcher<CubeFile<SellCubeRow>>(DATA_FILES.sellCube),
      fetcher<CubeFile<BuyCubeRow>>(DATA_FILES.buyCube),
      fetcher<CubeFile<FeesCubeRow>>(DATA_FILES.feesCube),
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
    ]);

    store.accountsV3 = Array.isArray(accounts?.accounts) ? accounts.accounts : [];
    store.sellCube = Array.isArray(sell?.data) ? sell.data : [];
    store.buyCube = Array.isArray(buy?.data) ? buy.data : [];
    store.feesCube = Array.isArray(fees?.data) ? fees.data : [];
    store.gmvPacing = Array.isArray(pacing?.pacing) ? pacing.pacing : [];
    store.gmvExternal = Array.isArray(external?.estimates) ? external.estimates : [];
    store.buyers = buyers?.companies ?? {};
    store.vendors = Array.isArray(vendors?.companies) ? vendors.companies : [];
    store.temporal = temporal ?? {};
    store.inventory = inventory?.companies ?? {};
    store.benchmarks = benchmarks?.benchmarks ?? {};
    store.config = config?.companies ?? {};
    store.hardgoods = Array.isArray(hardgoods?.companies) ? hardgoods.companies : [];
    store.skusOnlineOffline = skus?.companies ?? {};
    store.cubeMeta = { sell: sell?._meta ?? null, buy: buy?._meta ?? null, fees: fees?._meta ?? null };

    buildLookups();
    store.loaded = true;
  })();

  return loadPromise;
}

/** Reset — test-only. */
export function resetStore(): void {
  Object.assign(store, emptyStore());
  loadPromise = null;
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

  for (const row of store.sellCube) { const id = sid(row.company_id); if (id) pushTo(store.sellCubeById, id, row); }
  for (const row of store.buyCube) { const id = sid(row.company_id); if (id) pushTo(store.buyCubeById, id, row); }
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
