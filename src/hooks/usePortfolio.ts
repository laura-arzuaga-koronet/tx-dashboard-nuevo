/**
 * Derives everything the portfolio view renders from (evidence, filters, sort):
 * filtered rows, KPIs, tab counts, active chips, pagination window.
 */
import { useMemo, useReducer, useState } from 'react';
import type { AccountEvidence } from '../data/adapter/types';
import type { SfdcOppTotals } from '../data/sfdc/openOpportunities';
import {
  activeChips,
  applyFilters,
  countActionTabs,
  countBusinessTypes,
  DEFAULT_FILTERS,
  matchesBaseFilters,
} from '../domain/filters';
import { computeKpis } from '../domain/kpis';
import { DEFAULT_SORT, nextSort, sortEvidence, type SortKey, type SortState } from '../domain/sort';
import { filtersReducer } from '../state/filtersReducer';

export const PAGE_SIZE = 50;

export function usePortfolio(evidence: readonly AccountEvidence[], sfdcTotals: SfdcOppTotals) {
  const [filters, dispatch] = useReducer(filtersReducer, DEFAULT_FILTERS);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [pageCount, setPageCount] = useState(1);

  // Base-filtered (everything except the action tab) — feeds tab counts.
  const baseFiltered = useMemo(
    () => evidence.filter((ev) => matchesBaseFilters(ev, filters)),
    [evidence, filters],
  );

  const filtered = useMemo(() => applyFilters(evidence, filters), [evidence, filters]);

  const sorted = useMemo(() => sortEvidence(filtered, sort, sfdcTotals), [filtered, sort, sfdcTotals]);

  const kpis = useMemo(() => computeKpis(filtered), [filtered]);
  const actionCounts = useMemo(() => countActionTabs(baseFiltered), [baseFiltered]);
  const businessTypeCounts = useMemo(() => countBusinessTypes(evidence, filters), [evidence, filters]);
  const chips = useMemo(() => activeChips(filters), [filters]);

  const visible = useMemo(() => sorted.slice(0, pageCount * PAGE_SIZE), [sorted, pageCount]);
  const remaining = Math.max(0, sorted.length - visible.length);

  // Any filter/sort change resets pagination — wrap dispatchers to do it in one place.
  const dispatchFilters: typeof dispatch = (action) => {
    setPageCount(1);
    dispatch(action);
  };

  const toggleSort = (key: SortKey) => {
    setPageCount(1);
    setSort((s) => nextSort(s, key));
  };

  const loadMore = () => setPageCount((n) => n + 1);

  return {
    filters,
    dispatch: dispatchFilters,
    sort,
    toggleSort,
    filtered: sorted,
    visible,
    remaining,
    loadMore,
    kpis,
    actionCounts,
    businessTypeCounts,
    chips,
  };
}

export type PortfolioModel = ReturnType<typeof usePortfolio>;
