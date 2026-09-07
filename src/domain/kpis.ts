/** Portfolio-level KPIs aggregated over the filtered account list. */
import type { AccountEvidence } from '../data/adapter/types';
import { evValue } from './format';

export interface PortfolioKpis {
  totalSell: number;
  totalFees: number;
  sellYoyPct: number | null;
  feesYoyPct: number | null;
  /** Online % weighted by sell GMV (the headline figure). */
  avgOnlinePct: number | null;
  /** Simple mean of per-account online % (shown as a secondary hint). */
  avgOnlinePctSimple: number | null;
  avgTakeRate: number | null;
  accountsWithData: number;
  total: number;
}

export function computeKpis(list: readonly AccountEvidence[]): PortfolioKpis {
  let totalSell = 0, totalFees = 0, totalOnlinePct = 0, totalTakeRate = 0;
  let totalOnlineGmv = 0, totalSellForOnline = 0;
  let totalSell2025 = 0, totalFees2025 = 0;
  let onlineCount = 0, trCount = 0, accountsWithData = 0;
  let hasSell2025 = false, hasFees2025 = false;

  for (const ev of list) {
    const p = ev.potential;
    if (!p) continue;

    const ks = evValue(p.koronet_sell_period);
    if (ks != null && ks > 0) { totalSell += ks; accountsWithData++; }

    const ks25 = evValue(p.sell_prior_period);
    if (ks25 != null && ks25 > 0) { totalSell2025 += ks25; hasSell2025 = true; }

    const f = evValue(p.fees_period);
    if (f != null) totalFees += f;

    const f25 = evValue(p.fees_prior_period);
    if (f25 != null) { totalFees2025 += f25; hasFees2025 = true; }

    const op = evValue(p.sell_online_pct);
    if (op != null) { totalOnlinePct += op; onlineCount++; }
    if (op != null && ks != null && ks > 0) { totalOnlineGmv += (op / 100) * ks; totalSellForOnline += ks; }

    const tr = evValue(p.take_rate);
    if (tr != null && tr > 0) { totalTakeRate += tr; trCount++; }
  }

  return {
    totalSell,
    totalFees,
    sellYoyPct: hasSell2025 && totalSell2025 > 0 ? ((totalSell - totalSell2025) / totalSell2025) * 100 : null,
    feesYoyPct: hasFees2025 && totalFees2025 > 0 ? ((totalFees - totalFees2025) / totalFees2025) * 100 : null,
    avgOnlinePct: totalSellForOnline > 0 ? (totalOnlineGmv / totalSellForOnline) * 100 : null,
    avgOnlinePctSimple: onlineCount > 0 ? totalOnlinePct / onlineCount : null,
    avgTakeRate: trCount > 0 ? totalTakeRate / trCount : null,
    accountsWithData,
    total: list.length,
  };
}
