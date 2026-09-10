/**
 * Catalog reach — how much of what the account actually moves has ever gone
 * through an online channel, in three widths: categories, varieties, SKUs.
 *
 * Shared by SELL and BUY because the question is the same on both sides and the
 * answer is rarely the same: an account can have every category online and half
 * its varieties never listed there, which is precisely the finding the table
 * exists to surface.
 *
 * OFFLINE-ONLY IS A SET, NOT A SUBTRACTION
 * The legacy dashboard prints `offline − online`, a difference of two counts.
 * The two sets overlap almost always — a SKU sold through both channels is
 * counted twice and cancels — so that number came out negative for 141 of 330
 * accounts. Here it is `total − online`: what never touched an online channel.
 *
 * The window is fixed (12 closed months) and does not follow the period
 * selector: catalog width is a function of window length, so comparing H1 to
 * YTD would measure the window rather than the account.
 */
import type { CatalogDim, CatalogReach } from '../../../data/adapter/types';
import { fmtInt, fmtPct } from '../../../domain/format';
import { CardSection, CardTable } from '../EvidenceCard';

/** Below this the account is behind most of the network on that width. */
const BEHIND_MARGIN = 10;

function VsNetwork({ dim }: { dim: CatalogDim }) {
  if (dim.coverage_pct == null || dim.network_median == null) return <>—</>;
  const d = dim.coverage_pct - dim.network_median;
  const tone = d <= -BEHIND_MARGIN ? 'gap' : d >= BEHIND_MARGIN ? 'observed' : 'proxy';
  const sign = d > 0 ? '+' : '';
  return (
    <>
      {fmtPct(dim.network_median, 0)}{' '}
      <span className={`ev-state ${tone}`}>{sign}{d.toFixed(0)} pp</span>
    </>
  );
}

export function CatalogReachTable({ reach, side }: { reach: CatalogReach; side: 'sell' | 'buy' }) {
  const rows: [string, CatalogDim][] = [
    ['Categories', reach.categories],
    ['Varieties', reach.varieties],
    ['SKUs', reach.skus],
  ];
  const verb = side === 'sell' ? 'sold' : 'bought';

  /* The interesting shape is wide-but-shallow: the whole assortment is listed
     online while most of the depth behind it never is. Worth stating, because
     the categories row alone reads as "we're covered". */
  const cats = reach.categories.coverage_pct;
  const skus = reach.skus.coverage_pct;
  const shallow = cats != null && skus != null && cats - skus >= 25 && cats >= 50;

  return (
    <CardSection title={`Catalog reach · ${verb} through an online channel · ${reach.window}`}>
      <CardTable
        head={['', 'Total', 'Online', 'Offline-only', 'Coverage', 'Network median']}
        rows={rows.map(([label, d]) => [
          <strong>{label}</strong>,
          fmtInt(d.total),
          fmtInt(d.online),
          d.offline_only > 0
            ? <span className="ev-state gap">{fmtInt(d.offline_only)}</span>
            : '—',
          fmtPct(d.coverage_pct, 0),
          <VsNetwork dim={d} />,
        ])}
      />
      {shallow ? (
        <p className="ev-note">
          Wide but shallow: {fmtPct(cats, 0)} of the categories reach an online channel but only{' '}
          {fmtPct(skus, 0)} of the individual SKUs do — {fmtInt(reach.skus.offline_only)} SKUs were{' '}
          {verb} without ever appearing online.
        </p>
      ) : null}
    </CardSection>
  );
}
