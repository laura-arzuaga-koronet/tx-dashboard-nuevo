/**
 * Sticky top bar: brand, period selector, filter dropdowns, active-filter chips,
 * quick-filter chips (priority / impl) and search. KPI strip + coverage warning
 * are rendered as children so they stay inside the sticky region.
 */
import type { ReactNode } from 'react';
import { ClearAllButton, RemovableChip, ToggleChip } from '../../../components/ui/Chip';
import { SelectPill } from '../../../components/ui/SelectPill';
import type { ActiveChip, FilterState } from '../../../domain/filters';
import { PERIOD_IDS, type Period, type PeriodId } from '../../../domain/period';
import type { FiltersAction, SingleFilterKey } from '../../../state/filtersReducer';
import {
  ACCOUNT_CLASS_OPTIONS,
  BUSINESS_TYPE_OPTIONS,
  GMV_BAND_OPTIONS,
  IMPL_CHIPS,
  POTENTIAL_TIER_OPTIONS,
  PRIORITY_CHIPS,
  PRODUCT_TIER_OPTIONS,
  SEGMENT_OPTIONS,
  SELL_CHANNEL_OPTIONS,
} from '../filterOptions';
import styles from './TopBar.module.css';

interface TopBarProps {
  periods: Record<PeriodId, Period>;
  period: Period;
  onPeriodChange: (id: PeriodId) => void;
  filters: FilterState;
  chips: ActiveChip[];
  dispatch: (action: FiltersAction) => void;
  children?: ReactNode;
}

export function TopBar({ periods, period, onPeriodChange, filters, chips, dispatch, children }: TopBarProps) {
  const set = (key: SingleFilterKey) => (value: string) => dispatch({ type: 'set', key, value });

  const removeChip = (chip: ActiveChip) => {
    if (chip.key === 'priority') dispatch({ type: 'removeChip', group: 'priorities', value: chip.value });
    else if (chip.key === 'impl') dispatch({ type: 'removeChip', group: 'impl', value: chip.value });
    else dispatch({ type: 'clear', key: chip.key as SingleFilterKey });
  };

  return (
    <header className={styles.topbar}>
      <div className={styles.inner}>
        <div className={styles.header}>
          <div className={styles.brand}>
            <span className={styles.brandName}>TX Dashboard</span>
            <span className={styles.brandBadge}>Revenue OS</span>
          </div>

          <div className={styles.controls}>
            <span className={styles.periodLabel}>Period</span>
            <SelectPill
              aria-label="Period"
              value={period.id}
              options={PERIOD_IDS.map((id) => ({ value: id, label: periods[id].label }))}
              onChange={(id) => onPeriodChange(id as PeriodId)}
              title={`${period.from} → ${period.to} · YoY vs ${period.prior.from} → ${period.prior.to}`}
            />

            <div className={styles.chips} aria-label="Active filters">
              {chips.map((c) => (
                <RemovableChip key={`${c.key}:${c.value}`} label={c.label} onRemove={() => removeChip(c)} />
              ))}
              {chips.length > 1 && <ClearAllButton onClick={() => dispatch({ type: 'clearAll' })} />}
            </div>

            <SelectPill aria-label="Account class" value={filters.accountClass} options={ACCOUNT_CLASS_OPTIONS} onChange={set('accountClass')} />
            <SelectPill aria-label="Business type" value={filters.businessType} options={BUSINESS_TYPE_OPTIONS} onChange={set('businessType')} />
            <SelectPill aria-label="Segment" value={filters.segment} options={SEGMENT_OPTIONS} onChange={set('segment')} />
            <SelectPill aria-label="Product tier" value={filters.productTier} options={PRODUCT_TIER_OPTIONS} onChange={set('productTier')} />
            <SelectPill aria-label="GMV band" value={filters.gmvBand} options={GMV_BAND_OPTIONS} onChange={set('gmvBand')} />
            <SelectPill aria-label="Sell channel" value={filters.sellChannel} options={SELL_CHANNEL_OPTIONS} onChange={set('sellChannel')} />
            <SelectPill aria-label="Potential tier" value={filters.potentialTier} options={POTENTIAL_TIER_OPTIONS} onChange={set('potentialTier')} />
          </div>

          <div className={styles.quickRow}>
            <span className={styles.quickLabel}>Priority:</span>
            {PRIORITY_CHIPS.map((c) => (
              <ToggleChip
                key={c.value}
                label={c.label}
                active={filters.priorities.has(c.value)}
                onToggle={() => dispatch({ type: 'toggleChip', group: 'priorities', value: c.value })}
              />
            ))}
            <span className={`${styles.quickLabel} ${styles.quickLabelGap}`}>Impl:</span>
            {IMPL_CHIPS.map((c) => (
              <ToggleChip
                key={c.value}
                label={c.label}
                active={filters.impl.has(c.value)}
                onToggle={() => dispatch({ type: 'toggleChip', group: 'impl', value: c.value })}
              />
            ))}
            <input
              className={styles.search}
              type="search"
              placeholder="Search account…"
              aria-label="Search account"
              value={filters.search}
              onChange={(e) => dispatch({ type: 'set', key: 'search', value: e.target.value })}
            />
          </div>
        </div>

        {children}
      </div>
    </header>
  );
}
