/**
 * Filtering — the dashboard's filter model and the pure function that applies it.
 * The UI owns a `FilterState`; this module never touches the DOM.
 */
import type { AccountEvidence } from '../data/adapter/types';
import { detectOpportunityFlags, getGmvBand } from './metrics';

/** Action tabs. `portfolio` shows every filtered account; the others narrow by opportunity flag. */
export type ActionTab = 'portfolio' | 'buy' | 'list' | 'sell' | 'config' | 'declining';

export interface FilterState {
  accountClass: string;
  businessType: string;
  segment: string;
  productTier: string;
  gmvBand: string;
  sellChannel: string;
  potentialTier: string;
  priorities: ReadonlySet<string>;
  impl: ReadonlySet<string>;
  search: string;
  actionTab: ActionTab;
}

export const DEFAULT_FILTERS: FilterState = {
  accountClass: 'Client',
  businessType: 'Wholesaler',
  segment: '',
  productTier: '',
  gmvBand: '',
  sellChannel: '',
  potentialTier: '',
  priorities: new Set(),
  impl: new Set(),
  search: '',
  actionTab: 'portfolio',
};

/** Impl chips that map to identity flags rather than `impl_stage_display` values. */
export const IMPL_CHIP_ACTIVE_PMT = 'active-pmt';
export const IMPL_CHIP_GO_LIVE_GROWTH = 'go-live-growth';

/** Does an account pass every filter except the action tab? */
export function matchesBaseFilters(ev: AccountEvidence, f: FilterState): boolean {
  const id = ev.identity;
  if (!id) return false;

  if (f.accountClass && (id.account_class ?? '') !== f.accountClass) return false;
  if (f.businessType && (id.business_type ?? '') !== f.businessType) return false;
  if (f.segment && (id.segment ?? '') !== f.segment) return false;
  if (f.productTier && (id.product_tier ?? '') !== f.productTier) return false;
  if (f.gmvBand && getGmvBand(ev) !== f.gmvBand) return false;
  if (f.sellChannel && (id.sell_channel ?? '') !== f.sellChannel) return false;
  if (f.priorities.size > 0 && !f.priorities.has(id.priority_level ?? '')) return false;
  if (f.potentialTier && (id.potential_tier ?? '') !== f.potentialTier) return false;

  if (f.impl.size > 0) {
    const matched =
      (f.impl.has(IMPL_CHIP_ACTIVE_PMT) && id.has_active_pmt) ||
      (f.impl.has(IMPL_CHIP_GO_LIVE_GROWTH) && id.pmt_status === 'Go-Live and Growth') ||
      f.impl.has(id.impl_stage_display ?? '');
    if (!matched) return false;
  }

  if (f.search) {
    const name = (ev._company_name ?? '').toLowerCase();
    if (!name.includes(f.search.toLowerCase().trim())) return false;
  }
  return true;
}

export function matchesActionTab(ev: AccountEvidence, tab: ActionTab): boolean {
  if (tab === 'portfolio') return true;
  const flags = detectOpportunityFlags(ev);
  switch (tab) {
    case 'buy': return flags.hasBuy;
    case 'list': return flags.hasList;
    case 'sell': return flags.hasSell;
    case 'config': return flags.hasConfig;
    case 'declining': return flags.isDeclining;
  }
}

export function applyFilters(all: readonly AccountEvidence[], f: FilterState): AccountEvidence[] {
  return all.filter((ev) => matchesBaseFilters(ev, f) && matchesActionTab(ev, f.actionTab));
}

/** Counts for the action tabs, computed over the base-filtered set. */
export interface ActionTabCounts {
  portfolio: number;
  buy: number;
  list: number;
  sell: number;
  config: number;
  declining: number;
}

export function countActionTabs(baseFiltered: readonly AccountEvidence[]): ActionTabCounts {
  const c: ActionTabCounts = { portfolio: baseFiltered.length, buy: 0, list: 0, sell: 0, config: 0, declining: 0 };
  for (const ev of baseFiltered) {
    const fl = detectOpportunityFlags(ev);
    if (fl.hasBuy) c.buy++;
    if (fl.hasList) c.list++;
    if (fl.hasSell) c.sell++;
    if (fl.hasConfig) c.config++;
    if (fl.isDeclining) c.declining++;
  }
  return c;
}

/** Business-type tab counts — respect account class + segment only (as in the legacy UI). */
export interface BusinessTypeCounts {
  Wholesaler: number;
  Importer: number;
  Grower: number;
  Retailer: number;
  all: number;
}

export function countBusinessTypes(all: readonly AccountEvidence[], f: FilterState): BusinessTypeCounts {
  const c: BusinessTypeCounts = { Wholesaler: 0, Importer: 0, Grower: 0, Retailer: 0, all: 0 };
  for (const ev of all) {
    const id = ev.identity;
    if (!id) continue;
    if (f.accountClass && id.account_class !== f.accountClass) continue;
    if (f.segment && (id.segment ?? '') !== f.segment) continue;
    c.all++;
    const bt = id.business_type as keyof BusinessTypeCounts | null;
    if (bt && bt in c && bt !== 'all') c[bt]++;
  }
  return c;
}

/** Chips shown in the top bar summarizing active filters. */
export interface ActiveChip {
  key: keyof FilterState | 'priority' | 'impl';
  value: string;
  label: string;
}

export function activeChips(f: FilterState): ActiveChip[] {
  const chips: ActiveChip[] = [];
  const single: [keyof FilterState, string][] = [
    ['accountClass', f.accountClass],
    ['businessType', f.businessType],
    ['segment', f.segment],
    ['productTier', f.productTier],
    ['gmvBand', f.gmvBand],
    ['sellChannel', f.sellChannel],
  ];
  for (const [key, value] of single) if (value) chips.push({ key, value, label: value });
  for (const p of f.priorities) chips.push({ key: 'priority', value: p, label: p });
  if (f.potentialTier) chips.push({ key: 'potentialTier', value: f.potentialTier, label: f.potentialTier });
  for (const i of f.impl) chips.push({ key: 'impl', value: i, label: i });
  if (f.search.trim()) chips.push({ key: 'search', value: f.search, label: `“${f.search.trim()}”` });
  return chips;
}
