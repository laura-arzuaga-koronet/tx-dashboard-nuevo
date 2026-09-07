import type { ReactNode } from 'react';
import { fmtMoney, fmtPct, fmtSignedPct } from '../../../domain/format';
import type { PortfolioKpis } from '../../../domain/kpis';
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

export function KpiStrip({ kpis, loading }: { kpis: PortfolioKpis; loading: boolean }) {
  const v = (s: string) => (loading ? 'Loading…' : s);
  return (
    <div className={styles.strip} aria-busy={loading}>
      <KpiItem value={v(fmtMoney(kpis.totalSell, true))} label="Total Sell GMV" delta={loading ? null : yoyDelta(kpis.sellYoyPct)} />
      <KpiItem value={v(fmtMoney(kpis.totalFees, true))} label="Fees YTD" delta={loading ? null : yoyDelta(kpis.feesYoyPct)} />
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

export function CoverageWarning({ kpis }: { kpis: PortfolioKpis }) {
  const noData = kpis.total - kpis.accountsWithData;
  if (noData <= 0 || kpis.total === 0) return null;
  const pct = Math.round((kpis.accountsWithData / kpis.total) * 100);
  return (
    <div className={styles.coverage} role="note">
      <span aria-hidden>⚠</span>
      <span>
        {noData} accounts without sell data — decisions on this view may be incomplete. Coverage: {pct}% of portfolio
      </span>
    </div>
  );
}
