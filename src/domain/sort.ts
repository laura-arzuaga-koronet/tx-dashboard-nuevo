/** Column sorting for the portfolio table. */
import type { AccountEvidence } from '../data/adapter/types';
import type { SfdcOppTotals } from '../data/sfdc/openOpportunities';
import { evValue } from './format';
import { calcAtStake } from './metrics';

export type SortKey =
  | 'name' | 'est_sell' | 'koronet_sell' | 'sell_pen' | 'online_pct'
  | 'est_buy' | 'koronet_buy' | 'buy_pen' | 'buy_online_pct'
  | 'fees' | 'fees_indirect' | 'take_rate' | 'at_stake';

export type SortDir = 'asc' | 'desc';

export interface SortState {
  key: SortKey;
  dir: SortDir;
}

export const DEFAULT_SORT: SortState = { key: 'fees', dir: 'desc' };

export function getSortValue(ev: AccountEvidence, key: SortKey, sfdc: SfdcOppTotals): number | string | null {
  const p = ev.potential;
  switch (key) {
    case 'name': return (ev._company_name ?? '').toLowerCase();
    case 'est_sell': return p?.gmv_reference?.value ?? null;
    case 'koronet_sell': return p ? evValue(p.koronet_sell_period) : null;
    case 'sell_pen': return p ? evValue(p.sell_penetration) : null;
    case 'online_pct': return p ? evValue(p.sell_online_pct) : null;
    case 'est_buy': return p?.buy_gmv_estimated?.value ?? null;
    case 'koronet_buy': return p ? evValue(p.koronet_buy_period) : null;
    case 'buy_pen': return p ? evValue(p.buy_penetration) : null;
    case 'buy_online_pct': return p ? evValue(p.buy_online_pct) : null;
    case 'fees': return p ? evValue(p.fees_direct) : null;
    case 'fees_indirect': return p ? evValue(p.fees_indirect) : null;
    case 'take_rate': return p ? evValue(p.take_rate) : null;
    case 'at_stake': return calcAtStake(ev, sfdc)?.amount ?? null;
  }
}

/** Toggle direction on the same key; new keys default to desc (name → asc). */
export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key === key) return { key, dir: current.dir === 'desc' ? 'asc' : 'desc' };
  return { key, dir: key === 'name' ? 'asc' : 'desc' };
}

/** Stable sort; nulls always last regardless of direction. */
export function sortEvidence(list: readonly AccountEvidence[], sort: SortState, sfdc: SfdcOppTotals): AccountEvidence[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    const va = getSortValue(a, sort.key, sfdc);
    const vb = getSortValue(b, sort.key, sfdc);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string' && typeof vb === 'string') return sign * va.localeCompare(vb);
    return sign * ((va as number) - (vb as number));
  });
}

/** Default ordering when data loads: fees desc, then name. */
export function defaultOrder(list: readonly AccountEvidence[]): AccountEvidence[] {
  return [...list].sort((a, b) => {
    const fa = a.potential?.fees_direct?.value ?? 0;
    const fb = b.potential?.fees_direct?.value ?? 0;
    if (fb !== fa) return fb - fa;
    return (a._company_name ?? '').localeCompare(b._company_name ?? '');
  });
}
