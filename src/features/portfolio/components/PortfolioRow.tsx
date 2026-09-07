/**
 * One account row (14 columns) + its expandable detail row.
 * All numbers/colors come from src/domain — this file only lays them out.
 */
import { Fragment, type ReactNode } from 'react';
import { Badge } from '../../../components/ui/Badge';
import { Sparkline } from '../../../components/ui/Sparkline';
import type { AccountEvidence, Delta } from '../../../data/adapter/types';
import type { SfdcOppTotals } from '../../../data/sfdc/openOpportunities';
import { evValue, fmtMoney, fmtPct, fmtSignedPct } from '../../../domain/format';
import { buildDiagnosis, buildSparkline, calcAtStake, countInterventions, sellMomPct } from '../../../domain/metrics';
import {
  buyOnlineStyle,
  buyPenetrationStyle,
  feesTone,
  gmvDisplay,
  isSoloDigital,
  sellGrowthQualifier,
  sellOnlineStyle,
  sellPenetrationStyle,
  takeRateTone,
  type Tone,
} from '../../../domain/thresholds';
import { AccountDetail } from '../../account-detail/AccountDetail';
import tableStyles from './PortfolioTable.module.css';
import styles from './PortfolioRow.module.css';

export const COLUMN_COUNT = 14;

const toneClass: Record<Tone, string> = {
  green: styles.green,
  amber: styles.amber,
  red: styles.red,
  muted: styles.muted,
  'muted-italic': styles.mutedItalic,
  neutral: styles.neutral,
};

function MetricCell({ children }: { children: ReactNode }) {
  return <td className={styles.metricCell}>{children}</td>;
}

function Metric({ value, qualifier, tone = 'neutral', extra }: { value: ReactNode; qualifier?: string; tone?: Tone; extra?: ReactNode }) {
  return (
    <>
      <div className={`${styles.value} ${toneClass[tone]}`}>{value}</div>
      {qualifier ? <div className={styles.qualifier}>{qualifier}</div> : null}
      {extra}
    </>
  );
}

function YoyDelta({ delta }: { delta: Delta | null }) {
  if (!delta) return null;
  const arrow = delta.direction === 'up' ? '▲' : delta.direction === 'down' ? '▼' : '';
  return (
    <span className={`${styles.delta} ${delta.direction === 'down' ? styles.deltaNeg : ''}`}>
      {arrow}{fmtPct(Math.abs(delta.pct), 1)}
    </span>
  );
}

function priorityClass(level: string): string {
  if (level === 'P1') return styles.red;
  if (level === 'IMPL') return styles.amber;
  if (level === 'TA') return styles.blue;
  return styles.muted;
}

interface PortfolioRowProps {
  ev: AccountEvidence;
  sfdcTotals: SfdcOppTotals;
  expanded: boolean;
  onToggle: () => void;
}

export function PortfolioRow({ ev, sfdcTotals, expanded, onToggle }: PortfolioRowProps) {
  const id = ev._company_id;
  const name = ev._company_name ?? `Account ${id}`;
  const p = ev.potential;
  const identity = ev.identity;

  const gmv = gmvDisplay(ev);
  const koronetSell = p ? evValue(p.koronet_sell_period) : null;
  const sellPen = p ? evValue(p.sell_penetration) : null;
  const onlinePct = p ? evValue(p.sell_online_pct) : null;
  const estBuy = p?.buy_gmv_estimated?.value ?? null;
  const koronetBuy = p ? evValue(p.koronet_buy_period) : null;
  const buyPen = p ? evValue(p.buy_penetration) : null;
  const buyOnlinePct = p ? evValue(p.buy_online_pct) : null;
  const fees = p ? evValue(p.fees_period) : null;
  const takeRate = p ? evValue(p.take_rate) : null;

  const sellPenS = sellPenetrationStyle(p);
  const buyPenS = buyPenetrationStyle(p);
  const onlineS = sellOnlineStyle(ev);
  const buyOnlineS = buyOnlineStyle(ev);
  const sellTautological = p?.sell_penetration.ev === 'tautological';
  const buyTautological = p?.buy_penetration.ev === 'tautological';

  const atStake = calcAtStake(ev, sfdcTotals);
  const interventions = countInterventions(ev);
  const diagnosis = buildDiagnosis(ev);
  const mom = sellMomPct(ev);

  const metaParts: ReactNode[] = [];
  if (identity.priority_level) {
    metaParts.push(<span key="p" className={`${styles.priority} ${priorityClass(identity.priority_level)}`}>{identity.priority_level}</span>);
  }
  if (identity.ct_id) metaParts.push(identity.ct_id);
  if (identity.sfdc_type) metaParts.push(identity.sfdc_type);

  const stakeSource = atStake?.source === 'sfdc' ? 'SFDC opp' : atStake?.source === 'scenario' ? 'scenario est.' : '—';

  return (
    <>
      <tr className={expanded ? tableStyles.rowExpanded : undefined}>
        <td className={`${styles.toggleCell} ${tableStyles.stickyCol} ${tableStyles.col1}`}>
          <button
            type="button"
            className={`${styles.toggle} ${expanded ? styles.toggleOpen : ''}`}
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name}`}
          >
            <span className={styles.chevron} aria-hidden>▶</span>
          </button>
        </td>

        <td className={`${styles.accountCell} ${tableStyles.stickyCol} ${tableStyles.col2}`}>
          <div className={styles.name}>{name}</div>
          <div>
            {identity.business_type && <Badge kind="businessType">{identity.business_type}</Badge>}
            {identity.product_tier && <Badge kind="productTier">{identity.product_tier}</Badge>}
            {identity.sell_channel && <Badge kind="sellChannel">{identity.sell_channel}</Badge>}
            {identity.potential_tier && <Badge kind="potentialTier">{identity.potential_tier}</Badge>}
            {identity.segment && identity.segment !== 'Activo' && <Badge kind="segment">{identity.segment}</Badge>}
          </div>
          {metaParts.length > 0 && (
            <div className={styles.meta}>
              {metaParts.map((part, i) => (
                <Fragment key={i}>{i > 0 && ' · '}{part}</Fragment>
              ))}
            </div>
          )}
          <div className={styles.diagnosis}>
            {diagnosis.map((d, i) => (
              <Fragment key={i}>
                {i > 0 && '. '}
                {d.strong ? <strong>{d.text}</strong> : d.text}
              </Fragment>
            ))}
            {diagnosis.some((d) => d.fallback) ? '' : '.'}
          </div>
        </td>

        <MetricCell><Metric value={gmv.value} qualifier={gmv.qualifier} tone={gmv.tone} /></MetricCell>

        <MetricCell>
          <Metric
            value={<>{fmtMoney(koronetSell, true)} <YoyDelta delta={p?.sell_yoy_delta ?? null} /></>}
            qualifier={sellGrowthQualifier(p)}
          />
        </MetricCell>

        <MetricCell>
          <Metric value={sellTautological ? '~100%' : fmtPct(sellPen)} qualifier={sellPenS.qualifier} tone={sellPenS.tone} />
        </MetricCell>

        <MetricCell>
          <Metric
            value={fmtPct(onlinePct)}
            qualifier={onlineS.qualifier}
            tone={onlineS.tone}
            extra={isSoloDigital(ev) ? <div className={styles.caveat}>(solo digital)</div> : null}
          />
        </MetricCell>

        <MetricCell><Metric value={fmtMoney(estBuy, true)} /></MetricCell>
        <MetricCell><Metric value={fmtMoney(koronetBuy, true)} /></MetricCell>

        <MetricCell>
          <Metric value={buyTautological ? '~100%' : fmtPct(buyPen)} tone={buyPenS.tone} />
        </MetricCell>

        <MetricCell>
          <Metric value={fmtPct(buyOnlinePct)} qualifier={buyOnlineS.qualifier} tone={buyOnlineS.tone} />
        </MetricCell>

        <MetricCell><Metric value={fmtMoney(fees, true)} tone={feesTone(fees)} /></MetricCell>

        <MetricCell>
          <div className={`${styles.value} ${styles.small} ${toneClass[takeRateTone(takeRate)]}`}>{fmtPct(takeRate, 2)}</div>
        </MetricCell>

        <MetricCell>
          <Sparkline bars={buildSparkline(ev)} />
          {mom != null && (
            <div className={`${styles.trend} ${mom >= 0 ? styles.green : styles.red}`}>{fmtSignedPct(mom)} MoM</div>
          )}
        </MetricCell>

        <MetricCell>
          <div className={styles.stake}>{fmtMoney(atStake?.amount ?? null, true)}</div>
          <div className={styles.stakeSource}>
            {stakeSource}
            {interventions > 0 && ` · ${interventions} intervention${interventions !== 1 ? 's' : ''}`}
          </div>
        </MetricCell>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={COLUMN_COUNT} className={styles.expandedCell}>
            <div className={styles.expanded}>
              <AccountDetail ev={ev} sfdcTotals={sfdcTotals} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
