/**
 * Card 2 · OPPORTUNITIES — the interventions detected for the account, each with
 * the money it puts in play and the evidence behind it.
 *
 * Ported from the legacy `renderOpportunitiesCard`. The legacy card ranked the
 * interventions BUY → LIST → SELL → CONFIG and derived a single bottleneck from
 * that same chain, because config issues gate everything downstream.
 */
import type { AccountEvidence, LooseRecord } from '../../../data/adapter/types';
import type { SfdcOppTotals } from '../../../data/sfdc/openOpportunities';
import { evValue, fmtInt, fmtMoney, fmtPct } from '../../../domain/format';
import { calcAtStake, detectOpportunityFlags } from '../../../domain/metrics';
import { CardFocus, CardGap, CardNext, CardRow, CardSection, CardTable, EvidenceCard } from '../EvidenceCard';

type OppType = 'BUY' | 'LIST' | 'SELL' | 'CONFIG';
type Effort = 'quick fix' | 'investigation' | 'audit';

interface Opp {
  type: OppType;
  effort: Effort;
  /** What is in play for this single intervention; null when it cannot be priced. */
  amount: number | null;
  desc: string;
  /** Where the supporting detail lives. The legacy anchor never navigated, so this is text only. */
  ref: string | null;
}

/** Prerequisite chain: config gates supply, supply gates demand. */
const TYPE_ORDER: Record<OppType, number> = { BUY: 0, LIST: 1, SELL: 2, CONFIG: 3 };

const LEAKAGE_MIN = 10_000;
const VARIETY_GAP_MIN = 100;
const DECLINE_PCT_MAX = -5;
const ZERO_TX_SELL_MAX = 500;

function numField(rec: unknown, key: string): number | null {
  if (rec == null || typeof rec !== 'object') return null;
  const v = (rec as Record<string, unknown>)[key];
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** MaxAge lives under three different names across config generations. */
function readMaxAge(raw: LooseRecord | null): number | null {
  if (!raw) return null;
  for (const key of ['ecommerce_max_age', 'max_age_sell', 'MaxAge']) {
    const n = numField(raw, key);
    if (n != null) return Math.trunc(n);
  }
  return null;
}

function readBunchFlag(raw: LooseRecord | null): unknown {
  if (!raw) return null;
  if (raw.is_on_hand_inventory_units != null) return raw.is_on_hand_inventory_units;
  if (raw.sell_in_bunches != null) return raw.sell_in_bunches;
  if (raw.bunches != null) return raw.bunches;
  return null;
}

export function OpportunitiesCard({ ev, sfdcTotals }: { ev: AccountEvidence; sfdcTotals: SfdcOppTotals }) {
  const p = ev.potential;
  if (!p) {
    return (
      <EvidenceCard label="Card 2 · OPPORTUNITIES" headline="No data to detect interventions" defaultOpen={false}>
        <CardGap>This account has no row in accounts_v3 or in the cubes.</CardGap>
      </EvidenceCard>
    );
  }

  const stake = calcAtStake(ev, sfdcTotals);
  const flags = detectOpportunityFlags(ev);
  const opps: Opp[] = [];

  const sellOffline = evValue(p.sell_offline_period);
  const buyOffline = evValue(p.buy_offline_period);
  const buyOnlinePct = evValue(p.buy_online_pct);

  const k2k = ev.buy?.k2k_lifecycle?.value ?? null;
  const vendorLc = ev.buy?.vendor_lifecycle?.value ?? null;
  const k2kEligible = numField(k2k, 'no_k2k') ?? numField(k2k, 'inactive_connections');

  /* ── BUY: procurement offline a $0 de fees ── */
  if (buyOffline != null && buyOffline > 0) {
    const offlineVendors = numField(vendorLc, 'offline_vendors');
    const desc = [
      `${offlineVendors != null ? `${fmtInt(offlineVendors)} suppliers` : 'Suppliers'} with offline procurement today — ${fmtMoney(buyOffline, true)} with no fees.`,
      k2kEligible != null ? `${fmtInt(k2kEligible)} eligible for K2K.` : null,
    ].filter(Boolean).join(' ');
    opps.push({ type: 'BUY', effort: 'quick fix', amount: buyOffline, desc, ref: 'BUY card' });
  }

  /* ── LIST: config (MaxAge, bunches) ── */
  const cfg = ev.list?.config?.value ?? null;
  const cfgRaw = cfg?.raw ?? null;
  const bunchesRealityFlag = cfg?.bunches_reality?.actually_sells_bunches_ecom;
  const actuallyBunches = typeof bunchesRealityFlag === 'boolean' ? bunchesRealityFlag : null;

  const vf = ev.list?.variety_freshness?.value ?? null;
  const onlineVar = vf?.online ? vf.online.total_varieties || 0 : null;
  const offlineVar = vf?.offline ? vf.offline.total_varieties || 0 : null;
  const varietyGap = onlineVar != null && offlineVar != null ? Math.max(0, offlineVar - onlineVar) : null;

  const maxAge = readMaxAge(cfgRaw);
  const maxAgeBad = maxAge != null && maxAge < 30;
  const bunchFlag = readBunchFlag(cfgRaw);
  const bunchesOff = cfgRaw != null
    && (actuallyBunches === false || (actuallyBunches == null && (bunchFlag === false || bunchFlag === 0)));
  // Any config issue gates the LIST work downstream — drives the bottleneck pick.
  const configBlocker = (maxAgeBad || bunchesOff) && flags.hasList;

  if (maxAgeBad && flags.hasList) {
    const pctBlocked = varietyGap != null && offlineVar != null && offlineVar > 0
      ? Math.round((varietyGap / offlineVar) * 100)
      : null;
    const desc = [
      `MaxAge=${String(maxAge)} days — blocks forward inventory.`,
      varietyGap != null ? `${fmtInt(varietyGap)} offline varieties not visible online.` : 'Catalog depth blocked.',
      pctBlocked != null ? `${pctBlocked}% of the catalog hidden.` : null,
    ].filter(Boolean).join(' ');
    // No priced impact: the legacy card never attached a $ figure to MaxAge.
    opps.push({ type: 'LIST', effort: 'investigation', amount: null, desc, ref: 'LIST card' });
  }

  if (bunchesOff && flags.hasList) {
    const desc = [
      'Bunches format disabled — retail TAM blocked.',
      sellOffline != null ? `${fmtMoney(sellOffline, true)} of offline GMV in bunches invisible online.` : null,
    ].filter(Boolean).join(' ');
    opps.push({ type: 'LIST', effort: 'quick fix', amount: sellOffline, desc, ref: 'LIST card' });
  }

  /* ── SELL: activación de compradores offline ── */
  const bt = ev.sell?.buyers_table?.value ?? null;
  const offlineBuyers = bt?.offline_buyers ?? null;
  if (offlineBuyers != null && offlineBuyers > 0) {
    const desc = [
      `${fmtInt(offlineBuyers)} offline buyers never invited to the eShop.`,
      bt?.aov_online ? `Online AOV: ${fmtMoney(bt.aov_online, true)}.` : null,
    ].filter(Boolean).join(' ');
    // Priced as the online AOV they would each carry over.
    const amount = bt?.aov_online ? offlineBuyers * bt.aov_online : null;
    opps.push({ type: 'SELL', effort: 'audit', amount, desc, ref: 'SELL card' });
  }

  /* ── BUY: leakage de vendors conectados a K2K comprando offline ── */
  const leakage = ev.buy?.leakage?.value ?? null;
  const leakageCost = numField(leakage, 'leakage_cost');
  if (leakageCost != null && leakageCost > LEAKAGE_MIN) {
    const leakageVendors = numField(leakage, 'vendor_count');
    const desc = leakageVendors != null
      ? `${fmtInt(leakageVendors)} K2K-connected vendors buying ${fmtMoney(leakageCost, true)} offline. Recoverable with no new connections.`
      : `K2K-connected vendors buying ${fmtMoney(leakageCost, true)} offline. Recoverable with no new connections.`;
    opps.push({ type: 'BUY', effort: 'quick fix', amount: leakageCost, desc, ref: 'BUY card' });
  }

  /* ── BUY: conexiones K2K dormidas ── */
  const dormant = numField(k2k, 'dormant');
  if (dormant != null && dormant > 0) {
    opps.push({
      type: 'BUY',
      effort: 'investigation',
      amount: null,
      desc: `${fmtInt(dormant)} dormant K2K connections — connected but never bought. Investment left unactivated.`,
      ref: 'BUY card',
    });
  }

  /* ── LIST: gap de variedades ── */
  if (varietyGap != null && varietyGap > VARIETY_GAP_MIN) {
    opps.push({
      type: 'LIST',
      effort: 'audit',
      amount: null,
      desc: `${fmtInt(varietyGap)} varieties sold offline that are not shown online — catalog depth hidden from the online buyer.`,
      ref: 'LIST card',
    });
  }

  /* ── SELL: tendencia declinante ── */
  const yoyPct = p.sell_yoy_delta?.pct ?? null;
  if (flags.isDeclining && yoyPct != null && yoyPct < DECLINE_PCT_MAX) {
    opps.push({
      type: 'SELL',
      effort: 'investigation',
      amount: null,
      desc: `Sell GMV falling ${fmtPct(Math.abs(yoyPct), 1)} YoY. Investigate: inventory? pricing? buyer churn?`,
      ref: 'SELL card',
    });
  }

  /* ── CONFIG: implementación cerrada con 0 transacciones ── */
  const implStage = ev.identity?.impl_stage ?? null;
  const koronetSell = evValue(p.koronet_sell_period);
  if (implStage && (koronetSell == null || koronetSell < ZERO_TX_SELL_MAX)) {
    opps.push({
      type: 'CONFIG',
      effort: 'investigation',
      amount: null,
      desc: `Implementation complete (stage: ${implStage}) but almost no transactions. Configuration or activation problem.`,
      ref: null,
    });
  }

  if (!opps.length && stake == null) {
    return (
      <EvidenceCard label="Card 2 · OPPORTUNITIES" headline="No interventions detected" defaultOpen={false}>
        <CardGap>No BUY, LIST, SELL or CONFIG signal clears its threshold in this period.</CardGap>
      </EvidenceCard>
    );
  }

  opps.sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);

  const stakeLabel = stake?.source === 'sfdc' ? '(SFDC opps)' : 'scenario-based';
  const headline = `${fmtMoney(stake?.amount ?? null, true)} ${stakeLabel} at stake · ${opps.length} intervention${opps.length === 1 ? '' : 's'}`;

  const bottleneck = configBlocker
    ? (opps.find((o) => o.type === 'LIST') ?? opps[0] ?? null)
    : (opps[0] ?? null);

  const nextAction = buildNextAction(bottleneck, { k2kEligible, sellOffline, maxAge });

  const configIssues = [
    maxAgeBad ? `MaxAge=${String(maxAge)}` : null,
    bunchesOff ? 'Bunches OFF' : null,
  ].filter((s): s is string => s != null);

  const totalVarieties = numField(ev.list?.inventory_current?.value?.totals, 'total_varieties')
    ?? numField(ev.list?.inventory_current?.value?.totals, 'varieties');
  const industry = cfg?.company_industry ?? null;
  const productProfile = [
    ev.identity?.ct_id ? `ID: ${ev.identity.ct_id}` : null,
    industry ? industry.replace('Floral - ', '') : null,
    totalVarieties != null ? `${fmtInt(totalVarieties)} varieties` : null,
    cfgRaw ? (bunchesOff ? 'Boxes only' : 'Boxes + bunches') : null,
  ].filter(Boolean).join(' · ');

  const buyOfflinePct = buyOnlinePct != null ? Math.round(100 - buyOnlinePct) : null;

  return (
    <EvidenceCard label="Card 2 · OPPORTUNITIES" headline={headline}>
      <CardFocus>
        <strong>{fmtMoney(stake?.amount ?? null, true)}</strong>{' '}
        {stake?.source === 'sfdc'
          ? '— open opportunities in SFDC, taken from Salesforce.'
          : '— scenario: 12-month window at 10% conversion.'}
        {' '}Path: {opps.map((o) => o.type).join(' → ')}.
      </CardFocus>

      <CardTable
        head={['#', 'Front', 'Effort', 'At stake', 'Intervention']}
        rows={opps.map((o, i) => [
          `#${i + 1}`,
          <strong>{o.type}</strong>,
          o.effort,
          fmtMoney(o.amount, true),
          <>{o.desc}{o.ref ? <> <em>→ see {o.ref}</em></> : null}</>,
        ])}
      />

      <CardGap>
        Context: the main hypothesis (H-D1, unconfirmed) is that what drives offline buying
        is price, not configuration.
      </CardGap>

      <CardSection title="Profile and configuration">
        <CardRow label="Product profile" value={productProfile || '—'} tone={productProfile ? undefined : 'muted'} />
        <CardRow
          label="Configuration issues"
          value={configIssues.length ? `${configIssues.length} constraint${configIssues.length === 1 ? '' : 's'}` : 'None'}
          note={configIssues.length ? configIssues.join(' · ') : undefined}
          tone={configIssues.length ? 'amber' : 'muted'}
        />
      </CardSection>

      {bottleneck ? (
        <CardSection title="Bottleneck">
          <CardRow label={bottleneck.type} value={bottleneck.desc} tone="red" />
          <CardRow label="Next action" value={nextAction} />
        </CardSection>
      ) : null}

      <CardNext>
        → Continues in <strong>BUY</strong>:{' '}
        {buyOfflinePct != null && buyOfflinePct > 0
          ? `${buyOfflinePct}% of procurement is offline — how big is the buy gap?`
          : 'how big is the buy gap?'}
      </CardNext>
    </EvidenceCard>
  );
}

function buildNextAction(
  o: Opp | null,
  ctx: { k2kEligible: number | null; sellOffline: number | null; maxAge: number | null },
): string {
  if (!o) return 'Review the interventions above.';
  if (o.type === 'BUY') {
    return ctx.k2kEligible != null
      ? `Request K2K activation for ${fmtInt(ctx.k2kEligible)} eligible suppliers via CS · CS confirms within 48h.`
      : 'Identify offline suppliers eligible for K2K · request activation via CS.';
  }
  if (o.type === 'LIST') {
    if (o.effort === 'quick fix') {
      return ctx.sellOffline != null
        ? `Enable bunches in the eShop config · unblocks ${fmtMoney(ctx.sellOffline, true)} of offline GMV · 5-minute change · verify with ops after deploy.`
        : 'Enable the bunches format in the eShop config · 5-minute change · confirm with ops after deploy.';
    }
    return ctx.maxAge != null
      ? `Raise MaxAge from ${String(ctx.maxAge)} to 30+ days in the eShop config · unblocks the forward catalog · confirm impact with ops.`
      : 'Raise MaxAge to 30+ days in the eShop config · unblocks the forward catalog · confirm with ops.';
  }
  if (o.type === 'SELL') {
    return 'Export the offline buyer list · build a personalized eShop invitation campaign · start with the highest-GMV ones.';
  }
  return 'Audit the eShop config and the activation checklist · verify the implementation stage with CS · confirm the path to the first transaction is clear.';
}
