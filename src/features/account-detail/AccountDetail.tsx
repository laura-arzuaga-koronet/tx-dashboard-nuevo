/**
 * Expanded account panel.
 *
 * Identity and Key figures give the account at a glance; the six evidence cards
 * below are the argument — what the account could be worth, what to do about
 * it, and how much of that rests on data we actually have.
 */
import type { AccountEvidence } from '../../data/adapter/types';
import type { SfdcOppTotals } from '../../data/sfdc/openOpportunities';
import { fmtInt, fmtMoney, fmtPct } from '../../domain/format';
import { calcAtStake } from '../../domain/metrics';
import styles from './AccountDetail.module.css';
import { BuyCard } from './cards/BuyCard';
import { FreshnessCard } from './cards/FreshnessCard';
import { ListCard } from './cards/ListCard';
import { OpportunitiesCard } from './cards/OpportunitiesCard';
import { PotentialCard } from './cards/PotentialCard';
import { SellCard } from './cards/SellCard';

interface AccountDetailProps {
  ev: AccountEvidence;
  sfdcTotals: SfdcOppTotals;
}

function Row({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className={styles.row}>
      <span>{label}</span>
      <strong>{value == null || value === '' ? '—' : value}</strong>
    </div>
  );
}

export function AccountDetail({ ev, sfdcTotals }: AccountDetailProps) {
  const id = ev.identity;
  const p = ev.potential;
  const atStake = calcAtStake(ev, sfdcTotals);

  return (
    <div className={styles.grid}>
      <section className={styles.card} aria-label="Identity">
        <div className={styles.label}>Identity</div>
        <div className={styles.title}>{ev._company_name}</div>
        <Row label="Company ID" value={id.company_id ?? 'no Koronet ID'} />
        <Row label="SFDC ID" value={id.sfdc_id} />
        <Row label="Account class" value={id.account_class} />
        <Row label="Segment" value={id.segment} />
        <Row label="Product tier" value={id.product_tier} />
        <Row label="Potential tier" value={id.potential_tier} />
        <Row label="Priority" value={id.priority_level} />
        <Row label="Impl stage" value={id.impl_stage_display} />
        <Row label="PMT lead" value={id.pmt_lead} />
      </section>

      <section className={styles.card} aria-label="Key figures">
        <div className={styles.label}>Key figures · {ev._period.label}</div>
        <div className={styles.title}>Potential snapshot</div>
        <Row label="Est GMV (sell)" value={p ? `${fmtMoney(p.gmv_reference.value, true)} · ${p.gmv_reference.source ?? '—'}` : null} />
        <Row label="Koronet sell" value={fmtMoney(p?.koronet_sell_period.value ?? null, true)} />
        <Row label="Koronet buy" value={fmtMoney(p?.koronet_buy_period.value ?? null, true)} />
        <Row label="Direct fees" value={fmtMoney(p?.fees_direct.value ?? null, true)} />
        <Row label="Indirect fees" value={fmtMoney(p?.fees_indirect.value ?? null, true)} />
        <Row label="Take rate" value={fmtPct(p?.take_rate.value ?? null, 2)} />
        <Row label="$ at stake" value={atStake ? `${fmtMoney(atStake.amount, true)} (${atStake.source})` : null} />
        <Row label="Offline buyers" value={fmtInt(ev.sell?.buyers_table?.value?.offline_buyers ?? null)} />
      </section>

      {ev.freshness && (
        <section className={styles.card} aria-label="Source coverage">
          <div className={styles.label}>Source coverage</div>
          <div className={styles.title}>
            {ev.freshness.sources_used} of {ev.freshness.sources_total} sources · {ev.freshness.coverage_pct}%
          </div>
          <div className={styles.sources}>
            {ev.freshness.sources.map((s) => (
              <span key={s.source} className={`${styles.source} ${s.found ? styles.sourceFound : ''}`}>
                {s.found ? '✓ ' : '· '}{s.source}
              </span>
            ))}
          </div>
        </section>
      )}

      <div className={styles.cards}>
        <PotentialCard ev={ev} sfdcTotals={sfdcTotals} />
        <OpportunitiesCard ev={ev} sfdcTotals={sfdcTotals} />
        <BuyCard ev={ev} />
        <ListCard ev={ev} />
        <SellCard ev={ev} />
        <FreshnessCard ev={ev} />
      </div>
    </div>
  );
}
