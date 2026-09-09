/**
 * Data file registry — the single place that knows where each JSON lives.
 * Paths are relative to the app's base URL (Vite's `import.meta.env.BASE_URL`)
 * so the build works both at the domain root and under a GitHub Pages subpath.
 */

const DATA_BASE = `${import.meta.env.BASE_URL}data/`;

export const DATA_FILES = {
  // V3 — accounts universe + monthly cubes
  accountsV3: `${DATA_BASE}accounts_v3.json`,
  sellCube: `${DATA_BASE}current/sell_monthly.json`,
  buyCube: `${DATA_BASE}current/buy_monthly.json`,
  feesCube: `${DATA_BASE}current/fees_monthly.json`,
  indirectCube: `${DATA_BASE}current/indirect_fees_monthly.json`,
  whUniverse: `${DATA_BASE}wholesaler_universe.json`,
  gmvPacing: `${DATA_BASE}gmv_pacing.json`,
  gmvExternal: `${DATA_BASE}gmv_estimates_external.json`,

  // V2 — evidence files (buyers, vendors, temporal, inventory, benchmarks, config, hardgoods, skus)
  buyers: `${DATA_BASE}buyers_evidence_v2.json`,
  vendors: `${DATA_BASE}vendors_evidence_v2.json`,
  temporal: `${DATA_BASE}temporal_evidence_v2.json`,
  inventory: `${DATA_BASE}inventory_current_v1.json`,
  benchmarks: `${DATA_BASE}benchmarks_v2.json`,
  config: `${DATA_BASE}config_evidence_v2.json`,
  hardgoods: `${DATA_BASE}hardgoods_v2.json`,
  skusOnlineOffline: `${DATA_BASE}skus_online_offline.json`,

  // Salesforce — open opportunities (loaded outside the adapter)
  sfdcOpenOpportunities: `${DATA_BASE}sfdc_open_opportunities_v1.json`,
} as const;

export type DataFileKey = keyof typeof DATA_FILES;

/**
 * Known-bad company-months, dropped when the cubes are indexed.
 *
 * Ninfa Flowers reports Apr–Oct 2025 three orders of magnitude above its own
 * baseline — $268,182,503 in April 2025 against months of $6K–$627K, with a
 * single source line of $31,239,146. Left in, it is 20% of the buy cube.
 * PROCUREMENT_DETAILS has no equivalent of the model's `sales < 100000` guard,
 * so nothing upstream filters it; it needs a fix at the source.
 */
export const BAD_CUBE_ROWS: Readonly<Record<'sell' | 'buy', ReadonlyArray<{
  companyId: string; from: string; to: string; reason: string;
}>>> = {
  buy: [
    { companyId: '640977', from: '2025-04', to: '2025-10',
      reason: 'Valores 3 órdenes de magnitud sobre su propia línea base (verificado 2026-09-08)' },
  ],
  sell: [],
};

export function isBadCubeRow(cube: 'sell' | 'buy', companyId: string, month: string | undefined): boolean {
  if (!month) return false;
  return BAD_CUBE_ROWS[cube].some((b) => b.companyId === companyId && month >= b.from && month <= b.to);
}

/** Training / sandbox / demo accounts excluded from every view. */
export const EXCLUDED_COMPANY_IDS: ReadonlySet<string> = new Set([
  '561353', '549016', '6316', '554582',
  '531246', '531265', '55326', '751276',
  '132431', '468006', '398804', '806094',
]);

/**
 * Fetch a JSON file. Never throws: a 404 or parse error resolves to `null`
 * so a single missing file degrades gracefully instead of blanking the app.
 */
export async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn('[EvidenceAdapter] HTTP', res.status, url);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn('[EvidenceAdapter] fetch error:', url, err);
    return null;
  }
}
