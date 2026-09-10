/**
 * Section builders — turn the store's raw indexes into the normalized
 * `AccountEvidence` sections. Business rules (Piso de red, penetration,
 * 45% buy estimate, take rate threshold…) live here and ONLY here.
 */
import {
  aggregateBuyCube,
  aggregateFeesCube,
  aggregateSellCube,
  buyMonthlyTotals,
  computeMomDelta,
  delta,
  ev,
  num,
  selectPeriod,
  sellMonthlyTotals,
  sid,
  sumRange,
  aggregateIndirectCube,
  isOnlineChannel,
  sumRangeWhere,
  feesMonthlyTotals,
  pctChange,
  ppChange,
  INDIRECT_STATUSES,
} from './helpers';
import { DEFAULT_ANCHOR, covers, shiftMonth, type MonthRange, type Period } from './period';
import { store } from './store';
import type {
  TrendMap,
  ReasonMap,
  MetricReason,
  Benchmarks,
  BucketSummary,
  BuyDomain,
  BuyersTable,
  ConfigEvidence,
  EvidenceState,
  Freshness,
  FreshnessGroup,
  GmvReference,
  Identity,
  ListDomain,
  LooseRecord,
  MonthlyBuyTotal,
  Potential,
  SellDomain,
  SourcingTable,
  TemporalRow,
  VarietyFreshness,
} from './types';

/** Ratio of buy GMV to sell GMV for wholesalers (Christine measured). */
export const BUY_TO_SELL_RATIO = 0.45;
/** Minimum YTD sell for a take rate to be meaningful. */
export const TAKE_RATE_MIN_SELL = 10_000;
/**
 * How far a "Medido" / "Piso de red" estimate may sit from our own annualized
 * measurement before we stop believing the label.
 *
 * Those two sources claim the estimate IS our measurement, which is what makes
 * penetration against them tautological (~100%). The claim was never checked:
 * accounts_v3 was generated on an earlier window and before the cube gained the
 * R4 guard, the sale_item_id dedup and the self-sale split, so many labels no
 * longer match what we measure — the median of the 41 labelled accounts sits at
 * 0.83 of its label, and Ninfa at 0.13. Printing "~100% · Koronet = primary"
 * for those asserts something the data contradicts.
 */
export const TAUTOLOGY_TOLERANCE = 0.10;

const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

/* ── IDENTITY ─────────────────────────────────────────────────────────── */
export function buildIdentity(companyId: string): Identity | null {
  const rec = store.accountById[companyId];
  if (!rec) return null;
  return {
    company_id: rec.company_id != null ? sid(rec.company_id) : null,
    company_name: rec.company_name || null,
    account_class: rec.account_class || null,
    business_type: rec.business_type || null,
    segment: rec.segment || null,
    product_tier: rec.product_tier || null,
    sell_channel: rec.sell_channel || null,
    potential_tier: rec.potential_tier || null,
    impl_stage_display: rec.impl_stage_display || null,
    digital_pct_caveat: rec.digital_pct_caveat || null,
    has_active_pmt: rec.has_active_pmt || false,
    pmt_lead: rec.pmt_lead || null,
    pmt_status: rec.pmt_status || null,
    pmt_health: rec.pmt_health || null,
    priority_level: rec.priority_level || null,
    engagement_status: rec.engagement_status || null,
    komet_status: rec.komet_status || null,
    industry: rec.industry || null,
    sfdc_id: rec.sfdc_id || null,
    impl_stage: str(rec.impl_stage),
    impl_type: str(rec.impl_type),
    ct_id: str(rec.ct_id),
    sfdc_type: str(rec.sfdc_type),
    digital_pct: num(rec.digital_pct),
    has_eshop: rec.has_eshop || false,
    has_procurement: rec.has_procurement || false,
    in_christine_sheet: rec.in_christine_sheet || false,
    city: null,
    location: null,
    am_name: null,
    account_manager: null,
    status: null,
  };
}

/* ── POTENTIAL ────────────────────────────────────────────────────────── */
/**
 * Annualization factor for a period: 12 / months WITH DATA inside the range.
 * For full-year and L12M periods with complete data this is 1.
 */
function annualize(monthsWithData: number): number {
  return monthsWithData > 0 ? 12 / monthsWithData : 0;
}

/**
 * Fraction of a year the selected period covers — the factor that brings the
 * annual Est GMV down to the period every other column is measured over.
 *
 * The estimate is annual by construction (the Christine cascade, ORA, the
 * external model all emit a yearly figure). It has no monthly series, so
 * prorating is a flat split: 8/12 for YTD through August, 6/12 for H1, 1 for
 * the two 12-month periods. That is an assumption of even seasonality and it
 * is wrong at the month level for a flower business — but it is the only
 * split the source data supports, and it is far less wrong than comparing
 * eight months of measured flow against twelve months of estimate.
 */
function periodFraction(period: Period): number {
  return period.months > 0 ? period.months / 12 : 1;
}

/**
 * Fixed trailing-12-month window for the "Piso de red" rules.
 *
 * The floor asks a yearly question — does what this account moves in a year
 * exceed the yearly estimate? — so it must be evaluated over a fixed year, not
 * over whichever window is selected. Evaluated per period it made the ANNUAL
 * estimate a function of the selector, and an account could change GMV band
 * just by switching to H1: the account did not change, the window did.
 */
function floorWindow(): MonthRange {
  const to = store.cubeMeta.sell?.period_to;
  const anchor = typeof to === 'string' && /^\d{4}-\d{2}$/.test(to) ? to : DEFAULT_ANCHOR;
  return { from: shiftMonth(anchor, -11), to: anchor };
}

export function buildPotential(companyId: string, period: Period): Potential {
  const acct = store.accountById[companyId] ?? ({} as Partial<Identity> & Record<string, unknown>);
  const frac = periodFraction(period);

  // GMV reference (Christine cascade, from accounts_v3)
  let gmvRef = num(acct.gmv_reference);
  let gmvSource = (acct.gmv_source as string | null) || null;
  let gmvIsFloor = Boolean(acct.gmv_is_floor);
  /* `gmv_is_floor` de accounts_v3 NO alcanza para decir "esto es nuestra
     medición": 47 cuentas lo traen en true con gmv_source = 'Estimado' y sin
     ficha en los archivos de estimación, así que su significado no es
     rastreable. Tratarlas como medidas ponía 45 cuentas del portafolio en 100%
     de penetración exacto sin declararlo tautológico. Solo confiamos en el piso
     que derivamos nosotros en esta corrida. */
  let floorDerivedHere = false;
  let buyGmvEst = num(acct.buy_gmv_estimated);
  /* De dónde salió el Est Buy que se muestra. La tarjeta lo etiquetaba siempre
     como "ratio 45%", pero cuando la compra medida supera esa estimación la
     regla del piso la reemplaza — y entonces el número que se ve es medición,
     no modelo. Decir lo contrario invita a discutir el 45% cuando el 45% ni
     siquiera intervino. */
  let buyEstSource: 'ratio' | 'floor' | null = buyGmvEst ? 'ratio' : null;

  let gmvConfidence: GmvReference['confidence'] = null;
  /* 'Medido (parcial)' = la cuenta dejó de vender dentro de la ventana, así que
     el valor es la suma real sin proyectar. 'Medido (histórico)' = no vendió nada
     en la ventana y el valor viene de su último año con actividad: sigue siendo
     medición nuestra, pero vieja, y por eso no llega a confianza Alta. */
  if (gmvSource === 'Medido' || gmvSource === 'Piso de red' || gmvSource === 'Medido (parcial)') gmvConfidence = 'Alta';
  else if (gmvSource === 'Medido (histórico)') gmvConfidence = 'Baja';
  else if (gmvSource === 'ORA' || gmvSource === 'FCS') gmvConfidence = 'Baja';

  // Pacing
  const paceRec = store.pacingById[companyId] ?? null;
  const gmvPace = paceRec
    ? { value: num(paceRec.annual_pace), daily_rate: num(paceRec.daily_rate), confidence: paceRec.confidence ?? null }
    : null;

  // External estimate
  const extRec = store.externalById[companyId] ?? null;
  const gmvExternal = extRec
    ? { value: num(extRec.estimated_gmv_mid), methods: extRec.methods_used ?? [], confidence: extRec.confidence ?? null }
    : null;

  const gmvOra = gmvSource === 'ORA' && gmvRef ? { value: gmvRef } : null;

  // Cubes — everything below is scoped to `period` (and `period.prior` for YoY).
  // A YoY baseline is only reported when the cube actually covers the whole prior
  // range; otherwise a partial baseline would fake a huge growth number.
  const sellRows = store.sellCubeById[companyId] ?? [];
  const sellAgg = aggregateSellCube(sellRows, period);
  /* Same cube, fixed trailing year — feeds the floor rules only. */
  const sellYearAgg = aggregateSellCube(sellRows, floorWindow());
  const sellPriorCovered = covers(store.coverage.sell, period.prior);
  // Cubierto pero sin filas de esta compañía = 0, no "sin dato": la ausencia
  // de ventas en un mes cubierto es un cero real.
  const sellPrior = sellPriorCovered ? (sumRange(sellRows, 'sell_gmv', period.prior) ?? 0) : null;

  const buyRows = store.buyCubeById[companyId] ?? [];
  const buyAgg = aggregateBuyCube(buyRows, period);
  const buyPriorCovered = covers(store.coverage.buy, period.prior);
  const buyPrior = buyPriorCovered ? (sumRange(buyRows, 'buy_gmv', period.prior) ?? 0) : null;

  const feesRows = store.feesCubeById[companyId] ?? [];
  const feesAgg = aggregateFeesCube(feesRows, period);
  const feesPeriod = feesAgg ? feesAgg.total : null;
  const feesByChannel = feesAgg ? feesAgg.byChannel : null;
  const feesPriorCovered = covers(store.coverage.fees, period.prior);
  const feesPrior = feesPriorCovered ? (sumRange(feesRows, 'fee_amount', period.prior) ?? 0) : null;
  const notCovered = 'prior period not fully covered by data';

  /* Indirect fees — what this account's SUPPLIERS pay when it buys through
     fee-carrying channels. Koronet bills the seller, so that value never shows
     up against the buyer. The buyer is identified through K2K_CONNECTIONS
     (a deterministic id join, not name matching), and the fee already carries
     each seller's realised rate. */
  const indirectRows = store.indirectCubeById[companyId] ?? [];
  const indirectAgg = aggregateIndirectCube(indirectRows, period);
  const feesIndirect = indirectAgg ? indirectAgg.fees : null;
  const buyAttributed = indirectAgg ? indirectAgg.attributed : null;
  const indirectPriorCovered = covers(store.coverage.indirect, period.prior);
  const indirectPrior = indirectPriorCovered
    ? (sumRangeWhere(indirectRows, 'indirect_fee', period.prior, (r) => INDIRECT_STATUSES.has(r.connection_status)) ?? 0)
    : null;

  const feesDirect = feesPeriod;
  let feesTotal: number | null = (feesDirect ?? 0) + (feesIndirect ?? 0);
  if (!feesDirect && !feesIndirect) feesTotal = null;

  const sellOffline = sellAgg && sellAgg.offline > 0 ? sellAgg.offline : null;
  const buyOffline = buyAgg && buyAgg.offline > 0 ? buyAgg.offline : null;
  const koronetSell = sellAgg ? sellAgg.total : null;
  const koronetBuy = buyAgg ? buyAgg.total : null;
  const onlineSell = sellAgg ? sellAgg.online : 0;
  const onlineBuy = buyAgg ? buyAgg.online : 0;

  // Penetration + "Piso de red" rule: Est GMV can never be below what we already measure.
  let sellPenetration: number | null = null;
  let sellPenEv: EvidenceState = 'gap';
  let sellPenNote: string | null = null;
  let buyPenetration: number | null = null;
  let buyPenEv: EvidenceState = 'gap';
  let buyPenNote: string | null = null;

  const noReference = !gmvRef || gmvRef <= 0 || gmvSource === 'not in Christine cascade' || gmvSource === 'Sin dato';

  // Rule D: no GMV reference but Koronet activity → auto Piso de red
  const yearSell = sellYearAgg ? sellYearAgg.total : null;
  const yearMonths = sellYearAgg ? sellYearAgg.months.length : 0;
  /* 0 medido no es lo mismo que "no medido": si la cuenta tiene filas en el año
     y suman cero, eso es una medición de cero y así se reporta.
     
     La anualización sigue la misma regla que scripts/rebuild_accounts_gmv.py, que
     es quien produce el gmv_reference contra el que esto se compara: se anualiza
     solo si la cuenta seguía vendiendo en el último mes de la ventana. Si dejó de
     vender adentro, proyectar sus meses activos a doce inventaría volumen que ya
     no genera — y hacía que el propio archivo que acabamos de recalcular quedara
     marcado "no verificado" contra el adapter. */
  const lastSellInWindow = sellYearAgg?.months?.length
    ? [...sellYearAgg.months].sort().pop() ?? null
    : null;
  const stoppedInWindow = lastSellInWindow != null && lastSellInWindow < floorWindow().to;
  const annualizedSell = sellYearAgg && yearMonths > 0
    ? (yearSell ?? 0) * (stoppedInWindow ? 1 : annualize(yearMonths))
    : null;

  if (noReference && annualizedSell && annualizedSell > 0) {
    gmvRef = annualizedSell;
    gmvSource = 'Piso de red';
    gmvConfidence = 'Alta';
    gmvIsFloor = true;
    floorDerivedHere = true;
    buyGmvEst = gmvRef * BUY_TO_SELL_RATIO;
    buyEstSource = 'ratio';
  }

  /* Two separate questions, and conflating them was the bug.
   *
   * The FLOOR is annual and about the account: does what it moves in a year
   * exceed the yearly estimate? It must not depend on the selected window —
   * gated on activity inside the period, an account that sold nothing in H1
   * kept a stale low estimate and dropped a GMV band on switching to H1.
   *
   * PENETRATION is period-over-period: what we captured in the window against
   * the estimate prorated to that same window. */
  const hasReference = gmvRef && gmvRef > 0
    && gmvSource !== 'not in Christine cascade' && gmvSource !== 'Sin dato';

  const buyYearAgg = aggregateBuyCube(buyRows, floorWindow());
  const annualizedBuy = buyYearAgg && buyYearAgg.months.length > 0
    ? buyYearAgg.total * annualize(buyYearAgg.months.length) : null;

  if (hasReference && annualizedSell && annualizedSell > gmvRef!
      && !/^(Medido|Piso)/.test(gmvSource ?? '')) {
    // Estimate was wrong — Koronet already exceeds it over a full year.
    gmvRef = annualizedSell;
    gmvSource = 'Piso de red';
    gmvConfidence = 'Alta';
    gmvIsFloor = true;
    floorDerivedHere = true;
    buyGmvEst = gmvRef * BUY_TO_SELL_RATIO;
    buyEstSource = 'ratio';
  }
  if (hasReference && buyGmvEst && buyGmvEst > 0 && annualizedBuy && annualizedBuy > buyGmvEst) {
    buyGmvEst = annualizedBuy;
    buyEstSource = 'floor';
  }

  /* Trust, but verify. A label of Medido / Piso de red only earns the
     tautological ~100% when the figure actually agrees with the sell cube over
     a full year; otherwise we compute the real penetration and mark the source
     as unverified, so the disagreement is visible instead of hidden behind a
     round number. Accounts whose floor WE derived this run match by
     construction and always pass. */
  /* 'Medido (histórico)' queda fuera a propósito: su cifra es de otra ventana, así
     que no puede sostener una penetración tautológica sobre esta. */
  const claimsMeasured = /^(Medido|Piso)/.test(gmvSource ?? '') && gmvSource !== 'Medido (histórico)';
  const cubeAgrees = annualizedSell != null && gmvRef != null && gmvRef > 0
    && Math.abs(annualizedSell - gmvRef) / gmvRef <= TAUTOLOGY_TOLERANCE;
  const estUnverified = claimsMeasured && !cubeAgrees;

  /** The estimate IS our own measurement, and it checks out against the cube. */
  const estIsMeasured = (floorDerivedHere || claimsMeasured) && !estUnverified;

  /**
   * Prorating the estimate to the period.
   *
   * For an estimate that comes from OUTSIDE our data (ORA, the external
   * framework), a flat annual × months / 12 is all the source supports.
   *
   * But when the estimate IS our own measurement — a network floor, or a
   * "Medido" that verified against the cube — a flat slice fights the very
   * measurement it came from. The annual figure is computed over a FIXED
   * trailing year so that account size does not move with the selector;
   * slicing that evenly then understates any window where the account was
   * busier than its yearly average, and is nonsense for a window in the past.
   * Metropetals bought $466K in Jan–Aug 2026 against a prorated "estimate" of
   * $371K — 126%, hidden behind the 100% cap — and a trailing-2026 floor
   * applied to Full 2025 produced 613.066% for FreshLink, which stopped
   * selling in 2026.
   *
   * So for a measured estimate, the period value IS the period measurement.
   * `annual` keeps the fixed-window figure for the GMV bands. When the account
   * measured nothing in the window we fall back to the flat slice, so the
   * column still conveys scale instead of collapsing to $0.
   */
  const proratePeriod = (annual: number | null, measured: number | null, isMeasured: boolean): number | null => {
    if (annual == null) return null;
    if (isMeasured && measured && measured > 0) return measured;
    const slice = annual * frac;
    /* The "Piso de red" rule, applied to the WINDOW instead of only to the year:
       an estimate can never sit below what we measured inside that same window.
       Capping penetration at 100% instead used to bury the contradiction —
       FreshLink carries a $639 estimate labelled "Medido" against $3.92M of
       measured 2025 sell, and the table showed a tidy 100%. The floor rule
       could not reach it because the account stopped selling in 2026, so the
       fixed trailing year has no rows to annualize. */
    return measured && measured > slice ? measured : slice;
  };
  const gmvRefPeriod = proratePeriod(gmvRef, koronetSell, estIsMeasured);
  const buyGmvEstPeriod = proratePeriod(buyGmvEst, koronetBuy, buyEstSource === 'floor');
  /** The window's own measurement had to raise the estimate: it was too low for this period. */
  const sellPeriodFloored = !estIsMeasured && koronetSell != null && gmvRef != null
    && koronetSell > gmvRef * frac;
  const buyPeriodFloored = buyEstSource !== 'floor' && koronetBuy != null && buyGmvEst != null
    && koronetBuy > buyGmvEst * frac;

  if (gmvRef && gmvRef > 0 && gmvSource !== 'not in Christine cascade' && gmvSource !== 'Sin dato') {
    const isTautological = claimsMeasured && cubeAgrees;

    if (koronetSell && koronetSell > 0) {
      sellPenetration = isTautological ? 100 : (koronetSell / (gmvRefPeriod ?? gmvRef * frac)) * 100;
      sellPenEv = isTautological ? 'tautological' : estUnverified ? 'proxy' : gmvConfidence === 'Alta' ? 'model' : 'proxy';
      sellPenNote = sellPeriodFloored ? `${gmvSource} — estimado por debajo de lo medido en el período`
        : estUnverified ? `${gmvSource} — no verificado` : gmvSource;
    }

    if (buyGmvEst && buyGmvEst > 0 && koronetBuy && koronetBuy > 0) {
      /* La compra es tautológica SOLO cuando su propio estimado salió del piso
         medido: ahí el denominador ES el numerador anualizado y el 100% es una
         identidad, no un resultado.
         Antes esto además heredaba la tautología del lado de venta
         (`isTautological || sellPenEv === 'tautological'`), y esa herencia era
         un error del mismo tipo que el que arreglamos en venta: 35 cuentas con
         Est Buy de modelo (ratio 45%) mostraban ~100% sin que nadie hubiera
         comparado nada. Pacifica Produce compra $0 contra un estimado de $23K y
         figuraba al 100%; Chilfresh compra el 3,8% de su estimado; Mayesh el
         85,9%. Que la venta sea nuestra medición no dice absolutamente nada
         sobre cuánto de su compra pasa por Koronet. */
      const buyTaut = buyEstSource === 'floor';
      buyPenetration = buyTaut ? 100 : (koronetBuy / (buyGmvEstPeriod ?? buyGmvEst * frac)) * 100;
      buyPenEv = buyTaut ? 'tautological' : estUnverified ? 'proxy' : gmvConfidence === 'Alta' ? 'model' : 'proxy';
      buyPenNote = buyTaut ? `${gmvSource} — identidad: el estimado es la compra medida`
        : buyPeriodFloored ? `${gmvSource} — estimado por debajo de lo comprado en el período`
        : estUnverified ? `${gmvSource} — no verificado` : gmvSource;
    }
  }

  // The prorated estimate can still sit below a single concentrated month.
  if (sellPenetration != null && sellPenetration > 100) sellPenetration = 100;
  if (buyPenetration != null && buyPenetration > 100) buyPenetration = 100;

  // Online % = online in the period / Est GMV of the period (same denominator as penetration)
  let sellOnlinePct: number | null = null;
  if (koronetSell && koronetSell > 0 && gmvRef && gmvRef > 0) {
    sellOnlinePct = onlineSell > 0 ? (onlineSell / (gmvRefPeriod ?? gmvRef * frac)) * 100 : 0;
  }
  let buyOnlinePct: number | null = null;
  if (koronetBuy && koronetBuy > 0 && buyGmvEst && buyGmvEst > 0) {
    buyOnlinePct = onlineBuy > 0 ? (onlineBuy / (buyGmvEstPeriod ?? buyGmvEst * frac)) * 100 : 0;
  }
  // online ⊂ total → online% ≤ penetration%
  if (sellOnlinePct != null && sellPenetration != null && sellOnlinePct > sellPenetration) sellOnlinePct = sellPenetration;
  if (buyOnlinePct != null && buyPenetration != null && buyOnlinePct > buyPenetration) buyOnlinePct = buyPenetration;

  /* Take rate = (Direct + Indirect Fees) / (Estimated Buy + Estimated Sell).
     Was fees / koronet_sell: that measured execution over the volume we already
     move and was bounded by the fee rate itself. The denominator is now the
     account's whole addressable flow, so the number reads much lower — that is
     the point, not a regression. */
  /* Both sides of the take rate now span the same months: fees billed in the
     period over the flow estimated for that period. Against the annual
     denominator the YTD take rate came out 12/8 too low purely because of the
     unit mismatch. */
  const estFlow = (gmvRefPeriod ?? 0) + (buyGmvEstPeriod ?? 0);
  let takeRate: number | null = null;
  if (feesTotal && estFlow > TAKE_RATE_MIN_SELL * frac) {
    takeRate = (feesTotal / estFlow) * 100;
  }

  /* Trends — every metric recomputed over period.prior with the SAME formula
     and denominator, so the delta reflects the metric moving and not the method
     changing. Amounts in %, percentages in percentage points. Est GMV and Est
     Buy get none: a single annual figure with no time series behind it. */
  const priorSellOnline = sellPriorCovered
    ? sumRangeWhere(sellRows, 'sell_gmv', period.prior, (r) => isOnlineChannel(r.channel)) : null;
  /* buy_online does not exist before 2024-11: the first ten months of 2024 carry
     real buy_gmv and buy_offline but zero online, because sales_channel did not
     yet emit Web/Procurement/API. Comparing against that window would invent a
     jump from 0%. */
  const BUY_ONLINE_FROM = '2024-11';
  const buyOnlineCovered = buyPriorCovered && period.prior.from >= BUY_ONLINE_FROM;
  const priorBuyOnline = buyOnlineCovered ? (sumRange(buyRows, 'buy_online', period.prior) ?? 0) : null;

  /* The prior window is the same range shifted a year, so it spans the same
     number of months and gets the same prorated denominator. Using the annual
     estimate on one side and the prorated one on the other would show growth
     that is nothing but the change of unit. */
  const pen = (amount: number | null, denomAnnual: number | null): number | null =>
    amount == null || !denomAnnual || denomAnnual <= 0
      ? null : (amount / (denomAnnual * frac)) * 100;
  /* La ventana anterior no tiene medición propia acá, así que conserva el
     reparto plano: es el único denominador comparable entre las dos ventanas. */
  const priorSellPen = pen(sellPrior, gmvRef);
  let priorSellOnPct = pen(priorSellOnline, gmvRef);
  const priorBuyPen = pen(buyPrior, buyGmvEst);
  let priorBuyOnPct = pen(priorBuyOnline, buyGmvEst);
  // Same ceiling as the current period, or the pp delta compares capped against uncapped.
  if (priorSellOnPct != null && priorSellPen != null && priorSellOnPct > priorSellPen) priorSellOnPct = priorSellPen;
  if (priorBuyOnPct != null && priorBuyPen != null && priorBuyOnPct > priorBuyPen) priorBuyOnPct = priorBuyPen;

  let priorFeesTotal: number | null = (feesPrior ?? 0) + (indirectPrior ?? 0);
  if (!feesPrior && !indirectPrior) priorFeesTotal = null;
  const priorTakeRate = priorFeesTotal && estFlow > TAKE_RATE_MIN_SELL
    ? (priorFeesTotal / estFlow) * 100 : null;

  /* Est GMV moves YoY only when it IS our own measurement — "Medido" and "Piso
     de red" are derived from the sell cube, so they inherit that cube's trend.
     An ORA / FCS / external estimate is one annual number with nothing behind
     it: prorating it to two equal windows would print +0.0% and dress a
     missing series up as stability. */
  const trends: TrendMap = {
    gmv_reference: estIsMeasured ? pctChange(koronetSell, sellPrior) : null,
    buy_gmv_estimated: estIsMeasured ? pctChange(koronetSell, sellPrior) : null,
    koronet_sell: pctChange(koronetSell, sellPrior),
    sell_penetration: ppChange(sellPenetration, priorSellPen),
    sell_online_pct: ppChange(sellOnlinePct, priorSellOnPct),
    koronet_buy: pctChange(koronetBuy, buyPrior),
    buy_penetration: ppChange(buyPenetration, priorBuyPen),
    buy_online_pct: ppChange(buyOnlinePct, priorBuyOnPct),
    fees_direct: pctChange(feesDirect, feesPrior),
    fees_indirect: pctChange(feesIndirect, indirectPrior),
    take_rate: ppChange(takeRate, priorTakeRate),
  };

  /* Why a metric is empty. "$0" and "no data" read the same in a table and are
     very different decisions: an account with no online sales genuinely earns
     no fee, and that is not a gap. */
  /* Último mes con venta en TODO el cubo, para distinguir "dejó de vender" de
     "no sabemos". Una cuenta que facturó hasta diciembre y nada en el período
     es un cero con historia, no un hueco de datos: lo que hay que revisar es
     por qué paró, no si falta la fila. */
  const lastSellMonth = sellRows
    .filter((r) => (num(r.sell_gmv) ?? 0) > 0)
    .map((r) => r.month)
    .sort()
    .pop() ?? null;
  const churned = lastSellMonth != null && lastSellMonth < period.from;
  const cfgConf = (store.config[companyId]?.config ?? {}) as Record<string, unknown>;
  const feesAllOff = cfgConf.ecommerce_fee === false && cfgConf.k2k_fee === false && cfgConf.api_fee === false;
  const isK2kBuyer = indirectRows.length > 0;
  const isLive = acct.komet_status === 'Production - Live';
  const why = (value: number | null, cases: Array<[boolean, 'cero' | 'gap', string]>): MetricReason | null => {
    if (value != null && value !== 0) return null;
    for (const [cond, kind, note] of cases) if (cond) return { kind, note };
    return { kind: 'gap', note: 'no data' };
  };
  const reasons: ReasonMap = {
    gmv_reference: why(gmvRef, [
      [gmvSource === 'No vende (Koronet)', 'cero', 'does not sell through Koronet'],
      [gmvSource === 'Sin dato' || !gmvSource, 'gap', 'outside the Est GMV cascade'],
    ]),
    koronet_sell_period: why(koronetSell, [
      [!isLive, 'cero', 'not live yet'],
      /* La cascada de Est GMV ya resolvió que esta cuenta no vende por Koronet;
         el cero de la columna de venta es su consecuencia, no un dato faltante. */
      [gmvSource === 'No vende (Koronet)', 'cero', 'the Est GMV cascade records it as not selling through Koronet'],
      /* Procurement compra por Koronet y no vende: no tiene lado de venta que medir. */
      [acct.product_tier === 'Procurement', 'cero', 'Procurement tier: it buys through Koronet, it does not sell'],
      /* Sus filas de venta existen, pero el cliente es la propia empresa: son
         compras suyas espejadas en la tabla de ventas. Cero real, no hueco —
         sin este caso, 37 cuentas del portafolio se leían como "falta dato". */
      [(sellAgg?.selfSale ?? 0) > 0, 'cero', 'its «sales» are its own purchases mirrored (self-sale): it does not sell through Koronet'],
      [churned, 'cero', `last sale ${lastSellMonth} — nothing in this period`],
      [true, 'gap', 'live but no sales in the period'],
    ]),
    koronet_buy_period: why(koronetBuy, [
      [!isLive, 'cero', 'not live yet'],
      [true, 'cero', 'does not buy through Koronet in the period'],
    ]),
    sell_penetration: why(sellPenetration, [
      [!gmvRef, 'gap', 'no Est GMV to compare against'],
      [!koronetSell, 'cero', 'no sales in the period'],
    ]),
    sell_online_pct: why(sellOnlinePct, [
      [!koronetSell, 'cero', 'no sales in the period'],
      [true, 'cero', 'sells, but nothing online'],
    ]),
    buy_penetration: why(buyPenetration, [
      [!buyGmvEst, 'gap', 'no Est Buy to compare against'],
      [!koronetBuy, 'cero', 'no purchases in the period'],
    ]),
    buy_online_pct: why(buyOnlinePct, [
      [!koronetBuy, 'cero', 'no purchases in the period'],
      [true, 'cero', 'buys, but all offline'],
    ]),
    fees_direct: why(feesDirect, [
      [feesAllOff, 'cero', 'fees disabled in its configuration'],
      [!sellOnlinePct, 'cero', 'no online sales: earns no fee'],
      [true, 'gap', 'sells online but records no fee — review'],
    ]),
    fees_indirect: why(feesIndirect, [
      [!isK2kBuyer, 'cero', 'not a buyer in any K2K connection'],
      [true, 'gap', 'K2K buyer but no attributed purchases'],
    ]),
    take_rate: why(takeRate, [
      [!feesTotal, 'cero', 'no fees in the period'],
      [estFlow <= TAKE_RATE_MIN_SELL * frac, 'gap', 'Est Buy + Est Sell for the period too small: the ratio would be noise'],
    ]),
  };

  const feesYoy = feesPeriod && feesPrior ? delta(feesPeriod, feesPrior) : null;
  const daysObserved = paceRec ? num(paceRec.days_observed) : null;

  return {
    gmv_reference: { value: gmvRefPeriod, annual: gmvRef, source: gmvSource, is_floor: gmvIsFloor, confidence: gmvConfidence, days_observed: daysObserved, unverified: estUnverified, measured_annual: annualizedSell, period_floored: sellPeriodFloored },
    gmv_pace: gmvPace,
    gmv_external: gmvExternal,
    gmv_ora: gmvOra,
    buy_gmv_estimated: { value: buyGmvEstPeriod, annual: buyGmvEst, source: buyEstSource, period_floored: buyPeriodFloored },

    koronet_sell_period: ev(koronetSell, koronetSell ? 'observed' : 'gap', 'sell cube'),
    koronet_buy_period: ev(koronetBuy, koronetBuy ? 'observed' : 'gap', 'buy cube'),
    sell_prior_period: ev(sellPrior, sellPrior ? 'observed' : 'gap', sellPriorCovered ? null : notCovered),
    buy_prior_period: ev(buyPrior, buyPrior ? 'observed' : 'gap', buyPriorCovered ? null : notCovered),

    sell_online_pct: ev(sellOnlinePct, sellOnlinePct != null ? 'observed' : 'gap'),
    buy_online_pct: ev(buyOnlinePct, buyOnlinePct != null ? 'observed' : 'gap'),
    sell_offline_period: ev(sellOffline, sellOffline ? 'observed' : 'gap'),
    buy_offline_period: ev(buyOffline, buyOffline ? 'observed' : 'gap'),

    sell_penetration: ev(sellPenetration, sellPenEv, sellPenNote),
    buy_penetration: ev(buyPenetration, buyPenEv, buyPenNote),

    fees_period: ev(feesPeriod, feesPeriod ? 'observed' : 'gap', 'fees cube'),
    fees_prior_period: ev(feesPrior, feesPrior ? 'observed' : 'gap', feesPriorCovered ? 'fees cube' : notCovered),
    fees_by_channel: { value: feesByChannel },
    fees_yoy_pct: ev(feesYoy ? feesYoy.pct : null, feesYoy ? 'observed' : 'gap'),
    fees_direct: ev(feesDirect, feesDirect ? 'observed' : 'gap', 'fees cube'),
    fees_indirect: ev(feesIndirect, feesIndirect ? 'model' : 'gap', 'K2K attribution × seller realised rate'),
    fees_total: ev(feesTotal, feesTotal ? 'model' : 'gap'),
    buy_attributed: ev(buyAttributed, buyAttributed ? 'observed' : 'gap', 'K2K attribution'),
    indirect_by_channel: { value: indirectAgg ? indirectAgg.byChannel : null },
    indirect_rate: ev(indirectAgg?.effectiveRate != null ? indirectAgg.effectiveRate * 100 : null,
                      indirectAgg?.effectiveRate != null ? 'observed' : 'gap',
                      'realised rate of this account\u2019s sellers'),
    self_sale_gmv: ev(sellAgg?.selfSale ? sellAgg.selfSale : null,
                      sellAgg?.selfSale ? 'observed' : 'gap',
                      'sell cube · customer_name = the company itself'),
    take_rate: ev(takeRate, takeRate != null ? 'model' : 'gap', '(direct+indirect fees) / (est buy + est sell)'),
    trends,
    reasons,

    sell_yoy_delta: koronetSell && sellPrior ? delta(koronetSell, sellPrior) : null,
    buy_yoy_delta: koronetBuy && buyPrior ? delta(koronetBuy, buyPrior) : null,
    sell_mom_delta: computeMomDelta(sellMonthlyTotals(filterUpTo(sellRows, period.to)), 'sell_gmv'),
    buy_mom_delta: computeMomDelta(buyMonthlyTotals(filterUpTo(buyRows, period.to)), 'buy_gmv'),
    fees_mom_delta: computeMomDelta(feesMonthlyTotals(feesRows), 'fee_amount'),
  };
}

/** Rows up to and including the period's last month (MoM is measured at the period's end). */
function filterUpTo<R extends { month?: string }>(rows: R[], to: string): R[] {
  return rows.filter((r) => !!r.month && r.month <= to);
}

/* ── BUY DOMAIN ───────────────────────────────────────────────────────── */
function summarizeBuckets(rows: TemporalRow[]): BucketSummary {
  const buckets: BucketSummary['buckets'] = {};
  let totalOrders = 0;
  let weightedDays = 0;
  for (const r of rows) {
    buckets[r.bucket ?? ''] = { orders: r.total_orders, gmv: r.total_gmv, avg_days: r.avg_days };
    totalOrders += r.total_orders ?? 0;
    weightedDays += (r.avg_days ?? 0) * (r.total_orders ?? 0);
  }
  return { buckets, total_orders: totalOrders, avg_days: totalOrders > 0 ? weightedDays / totalOrders : null };
}

export function buildBuy(companyId: string, period: Period): BuyDomain {
  const name = store.idToName[companyId];
  const vendRec = store.vendorsById[companyId] ?? (name ? store.vendorsByName[name] ?? null : null);
  const saRows = store.temporalSAById[companyId] ?? (name ? store.temporalSAByName[name] ?? null : null);
  const skusRec = store.skusById[companyId] ?? (name ? store.skusOnlineOffline[name] ?? null : null);

  const buyRows = store.buyCubeById[companyId] ?? [];
  const monthly = buyMonthlyTotals(buyRows);
  const buyAgg = aggregateBuyCube(buyRows, period);
  const buyPrior = covers(store.coverage.buy, period.prior) ? (sumRange(buyRows, 'buy_gmv', period.prior) ?? 0) : null;

  let sourcingTable: SourcingTable | null = null;
  if (monthly.length) {
    const byMonth: Record<string, MonthlyBuyTotal> = {};
    for (const m of monthly) byMonth[m.month] = m;
    const sp = selectPeriod(byMonth, period);
    sourcingTable = {
      period_total: buyAgg ? buyAgg.total : null,
      prior_period_total: buyPrior,
      yoy_delta: buyAgg && buyPrior ? delta(buyAgg.total, buyPrior) : null,
      monthly: byMonth,
      current_month: sp.current,
      current_month_key: sp.current ? sp.current.month : null,
      prior_month: sp.prior,
      prior_month_key: sp.prior ? sp.prior.month : null,
      ev: 'observed',
    };
  }

  const k2kLifecycle = (vendRec?.k2k_connections as LooseRecord | undefined) || null;
  const vendorLifecycle = (vendRec?.vendor_lifecycle as LooseRecord | undefined) || null;
  const categoriesTop20 = vendRec?.categories_top20 || null;
  const leakage = (vendRec?.vendor_leakage as LooseRecord | undefined) || null;

  let anticipationOnline: BucketSummary | null = null;
  let anticipationOffline: BucketSummary | null = null;
  if (saRows && saRows.length) {
    const online = saRows.filter((r) => r.channel_type === 'online');
    const offline = saRows.filter((r) => r.channel_type === 'offline');
    anticipationOnline = online.length ? summarizeBuckets(online) : null;
    anticipationOffline = offline.length ? summarizeBuckets(offline) : null;
  }

  return {
    sourcing_table: sourcingTable ? ev(sourcingTable, 'observed', 'buy cube + vendors_evidence_v2') : null,
    k2k_lifecycle: k2kLifecycle ? ev(k2kLifecycle, 'observed', 'vendors_evidence_v2') : null,
    vendor_lifecycle: vendorLifecycle ? ev(vendorLifecycle, 'observed', 'vendors_evidence_v2') : null,
    anticipation_online: anticipationOnline ? ev(anticipationOnline, 'observed', 'temporal sell_anticipation') : null,
    anticipation_offline: anticipationOffline ? ev(anticipationOffline, 'observed', 'temporal sell_anticipation') : null,
    categories_top20: categoriesTop20 ? ev(categoriesTop20, 'observed', 'vendors_evidence_v2') : null,
    leakage: leakage ? ev(leakage, 'observed', 'vendors_evidence_v2') : null,
    skus_online_offline: skusRec ? ev(skusRec, 'observed', 'skus_online_offline') : null,
  };
}

/* ── LIST DOMAIN ──────────────────────────────────────────────────────── */
function groupFreshness(rows: TemporalRow[]): FreshnessGroup {
  const buckets: FreshnessGroup['buckets'] = {};
  let total = 0;
  for (const r of rows) {
    buckets[r.freshness_bucket ?? ''] = { variety_count: r.variety_count, avg_days: r.avg_days_since };
    total += r.variety_count ?? 0;
  }
  return { buckets, total_varieties: total };
}

export function buildList(companyId: string): ListDomain {
  const name = store.idToName[companyId];
  const invRec = store.inventory[companyId] ?? null;
  const cfgRec = store.config[companyId] ?? null;
  const vfRows = store.temporalVFById[companyId] ?? (name ? store.temporalVFByName[name] ?? null : null);
  const fiRows = store.temporalFIById[companyId] ?? (name ? store.temporalFIByName[name] ?? null : null);

  const inventoryCurrent = invRec
    ? { by_type: invRec.by_inventory_type || null, by_division: invRec.by_inventory_division || null, totals: invRec.totals || null, ev: 'observed' as const }
    : null;

  let varietyFreshness: VarietyFreshness | null = null;
  if (vfRows && vfRows.length) {
    const online = vfRows.filter((r) => r.channel_type === 'online');
    const offline = vfRows.filter((r) => r.channel_type === 'offline');
    varietyFreshness = {
      online: online.length ? groupFreshness(online) : null,
      offline: offline.length ? groupFreshness(offline) : null,
      ev: 'observed',
    };
  }

  let forwardInventory: { by_bucket: Record<string, LooseRecord>; ev: EvidenceState } | null = null;
  if (fiRows && fiRows.length) {
    const byBucket: Record<string, LooseRecord> = {};
    for (const r of fiRows) {
      byBucket[r.horizon_bucket ?? ''] = {
        prebook_lines: r.prebook_lines,
        total_value: r.total_value,
        distinct_vendors: r.distinct_vendors,
        distinct_products: r.distinct_products,
      };
    }
    forwardInventory = { by_bucket: byBucket, ev: 'observed' };
  }

  const config: ConfigEvidence | null = cfgRec
    ? {
        raw: (cfgRec.config as LooseRecord | undefined) || null,
        bunches_reality: (cfgRec.bunches_reality as LooseRecord | undefined) || null,
        sfdc: (cfgRec.sfdc as LooseRecord | undefined) || null,
        company_name: (cfgRec.company_name as string | undefined) || null,
        company_industry: (cfgRec.company_industry as string | undefined) || null,
        ev: 'observed',
      }
    : null;

  return {
    inventory_current: inventoryCurrent ? ev(inventoryCurrent, 'observed', 'inventory_current_v1') : null,
    variety_freshness: varietyFreshness ? ev(varietyFreshness, 'observed', 'temporal variety_freshness') : null,
    forward_inventory: forwardInventory ? ev(forwardInventory, 'observed', 'temporal forward_inventory_depth') : null,
    tam_lost: null,
    config: config ? ev(config, 'observed', 'config_evidence_v2') : null,
  };
}

/* ── SELL DOMAIN ──────────────────────────────────────────────────────── */
export function buildSell(companyId: string, period: Period): SellDomain {
  const name = store.idToName[companyId];
  const buyRec = store.buyersById[companyId] ?? (name ? store.buyers[name] ?? null : null);
  const hgRec = name ? store.hardgoodsByName[name] ?? null : null;

  const sellRows = store.sellCubeById[companyId] ?? [];
  const monthly = sellMonthlyTotals(sellRows);

  // Latest month inside the period, and the month before it (MoM reference).
  const byMonth: Record<string, (typeof monthly)[number]> = {};
  for (const m of monthly) byMonth[m.month] = m;
  const sp = selectPeriod(byMonth, period);
  const currentMonth = sp.current;
  const priorMonth = sp.prior;

  let buyersTable: BuyersTable | null = null;
  const bd = buyRec?.buyers as LooseRecord | undefined;
  if (bd) {
    buyersTable = {
      online_buyers: num(bd.online_buyers),
      offline_buyers: num(bd.offline_buyers),
      total_buyers: num(bd.total_buyers),
      l30d_online: num(bd.l30d_online),
      l30d_offline: num(bd.l30d_offline),
      aov_online: num(bd.aov_online) || null,
      aov_offline: num(bd.aov_offline) || null,
      new_month: num(bd.new_month) || null,
      churned: num(bd.churned) || null,
      ev: 'observed',
    };
  }

  const hardgoods: LooseRecord | null = hgRec
    ? {
        hardgoods_total: num(hgRec.hardgoods_total),
        hardgoods_online: num(hgRec.hardgoods_online),
        hardgoods_offline: num(hgRec.hardgoods_offline),
        hardgoods_online_pct: num(hgRec.hardgoods_online_pct),
        plants_total: num(hgRec.plants_total),
        plants_online: num(hgRec.plants_online),
        plants_offline: num(hgRec.plants_offline),
        plants_online_pct: num(hgRec.plants_online_pct),
        ct_id: hgRec.ct_id || null,
        ev: 'observed',
      }
    : null;

  const agg = aggregateSellCube(sellRows, period);
  const sellOnline = agg && agg.online > 0 ? agg.online : null;
  const sellOffline = agg && agg.offline > 0 ? agg.offline : null;
  const sellTotal = agg && agg.total > 0 ? agg.total : null;

  const cvr = buyRec?.login_cvr ?? null;
  const newUserCvr = buyRec?.new_user_cvr ?? null;
  const repeatRate = buyRec?.repeat_rate ?? null;
  const concentration = buyRec?.concentration ?? null;

  return {
    buyers_table: buyersTable ? ev(buyersTable, 'observed', 'buyers_evidence_v2') : null,
    cvr: cvr ? ev(cvr, 'observed', 'buyers_evidence_v2') : null,
    new_user_cvr: newUserCvr ? ev(newUserCvr, 'observed', 'buyers_evidence_v2') : null,
    repeat_rate: repeatRate ? ev(repeatRate, 'observed', 'buyers_evidence_v2') : null,
    concentration: concentration ? ev(concentration, 'observed', 'buyers_evidence_v2') : null,
    hardgoods: hardgoods ? ev(hardgoods, 'observed', 'hardgoods_v2') : null,
    sell_online_period: ev(sellOnline, sellOnline ? 'observed' : 'gap'),
    sell_offline_period: ev(sellOffline, sellOffline ? 'observed' : 'gap'),
    sell_total_period: ev(sellTotal, sellTotal ? 'observed' : 'gap'),
    monthly_series: monthly.length ? ev(monthly, 'observed', 'sell cube') : null,
    current_month: currentMonth,
    prior_month: priorMonth,
  };
}

/* ── BENCHMARKS ───────────────────────────────────────────────────────── */
export function buildBenchmarks(companyId: string): Benchmarks | null {
  const acct = store.accountById[companyId];
  const ctId = (acct?.ct_id as string | undefined) ?? '';
  const bmarks = store.benchmarks;
  if (!bmarks || !Object.keys(bmarks).length) return null;

  const result: Benchmarks = { segment: ctId, per_metric: {} };
  for (const [key, bm] of Object.entries(bmarks)) {
    const network = bm.network ?? null;
    const seg = bm.by_segment && ctId ? bm.by_segment[ctId] ?? null : null;
    result.per_metric[key] = {
      description: bm.description ?? null,
      network,
      segment: seg,
      median: network?.median ?? null,
      p75: network?.p75 ?? null,
      p90: network?.p90 ?? null,
      best_account: network?.best_account ?? null,
      best_value: network?.best_value ?? null,
      seg_median: seg?.median ?? null,
      seg_p75: seg?.p75 ?? null,
      seg_p90: seg?.p90 ?? null,
    };
  }
  return result;
}

/* ── FRESHNESS / SOURCE COVERAGE ─────────────────────────────────────── */
export function buildFreshness(companyId: string): Freshness {
  const id = companyId;
  const name = store.idToName[id];
  const has = (arr: unknown[] | undefined) => !!(arr && arr.length);

  const checks: [string, boolean][] = [
    ['accounts_v3', !!store.accountById[id]],
    ['sell_cube', has(store.sellCubeById[id])],
    ['buy_cube', has(store.buyCubeById[id])],
    ['fees_cube', has(store.feesCubeById[id])],
    ['gmv_pacing', !!store.pacingById[id]],
    ['gmv_external', !!store.externalById[id]],
    ['buyers_evidence', !!(store.buyersById[id] || (name && store.buyers[name]))],
    ['vendors_evidence', !!(store.vendorsById[id] || (name && store.vendorsByName[name]))],
    ['temporal', has(store.temporalSAById[id]) || (!!name && has(store.temporalSAByName[name]))],
    ['inventory_current', !!store.inventory[id]],
    ['benchmarks', Object.keys(store.benchmarks).length > 0],
    ['config_evidence', !!store.config[id]],
    ['hardgoods', name ? !!store.hardgoodsByName[name] : false],
  ];

  const sources = checks.map(([source, found]) => ({ source, found, as_of: null }));
  const foundCount = sources.filter((s) => s.found).length;
  return {
    as_of: new Date().toISOString().slice(0, 10),
    sources_used: foundCount,
    sources_total: sources.length,
    coverage_pct: Math.round((foundCount / sources.length) * 100),
    sources,
  };
}
