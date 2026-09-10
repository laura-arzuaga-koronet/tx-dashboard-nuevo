/**
 * Card 1 · POTENTIAL — the sell and buy sides side by side, and what the gap
 * between what the account moves and what it moves *through Koronet* is worth.
 *
 * This card is the exemplar the other five follow: read a slice of
 * AccountEvidence, state the finding in the headline, show the numbers with
 * their evidence state, and hand off to the next card.
 */
import type { AccountEvidence } from '../../../data/adapter/types';
import type { SfdcOppTotals } from '../../../data/sfdc/openOpportunities';
import { evValue, fmtMoney, fmtPct, gmvSourceLabel } from '../../../domain/format';
import { calcAtStake, detectOpportunityFlags } from '../../../domain/metrics';
import { CardFocus, CardGap, CardNext, CardTable, EvidenceCard } from '../EvidenceCard';

const K2K_RATE = 1.5;

function EvState({ state, label }: { state: string; label?: string }) {
  return <span className={`ev-state ${state}`}>{label ?? state}</span>;
}

/**
 * Penetration cell.
 *
 * A tautological penetration used to print "~100%", and the tilde was doing too
 * much work: read at a glance it looks like an account that moves everything
 * through us, when in fact the denominator is our own measurement and the ratio
 * could not have come out any other way. It is an identity, so the cell says so
 * instead of putting a number where a number is not an answer.
 */
function PenCell({ pct, tautological, why }: { pct: number | null; tautological: boolean; why: string }) {
  if (!tautological) return <>{fmtPct(pct)}</>;
  return (
    <><EvState state="tautological" label="identity" />
      <div className="ev-note">{why}</div></>
  );
}

export function PotentialCard({ ev, sfdcTotals }: { ev: AccountEvidence; sfdcTotals: SfdcOppTotals }) {
  const p = ev.potential;
  if (!p) {
    return (
      <EvidenceCard label="Card 1 · POTENTIAL" headline="No potential data" defaultOpen={false}>
        <CardGap>This account has no row in accounts_v3 or in the cubes.</CardGap>
      </EvidenceCard>
    );
  }

  const estSell = p.gmv_reference?.value ?? null;
  const estBuy = p.buy_gmv_estimated?.value ?? null;
  const kSell = evValue(p.koronet_sell_period);
  const kBuy = evValue(p.koronet_buy_period);
  const sellPen = evValue(p.sell_penetration);
  const buyPen = evValue(p.buy_penetration);
  const sellOnline = evValue(p.sell_online_pct);
  const buyOnline = evValue(p.buy_online_pct);
  const sellOffline = evValue(p.sell_offline_period);
  const buyOffline = evValue(p.buy_offline_period);
  const feesDirect = evValue(p.fees_direct);
  const feesIndirect = evValue(p.fees_indirect);
  const buyAttributed = evValue(p.buy_attributed);
  const indirectRate = evValue(p.indirect_rate);
  const takeRate = evValue(p.take_rate);
  const selfSale = evValue(p.self_sale_gmv);

  const sellTautological = p.sell_penetration?.ev === 'tautological';
  const penLabel = sellTautological
    ? 'Koronet is the primary channel'
    : sellPen != null ? `${fmtPct(sellPen)} of sell captured` : '';
  const headline = [
    sellOffline ? `${fmtMoney(sellOffline, true)} offline with no fees.` : null,
    penLabel || null,
    sellOnline != null ? `${fmtPct(sellOnline)} online` : null,
  ].filter(Boolean).join(' ');

  const stake = calcAtStake(ev, sfdcTotals);
  const oppCount = Object.values(detectOpportunityFlags(ev)).filter(Boolean).length;

  const focus = stake?.source === 'sfdc'
    ? <><strong>{fmtMoney(stake.amount, true)} in open SFDC opportunities</strong> — what this account is expected to pay.</>
    : sellOffline && buyOffline
      ? <>{fmtMoney(sellOffline, true)} offline sell + {fmtMoney(buyOffline, true)} offline buy → <strong>{fmtMoney(stake?.amount ?? null, true)}</strong> if 10% moves online (10% conversion × {fmtPct(K2K_RATE, 1)} K2K rate, 12-month window)</>
      : sellOffline
        ? <>{fmtMoney(sellOffline, true)} offline sell → <strong>{fmtMoney(stake?.amount ?? null, true)}</strong> if 10% moves online</>
        : <>No offline volume measured in the period: there is no conversion scenario to estimate.</>;

  return (
    <EvidenceCard label="Card 1 · POTENTIAL" headline={headline || 'No activity in the period'}>
      <CardTable
        head={['', 'Estimated', 'Koronet', 'Penetration', 'Online %']}
        rows={[
          [
            <strong>SELL</strong>,
            <>{fmtMoney(estSell, true)}<br />
              <EvState
                state={p.gmv_reference?.unverified ? 'proxy' : p.gmv_reference?.confidence ?? 'gap'}
                label={p.gmv_reference?.unverified
                  ? `${gmvSourceLabel(p.gmv_reference.source)} — unverified`
                  : gmvSourceLabel(p.gmv_reference?.source)} />
              {p.gmv_reference?.annual != null && p.gmv_reference.annual !== estSell
                ? <div className="ev-note">{fmtMoney(p.gmv_reference.annual, true)} annual, prorated to the period</div> : null}
              {p.gmv_reference?.unverified
                ? <div className="ev-note">the sell cube measures {fmtMoney(p.gmv_reference.measured_annual, true)}/yr — the source claims to be our own measurement but does not match it</div>
                : null}
              {p.gmv_reference?.period_floored
                ? <div className="ev-note">raised to what we measured in this window: the estimate sat below it</div>
                : null}</>,
            fmtMoney(kSell, true),
            <PenCell pct={sellPen} tautological={sellTautological}
              why="the estimate is our own measurement — there is nothing independent to compare it against" />,
            fmtPct(sellOnline),
          ],
          [
            <strong>BUY</strong>,
            <>{fmtMoney(estBuy, true)}<br /><EvState
              state={estBuy ? (p.buy_gmv_estimated?.source === 'floor' ? 'observed' : 'model') : 'gap'}
              label={!estBuy ? 'gap'
                : p.buy_gmv_estimated?.source === 'floor' ? 'Measured floor — exceeds the 45% ratio'
                : 'Model — 45% ratio'} />
              {p.buy_gmv_estimated?.period_floored
                ? <div className="ev-note">raised to the buy measured in this window</div>
                : null}</>,
            fmtMoney(kBuy, true),
            <PenCell pct={buyPen} tautological={p.buy_penetration?.ev === 'tautological'}
              why="the estimate IS the buy we measured: the 45% ratio came out below it" />,
            fmtPct(buyOnline),
          ],
        ]}
      />

      <CardTable
        head={['Fees', 'Amount', 'Base', 'Note']}
        rows={[
          ['Direct', fmtMoney(feesDirect, true), fmtMoney(kSell, true) + ' of sell', 'Billed, sell side'],
          [
            'Indirect',
            fmtMoney(feesIndirect, true),
            buyAttributed ? fmtMoney(buyAttributed, true) + ' purchased' : '—',
            indirectRate != null
              ? `${fmtPct(indirectRate, 3)} — its suppliers' realised rate`
              : 'Not a buyer in any K2K connection',
          ],
          [
            <strong>Take rate</strong>,
            <strong>{fmtPct(takeRate, 2)}</strong>,
            fmtMoney((estSell ?? 0) + (estBuy ?? 0), true) + ' of estimated period flow',
            '(Direct + Indirect) / (Est Buy + Est Sell), both for the period',
          ],
        ]}
      />

      {selfSale ? (
        <CardGap>
          {fmtMoney(selfSale, true)} of its sell rows have the company itself as the customer:
          they are its own purchases mirrored in the sales table, already excluded from Koronet Sell.
        </CardGap>
      ) : null}

      <CardFocus><strong>Focus:</strong> {focus}</CardFocus>

      <CardNext>
        → Continues in <strong>OPPORTUNITIES</strong>
        {oppCount ? `: ${oppCount} intervention${oppCount !== 1 ? 's' : ''} worth ${fmtMoney(stake?.amount ?? null, true)}` : ''}
      </CardNext>
    </EvidenceCard>
  );
}
