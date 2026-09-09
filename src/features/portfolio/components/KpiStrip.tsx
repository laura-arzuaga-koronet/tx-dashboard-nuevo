import type { ReactNode } from 'react';
import { fmtMoney, fmtPct, fmtSignedPct } from '../../../domain/format';
import type { PortfolioKpis } from '../../../domain/kpis';
import type { Period } from '../../../domain/period';
import styles from './KpiStrip.module.css';

interface KpiItemProps {
  value: string;
  label: ReactNode;
  delta?: { text: string; tone: 'up' | 'down' | 'neutral' } | null;
}

function KpiItem({ value, label, delta }: KpiItemProps) {
  return (
    <div className={styles.item}>
      <div>
        <span className={styles.value}>{value}</span>
        {delta && <span className={`${styles.delta} ${styles[delta.tone]}`}>{delta.text}</span>}
      </div>
      <div className={styles.label}>{label}</div>
    </div>
  );
}

function yoyDelta(pct: number | null) {
  if (pct == null) return null;
  return { text: `${fmtSignedPct(pct)} YoY`, tone: pct >= 0 ? ('up' as const) : ('down' as const) };
}

export function KpiStrip({ kpis, loading, period }: { kpis: PortfolioKpis; loading: boolean; period: Period }) {
  const v = (s: string) => (loading ? 'Loading…' : s);
  return (
    <div className={styles.strip} aria-busy={loading}>
      <KpiItem value={v(fmtMoney(kpis.totalSell, true))} label={`Total Sell GMV · ${period.label}`} delta={loading ? null : yoyDelta(kpis.sellYoyPct)} />
      <KpiItem value={v(fmtMoney(kpis.totalFees, true))} label={`Fees · ${period.label}`} delta={loading ? null : yoyDelta(kpis.feesYoyPct)} />
      <KpiItem value={v(`${kpis.accountsWithData} of ${kpis.total}`)} label="Accounts with Data" />
      <KpiItem
        value={v(fmtPct(kpis.avgOnlinePct, 1))}
        label={<>Overall Online % <span className={styles.labelHint}>(pond. GMV)</span></>}
        delta={!loading && kpis.avgOnlinePctSimple != null ? { text: `simple ${fmtPct(kpis.avgOnlinePctSimple, 1)}`, tone: 'neutral' } : null}
      />
      <KpiItem value={v(fmtPct(kpis.avgTakeRate, 2))} label="Avg Take Rate" />
    </div>
  );
}

/* Antes esto decía "N cuentas sin datos de sell" y metía en la misma bolsa dos
   cosas distintas: la cuenta que no vende por Koronet (cero real, explicado) y
   la que debería tener ventas y no las tiene (hueco). Solo la segunda vuelve
   incompleta la vista. */
export function CoverageWarning({ kpis }: { kpis: PortfolioKpis }) {
  const sinVentas = kpis.total - kpis.accountsWithData;
  const gaps = sinVentas - kpis.accountsZeroExplained;
  if (sinVentas <= 0 || kpis.total === 0) return null;
  const pct = Math.round(((kpis.accountsWithData + kpis.accountsZeroExplained) / kpis.total) * 100);
  return (
    <div className={styles.coverage} role="note">
      <span aria-hidden>{gaps > 0 ? '⚠' : 'ℹ'}</span>
      <span>
        {sinVentas} cuentas sin ventas en el período
        {kpis.accountsZeroExplained > 0 && <> · {kpis.accountsZeroExplained} son cero explicado (no venden por Koronet o no están live)</>}
        {gaps > 0
          ? <> · <strong>{gaps} sin explicación</strong> — ahí sí puede faltar dato</>
          : <> · ninguna sin explicar</>}
        . Cobertura: {pct}% del portafolio
      </span>
    </div>
  );
}
