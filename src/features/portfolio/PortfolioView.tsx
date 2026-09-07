/**
 * Portfolio feature — composes the top bar, KPI strip, tabs and table.
 * Owns the period selection; everything else flows through usePortfolio().
 */
import { useMemo, useState } from 'react';
import { ErrorState } from '../../components/ui/Spinner';
import { fmtDate } from '../../domain/format';
import { buildPeriodOptions, PERIOD_TIMEFRAME, type PeriodId } from '../../domain/timeframe';
import { useDashboardData } from '../../hooks/useDashboardData';
import { usePortfolio } from '../../hooks/usePortfolio';
import { CoverageWarning, KpiStrip } from './components/KpiStrip';
import { ActionTabs, BusinessTypeTabs } from './components/PortfolioTabs';
import { LoadMore, NoteStrip, PortfolioTable, SectionLabel } from './components/PortfolioTable';
import { TopBar } from './components/TopBar';
import styles from './PortfolioView.module.css';

export function PortfolioView() {
  const [periodId, setPeriodId] = useState<PeriodId>('ytd');

  // The timeframe token is static per period id; only the labels depend on
  // cube metadata (which arrives with the data), so there is no cycle here.
  const data = useDashboardData(PERIOD_TIMEFRAME[periodId]);
  const periodOptions = useMemo(() => buildPeriodOptions(data.cubeMeta.sell), [data.cubeMeta.sell]);
  const period = periodOptions.find((p) => p.id === periodId) ?? periodOptions[0];

  const model = usePortfolio(data.evidence, data.sfdc.totals);
  const loading = data.status === 'loading' || data.recomputing;

  if (data.status === 'error') {
    return (
      <ErrorState text={`Error loading data: ${data.error}. Make sure the data/ folder is available.`} />
    );
  }

  const periodLabel = period.label.toUpperCase();

  return (
    <>
      <TopBar
        periodOptions={periodOptions}
        periodId={period.id}
        onPeriodChange={(id) => setPeriodId(id as PeriodId)}
        filters={model.filters}
        chips={model.chips}
        dispatch={model.dispatch}
      >
        <KpiStrip kpis={model.kpis} loading={loading} />
        {!loading && <CoverageWarning kpis={model.kpis} />}
      </TopBar>

      <main className={styles.main}>
        <BusinessTypeTabs value={model.filters.businessType} counts={model.businessTypeCounts} dispatch={model.dispatch} />
        <ActionTabs value={model.filters.actionTab} counts={model.actionCounts} dispatch={model.dispatch} />

        <SectionLabel>
          {loading
            ? 'Loading portfolio…'
            : `Portfolio · ${model.filtered.length} accounts · ${periodLabel} · Updated ${fmtDate(new Date())}`}
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
