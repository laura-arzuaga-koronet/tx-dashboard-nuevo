/**
 * One account row (14 columns) + its expandable detail row.
 * All numbers/colors come from src/domain — this file only lays them out.
 */
import { Fragment, type ReactNode } from 'react';
import { Badge } from '../../../components/ui/Badge';
import { Sparkline } from '../../../components/ui/Sparkline';
import type { AccountEvidence, MetricReason, TrendMap } from '../../../data/adapter/types';
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

/**
 * La tabla imprimía "~100%" donde la penetración es una identidad, mientras la
 * tarjeta ya decía "Calculated measured". Dos pantallas diciendo cosas
 * distintas del mismo número. Ahora el valor es el porcentaje real y el
 * calificador dice de dónde sale, igual que en la tarjeta.
 */
const TAUTOLOGICAL_QUALIFIER = 'calculated measured';

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

/**
 * Movimiento contra el mismo rango un año atrás. Los montos van en %, los
 * porcentajes en puntos porcentuales: una penetración de 4% a 6% es +2pp, y
 * "+50%" sería cierto y a la vez inútil en una celda. Un % mayor a 999 se
 * recorta y una cuenta que arrancó de cero muestra "nuevo".
 */
function Trend({ t }: { t: TrendMap[keyof TrendMap] | undefined }) {
  if (!t) return null;
  if (t.from_zero) return <span className={styles.delta} title="No activity in the prior period">new</span>;
  const v = t.pct ?? t.pp;
  if (v == null || !Number.isFinite(v)) return null;
  const unit = t.pct != null ? '%' : 'pp';
  const abs = Math.abs(v);
  if (abs < (unit === 'pp' ? 0.1 : 0.5)) {
    return <span className={`${styles.delta} ${styles.deltaFlat}`} title="Sin cambio relevante">=</span>;
  }
  const txt = unit === '%' && abs > 999 ? '>999%' : `${abs.toFixed(1)}${unit}`;
  return (
    <span className={`${styles.delta} ${v < 0 ? styles.deltaNeg : ''}`} title="vs. the same period a year earlier">
      {v > 0 ? '▲' : '▼'}{txt}
    </span>
  );
}

/**
 * Por qué una métrica está vacía. "$0" y "sin dato" se leen igual en una tabla
 * y son decisiones distintas: una cuenta que no vende online genuinamente no
 * genera fee, y eso no es un hueco.
 */
function Why({ r }: { r: MetricReason | null | undefined }) {
  if (!r) return null;
  const cero = r.kind === 'cero';
  return (
    <div className={`${styles.why} ${cero ? styles.whyCero : styles.whyGap}`}
         title={cero ? 'El valor es correctamente cero, no es un dato faltante' : 'Dato faltante: no lo sabemos'}>
      {cero ? '' : '⚠ '}{r.note}
    </div>
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
  const feesDirect = p ? evValue(p.fees_direct) : null;
  const feesIndirect = p ? evValue(p.fees_indirect) : null;
  const buyAttributed = p ? evValue(p.buy_attributed) : null;
  const takeRate = p ? evValue(p.take_rate) : null;
  const tr = p?.trends ?? {};
  const rs = p?.reasons ?? {};

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

        {/* Est GMV y Est Buy llevan tendencia solo cuando el estimado ES nuestra
            medición: ahí heredan el movimiento del cubo. Con un ORA o un modelo
            externo detrás no hay serie, y el adapter devuelve null. */}
        <MetricCell>
          <Metric
            value={<>{gmv.value} <Trend t={tr.gmv_reference} /></>}
            qualifier={gmv.qualifier}
            tone={gmv.tone}
            extra={<Why r={rs.gmv_reference} />}
          />
        </MetricCell>

        <MetricCell>
          <Metric
            value={<>{fmtMoney(koronetSell, true)} <Trend t={tr.koronet_sell} /></>}
            qualifier={sellGrowthQualifier(p)}
            extra={<Why r={rs.koronet_sell_period} />}
          />
        </MetricCell>

        <MetricCell>
          <Metric value={<>{fmtPct(sellPen)} {sellTautological ? null : <Trend t={tr.sell_penetration} />}</>}
                  qualifier={sellTautological ? TAUTOLOGICAL_QUALIFIER : sellPenS.qualifier}
                  tone={sellPenS.tone} extra={<Why r={rs.sell_penetration} />} />
        </MetricCell>

        <MetricCell>
          <Metric
            value={<>{fmtPct(onlinePct)} <Trend t={tr.sell_online_pct} /></>}
            qualifier={onlineS.qualifier}
            tone={onlineS.tone}
            extra={<>{isSoloDigital(ev) ? <div className={styles.caveat}>(digital only)</div> : null}<Why r={rs.sell_online_pct} /></>}
          />
        </MetricCell>

        <MetricCell><Metric value={<>{fmtMoney(estBuy, true)} <Trend t={tr.buy_gmv_estimated} /></>} /></MetricCell>
        <MetricCell><Metric value={<>{fmtMoney(koronetBuy, true)} <Trend t={tr.koronet_buy} /></>} extra={<Why r={rs.koronet_buy_period} />} /></MetricCell>

        <MetricCell>
          <Metric value={<>{fmtPct(buyPen)} {buyTautological ? null : <Trend t={tr.buy_penetration} />}</>}
                  qualifier={buyTautological ? TAUTOLOGICAL_QUALIFIER : undefined}
                  tone={buyPenS.tone} extra={<Why r={rs.buy_penetration} />} />
        </MetricCell>

        <MetricCell>
          <Metric value={<>{fmtPct(buyOnlinePct)} <Trend t={tr.buy_online_pct} /></>}
                  qualifier={buyOnlineS.qualifier} tone={buyOnlineS.tone} extra={<Why r={rs.buy_online_pct} />} />
        </MetricCell>

        <MetricCell>
          <Metric value={<>{fmtMoney(feesDirect, true)} <Trend t={tr.fees_direct} /></>}
                  tone={feesTone(feesDirect)} extra={<Why r={rs.fees_direct} />} />
        </MetricCell>

        <MetricCell>
          <Metric value={<>{fmtMoney(feesIndirect, true)} <Trend t={tr.fees_indirect} /></>}
                  tone={feesIndirect ? 'neutral' : 'muted'}
                  qualifier={buyAttributed ? `${fmtMoney(buyAttributed, true)} purchased` : undefined}
                  extra={<Why r={rs.fees_indirect} />} />
        </MetricCell>

        <MetricCell>
          <div className={`${styles.value} ${styles.small} ${toneClass[takeRateTone(takeRate)]}`}>
            {fmtPct(takeRate, 2)} <Trend t={tr.take_rate} />
          </div>
          <Why r={rs.take_rate} />
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
