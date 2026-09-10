/**
 * Types for the Evidence Adapter.
 *
 * Two layers:
 *  - Raw*   → shape of the JSON files under public/data (as produced by the
 *             Snowflake / Salesforce extraction scripts).
 *  - Domain → the normalized `AccountEvidence` object the UI consumes.
 */

/* ────────────────────────────────────────────────────────────────────────
   Shared primitives
──────────────────────────────────────────────────────────────────────── */

export type { Period, PeriodId, MonthRange } from './period';

/** Evidence state — how much we trust a value. */
export type EvidenceState = 'observed' | 'proxy' | 'model' | 'gap' | 'tautological';

/** A value annotated with its evidence state and a provenance note. */
export interface Ev<T> {
  value: T | null;
  ev: EvidenceState;
  note: string | null;
}

export interface Delta {
  value: number;
  pct: number;
  direction: 'up' | 'down' | 'flat';
}

export interface MomDelta {
  pct: number;
  absolute: number;
  current_month: string;
  prior_month: string;
}

/* ────────────────────────────────────────────────────────────────────────
   Raw file shapes (public/data/*.json)
──────────────────────────────────────────────────────────────────────── */

export interface RawAccount {
  company_id: string | number | null;
  company_name: string;
  business_type: string | null;
  product_tier: string | null;
  sell_channel: string | null;
  komet_status: string | null;
  industry: string | null;
  gmv_reference: string | number | null;
  gmv_source: string | null;
  gmv_is_floor: boolean;
  buy_gmv_estimated: number | null;
  digital_pct: number | null;
  has_eshop: boolean;
  has_procurement: boolean;
  sfdc_id: string | null;
  in_christine_sheet: boolean;
  potential_tier: string | null;
  engagement_status: string | null;
  priority_level: string | null;
  impl_stage_display: string | null;
  impl_stage?: string | null;
  impl_type?: string | null;
  ct_id?: string | null;
  sfdc_type?: string | null;
  has_active_pmt: boolean;
  pmt_lead: string | null;
  pmt_status: string | null;
  pmt_health: string | null;
  digital_pct_caveat: string | null;
  account_class: string | null;
  segment: string | null;
  record_type?: string | null;
  fees_ytd?: number | null;
  [key: string]: unknown;
}

export interface RawAccountsFile {
  accounts: RawAccount[];
  _meta?: Record<string, unknown>;
}

export interface SellCubeRow {
  company_id: string | number;
  company_name?: string;
  month: string; // YYYY-MM
  channel: string; // 'Online' | 'Offline' | 'K2K' | 'API'
  sell_gmv: number | string;
  /** Rows whose customer_name is the company itself — its own purchases
   *  mirrored into the sales table, already excluded from sell_gmv. */
  self_sale_gmv?: number | string;
  order_count?: number;
}

export interface BuyCubeRow {
  company_id: string | number;
  company_name?: string;
  month: string;
  buy_gmv: number | string;
  buy_online?: number | string;
  buy_offline?: number | string;
}

export interface IndirectCubeRow {
  month: string;
  buyer_company_id: string | number;
  fee_channel: string;      // 'ecom' | 'k2k' | 'api'
  connection_status: string; // 'Active' | 'Suspended' | 'Vendor Approval' | 'Rejected'
  buy_online_attributed: number | string;
  /** Already computed with the seller's realised rate; see helpers. */
  indirect_fee?: number | string;
}

export interface WholesalerUniverseFile {
  portfolio_sfdc_ids: string[];
  sfdc_ids: string[];
  only_618_sfdc_ids: string[];
}

/** Why a metric is empty: 'cero' = the value is correctly zero, 'gap' = unknown. */
export interface MetricReason {
  kind: 'cero' | 'gap';
  note: string;
}

export type TrendMap = Partial<Record<
  'gmv_reference' | 'buy_gmv_estimated' | 'koronet_sell' | 'sell_penetration' | 'sell_online_pct' | 'koronet_buy'
  | 'buy_penetration' | 'buy_online_pct' | 'fees_direct' | 'fees_indirect' | 'take_rate',
  { pct?: number; pp?: number; from_zero?: true } | null
>>;

export type ReasonMap = Partial<Record<
  'gmv_reference' | 'koronet_sell_period' | 'koronet_buy_period' | 'sell_penetration'
  | 'sell_online_pct' | 'buy_penetration' | 'buy_online_pct' | 'fees_direct'
  | 'fees_indirect' | 'take_rate',
  MetricReason | null
>>;

export interface FeesCubeRow {
  company_id: string | number;
  company_name?: string;
  month: string;
  fee_channel: string; // 'ecom' | 'k2k' | 'api' | other
  fee_amount: number | string;
}

export interface CubeFile<Row> {
  _meta?: CubeMeta;
  data: Row[];
}

export interface CubeMeta {
  cube?: string;
  generated_at?: string;
  period_from?: string;
  period_to?: string;
  grain?: string;
  source?: string;
  rows?: number;
  companies?: number;
  months?: number;
  as_of?: string;
  [key: string]: unknown;
}

export interface PacingRecord {
  company_id: string | number;
  annual_pace?: number | string | null;
  daily_rate?: number | string | null;
  confidence?: string | null;
  days_observed?: number | string | null;
  [key: string]: unknown;
}

export interface PacingFile {
  _meta?: Record<string, unknown>;
  pacing: PacingRecord[];
}

export interface ExternalEstimateRecord {
  company_id: string | number;
  estimated_gmv_mid?: number | string | null;
  methods_used?: string[];
  confidence?: string | null;
  [key: string]: unknown;
}

export interface ExternalEstimatesFile {
  _meta?: Record<string, unknown>;
  estimates: ExternalEstimateRecord[];
}

/** Loosely-typed V2 evidence records — their inner shape is consumed by the cards (phase 2). */
export type LooseRecord = Record<string, unknown> & { company_id?: string | number | null; company_name?: string | null };

export interface BuyersFile {
  metadata?: Record<string, unknown>;
  companies: Record<string, LooseRecord>;
}

export interface VendorsFile {
  _meta?: Record<string, unknown>;
  companies: LooseRecord[];
}

export interface TemporalRow extends LooseRecord {
  channel_type?: 'online' | 'offline' | string;
  bucket?: string;
  total_orders?: number;
  total_gmv?: number;
  avg_days?: number;
  freshness_bucket?: string;
  variety_count?: number;
  avg_days_since?: number;
  horizon_bucket?: string;
  prebook_lines?: number;
  total_value?: number;
  distinct_vendors?: number;
  distinct_products?: number;
}

export interface TemporalFile {
  metadata?: Record<string, unknown>;
  sell_anticipation?: { data: TemporalRow[] };
  variety_freshness?: { data: TemporalRow[] };
  forward_inventory_depth?: { data: TemporalRow[] };
}

/**
 * catalog_reach_v1.json — cuánto del catálogo movido pasa por un canal online.
 *
 * `companies` va indexado por company_id (no por nombre: indexar por nombre fue
 * lo que dejó 4.014 cuentas sin config), y `network` trae los percentiles de
 * cobertura de toda la red para poder comparar cada cuenta contra la mediana.
 */
export interface CatalogReachFile {
  _metadata?: LooseRecord;
  network?: LooseRecord;
  companies?: Record<string, LooseRecord>;
}

export interface KeyedCompaniesFile {
  _metadata?: Record<string, unknown>;
  companies: Record<string, LooseRecord>;
}

export interface BenchmarkNetwork {
  median?: number | null;
  p75?: number | null;
  p90?: number | null;
  best_account?: string | null;
  best_value?: number | null;
}

export interface Benchmark {
  description?: string | null;
  network?: BenchmarkNetwork | null;
  by_segment?: Record<string, BenchmarkNetwork> | null;
}

export interface BenchmarksFile {
  _metadata?: Record<string, unknown>;
  benchmarks: Record<string, Benchmark>;
}

export interface HardgoodsFile {
  _metadata?: Record<string, unknown>;
  companies: LooseRecord[];
}

/* ────────────────────────────────────────────────────────────────────────
   Domain — normalized evidence consumed by the UI
──────────────────────────────────────────────────────────────────────── */

export interface Identity {
  company_id: string | null;
  company_name: string | null;
  account_class: string | null;
  business_type: string | null;
  segment: string | null;
  product_tier: string | null;
  sell_channel: string | null;
  potential_tier: string | null;
  impl_stage_display: string | null;
  digital_pct_caveat: string | null;
  has_active_pmt: boolean;
  pmt_lead: string | null;
  pmt_status: string | null;
  pmt_health: string | null;
  priority_level: string | null;
  engagement_status: string | null;
  komet_status: string | null;
  industry: string | null;
  sfdc_id: string | null;
  impl_stage: string | null;
  impl_type: string | null;
  ct_id: string | null;
  sfdc_type: string | null;
  digital_pct: number | null;
  has_eshop: boolean;
  has_procurement: boolean;
  in_christine_sheet: boolean;
  /** V2 compat — not present in accounts_v3 yet */
  city: string | null;
  location: string | null;
  am_name: string | null;
  account_manager: string | null;
  status: string | null;
}

export interface GmvReference {
  /**
   * Estimated GMV PRORATED TO THE SELECTED PERIOD (annual × months / 12).
   * Every other figure in the row is period-scoped; leaving the estimate annual
   * made the comparison — and the take rate built on it — mix units.
   */
  value: number | null;
  /** The un-prorated annual figure. Account SIZE (GMV bands) must not move with the period. */
  annual: number | null;
  /**
   * The source claims to be our own measurement (Medido / Piso de red) but the
   * figure does not match the sell cube over a full year. Penetration against
   * it is NOT tautological, and the estimate should be re-derived upstream.
   */
  unverified: boolean;
  /** What the sell cube actually measures over a fixed year, annualized. */
  measured_annual: number | null;
  /** The estimate sat below what we measured inside the selected window, so the
   *  window's own measurement replaced it. The estimate is wrong for this period. */
  period_floored: boolean;
  source: string | null;
  is_floor: boolean;
  confidence: 'Alta' | 'Baja' | null;
  days_observed: number | null;
}

export interface FeesByChannel {
  ecom: number;
  k2k: number;
  api: number;
  indirect: number;
}

export interface Potential {
  gmv_reference: GmvReference;
  gmv_pace: { value: number | null; daily_rate: number | null; confidence: string | null } | null;
  gmv_external: { value: number | null; methods: string[]; confidence: string | null } | null;
  gmv_ora: { value: number } | null;
  buy_gmv_estimated: {
    value: number | null;
    annual: number | null;
    /** 'ratio' = Est GMV × 0,45. 'floor' = lo reemplazó la compra medida, que era mayor. */
    source: 'ratio' | 'floor' | null;
    /** La compra medida del período superaba al estimado prorrateado. */
    period_floored: boolean;
  };

  /** Koronet sell / buy GMV inside the selected period. */
  koronet_sell_period: Ev<number>;
  koronet_buy_period: Ev<number>;
  /** Same range one year earlier (YoY baseline). */
  sell_prior_period: Ev<number>;
  buy_prior_period: Ev<number>;

  sell_online_pct: Ev<number>;
  buy_online_pct: Ev<number>;
  sell_offline_period: Ev<number>;
  buy_offline_period: Ev<number>;

  sell_penetration: Ev<number>;
  buy_penetration: Ev<number>;

  /** Billed fees inside the selected period (ecom + k2k + api). */
  fees_period: Ev<number>;
  fees_prior_period: Ev<number>;
  fees_by_channel: { value: FeesByChannel | null };
  fees_yoy_pct: Ev<number>;

  /** Direct = billed on the sell side. Indirect = what the account's suppliers
   *  pay when it buys through fee-carrying channels, at each seller's realised
   *  rate. Take rate = (direct + indirect) / (est buy + est sell). */
  fees_direct: Ev<number>;
  fees_indirect: Ev<number>;
  fees_total: Ev<number>;
  buy_attributed: Ev<number>;
  indirect_by_channel: { value: { ecom: number; k2k: number; api: number } | null };
  indirect_rate: Ev<number>;
  self_sale_gmv: Ev<number>;
  take_rate: Ev<number>;

  /** Movement vs the same range one year earlier. Amounts in %, percentages in pp. */
  trends: TrendMap;
  /** Why a metric is empty, when it is. */
  reasons: ReasonMap;

  sell_yoy_delta: Delta | null;
  buy_yoy_delta: Delta | null;
  sell_mom_delta: MomDelta | null;
  buy_mom_delta: MomDelta | null;
  fees_mom_delta: MomDelta | null;
}

export interface MonthlySellTotal {
  month: string;
  sell_gmv: number;
  sell_online: number;
  sell_offline: number;
  self_sale_gmv: number;
}

export interface MonthlyBuyTotal {
  month: string;
  buy_gmv: number;
  buy_online: number;
  buy_offline: number;
}

export interface BucketSummary {
  buckets: Record<string, { orders?: number; gmv?: number; avg_days?: number }>;
  total_orders: number;
  avg_days: number | null;
}

export interface SourcingTable {
  period_total: number | null;
  prior_period_total: number | null;
  yoy_delta: Delta | null;
  monthly: Record<string, MonthlyBuyTotal>;
  current_month: MonthlyBuyTotal | null;
  current_month_key: string | null;
  prior_month: MonthlyBuyTotal | null;
  prior_month_key: string | null;
  ev: EvidenceState;
}

export interface BuyDomain {
  sourcing_table: Ev<SourcingTable> | null;
  k2k_lifecycle: Ev<LooseRecord> | null;
  vendor_lifecycle: Ev<LooseRecord> | null;
  anticipation_online: Ev<BucketSummary> | null;
  anticipation_offline: Ev<BucketSummary> | null;
  categories_top20: Ev<unknown> | null;
  leakage: Ev<LooseRecord> | null;
  skus_online_offline: Ev<LooseRecord> | null;
  catalog_reach: Ev<CatalogReach> | null;
}

export interface FreshnessGroup {
  buckets: Record<string, { variety_count?: number; avg_days?: number }>;
  total_varieties: number;
}

export interface ConfigEvidence {
  raw: LooseRecord | null;
  bunches_reality: LooseRecord | null;
  sfdc: LooseRecord | null;
  company_name: string | null;
  company_industry: string | null;
  ev: EvidenceState;
}

export interface VarietyFreshness {
  online: FreshnessGroup | null;
  offline: FreshnessGroup | null;
  ev: EvidenceState;
}

export interface ListDomain {
  inventory_current: Ev<{ by_type: unknown; by_division: unknown; totals: unknown;
    /** Fecha de la foto: el inventario no sigue el selector de período. */
    as_of: string | null; ev: EvidenceState }> | null;
  variety_freshness: Ev<VarietyFreshness> | null;
  forward_inventory: Ev<{ by_bucket: Record<string, LooseRecord>; ev: EvidenceState }> | null;
  tam_lost: null;
  config: Ev<ConfigEvidence> | null;
}

export interface BuyersTable {
  online_buyers: number | null;
  offline_buyers: number | null;
  total_buyers: number | null;
  l30d_online: number | null;
  l30d_offline: number | null;
  aov_online: number | null;
  aov_offline: number | null;
  new_month: number | null;
  churned: number | null;
  ev: EvidenceState;
}

/**
 * Alcance online del catálogo, por dimensión.
 *
 * `offline_only` es una DIFERENCIA DE CONJUNTOS (total − online): lo que nunca
 * tocó un canal online. No es `offline − online`, que es lo que hace el
 * dashboard legacy y da negativos en 141 de 330 cuentas porque los dos conteos
 * se solapan.
 */
export interface CatalogDim {
  total: number;
  online: number;
  offline_only: number;
  coverage_pct: number | null;
  /** Mediana de la red, para leer la cobertura contra algo. */
  network_median: number | null;
  /** p90: el techo de la red. Suele ser 100% — la distribución es bimodal. */
  network_p90: number | null;
}

export interface CatalogReach {
  /** Ventana fija de 12 meses cerrados: no sigue el selector de período. */
  window: string;
  categories: CatalogDim;
  varieties: CatalogDim;
  skus: CatalogDim;
}

export interface SellDomain {
  buyers_table: Ev<BuyersTable> | null;
  cvr: Ev<unknown> | null;
  new_user_cvr: Ev<unknown> | null;
  repeat_rate: Ev<unknown> | null;
  concentration: Ev<unknown> | null;
  hardgoods: Ev<LooseRecord> | null;
  sell_online_period: Ev<number>;
  sell_offline_period: Ev<number>;
  sell_total_period: Ev<number>;
  monthly_series: Ev<MonthlySellTotal[]> | null;
  current_month: MonthlySellTotal | null;
  prior_month: MonthlySellTotal | null;
  catalog_reach: Ev<CatalogReach> | null;
}

export interface BenchmarkMetric {
  description: string | null;
  network: BenchmarkNetwork | null;
  segment: BenchmarkNetwork | null;
  median: number | null;
  p75: number | null;
  p90: number | null;
  best_account: string | null;
  best_value: number | null;
  seg_median: number | null;
  seg_p75: number | null;
  seg_p90: number | null;
}

export interface Benchmarks {
  segment: string;
  per_metric: Record<string, BenchmarkMetric>;
}

export interface Freshness {
  as_of: string;
  sources_used: number;
  sources_total: number;
  coverage_pct: number;
  sources: { source: string; found: boolean; as_of: string | null }[];
}

/** The full evidence object for one account — what every UI component consumes. */
import type { Period } from './period';

export interface AccountEvidence {
  _company_id: string;
  _company_name: string | null;
  _period: Period;
  identity: Identity;
  potential: Potential | null;
  buy: BuyDomain | null;
  list: ListDomain | null;
  sell: SellDomain | null;
  benchmarks: Benchmarks | null;
  freshness: Freshness | null;
}

export interface LoadedState {
  loaded: boolean;
  accounts_v3_count: number;
  sell_cube_companies: number;
  sell_cube_rows: number;
  buy_cube_companies: number;
  buy_cube_rows: number;
  fees_cube_companies: number;
  fees_cube_rows: number;
  gmv_pacing_count: number;
  gmv_external_count: number;
  buyers_count: number;
  vendors_count: number;
  inventory_count: number;
  benchmarks_count: number;
  config_count: number;
  hardgoods_count: number;
  name_to_id_count: number;
  id_to_name_count: number;
}
