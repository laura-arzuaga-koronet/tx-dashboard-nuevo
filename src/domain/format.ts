/** Display formatting helpers — pure, no DOM. */
import type { Ev } from '../data/adapter/types';

export const EM_DASH = '—';

/** `$1.2M`, `$450K`, `$980` when compact; `$1,234,567` otherwise. */
export function fmtMoney(n: number | null | undefined, compact = false): string {
  if (n == null) return EM_DASH;
  if (compact) {
    const abs = Math.abs(n);
    if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
    return `$${n.toFixed(0)}`;
  }
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function fmtPct(n: number | null | undefined, dp = 1): string {
  if (n == null) return EM_DASH;
  return `${n.toFixed(dp)}%`;
}

/** Signed percentage, e.g. `+4.2%` / `-1.0%`. */
export function fmtSignedPct(n: number, dp = 1): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(dp)}%`;
}

export function fmtInt(n: number | null | undefined): string {
  if (n == null) return EM_DASH;
  return n.toLocaleString('en-US');
}

/** Unwrap an Ev<T> to its value (null when missing). */
export function evValue<T>(e: Ev<T> | null | undefined): T | null {
  return e && e.value != null ? e.value : null;
}

/** 'observed' → 'Observed'; 'gap' → '' */
export function evLabel(state: string | null | undefined): string {
  if (!state || state === 'gap') return '';
  return state.charAt(0).toUpperCase() + state.slice(1);
}

export function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** '2026-07' → 'Jul 2026' */
export function fmtMonthKey(key: string | null | undefined): string {
  if (!key) return EM_DASH;
  const [y, m] = key.split('-').map(Number);
  if (!y || !m) return key;
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/**
 * The cascade emits its GMV sources in Spanish, because that is the vocabulary
 * of accounts_v3 and of the docs that describe it. The dashboard is in English,
 * so the string is translated here, at the edge, and the data keeps its own
 * names: renaming them in the JSON would break every comparison against the
 * legacy dashboard and every doc that cites them.
 *
 * An unknown source falls through unchanged — better a Spanish word on screen
 * than a silently swallowed one.
 */
const GMV_SOURCE_EN: Record<string, string> = {
  'Medido': 'Measured',
  'Medido (parcial)': 'Measured (partial)',
  'Medido (histórico)': 'Measured (historical)',
  'Piso de red': 'Network floor',
  'Estimado': 'Estimated',
  'Estimado (verificar)': 'Estimated (to verify)',
  'Estimado (AnnualRevenue×0.11)': 'Estimated (AnnualRevenue × 0.11)',
  'Sin dato': 'No data',
  'No vende (Koronet)': 'Does not sell (Koronet)',
  'not in Christine cascade': 'Not in Christine cascade',
};

export function gmvSourceLabel(source: string | null | undefined): string {
  if (!source) return 'gap';
  return GMV_SOURCE_EN[source] ?? source;
}

/** 'Alta' | 'Baja' → 'High' | 'Low'. Same reasoning as gmvSourceLabel. */
export function confidenceLabel(c: string | null | undefined): string {
  return c === 'Alta' ? 'High' : c === 'Baja' ? 'Low' : c === 'Media' ? 'Medium' : (c ?? '');
}
