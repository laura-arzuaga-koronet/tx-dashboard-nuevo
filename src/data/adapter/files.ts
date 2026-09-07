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
