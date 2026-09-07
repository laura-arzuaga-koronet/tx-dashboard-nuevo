/**
 * Loads the adapter + SFDC opportunities once, then exposes the evidence list
 * for the selected timeframe. Evidence is computed in batches via
 * requestAnimationFrame so the UI stays responsive on ~4k accounts.
 */
import { useEffect, useState } from 'react';
import { evidenceAdapter } from '../data/adapter';
import type { AccountEvidence, CubeMeta, Timeframe } from '../data/adapter/types';
import { loadSfdcOpportunities, type SfdcOpportunities } from '../data/sfdc/openOpportunities';
import { defaultOrder } from '../domain/sort';

export type LoadStatus = 'loading' | 'ready' | 'error';

export interface DashboardData {
  status: LoadStatus;
  error: string | null;
  /** All accounts (default order: fees desc) for the active timeframe. */
  evidence: AccountEvidence[];
  /** True while a timeframe switch is recomputing evidence. */
  recomputing: boolean;
  sfdc: SfdcOpportunities;
  cubeMeta: { sell: CubeMeta | null; buy: CubeMeta | null; fees: CubeMeta | null };
}

const EMPTY_SFDC: SfdcOpportunities = { totals: {}, byAccount: {}, generatedAt: null };
const BATCH_SIZE = 50;

export function useDashboardData(timeframe: Timeframe): DashboardData {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [sfdc, setSfdc] = useState<SfdcOpportunities>(EMPTY_SFDC);
  // Evidence is tagged with the timeframe it was computed for, so "recomputing"
  // is derived (no setState-in-effect) — it's true until the tag matches.
  const [computed, setComputed] = useState<{ timeframe: Timeframe; evidence: AccountEvidence[] } | null>(null);
  const [cubeMeta, setCubeMeta] = useState<DashboardData['cubeMeta']>({ sell: null, buy: null, fees: null });

  // 1. Load files once.
  useEffect(() => {
    let cancelled = false;
    Promise.all([evidenceAdapter.init(), loadSfdcOpportunities()])
      .then(([, opps]) => {
        if (cancelled) return;
        setSfdc(opps);
        setCubeMeta(evidenceAdapter.getCubeMeta());
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      });
    return () => { cancelled = true; };
  }, []);

  // 2. (Re)compute evidence whenever the timeframe changes, in rAF batches.
  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    let frame = 0;
    const ids = evidenceAdapter.getAllAccountIds();
    const acc: AccountEvidence[] = [];
    let idx = 0;

    const step = () => {
      if (cancelled) return;
      for (const id of ids.slice(idx, idx + BATCH_SIZE)) {
        const ev = evidenceAdapter.getAccountEvidence(id, timeframe);
        if (ev) acc.push(ev);
      }
      idx += BATCH_SIZE;
      if (idx < ids.length) {
        frame = requestAnimationFrame(step);
      } else {
        setComputed({ timeframe, evidence: defaultOrder(acc) });
      }
    };
    frame = requestAnimationFrame(step);
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [status, timeframe]);

  const evidence = computed?.evidence ?? [];
  const recomputing = status === 'ready' && computed?.timeframe !== timeframe;
  return { status, error, evidence, recomputing, sfdc, cubeMeta };
}
