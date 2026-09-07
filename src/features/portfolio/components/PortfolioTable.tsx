import { useState } from 'react';
import type { AccountEvidence } from '../../../data/adapter/types';
import type { SfdcOppTotals } from '../../../data/sfdc/openOpportunities';
import type { SortKey, SortState } from '../../../domain/sort';
import { PortfolioRow } from './PortfolioRow';
import styles from './PortfolioTable.module.css';

interface Column {
  key: SortKey | null;
  label: string;
}

const COLUMNS: Column[] = [
  { key: 'est_sell', label: 'Est GMV (sell)' },
  { key: 'koronet_sell', label: 'Koronet Sell' },
  { key: 'sell_pen', label: 'Penetration %' },
  { key: 'online_pct', label: 'Online %' },
  { key: 'est_buy', label: 'Est Buy' },
  { key: 'koronet_buy', label: 'Koronet Buy' },
  { key: 'buy_pen', label: 'Buy Pen%' },
  { key: 'buy_online_pct', label: 'Online Buy%' },
  { key: 'fees', label: 'Fees' },
  { key: 'take_rate', label: 'Take Rate' },
  { key: null, label: 'Trend' },
  { key: 'at_stake', label: '$ at Stake' },
];

interface PortfolioTableProps {
  rows: AccountEvidence[];
  sfdcTotals: SfdcOppTotals;
  sort: SortState;
  onSort: (key: SortKey) => void;
  loading: boolean;
}

function SortHeader({ col, sort, onSort, className }: { col: Column; sort: SortState; onSort: (k: SortKey) => void; className?: string }) {
  const active = col.key != null && sort.key === col.key;
  const arrow = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  const cls = [styles.th, col.key ? styles.sortable : '', active ? styles.sortActive : '', className].filter(Boolean).join(' ');
  if (!col.key) return <th className={cls} scope="col">{col.label}</th>;
  return (
    <th
      className={cls}
      scope="col"
      onClick={() => onSort(col.key!)}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {col.label}{arrow}
    </th>
  );
}

export function PortfolioTable({ rows, sfdcTotals, sort, onSort, loading }: PortfolioTableProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className={styles.wrap}>
      <table className={styles.table} aria-busy={loading}>
        <thead>
          <tr>
            <th className={`${styles.th} ${styles.stickyCol} ${styles.col1}`} scope="col" aria-label="Expand" />
            <SortHeader col={{ key: 'name', label: 'Account' }} sort={sort} onSort={onSort} className={`${styles.stickyCol} ${styles.col2}`} />
            {COLUMNS.map((c) => <SortHeader key={c.label} col={c} sort={sort} onSort={onSort} />)}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={COLUMNS.length + 2} className={styles.empty}>
                {loading ? 'Loading accounts…' : 'No accounts match the current filters.'}
              </td>
            </tr>
          ) : (
            rows.map((ev) => (
              <PortfolioRow
                key={ev._company_id}
                ev={ev}
                sfdcTotals={sfdcTotals}
                expanded={expanded.has(ev._company_id)}
                onToggle={() => toggle(ev._company_id)}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function SectionLabel({ children }: { children: string }) {
  return <div className={styles.sectionLabel}>{children}</div>;
}

export function LoadMore({ remaining, onClick }: { remaining: number; onClick: () => void }) {
  if (remaining <= 0) return null;
  return (
    <div className={styles.loadMoreWrap}>
      <button type="button" className={styles.loadMore} onClick={onClick}>
        Load more accounts ({remaining} remaining)
      </button>
    </div>
  );
}

export function NoteStrip({ children }: { children: string }) {
  return <div className={styles.note}>{children}</div>;
}
