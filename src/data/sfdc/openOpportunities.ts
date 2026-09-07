/**
 * Salesforce open opportunities — summed per SFDC account id.
 * Feeds the "$ at Stake" column (primary source) and, later, the Opportunities card.
 */
import { DATA_FILES, fetchJson } from '../adapter/files';

export interface SfdcOpportunity {
  opportunity_id: string;
  account_id: string;
  opp_name: string;
  stage: string;
  amount: number | string | null;
  close_date: string | null;
  owner: string | null;
  last_modified_at: string | null;
}

export interface SfdcOpportunitiesFile {
  generated_at?: string;
  source_contract?: string;
  records: SfdcOpportunity[];
}

/** sfdc account id → total open opportunity amount */
export type SfdcOppTotals = Record<string, number>;

export interface SfdcOpportunities {
  totals: SfdcOppTotals;
  byAccount: Record<string, SfdcOpportunity[]>;
  generatedAt: string | null;
}

export async function loadSfdcOpportunities(
  fetcher: <T>(url: string) => Promise<T | null> = fetchJson,
): Promise<SfdcOpportunities> {
  const data = await fetcher<SfdcOpportunitiesFile>(DATA_FILES.sfdcOpenOpportunities);
  const totals: SfdcOppTotals = {};
  const byAccount: Record<string, SfdcOpportunity[]> = {};
  if (data && Array.isArray(data.records)) {
    for (const rec of data.records) {
      if (!rec.account_id) continue;
      const amt = parseFloat(String(rec.amount)) || 0;
      totals[rec.account_id] = (totals[rec.account_id] ?? 0) + amt;
      (byAccount[rec.account_id] ??= []).push(rec);
    }
  }
  return { totals, byAccount, generatedAt: data?.generated_at ?? null };
}
