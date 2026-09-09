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
      <EvidenceCard label="Card 3 · BUY" headline="No buy data" defaultOpen={false}>
        <CardGap>No sourcing evidence for this account (neither buy cube nor vendors_evidence_v2).</CardGap>
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
    buyOnlinePct != null ? `${fmtPct(buyOnlinePct, 0)} of buying is online` : null,
    buyOffline ? `${fmtMoney(buyOffline, true)} offline with no fees` : null,
  ].filter(Boolean).join(' · ') || 'No measured buying in the period';

  const focus = kBuy != null
    ? <>
        <strong>{fmtMoney(kBuy, true)}</strong> of procurement through Koronet
        {buyOffline ? <>, of which {fmtMoney(buyOffline, true)} is offline and generates no fees</> : null}.
        {noK2k != null ? ` ${fmtInt(noK2k)} connections not activated (eligible for K2K).` : ''}
        {leakageVendors != null && leakageVendors > 0 && leakageCost != null && leakageCost > 0
          ? ` ${fmtInt(leakageVendors)} vendors already connected via K2K buy ${fmtMoney(leakageCost, true)} offline: recoverable without new connections.`
          : ''}
      </>
    : <>No measured buy volume in the period.</>;

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
      ['Total vendors', fmtInt(num(vendorLc, 'vendors_total')), '—'],
      ['Active L30D', fmtInt(num(vendorLc, 'active_l30d')), 'bought in the last 30 days'],
      ['Dormant 30–90D', fmtInt(num(vendorLc, 'dormant_30_90d')), 'no recent purchases'],
      ['Churned 90D+', fmtInt(num(vendorLc, 'churned_90plus')), 'no purchases in more than 90 days'],
      ['Online vendors', fmtInt(num(vendorLc, 'online_vendors')), fmtMoney(num(vendorLc, 'online_buy_gmv'), true)],
      ['Offline vendors', fmtInt(num(vendorLc, 'offline_vendors')), fmtMoney(num(vendorLc, 'offline_buy_gmv'), true)],
    );
  }

  const k2kRows: ReactNode[][] = [];
  if (k2k) {
    const total = num(k2k, 'total_connections');
    const active = num(k2k, 'active_connections');
    k2kRows.push(
      ['Total connections', fmtInt(total), '—'],
      ['Active', fmtInt(active), fmtPct(active != null && total ? share(active, total) : null)],
      ['Inactive', fmtInt(num(k2k, 'inactive_connections')), 'eligible for activation'],
      ['Average age', `${fmtInt(num(k2k, 'avg_connection_age_days'))} days`, '—'],
      ['Latest connection', text(k2k, 'latest_connection')?.slice(0, 10) ?? '—', `first: ${text(k2k, 'earliest_connection')?.slice(0, 10) ?? '—'}`],
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
      <CardFocus><strong>Focus:</strong> {focus}</CardFocus>

      {sourcingRows.length ? (
        <CardSection title="Monthly sourcing">
          <CardTable
            head={['Month', 'Total', 'Online', 'Offline', 'Online %', 'YoY']}
            rows={sourcingRows}
          />
          <CardGap>
            Period: {fmtMoney(sourcing?.period_total ?? null, true)} vs {fmtMoney(sourcing?.prior_period_total ?? null, true)} a year earlier
            {periodYoy != null ? ` (${fmtSignedPct(periodYoy)})` : ''}.
          </CardGap>
        </CardSection>
      ) : (
        <CardGap>No buy rows in the selected period.</CardGap>
      )}

      {vendorRows.length ? (
        <CardSection title="Vendor lifecycle">
          <CardTable head={['', 'Count', 'Detail']} rows={vendorRows} />
        </CardSection>
      ) : null}

      {k2kRows.length ? (
        <CardSection title="K2K connections">
          <CardTable head={['', 'Value', 'Detail']} rows={k2kRows} />
        </CardSection>
      ) : null}

      {antRows.length ? (
        <CardSection title="Order lead time — days between the order and the shipment">
          <CardTable head={['Window', 'Online (orders)', 'Offline (orders)']} rows={antRows} />
          <CardGap>
            Weighted average: online {antOnline?.avg_days != null ? `${antOnline.avg_days.toFixed(1)}d` : '—'} ·
            offline {antOffline?.avg_days != null ? `${antOffline.avg_days.toFixed(1)}d` : '—'}.
            {spotPct != null && spotPct > 0
              ? ` ${fmtPct(spotPct, 0)} of online orders are placed 0–3 days before shipping: spot buying, with no planning advantage.`
              : ''}
          </CardGap>
        </CardSection>
      ) : null}

      {catRows.length ? (
        <CardSection title={`Top categories bought (top ${TOP_CATEGORIES} of the 20 surveyed)`}>
          <CardTable head={['Category', 'Online', 'Offline', 'Offline %', 'Vendors']} rows={catRows} />
          {heavyOffline.length ? (
            <CardGap>
              {heavyOffline.length} categor{heavyOffline.length !== 1 ? 'ies' : 'y'} with {OFFLINE_CATEGORY_PCT}%+ of their buying offline:{' '}
              {heavyOffline.slice(0, 6).map((c) => `${c.category} (${fmtMoney(c.offline_gmv, true)})`).join(', ')}.
              They are buying offline while online supply exists.
            </CardGap>
          ) : null}
        </CardSection>
      ) : null}

      {leakage ? (
        <CardSection title="Leakage — connected vendors that still buy offline">
          <CardTable
            head={['', 'Value']}
            rows={[
              ['Connected vendors that buy', fmtInt(num(leakage, 'connected_vendors_buying'))],
              ['Of those, with offline buying', fmtInt(leakageVendors)],
              ['Offline GMV of those vendors', fmtMoney(leakageCost, true)],
              ['Online GMV of those vendors', fmtMoney(num(leakage, 'online_cost'), true)],
              ['% offline of their GMV', fmtPct(leakagePct, 0)],
            ]}
          />
          <CardGap>
            This is the volume recoverable without opening new connections: the K2K connection already exists and the buying still goes offline.
          </CardGap>
        </CardSection>
      ) : null}

      {offlineVendors != null && offlineVendors > 0 ? (
        <CardGap>
          Open Market shortcut: manual inventory upload makes it possible to list product from vendors without K2K.
          {` ${fmtInt(offlineVendors)} offline vendor${offlineVendors !== 1 ? 's' : ''}`} — a subset can be uploaded as
          Open Market inventory without a full K2K integration.
        </CardGap>
      ) : null}

      <CardNext>
        → Continues in <strong>LIST</strong>: can the supply they buy be shown to their buyers?
      </CardNext>
    </EvidenceCard>
  );
}
