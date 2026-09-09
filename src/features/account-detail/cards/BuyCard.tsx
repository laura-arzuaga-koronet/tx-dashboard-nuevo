/**
 * Card 3 · BUY — where the account sources from: monthly procurement, the vendor
 * and K2K connection funnels, how far ahead it buys, which categories stay
 * offline, and the leakage of vendors that are already connected yet still buy
 * offline.
 *
 * Ported from the legacy `renderBuyCard`. The legacy card drew the buying
 * horizon as CSS bars against a hard-coded "best in class" benchmark; there is
 * no such benchmark in the evidence, so the distribution is shown as shares of
 * orders instead of an invented reference line.
 */
import type { ReactNode } from 'react';
import type { AccountEvidence, BucketSummary, MonthlyBuyTotal } from '../../../data/adapter/types';
import { evValue, fmtInt, fmtMoney, fmtMonthKey, fmtPct, fmtSignedPct } from '../../../domain/format';
import { CardFocus, CardGap, CardNext, CardSection, CardTable, EvidenceCard } from '../EvidenceCard';

/** Buckets as the temporal cube emits them, ordered nearest-to-shipping first. */
const HORIZON_BUCKETS = ['0-3d', '4-7d', '8-14d', '15-30d', '31-90d', '90d+'] as const;

const TOP_CATEGORIES = 8;
const OFFLINE_CATEGORY_PCT = 80;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(source: unknown, key: string): number | null {
  const rec = asRecord(source);
  if (!rec) return null;
  const v = rec[key];
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function text(source: unknown, key: string): string | null {
  const rec = asRecord(source);
  const v = rec ? rec[key] : null;
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

interface Category {
  category: string;
  online_gmv: number;
  offline_gmv: number;
  pct_offline: number | null;
  vendor_count: number | null;
}

/** `categories_top20` arrives as `unknown`; keep only rows that carry a name. */
function readCategories(v: unknown): Category[] {
  if (!Array.isArray(v)) return [];
  const out: Category[] = [];
  for (const row of v) {
    const name = text(row, 'category');
    if (!name) continue;
    out.push({
      category: name,
      online_gmv: num(row, 'online_gmv') ?? 0,
      offline_gmv: num(row, 'offline_gmv') ?? 0,
      pct_offline: num(row, 'pct_offline'),
      vendor_count: num(row, 'vendor_count'),
    });
  }
  return out;
}

function bucketOrders(summary: BucketSummary, bucket: string): number {
  const entry = summary.buckets[bucket] ?? summary.buckets[bucket.replace(/d$/, '')] ?? null;
  return entry?.orders ?? 0;
}

function share(part: number, total: number): number | null {
  return total > 0 ? (part / total) * 100 : null;
}

function DeltaCell({ pct }: { pct: number | null }) {
  if (pct == null) return <>—</>;
  return <span className={pct >= 0 ? 'ev-state observed' : 'ev-state gap'}>{fmtSignedPct(pct)}</span>;
}

/** Months of the period that actually have buy rows, newest first. */
function periodMonths(monthly: Record<string, MonthlyBuyTotal>, from: string, to: string): MonthlyBuyTotal[] {
  return Object.values(monthly)
    .filter((m) => m.month >= from && m.month <= to)
    .sort((a, b) => b.month.localeCompare(a.month));
}

function shiftYear(month: string, delta: number): string {
  const [y, m] = month.split('-');
  return `${Number(y) + delta}-${m}`;
}

export function BuyCard({ ev }: { ev: AccountEvidence }) {
  const buy = ev.buy;
  const p = ev.potential;

  if (!buy) {
    return (
      <EvidenceCard label="Card 3 · BUY" headline="Sin datos de compra" defaultOpen={false}>
        <CardGap>No hay evidencia de sourcing para esta cuenta (buy cube ni vendors_evidence_v2).</CardGap>
      </EvidenceCard>
    );
  }

  const kBuy = p ? evValue(p.koronet_buy_period) : null;
  const buyOnlinePct = p ? evValue(p.buy_online_pct) : null;
  const buyOffline = p ? evValue(p.buy_offline_period) : null;

  const sourcing = buy.sourcing_table?.value ?? null;
  const k2k = buy.k2k_lifecycle?.value ?? null;
  const vendorLc = buy.vendor_lifecycle?.value ?? null;
  const leakage = buy.leakage?.value ?? null;
  const categories = readCategories(buy.categories_top20?.value);

  const noK2k = num(k2k, 'inactive_connections') ?? num(k2k, 'no_k2k');
  const leakageVendors = num(leakage, 'leakage_vendors') ?? num(leakage, 'connected_vendors_buying');
  const leakageCost = num(leakage, 'leakage_cost');
  const leakagePct = num(leakage, 'pct_offline_leakage');
  const offlineVendors = num(vendorLc, 'offline_vendors');

  const headline = [
    buyOnlinePct != null ? `${fmtPct(buyOnlinePct, 0)} de la compra es online` : null,
    buyOffline ? `${fmtMoney(buyOffline, true)} offline sin fees` : null,
  ].filter(Boolean).join(' · ') || 'Sin compra medida en el período';

  const focus = kBuy != null
    ? <>
        <strong>{fmtMoney(kBuy, true)}</strong> de procurement por Koronet
        {buyOffline ? <>, de los cuales {fmtMoney(buyOffline, true)} son offline y no generan fees</> : null}.
        {noK2k != null ? ` ${fmtInt(noK2k)} conexiones sin activar (elegibles para K2K).` : ''}
        {leakageVendors != null && leakageVendors > 0 && leakageCost != null && leakageCost > 0
          ? ` ${fmtInt(leakageVendors)} vendors ya conectados por K2K compran ${fmtMoney(leakageCost, true)} offline: recuperable sin conexiones nuevas.`
          : ''}
      </>
    : <>Sin volumen de compra medido en el período.</>;

  /* ── Sourcing mensual ── */
  const months = sourcing ? periodMonths(sourcing.monthly, ev._period.from, ev._period.to) : [];
  const sourcingRows = months.map((m) => {
    const prior = sourcing?.monthly[shiftYear(m.month, -1)] ?? null;
    const yoy = prior && prior.buy_gmv > 0 ? ((m.buy_gmv - prior.buy_gmv) / prior.buy_gmv) * 100 : null;
    return [
      fmtMonthKey(m.month),
      fmtMoney(m.buy_gmv, true),
      fmtMoney(m.buy_online, true),
      fmtMoney(m.buy_offline, true),
      fmtPct(share(m.buy_online, m.buy_gmv)),
      <DeltaCell pct={yoy} />,
    ];
  });

  const periodYoy = sourcing?.yoy_delta?.pct ?? null;

  /* ── Ciclo de vida de vendors y de conexiones K2K ── */
  const vendorRows: ReactNode[][] = [];
  if (vendorLc) {
    vendorRows.push(
      ['Vendors totales', fmtInt(num(vendorLc, 'vendors_total')), '—'],
      ['Activos L30D', fmtInt(num(vendorLc, 'active_l30d')), 'compraron en los últimos 30 días'],
      ['Dormidos 30–90D', fmtInt(num(vendorLc, 'dormant_30_90d')), 'sin compra reciente'],
      ['Perdidos 90D+', fmtInt(num(vendorLc, 'churned_90plus')), 'sin compra hace más de 90 días'],
      ['Vendors online', fmtInt(num(vendorLc, 'online_vendors')), fmtMoney(num(vendorLc, 'online_buy_gmv'), true)],
      ['Vendors offline', fmtInt(num(vendorLc, 'offline_vendors')), fmtMoney(num(vendorLc, 'offline_buy_gmv'), true)],
    );
  }

  const k2kRows: ReactNode[][] = [];
  if (k2k) {
    const total = num(k2k, 'total_connections');
    const active = num(k2k, 'active_connections');
    k2kRows.push(
      ['Conexiones totales', fmtInt(total), '—'],
      ['Activas', fmtInt(active), fmtPct(active != null && total ? share(active, total) : null)],
      ['Inactivas', fmtInt(num(k2k, 'inactive_connections')), 'elegibles para activación'],
      ['Antigüedad promedio', `${fmtInt(num(k2k, 'avg_connection_age_days'))} días`, '—'],
      ['Última conexión', text(k2k, 'latest_connection')?.slice(0, 10) ?? '—', `primera: ${text(k2k, 'earliest_connection')?.slice(0, 10) ?? '—'}`],
    );
  }

  /* ── Anticipación de compra ── */
  const antOnline = buy.anticipation_online?.value ?? null;
  const antOffline = buy.anticipation_offline?.value ?? null;
  const antRows = (antOnline || antOffline)
    ? HORIZON_BUCKETS.map((b) => {
        const on = antOnline ? bucketOrders(antOnline, b) : 0;
        const off = antOffline ? bucketOrders(antOffline, b) : 0;
        return [
          b,
          antOnline ? `${fmtInt(on)} (${fmtPct(share(on, antOnline.total_orders), 0)})` : '—',
          antOffline ? `${fmtInt(off)} (${fmtPct(share(off, antOffline.total_orders), 0)})` : '—',
        ];
      })
    : [];

  const spotPct = antOnline ? share(bucketOrders(antOnline, '0-3d'), antOnline.total_orders) : null;

  /* ── Categorías ── */
  const catRows = categories.slice(0, TOP_CATEGORIES).map((c) => [
    c.category,
    fmtMoney(c.online_gmv, true),
    fmtMoney(c.offline_gmv, true),
    fmtPct(c.pct_offline ?? share(c.offline_gmv, c.online_gmv + c.offline_gmv), 0),
    fmtInt(c.vendor_count),
  ]);
  const heavyOffline = categories.filter((c) => (c.pct_offline ?? 0) >= OFFLINE_CATEGORY_PCT && c.offline_gmv > 0);

  return (
    <EvidenceCard label="Card 3 · BUY" headline={headline}>
      <CardFocus><strong>Foco:</strong> {focus}</CardFocus>

      {sourcingRows.length ? (
        <CardSection title="Sourcing mensual">
          <CardTable
            head={['Mes', 'Total', 'Online', 'Offline', 'Online %', 'YoY']}
            rows={sourcingRows}
          />
          <CardGap>
            Período: {fmtMoney(sourcing?.period_total ?? null, true)} vs {fmtMoney(sourcing?.prior_period_total ?? null, true)} el año anterior
            {periodYoy != null ? ` (${fmtSignedPct(periodYoy)})` : ''}.
          </CardGap>
        </CardSection>
      ) : (
        <CardGap>Sin filas de compra en el período seleccionado.</CardGap>
      )}

      {vendorRows.length ? (
        <CardSection title="Ciclo de vida de vendors">
          <CardTable head={['', 'Cantidad', 'Detalle']} rows={vendorRows} />
        </CardSection>
      ) : null}

      {k2kRows.length ? (
        <CardSection title="Conexiones K2K">
          <CardTable head={['', 'Valor', 'Detalle']} rows={k2kRows} />
        </CardSection>
      ) : null}

      {antRows.length ? (
        <CardSection title="Anticipación de compra — días entre la orden y el envío">
          <CardTable head={['Ventana', 'Online (órdenes)', 'Offline (órdenes)']} rows={antRows} />
          <CardGap>
            Promedio ponderado: online {antOnline?.avg_days != null ? `${antOnline.avg_days.toFixed(1)}d` : '—'} ·
            offline {antOffline?.avg_days != null ? `${antOffline.avg_days.toFixed(1)}d` : '—'}.
            {spotPct != null && spotPct > 0
              ? ` ${fmtPct(spotPct, 0)} de las órdenes online se colocan a 0–3 días del envío: compra spot, sin ventaja de planificación.`
              : ''}
          </CardGap>
        </CardSection>
      ) : null}

      {catRows.length ? (
        <CardSection title={`Top categorías compradas (top ${TOP_CATEGORIES} de las 20 relevadas)`}>
          <CardTable head={['Categoría', 'Online', 'Offline', 'Offline %', 'Vendors']} rows={catRows} />
          {heavyOffline.length ? (
            <CardGap>
              {heavyOffline.length} categoría{heavyOffline.length !== 1 ? 's' : ''} con {OFFLINE_CATEGORY_PCT}%+ de su compra offline:{' '}
              {heavyOffline.slice(0, 6).map((c) => `${c.category} (${fmtMoney(c.offline_gmv, true)})`).join(', ')}.
              Están comprando offline mientras existe oferta online.
            </CardGap>
          ) : null}
        </CardSection>
      ) : null}

      {leakage ? (
        <CardSection title="Leakage — vendors conectados que igual compran offline">
          <CardTable
            head={['', 'Valor']}
            rows={[
              ['Vendors conectados que compran', fmtInt(num(leakage, 'connected_vendors_buying'))],
              ['De ellos, con compra offline', fmtInt(leakageVendors)],
              ['GMV offline de esos vendors', fmtMoney(leakageCost, true)],
              ['GMV online de esos vendors', fmtMoney(num(leakage, 'online_cost'), true)],
              ['% offline sobre su GMV', fmtPct(leakagePct, 0)],
            ]}
          />
          <CardGap>
            Es el volumen recuperable sin abrir conexiones nuevas: la conexión K2K ya existe y la compra igual sale offline.
          </CardGap>
        </CardSection>
      ) : null}

      {offlineVendors != null && offlineVendors > 0 ? (
        <CardGap>
          Atajo Open Market: la carga manual de inventario permite listar producto de vendors sin K2K.
          {` ${fmtInt(offlineVendors)} vendor${offlineVendors !== 1 ? 's' : ''} offline`} — un subconjunto puede subirse como
          inventario Open Market sin integración K2K completa.
        </CardGap>
      ) : null}

      <CardNext>
        → Continúa en <strong>LIST</strong>: ¿la oferta que compran puede mostrarse a sus compradores?
      </CardNext>
    </EvidenceCard>
  );
}
