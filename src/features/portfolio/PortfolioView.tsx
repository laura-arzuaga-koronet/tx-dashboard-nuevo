/**
 * Portfolio feature — composes the top bar, KPI strip, tabs and table.
 * Owns the period selection; everything else flows through usePortfolio().
 */
import { useState } from 'react';
import { ErrorState } from '../../components/ui/Spinner';
import { buildPeriods } from '../../data/adapter/period';
import { fmtDate } from '../../domain/format';
import { DEFAULT_PERIOD_ID, describePrior, describeRange, type PeriodId } from '../../domain/period';
import { useDashboardData } from '../../hooks/useDashboardData';
import { usePortfolio } from '../../hooks/usePortfolio';
import { CoverageWarning, KpiStrip } from './components/KpiStrip';
import { ActionTabs, BusinessTypeTabs } from './components/PortfolioTabs';
import { LoadMore, NoteStrip, PortfolioTable, SectionLabel } from './components/PortfolioTable';
import { TopBar } from './components/TopBar';
import styles from './PortfolioView.module.css';

export function PortfolioView() {
  const [periodId, setPeriodId] = useState<PeriodId>(DEFAULT_PERIOD_ID);

  const data = useDashboardData(periodId);
  // Until the data (and its anchor month) arrives, show periods built on the default anchor.
  const periods = data.periods ?? buildPeriods();
  const period = periods[periodId];

  const model = usePortfolio(data.evidence, data.sfdc.totals);
  const loading = data.status === 'loading' || data.recomputing;

  if (data.status === 'error') {
    return (
      <ErrorState text={`Error loading data: ${data.error}. Make sure the data/ folder is available.`} />
    );
  }


  return (
    <>
      <TopBar
        periods={periods}
        period={period}
        onPeriodChange={setPeriodId}
        filters={model.filters}
        chips={model.chips}
        dispatch={model.dispatch}
      >
        <KpiStrip kpis={model.kpis} loading={loading} period={period} />
        {!loading && <CoverageWarning kpis={model.kpis} />}
      </TopBar>

      <main className={styles.main}>
        <BusinessTypeTabs value={model.filters.businessType} counts={model.businessTypeCounts} dispatch={model.dispatch} />
        <ActionTabs value={model.filters.actionTab} counts={model.actionCounts} dispatch={model.dispatch} />

        <SectionLabel>
          {loading
            ? 'Loading portfolio…'
            : `Portfolio · ${model.filtered.length} accounts · ${period.label} (${describeRange(period)}, ${describePrior(period)}) · Updated ${fmtDate(new Date())}`}
        </SectionLabel>

        <PortfolioTable
          rows={model.visible}
          sfdcTotals={data.sfdc.totals}
          sort={model.sort}
          onSort={model.toggleSort}
          loading={loading}
        />

        <LoadMore remaining={model.remaining} onClick={model.loadMore} />

        {!loading && (
          <NoteStrip>
            {`Showing ${model.visible.length} of ${model.filtered.length} filtered accounts · Total: ${data.evidence.length} in universe`}
          </NoteStrip>
        )}
      </main>
    </>
  );
}
