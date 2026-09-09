/**
 * Card 5 · SELL — who buys from this account, through which channel, and how
 * much of that demand is still offline.
 *
 * Omitted from the legacy card, on purpose:
 *  - new_online / new_offline / churned_online / churned_offline: the legacy
 *    template read them optimistically, but BuyersTable has no channel split
 *    for new/churned. Only the totals are shown.
 *  - The CVR gauge bars, the "CVR impact" box and the calculator chrome: they
 *    depended on markup/CSS this shell does not have. The same numbers are
 *    rendered as rows and tables.
 *  - The AOV uplift row of the efficiency calculator: it needed an `aov_online`
 *    benchmark, and benchmarks_v2 exposes no such metric.
 *  - The "future data need — product mix & channels" note: it described the
 *    legacy pipeline, not this account.
 */
import type { AccountEvidence, Benchmarks, MonthlySellTotal } from '../../../data/adapter/types';
import { evValue, fmtInt, fmtMoney, fmtMonthKey, fmtPct } from '../../../domain/format';
import { CardFocus, CardGap, CardNext, CardRow, CardSection, CardTable, EvidenceCard } from '../EvidenceCard';

/** Fee yield applied to a GMV shift scenario — the network-wide take rate. */
const TAKE_RATE = 0.002;
/** Share of offline buyers assumed to be reachable in an activation push. */
const ACTIVATION_SHARE = 0.2;
/** Last N months of the sell series rendered in the table. */
const SERIES_MONTHS = 12;

/** Reads one numeric field out of an `unknown` evidence payload. */
function numField(src: unknown, key: string): number | null {
  if (typeof src !== 'object' || src === null) return null;
  const v = (src as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function benchmark(bm: Benchmarks | null, metric: string, stat: 'median' | 'p75' | 'p90'): number | null {
  return bm?.per_metric[metric]?.[stat] ?? null;
}

export function SellCard({ ev }: { ev: AccountEvidence }) {
  const sell = ev.sell;
  if (!sell) {
    return (
      <EvidenceCard label="Card 5 · SELL" headline="No sell data" defaultOpen={false}>
        <CardGap>This account has no sell evidence (neither buyers_evidence_v2 nor the sell cube).</CardGap>
      </EvidenceCard>
    );
  }

  const p = ev.potential;
  const bt = evValue(sell.buyers_table);
  const series = evValue(sell.monthly_series) ?? [];

  const sellOnline = evValue(sell.sell_online_period);
  const sellOffline = evValue(sell.sell_offline_period);
  const sellTotal = evValue(sell.sell_total_period);
  const onlinePct = evValue(p?.sell_online_pct)
    ?? (sellTotal && sellOnline != null ? (sellOnline / sellTotal) * 100 : null);

  const cvrPct = numField(evValue(sell.cvr), 'user_cvr_pct');
  const ecomUsers = numField(evValue(sell.cvr), 'unique_ecom_users');
  const newUserCvrPct = numField(evValue(sell.new_user_cvr), 'new_user_cvr_pct');
  const repeatPct = numField(evValue(sell.repeat_rate), 'repeat_rate_pct');
  const top5Pct = numField(evValue(sell.concentration), 'top5_pct');

  const hg = evValue(sell.hardgoods);
  const hgTotal = numField(hg, 'hardgoods_total');
  const hgOnline = numField(hg, 'hardgoods_online');
  const hgOfflineRaw = numField(hg, 'hardgoods_offline');
  const hgOnlinePct = numField(hg, 'hardgoods_online_pct');
  const plantsTotal = numField(hg, 'plants_total');

  const offlineBuyers = bt?.offline_buyers ?? null;
  const onlineBuyers = bt?.online_buyers ?? null;
  const aovOnline = bt?.aov_online ?? null;
  const aovOffline = bt?.aov_offline ?? null;
  const retentionPct = onlineBuyers && bt?.l30d_online != null
    ? (bt.l30d_online / onlineBuyers) * 100
    : null;
  const netBuyers = bt && (bt.new_month != null || bt.churned != null)
    ? (bt.new_month ?? 0) - (bt.churned ?? 0)
    : null;

  const selfSaleTotal = series.reduce((acc, m) => acc + (m.self_sale_gmv || 0), 0);
  const recent: MonthlySellTotal[] = series.slice(-SERIES_MONTHS);
  const seriesHasSelfSale = recent.some((m) => m.self_sale_gmv > 0);

  // Headline scenario: 10% of the offline buyer base ordering online for a year.
  const shiftGmv = offlineBuyers != null && aovOnline
    ? Math.round(offlineBuyers * 0.1) * aovOnline * 12
    : null;
  const subtitle = shiftGmv != null
    ? `+10% online buyers = ${fmtMoney(shiftGmv, true)} of shifted GMV = ${fmtMoney(shiftGmv * TAKE_RATE, true)} of fees/year`
    : undefined;

  const headline = `${fmtPct(onlinePct)} online`
    + (offlineBuyers ? `. ${fmtInt(offlineBuyers)} offline buyers still not invited.` : '.');

  const soWhat = [
    onlinePct != null ? `${fmtPct(onlinePct)} online` : null,
    cvrPct != null ? `${fmtPct(cvrPct)} CVR` : null,
    repeatPct != null ? `${fmtPct(repeatPct)} repeat rate` : null,
    top5Pct != null ? `${fmtPct(top5Pct)} top 5 concentration` : null,
  ].filter(Boolean).join(', ');

  const repeatP75 = benchmark(ev.benchmarks, '5_repeat_rate', 'p75');
  const cvrMedian = benchmark(ev.benchmarks, '3_login_cvr', 'median');
  const cvrP75 = benchmark(ev.benchmarks, '3_login_cvr', 'p75');
  const concMedian = benchmark(ev.benchmarks, '6_concentration_top5', 'median');

  // "What if" rows — only the ones every input is present for.
  const upliftRows: [string, string][] = [];
  if (repeatPct != null && repeatP75 != null && repeatP75 > repeatPct && sellTotal) {
    upliftRows.push([
      `If the repeat rate reached the network p75 (${fmtPct(repeatP75)} vs ${fmtPct(repeatPct)})`,
      `+${fmtMoney(sellTotal * (repeatP75 - repeatPct) / 100, true)} of GMV`,
    ]);
  }
  if (offlineBuyers != null && aovOnline) {
    const activated = Math.round(offlineBuyers * ACTIVATION_SHARE);
    const gmv = activated * aovOnline * 12;
    upliftRows.push([
      `If ${fmtPct(ACTIVATION_SHARE * 100, 0)} of offline buyers moved online (${fmtInt(activated)} of ${fmtInt(offlineBuyers)})`,
      `+${fmtMoney(gmv, true)} of GMV/year → ~${fmtMoney(gmv * TAKE_RATE, true)} of fees`,
    ]);
  }

  return (
    <EvidenceCard label="Card 5 · SELL" headline={headline} subtitle={subtitle}>
      <CardFocus>
        <strong>What this means:</strong> {soWhat || 'Sell data loaded.'}
        {offlineBuyers != null
          ? ` The lever is activation: ${fmtInt(offlineBuyers)} buyers purchase from them offline and were never invited to order online.`
          : ''}
      </CardFocus>

      {bt ? (
        <CardSection title="Buyers">
          {netBuyers != null ? (
            <CardRow
              label="Net buyers"
              value={`${netBuyers >= 0 ? '+' : ''}${fmtInt(netBuyers)}`}
              tone={netBuyers >= 0 ? 'green' : 'red'}
              note={`${bt.new_month != null ? `+${fmtInt(bt.new_month)} new` : ''}${bt.churned != null ? ` / −${fmtInt(bt.churned)} lost (last 3 months)` : ''}`}
            />
          ) : null}
          <CardTable
            head={['', 'Online', 'Offline', 'Total / context']}
            rows={[
              [
                'Buyers',
                fmtInt(bt.online_buyers),
                fmtInt(bt.offline_buyers),
                <>
                  <strong>{fmtInt(bt.total_buyers)}</strong> in total
                  {bt.total_buyers != null && bt.online_buyers != null && bt.offline_buyers != null
                    && bt.total_buyers < bt.online_buyers + bt.offline_buyers
                    ? ' — there may be overlap'
                    : ''}
                </>,
              ],
              [
                'Active last 30 days',
                fmtInt(bt.l30d_online),
                fmtInt(bt.l30d_offline),
                retentionPct != null ? `${fmtPct(retentionPct, 0)} online retention` : '—',
              ],
              [
                'AOV',
                fmtMoney(aovOnline, true),
                fmtMoney(aovOffline, true),
                aovOnline && aovOffline
                  ? `AOV online ${aovOnline > aovOffline ? '+' : ''}${fmtPct((aovOnline / aovOffline - 1) * 100)}`
                  : '—',
              ],
              [
                'New / lost',
                '—',
                '—',
                <>
                  {bt.new_month != null ? `${fmtInt(bt.new_month)} activations` : '—'}
                  {bt.churned != null ? ` · ${fmtInt(bt.churned)} at risk` : ''}
                </>,
              ],
            ]}
          />
        </CardSection>
      ) : (
        <CardGap>No buyers table: this account is not in buyers_evidence_v2.</CardGap>
      )}

      <CardSection title="Demand quality">
        <CardRow label="Online period GMV" value={fmtMoney(sellOnline, true)} />
        <CardRow label="Offline period GMV" value={fmtMoney(sellOffline, true)} tone="amber" />
        <CardRow
          label="Repeat rate"
          value={fmtPct(repeatPct)}
          note={repeatP75 != null ? `network p75: ${fmtPct(repeatP75)}` : undefined}
          tone={repeatPct != null && repeatP75 != null && repeatPct >= repeatP75 ? 'green' : 'amber'}
        />
        <CardRow
          label="Top 5 concentration"
          value={fmtPct(top5Pct)}
          note={concMedian != null ? `network median: ${fmtPct(concMedian)}` : undefined}
          tone={top5Pct != null && top5Pct < 20 ? 'green' : 'amber'}
        />
        <CardRow label="Retention last 30 days" value={fmtPct(retentionPct, 0)} />
      </CardSection>

      {cvrPct != null || newUserCvrPct != null ? (
        <CardSection title="Web conversion (internal use)">
          <CardRow
            label="CVR for this account"
            value={fmtPct(cvrPct)}
            note={ecomUsers != null ? `across ${fmtInt(ecomUsers)} eCommerce users` : undefined}
          />
          <CardRow label="New user CVR" value={fmtPct(newUserCvrPct)} />
          <CardRow label="Network median" value={fmtPct(cvrMedian)} tone="muted" />
          <CardRow label="Network p75" value={fmtPct(cvrP75)} tone="muted" />
        </CardSection>
      ) : null}

      {recent.length ? (
        <CardSection title="Monthly sell series">
          <CardTable
            head={seriesHasSelfSale
              ? ['Month', 'Total', 'Online', 'Offline', 'Self-sale']
              : ['Month', 'Total', 'Online', 'Offline']}
            rows={recent.map((m) => {
              const row = [
                fmtMonthKey(m.month),
                fmtMoney(m.sell_gmv, true),
                fmtMoney(m.sell_online, true),
                fmtMoney(m.sell_offline, true),
              ];
              return seriesHasSelfSale ? [...row, fmtMoney(m.self_sale_gmv, true)] : row;
            })}
          />
        </CardSection>
      ) : null}

      {selfSaleTotal > 0 ? (
        <CardGap>
          {fmtMoney(selfSaleTotal, true)} of the self-sale column are sell lines whose customer is the
          company itself: they are its own purchases mirrored in the sales table, not sales, and are already
          excluded from sell GMV.
        </CardGap>
      ) : null}

      {hg ? (
        <CardSection title="Hardgoods and plants">
          <CardRow
            label="Hardgoods"
            value={fmtMoney(hgTotal, true)}
            note={hgOnlinePct != null ? `${fmtPct(hgOnlinePct, 2)} online` : undefined}
          />
          <CardRow label="Hardgoods online / offline" value={`${fmtMoney(hgOnline, true)} / ${fmtMoney(hgOfflineRaw, true)}`} />
          {plantsTotal ? <CardRow label="Plants" value={fmtMoney(plantsTotal, true)} /> : null}
        </CardSection>
      ) : null}

      {upliftRows.length ? (
        <CardSection title="If it matched the network ceiling (internal use)">
          <CardTable head={['Scenario', 'Effect']} rows={upliftRows.map(([a, b]) => [a, b])} />
        </CardSection>
      ) : null}

      <CardNext>
        → Continues in <strong>DATA COVERAGE</strong>: how much of this evidence is actually measured.
      </CardNext>
    </EvidenceCard>
  );
}
