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
type Effort = 'arreglo rápido' | 'investigación' | 'auditoría';

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
      <EvidenceCard label="Card 2 · OPPORTUNITIES" headline="Sin datos para detectar intervenciones" defaultOpen={false}>
        <CardGap>Esta cuenta no tiene fila en accounts_v3 ni en los cubos.</CardGap>
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
      `${offlineVendors != null ? `${fmtInt(offlineVendors)} proveedores` : 'Proveedores'} con procurement offline hoy — ${fmtMoney(buyOffline, true)} sin fees.`,
      k2kEligible != null ? `${fmtInt(k2kEligible)} elegibles para K2K.` : null,
    ].filter(Boolean).join(' ');
    opps.push({ type: 'BUY', effort: 'arreglo rápido', amount: buyOffline, desc, ref: 'tarjeta BUY' });
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
      `MaxAge=${String(maxAge)} días — bloquea el inventario forward.`,
      varietyGap != null ? `${fmtInt(varietyGap)} variedades offline no visibles online.` : 'Profundidad de catálogo bloqueada.',
      pctBlocked != null ? `${pctBlocked}% del catálogo oculto.` : null,
    ].filter(Boolean).join(' ');
    // No priced impact: the legacy card never attached a $ figure to MaxAge.
    opps.push({ type: 'LIST', effort: 'investigación', amount: null, desc, ref: 'tarjeta LIST' });
  }

  if (bunchesOff && flags.hasList) {
    const desc = [
      'Formato bunches deshabilitado — TAM retail bloqueado.',
      sellOffline != null ? `${fmtMoney(sellOffline, true)} de GMV offline en bunches invisible online.` : null,
    ].filter(Boolean).join(' ');
    opps.push({ type: 'LIST', effort: 'arreglo rápido', amount: sellOffline, desc, ref: 'tarjeta LIST' });
  }

  /* ── SELL: activación de compradores offline ── */
  const bt = ev.sell?.buyers_table?.value ?? null;
  const offlineBuyers = bt?.offline_buyers ?? null;
  if (offlineBuyers != null && offlineBuyers > 0) {
    const desc = [
      `${fmtInt(offlineBuyers)} compradores offline nunca invitados al eShop.`,
      bt?.aov_online ? `AOV online: ${fmtMoney(bt.aov_online, true)}.` : null,
    ].filter(Boolean).join(' ');
    // Priced as the online AOV they would each carry over.
    const amount = bt?.aov_online ? offlineBuyers * bt.aov_online : null;
    opps.push({ type: 'SELL', effort: 'auditoría', amount, desc, ref: 'tarjeta SELL' });
  }

  /* ── BUY: leakage de vendors conectados a K2K comprando offline ── */
  const leakage = ev.buy?.leakage?.value ?? null;
  const leakageCost = numField(leakage, 'leakage_cost');
  if (leakageCost != null && leakageCost > LEAKAGE_MIN) {
    const leakageVendors = numField(leakage, 'vendor_count');
    const desc = leakageVendors != null
      ? `${fmtInt(leakageVendors)} vendors conectados por K2K comprando ${fmtMoney(leakageCost, true)} offline. Recuperable sin conexiones nuevas.`
      : `Vendors conectados por K2K comprando ${fmtMoney(leakageCost, true)} offline. Recuperable sin conexiones nuevas.`;
    opps.push({ type: 'BUY', effort: 'arreglo rápido', amount: leakageCost, desc, ref: 'tarjeta BUY' });
  }

  /* ── BUY: conexiones K2K dormidas ── */
  const dormant = numField(k2k, 'dormant');
  if (dormant != null && dormant > 0) {
    opps.push({
      type: 'BUY',
      effort: 'investigación',
      amount: null,
      desc: `${fmtInt(dormant)} conexiones K2K dormidas — conectadas pero nunca compraron. Inversión sin activar.`,
      ref: 'tarjeta BUY',
    });
  }

  /* ── LIST: gap de variedades ── */
  if (varietyGap != null && varietyGap > VARIETY_GAP_MIN) {
    opps.push({
      type: 'LIST',
      effort: 'auditoría',
      amount: null,
      desc: `${fmtInt(varietyGap)} variedades vendidas offline que no se muestran online — profundidad de catálogo oculta al comprador online.`,
      ref: 'tarjeta LIST',
    });
  }

  /* ── SELL: tendencia declinante ── */
  const yoyPct = p.sell_yoy_delta?.pct ?? null;
  if (flags.isDeclining && yoyPct != null && yoyPct < DECLINE_PCT_MAX) {
    opps.push({
      type: 'SELL',
      effort: 'investigación',
      amount: null,
      desc: `Sell GMV cayendo ${fmtPct(Math.abs(yoyPct), 1)} YoY. Investigar: ¿inventario? ¿precios? ¿churn de compradores?`,
      ref: 'tarjeta SELL',
    });
  }

  /* ── CONFIG: implementación cerrada con 0 transacciones ── */
  const implStage = ev.identity?.impl_stage ?? null;
  const koronetSell = evValue(p.koronet_sell_period);
  if (implStage && (koronetSell == null || koronetSell < ZERO_TX_SELL_MAX)) {
    opps.push({
      type: 'CONFIG',
      effort: 'investigación',
      amount: null,
      desc: `Implementación completa (etapa: ${implStage}) pero transacciones casi nulas. Problema de configuración o de activación.`,
      ref: null,
    });
  }

  if (!opps.length && stake == null) {
    return (
      <EvidenceCard label="Card 2 · OPPORTUNITIES" headline="Sin intervenciones detectadas" defaultOpen={false}>
        <CardGap>Ninguna señal de BUY, LIST, SELL ni CONFIG supera su umbral en este período.</CardGap>
      </EvidenceCard>
    );
  }

  opps.sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);

  const stakeLabel = stake?.source === 'sfdc' ? '(opps SFDC)' : 'de escenario';
  const headline = `${fmtMoney(stake?.amount ?? null, true)} ${stakeLabel} en juego · ${opps.length} intervenci${opps.length === 1 ? 'ón' : 'ones'}`;

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
    totalVarieties != null ? `${fmtInt(totalVarieties)} variedades` : null,
    cfgRaw ? (bunchesOff ? 'Sólo cajas' : 'Cajas + bunches') : null,
  ].filter(Boolean).join(' · ');

  const buyOfflinePct = buyOnlinePct != null ? Math.round(100 - buyOnlinePct) : null;

  return (
    <EvidenceCard label="Card 2 · OPPORTUNITIES" headline={headline}>
      <CardFocus>
        <strong>{fmtMoney(stake?.amount ?? null, true)}</strong>{' '}
        {stake?.source === 'sfdc'
          ? '— oportunidades abiertas en SFDC, tomadas de Salesforce.'
          : '— escenario: ventana de 12 meses con 10% de conversión.'}
        {' '}Ruta: {opps.map((o) => o.type).join(' → ')}.
      </CardFocus>

      <CardTable
        head={['#', 'Frente', 'Esfuerzo', 'En juego', 'Intervención']}
        rows={opps.map((o, i) => [
          `#${i + 1}`,
          <strong>{o.type}</strong>,
          o.effort,
          fmtMoney(o.amount, true),
          <>{o.desc}{o.ref ? <> <em>→ ver {o.ref}</em></> : null}</>,
        ])}
      />

      <CardGap>
        Contexto: la hipótesis principal (H-D1, sin confirmar) es que lo que empuja la compra offline
        es el precio, no la configuración.
      </CardGap>

      <CardSection title="Perfil y configuración">
        <CardRow label="Perfil de producto" value={productProfile || '—'} tone={productProfile ? undefined : 'muted'} />
        <CardRow
          label="Problemas de configuración"
          value={configIssues.length ? `${configIssues.length} limitante${configIssues.length === 1 ? '' : 's'}` : 'Ninguno'}
          note={configIssues.length ? configIssues.join(' · ') : undefined}
          tone={configIssues.length ? 'amber' : 'muted'}
        />
      </CardSection>

      {bottleneck ? (
        <CardSection title="Cuello de botella">
          <CardRow label={bottleneck.type} value={bottleneck.desc} tone="red" />
          <CardRow label="Próxima acción" value={nextAction} />
        </CardSection>
      ) : null}

      <CardNext>
        → Continúa en <strong>BUY</strong>:{' '}
        {buyOfflinePct != null && buyOfflinePct > 0
          ? `${buyOfflinePct}% del procurement es offline — ¿qué tan grande es la brecha de compra?`
          : '¿qué tan grande es la brecha de compra?'}
      </CardNext>
    </EvidenceCard>
  );
}

function buildNextAction(
  o: Opp | null,
  ctx: { k2kEligible: number | null; sellOffline: number | null; maxAge: number | null },
): string {
  if (!o) return 'Revisar las intervenciones de arriba.';
  if (o.type === 'BUY') {
    return ctx.k2kEligible != null
      ? `Pedir la activación K2K de ${fmtInt(ctx.k2kEligible)} proveedores elegibles vía CS · CS confirma en 48h.`
      : 'Identificar proveedores offline elegibles para K2K · pedir la activación vía CS.';
  }
  if (o.type === 'LIST') {
    if (o.effort === 'arreglo rápido') {
      return ctx.sellOffline != null
        ? `Habilitar bunches en la config del eShop · desbloquea ${fmtMoney(ctx.sellOffline, true)} de GMV offline · cambio de 5 minutos · verificar con ops después del deploy.`
        : 'Habilitar el formato bunches en la config del eShop · cambio de 5 minutos · confirmar con ops después del deploy.';
    }
    return ctx.maxAge != null
      ? `Subir MaxAge de ${String(ctx.maxAge)} a 30+ días en la config del eShop · desbloquea el catálogo forward · confirmar impacto con ops.`
      : 'Subir MaxAge a 30+ días en la config del eShop · desbloquea el catálogo forward · confirmar con ops.';
  }
  if (o.type === 'SELL') {
    return 'Exportar la lista de compradores offline · armar una campaña de invitación personalizada al eShop · empezar por los de mayor GMV.';
  }
  return 'Auditar la config del eShop y el checklist de activación · verificar la etapa de implementación con CS · confirmar que el camino a la primera transacción está despejado.';
}
